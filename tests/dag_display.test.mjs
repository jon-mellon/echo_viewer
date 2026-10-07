import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as display from "../site/dag_display.mjs";
import { confounderPathNodeRole } from "../site/dag_graph.mjs";
import { wrapDagLabel } from "../site/dag_layout.mjs";
import { directedGroupLabels } from "../site/dag_exports.mjs";
import { studyDesignEdgeData } from "../site/dag_study_edges.mjs";
import { STUDY_DESIGN_EDGE_ID, STUDY_INSTRUMENT_EDGE_ID } from "../site/dag_inspector_controller.mjs";

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
    for (const is_target_relation of [false, true]) {
      const link = { edge_id: "edge", group_a: "iv", group_b: "dv", direction_type,
        is_target_relation,
        a_to_b_raw_link_ids: ["test-1", "test-2"], b_to_a_raw_link_ids: ["test-2", "test-3"],
        a_to_b_paper_table_keys: ["p1", "p2"], b_to_a_paper_table_keys: ["p2"] };
      for (const selected of [null, "edge"]) {
        state.selectedEdgeId = selected;
        assert.deepEqual(plain(display.edgeVisualData(link, selected)), plain(legacy.edgeVisualData(link)));
      }
      const hover = display.edgeHoverText(link, groups);
      assert.match(hover, /Supporting tests: 3$/);
      assert.doesNotMatch(hover, /Papers\/tables:|p1|p2/);
      link.a_to_b_paper_table_keys = [];
      link.b_to_a_paper_table_keys = [];
      assert.equal(display.edgeHoverText(link, groups), hover);
    }
  }
  assert.deepEqual(groups, before);
});

test("edge descriptions use singular supporting-test grammar and tolerate missing evidence arrays", () => {
  const groups = [
    { group_id: "a", label: "A" },
    { group_id: "b", label: "B" },
  ];
  const base = { group_a: "a", group_b: "b", direction_type: "A_TO_B" };
  assert.match(display.edgeHoverText({ ...base, a_to_b_raw_link_ids: ["only"] }, groups), /Supporting test: 1$/);
  assert.match(display.edgeHoverText(base, groups), /Supporting tests: 0$/);
});

test("paper/table labels omit missing internal key parts", () => {
  assert.equal(display.displayPaperTableKey("10.1000/example::unknown"), "10.1000/example");
  assert.equal(display.displayPaperTableKey("unknown::table-2"), "Occurrence table-2");
  assert.equal(display.displayPaperTableKey("unknown::unknown"), "");
});

test("selected instrument adds a matching study link alongside the existing IV to DV link", () => {
  const groups = ["z", "iv", "dv"].map(group_id => ({ group_id }));
  const project = { instrument_group_id: "z", iv_group_id: "iv", dv_group_id: "dv", links: [] };
  const edges = studyDesignEdgeData(groups, project);
  assert.deepEqual(edges.map(({ id, from, to }) => ({ id, from, to })), [
    { id: STUDY_DESIGN_EDGE_ID, from: "iv", to: "dv" },
    { id: STUDY_INSTRUMENT_EDGE_ID, from: "z", to: "iv" },
  ]);
  assert.equal(edges[0].color.color, edges[1].color.color);
  assert.equal(edges[0].width, edges[1].width);
  assert.equal(studyDesignEdgeData(groups, { ...project, instrument_group_id: null }).length, 1);
});

test("exogeneity colors common causes while keeping the three study anchors", () => {
  const view = {
    showExogeneity: true, instrumentId: "z", ivId: "iv", dvId: "dv",
    exogeneityGroupIds: new Set(["common"]),
    exogeneityPathGroupIds: new Set(["common", "via", "z", "iv", "dv"]),
    groupColor: "#123456",
  };
  const group = (group_id, type = "candidate") => ({ group_id, type, label: group_id, variable_ids: [] });
  const candidate = display.visNodeData(group("common"), null, {}, view);
  const mediator = display.visNodeData(group("via"), null, {}, view);
  const instrument = display.visNodeData(group("z"), null, {}, view);
  const iv = display.visNodeData(group("iv", "iv"), null, {}, view);
  assert.equal(candidate.color.background, "#c62828");
  assert.equal(mediator.color.background, "#6b7280");
  assert.equal(instrument.color.background, "#166534");
  assert.equal(iv.color.background, "#123456");
  assert.equal(instrument.shape, "ellipse");
});
