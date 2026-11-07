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
  // Colours, fonts, hover behaviour and shadows are restyled; geometry and text are not.
  const geometry = ({ color, font, chosen, shadow, shapeProperties, borderWidth, borderWidthSelected, title, ...rest }) => rest;
  const before = structuredClone(groups);
  for (const mode of ["normal", "confounder", "collider"]) for (const selected of [null, "candidate", "iv"]) {
    state.showCollidersOnly = mode === "collider";
    state.showConfoundersOnly = mode === "confounder";
    state.activeGroupId = selected;
    const view = { ...state, ivId: "iv", dvId: "dv", groupColor: "#123456" };
    if (mode === "confounder") view.colliderGroupIds = new Set();
    if (mode === "collider") view.confounderGroupIds = new Set();
    for (const group of groups) for (const width of [160, 220]) for (const point of [undefined, { x: 20, y: -10 }]) {
      const node = display.visNodeData(group, point, { nodeMaxWidth: width }, view);
      assert.deepEqual(plain(geometry(node)), plain(geometry(legacy.visNodeData(group, point, { nodeMaxWidth: width }))));
      assert.equal(node.title, undefined);
      assert.equal(node.chosen.label, false);
      assert.equal(typeof node.chosen.node, "function");
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
        const visual = display.edgeVisualData(link, selected);
        const old = legacy.edgeVisualData(link);
        assert.equal(visual.width, old.width);
        assert.equal(visual.dashes, old.dashes);
        assert.equal(visual.color.opacity, selected || link.is_target_relation ? 1 : display.PLAIN_EDGE_OPACITY);
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

test("controlled and design-addressed confounders have a lighter fill in every interaction state", () => {
  const group = { group_id: "c", label: "Confounder", variable_ids: ["v"] };
  const view = { showConfoundersOnly: true, confounderGroupIds: new Set(["c"]),
    confounderPathGroupIds: new Set(), ivId: "iv", dvId: "dv", groupColor: "#123456" };
  const node = status => display.visNodeData(group, null, {}, { ...view, confounderStatus: status });
  const normal = node("unaddressed").color.background;
  const lighter = display.mixHex(display.OKABE_ITO.vermillion, "#ffffff", 0.8);
  for (const status of ["explicitly_controlled", "accounted_for_by_design", "removed_other", "other"]) {
    const styled = node(status);
    assert.equal(styled.color.background, lighter);
    assert.equal(styled.color.highlight.background, lighter);
    assert.equal(styled.color.hover.background, lighter);
    assert.notEqual(styled.color.background, normal);
    assert.equal(styled.font.color, node("unaddressed").font.color);
  }
  const colliderView = { ...view, showConfoundersOnly: false, showCollidersOnly: true, colliderGroupIds: new Set(["c"]) };
  assert.equal(display.visNodeData(group, null, {}, { ...colliderView, confounderStatus: "explicitly_controlled" }).color.background,
    display.visNodeData(group, null, {}, colliderView).color.background);
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
  assert.deepEqual(studyDesignEdgeData(groups, project, "causes"), []);
  assert.deepEqual(studyDesignEdgeData(groups, project, "consequences"), []);
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
  assert.equal(candidate.color.background, display.mixHex("#D55E00", "#ffffff", 0.4));
  assert.equal(mediator.color.background, display.mixHex("#999999", "#ffffff", 0.4));
  assert.equal(instrument.color.background, display.mixHex("#009E73", "#ffffff", 0.4));
  assert.equal(iv.color.background, display.mixHex("#123456", "#ffffff", 0.4));
  assert.equal(instrument.shape, "ellipse");
});

test("group centroid skips cold membership scans and retains duplicate-representative weighting", async () => {
  const { groupMapCentroid } = await import("../site/dag_display.mjs");
  const group = { variable_ids: ["copy", "v1", "v2", "missing"] };
  const empty = new Map();
  let representativesVisited = 0;
  assert.deepEqual(groupMapCentroid(group, empty, id => { representativesVisited++; return id; }), { x: 0, y: 0 });
  assert.equal(representativesVisited, 0);
  const variables = new Map([["v1", { map_x: 3, map_y: 6 }], ["v2", { map_x: 9 }]]);
  assert.deepEqual(groupMapCentroid(group, variables, id => id === "copy" ? "v1" : id), { x: 5, y: 4 });
});


test("overlapping diagnostic roles get a dashed border in the opposite role colour", () => {
  const group = { group_id: "both", label: "Both", variable_ids: [] };
  const base = { confounderGroupIds: new Set(["both"]), colliderGroupIds: new Set(["both"]),
    confounderPathGroupIds: new Set(), colliderPathGroupIds: new Set(), groupColor: "#123456" };
  for (const [mode, role] of [["showConfoundersOnly", "#CC79A7"], ["showCollidersOnly", "#D55E00"]]) {
    const color = display.mixHex(role, "#000000", 0.35);
    const node = display.visNodeData(group, null, {}, { ...base, [mode]: true, activeGroupId: "both" });
    assert.equal(node.color.border, color);
    assert.equal(node.color.highlight.border, color);
    assert.equal(node.color.hover.border, color);
    assert.equal(node.borderWidth, 1.5);
    assert.deepEqual(node.shapeProperties.borderDashes, [4, 3]);
  }
  const plain = display.visNodeData(group, null, {}, { ...base, activeGroupId: "other" });
  assert.equal(plain.shapeProperties, undefined);
  assert.equal(plain.color.border, plain.color.background);
  assert.equal(plain.color.highlight.border, plain.color.background);
});

test("hovering a node colours its border without changing its size", () => {
  const hover = display.chosenNodeHover("#0072B2");
  const values = { borderWidth: 2.4, borderColor: "#fbfcfa", color: "#cce3f0" };
  hover(values, "n", false, true);
  assert.equal(values.borderWidth, 2.4);
  assert.equal(values.borderColor, "#0072B2");
  assert.equal(values.color, "#cce3f0");
  const selected = { borderWidth: 2.4, borderColor: "#cce3f0", color: "#cce3f0" };
  hover(selected, "n", true, true);
  assert.equal(selected.borderColor, "#0072B2");
  const idle = { borderColor: "#cce3f0" };
  hover(idle, "n", false, false);
  assert.equal(idle.borderColor, "#cce3f0");
});

test("labels break at slashes as well as spaces", () => {
  assert.equal(wrapDagLabel("Alpha/Beta gamma", 8), "Alpha /\nBeta\ngamma");
  assert.equal(wrapDagLabel("Income / wealth", 40), "Income / wealth");
});
