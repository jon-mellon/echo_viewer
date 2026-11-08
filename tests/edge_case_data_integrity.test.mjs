import assert from "node:assert/strict";
import test from "node:test";
import { addMembers, restoreSnapshot, snapshotProject } from "../site/dag_project.mjs";
import { groupNeighborSuggestions } from "../site/dag_search.mjs";
import { buildLinksTable, collectAllDagDois } from "../site/dag_exports.mjs";

const project = () => ({
  groups: [
    { group_id: "a", label: "A", variable_ids: ["v1"], updated_at: "old" },
    { group_id: "b", label: "B", variable_ids: ["v2"], updated_at: "old" },
    { group_id: "c", label: "C", updated_at: "old" },
  ],
  link_decisions: {},
});

test("addMembers leaves untouched groups unchanged and tolerates a missing member list", () => {
  const before = project();
  const next = addMembers(before, "c", ["v1"], "new");
  assert.deepEqual(next.groups.find(g => g.group_id === "c").variable_ids, ["v1"]);
  assert.equal(next.groups.find(g => g.group_id === "a").variable_ids.length, 0);
  assert.equal(next.groups.find(g => g.group_id === "b"), before.groups[1]);
});

test("restoreSnapshot defaults missing link decisions", () => {
  const base = project();
  const json = JSON.stringify({ groups: base.groups, phase: "build" });
  assert.deepEqual(restoreSnapshot(base, json).project.link_decisions, {});
  assert.ok(snapshotProject({ ...base, decisions: [] }, "build"));
});

test("neighbour suggestions survive a group without members and a missing similarity", () => {
  const opts = { variableById: new Map(), blockedIds: new Set(), clusterMemberIds: id => [id] };
  assert.deepEqual(groupNeighborSuggestions({ group_id: "x" }, opts, 5), []);
  const v = new Map([["v1", { similarity_neighbors: [
    { variable_id: "n1" }, { variable_id: "n2", cosine_similarity: 0.5 }] }],
  ["n1", {}], ["n2", {}]]);
  const out = groupNeighborSuggestions({ variable_ids: ["v1"] }, { ...opts, variableById: v }, 5);
  assert.deepEqual(out.map(n => n.variable_id), ["n2", "n1"]);
});

test("markdown link table escapes pipes and tolerates links without raw ids", () => {
  const input = {
    visibleLinks: [{ group_a: "a", group_b: "b", direction_type: "A_TO_B" }],
    project: { groups: [{ group_id: "a", label: "Left | right" }, { group_id: "b", label: "B" }] },
    rawLinksById: new Map(),
  };
  const table = buildLinksTable("md", input, new Map());
  assert.match(table, /\| Left \\\| right \| B \|/);
  assert.deepEqual(collectAllDagDois(input), []);
});
