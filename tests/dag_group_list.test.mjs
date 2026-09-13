import test from "node:test";
import assert from "node:assert/strict";
import { buildGroupListModel } from "../site/dag_group_list.mjs";

test("anchors stay pinned; relevance, alphabetical order and ties remain stable", () => {
  const project = { iv_group_id: "iv", dv_group_id: "dv", groups: [
    { group_id: "z", label: "Zulu", variable_ids: ["a", "b"] },
    { group_id: "iv", label: "Zulu anchor", variable_ids: ["x"] },
    { group_id: "tie1", label: "Alpha", variable_ids: [] },
    { group_id: "dv", label: "Alpha anchor", variable_ids: ["y"] },
    { group_id: "tie2", label: "Alpha", variable_ids: ["c"] },
  ] };
  const options = { sort: "relevance", activeGroupId: "z", roleLabels: { known: "Known role" },
    candidateQueue: [{ group_id: "z", roles: ["known", "unknown", "third"] }] };
  const before = structuredClone({ project, options });
  const model = buildGroupListModel(project, options);
  assert.deepEqual(model.rows.map(r => r.groupId), ["dv", "iv", "z", "tie1", "tie2"]);
  assert.equal(model.countText, "5 groups");
  assert.deepEqual(model.rows[2], { groupId: "z", label: "Zulu", variableCount: 2,
    isActive: true, roleLabels: ["Known role", "unknown"], anchorLabel: "" });
  assert.equal(model.rows[0].anchorLabel, "DV");
  assert.equal(model.rows[1].anchorLabel, "IV");
  assert.equal(model.rows[3].variableCount, 0);
  assert.deepEqual(buildGroupListModel(project, { ...options, sort: "alpha" }).rows.map(r => r.groupId),
    ["dv", "iv", "tie1", "tie2", "z"]);
  assert.deepEqual({ project, options }, before);
});

test("empty, single and unranked lists retain counts and label fallbacks", () => {
  const options = { candidateQueue: [], sort: "relevance", roleLabels: {} };
  assert.deepEqual(buildGroupListModel({ groups: [] }, options), { countText: "0 groups", rows: [] });
  const model = buildGroupListModel({ groups: [{ group_id: "g", label: "", variable_ids: [] }] }, options);
  assert.equal(model.countText, "1 group");
  assert.equal(model.rows[0].label, "g");
  assert.deepEqual(model.rows[0].roleLabels, []);
});
