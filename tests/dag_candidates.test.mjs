import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as candidates from "../site/dag_candidates.mjs";
const { centroid } = candidates;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const worldToScreen = (x, y, transform) => ({ x: x * transform.scale + transform.tx, y: y * transform.scale + transform.ty });
import { rawLinksBetween, pairKey, linkKey } from "../site/dag_link_aggregation.mjs";

test("candidate centroids are reused within a calculation and refreshed after edits", () => {
  const variables = new Map([
    ["a", { map_x: 0, map_y: 0 }], ["b", { map_x: 10, map_y: 0 }],
    ["c", { map_x: 2, map_y: 0 }],
  ]);
  let reads = 0;
  const lookup = { get(id) { reads++; return variables.get(id); } };
  const project = { iv_group_id: "iv", dv_group_id: "dv", groups: [
    { group_id: "iv", label: "IV", variable_ids: ["a"] },
    { group_id: "dv", label: "DV", variable_ids: ["b"] },
    { group_id: "c", label: "C", variable_ids: ["c"] },
  ] };
  const inputs = { variables: lookup, similarityEdgeMap: new Map(),
    linkLookup: new Map([[linkKey("c", "a"), [1]], [linkKey("c", "b"), [1]]]) };
  const first = candidates.buildCandidateQueue(project, inputs);
  assert.equal(reads, 3);
  assert.equal(first[0].proximity, 2);
  variables.get("c").map_x = 4;
  const next = candidates.buildCandidateQueue(project, inputs);
  assert.equal(next[0].proximity, 4);
  assert.equal(reads, 6);
});

test("causal candidate roles retain legacy behavior and do not depend on the coordinate scale", () => {
  const variables = Array.from({ length: 100 }, (_, i) => ({
    variable_id: "v" + i, map_x: i * 0.02, map_y: i % 3 * 0.02,
  }));
  const variableById = new Map(variables.map(v => [v.variable_id, v]));
  const project = { iv_group_id: "g0", dv_group_id: "g1",
    groups: variables.slice(0, 90).map((v, i) => ({
      group_id: "g" + i, label: "Group " + i, variable_ids: [v.variable_id],
    })) };
  const lookup = new Map();
  const connect = (a, b) => lookup.set(linkKey("v" + a, "v" + b), [a + "-" + b]);
  connect(2, 0); connect(2, 1); connect(0, 3); connect(3, 1);
  connect(0, 4); connect(1, 4); connect(5, 1); connect(6, 0);
  for (let i = 90; i < 100; i++) connect(i, 1);
  const state = { project, variableById, similarityEdgeMap: new Map() };
  const transform = { scale: 100, tx: 0, ty: 0 };
  const legacy = vm.createContext({
    state, pairKey, distance, Date: { now: () => 123 }, nowIso: () => "time",
    groupById: id => project.groups.find(g => g.group_id === id),
    dagGroups: () => project.groups.filter(g => g.variable_ids?.length),
    hasAnyMapping: (a, b) => rawLinksBetween(a, b, lookup).length > 0,
    groupCentroid: ids => centroid(ids, variableById),
    visibleVariables: () => variables,
    worldToScreen: (x, y) => worldToScreen(x, y, transform),
    canvasWidth: () => 200, canvasHeight: () => 100,
    ensureGroup() {}, addDecision() {},
  });
  vm.runInContext(readFileSync(new URL("./fixtures/legacy_dag_candidates.js", import.meta.url), "utf8"), legacy);
  const inputs = { variables: variableById, similarityEdgeMap: state.similarityEdgeMap, linkLookup: lookup };
  const plain = value => JSON.parse(JSON.stringify(value));
  for (const missing of [false, true]) {
    project.iv_group_id = missing ? "missing" : "g0";
    legacy.buildCandidateQueue();
    const before = structuredClone(project);
    const current = candidates.buildCandidateQueue(project, inputs);
    const causalOnly = queue => queue.filter(item => !item.roles.includes("near_iv_dv_map_region"));
    assert.deepEqual(plain(causalOnly(current)), plain(causalOnly(state.candidateQueue)));
    assert.deepEqual(plain(project), plain(before));
    if (!missing) {
      for (const factor of [1e-6, 1e6]) {
        const scaledVariables = variables.map(variable => ({
          ...variable, map_x: variable.map_x * factor, map_y: variable.map_y * factor,
        }));
        const scaledInputs = { ...inputs,
          variables: new Map(scaledVariables.map(variable => [variable.variable_id, variable])) };
        const scaledQueue = candidates.buildCandidateQueue(project, scaledInputs);
        assert.deepEqual(current.map(item => [item.group_id, item.roles]),
          scaledQueue.map(item => [item.group_id, item.roles]));
      }
    }
  }
});
