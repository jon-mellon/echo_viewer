import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as candidates from "../site/dag_candidates.mjs";
import { centroid, distance, worldToScreen } from "../site/map_geometry.mjs";
import { rawLinksBetween, pairKey, linkKey } from "../site/dag_link_aggregation.mjs";

test("causal candidate roles retain legacy behavior while spatial roles are scale invariant", () => {
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
      const options = { visibleVariables: variables, transform, width: 200, height: 100,
        groupId: "density_123", createdAt: "time" };
      const density = candidates.createDensityCandidateGroup(project, inputs, options);
      assert.equal(density.variable_ids.length, 10);
      for (const factor of [1e-6, 1e6]) {
        const scaledVariables = variables.map(variable => ({
          ...variable, map_x: variable.map_x * factor, map_y: variable.map_y * factor,
        }));
        const scaledInputs = { ...inputs,
          variables: new Map(scaledVariables.map(variable => [variable.variable_id, variable])) };
        const scaledQueue = candidates.buildCandidateQueue(project, scaledInputs);
        assert.deepEqual(current.map(item => [item.group_id, item.roles]),
          scaledQueue.map(item => [item.group_id, item.roles]));
        const scaledOptions = { ...options, visibleVariables: scaledVariables,
          transform: { ...transform, scale: transform.scale / factor } };
        const scaledDensity = candidates.createDensityCandidateGroup(project, scaledInputs, scaledOptions);
        assert.deepEqual(density.variable_ids, scaledDensity.variable_ids);
      }
    }
  }
});

test("density selection minimizes the fixed-size nearest-neighbour radius", () => {
  const variables = [
    { variable_id: "a", map_x: 0, map_y: 0 },
    { variable_id: "b", map_x: 0.01, map_y: 0 },
    { variable_id: "c", map_x: 0, map_y: 0.01 },
    { variable_id: "d", map_x: 10, map_y: 10 },
    { variable_id: "e", map_x: -10, map_y: -10 },
  ];
  assert.deepEqual(candidates.densestNeighborhood(variables, 3).map(variable => variable.variable_id),
    ["a", "b", "c"]);
  const scaled = variables.map(variable => ({
    ...variable, map_x: variable.map_x * 1e-8, map_y: variable.map_y * 1e-8,
  }));
  assert.deepEqual(candidates.densestNeighborhood(scaled, 3).map(variable => variable.variable_id),
    ["a", "b", "c"]);
});
