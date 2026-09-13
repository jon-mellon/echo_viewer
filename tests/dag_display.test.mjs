import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as display from "../site/dag_display.mjs";
import { confounderPathNodeRole } from "../site/dag_graph.mjs";
import { wrapDagLabel } from "../site/dag_layout.mjs";
import { directedGroupLabels } from "../site/dag_exports.mjs";

test("display records preserve node roles, selection, edge styles and descriptions", () => {
  const groups = [
    { group_id: "iv", type: "iv", label: "IV <&", variable_ids: ["a"] },
    { group_id: "dv", type: "dv", label: "DV", variable_ids: ["b"] },
    { group_id: "candidate", label: "A long candidate label with multiple words", variable_ids: ["c", "d"] },
    { group_id: "path", label: "Path", variable_ids: [] },
  ];
  const state = {
    project: { groups, iv_group_id: "iv", dv_group_id: "dv" },
    colliderGroupIds: new Set(["candidate"]), confounderGroupIds: new Set(["candidate"]),
    colliderPathGroupIds: new Set(["path"]), confounderPathGroupIds: new Set(["path"]),
  };
  const legacy = vm.createContext({ state, confounderPathNodeRole, wrapDagLabel,
    groupColor: () => "#123456",
    directedGroupLabels: (link, arrow) => directedGroupLabels(link, groups, arrow),
  });
  vm.runInContext(readFileSync(new URL("./fixtures/legacy_dag_display.js", import.meta.url), "utf8"), legacy);
  const plain = value => JSON.parse(JSON.stringify(value));
  const before = structuredClone(groups);
  for (const mode of ["normal", "confounder", "collider"]) for (const selected of [null, "candidate", "iv"]) {
    state.showCollidersOnly = mode === "collider";
    state.showConfoundersOnly = mode === "confounder";
    state.activeGroupId = selected;
    const view = { ...state, ivId: "iv", dvId: "dv", groupColor: "#123456" };
    for (const group of groups) for (const width of [160, 220]) for (const point of [undefined, { x: 20, y: -10 }]) {
      assert.deepEqual(plain(display.visNodeData(group, point, { nodeMaxWidth: width }, view)),
        plain(legacy.visNodeData(group, point, { nodeMaxWidth: width })));
    }
  }
  for (const direction_type of ["A_TO_B", "B_TO_A", "BIDIRECTIONAL"]) {
    for (const is_manual of [false, true]) for (const is_target_relation of [false, true]) {
      const link = { edge_id: "edge", group_a: "iv", group_b: "dv", direction_type,
        is_manual, is_target_relation, a_to_b_paper_table_keys: ["p1", "p2"], b_to_a_paper_table_keys: ["p2"] };
      for (const selected of [null, "edge"]) {
        state.selectedEdgeId = selected;
        assert.deepEqual(plain(display.edgeVisualData(link, selected)), plain(legacy.edgeVisualData(link)));
      }
      assert.equal(display.edgeHoverText(link, groups), legacy.edgeHoverText(link));
      link.a_to_b_paper_table_keys = [];
      link.b_to_a_paper_table_keys = [];
      assert.equal(display.edgeHoverText(link, groups), legacy.edgeHoverText(link));
    }
  }
  assert.deepEqual(groups, before);
});
