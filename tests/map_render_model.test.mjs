import test from "node:test";
import assert from "node:assert/strict";
import { createDagMapUiController } from "../site/dag_map_ui_controller.mjs";
import {
  buildMapPointModels,
  computePaletteAssignment,
  estimateLabelSize,
  importantMapVariables,
  labelPriority,
  mapLabelClasses,
  shouldShowVariableLabel,
  variableVisualStatus,
} from "../site/map_render_model.mjs";

const colors = { iv: "#315f9d", dv: "#9b5c2e", assigned: "#1f7a67", active: "#b83b5e" };
const palette = ["#0f766e", "#9f1239", "#1d4ed8"];
const identity = (x, y) => ({ x, y });

test("actual point renderer applies unassigned, assigned and UOA opacity", () => {
  const variables = [
    { variable_id: "a", map_x: 10, map_y: 20, uoa: "x" },
    { variable_id: "b", map_x: 30, map_y: 20, uoa: "x" },
    { variable_id: "c", map_x: 50, map_y: 20, uoa: "y" },
  ];
  const fills = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, arc() {}, stroke() {},
    fill() { fills.push(this.globalAlpha); },
  };
  const controller = createDagMapUiController({
    state: {
      project: { groups: [{ group_id: "g", variable_ids: ["b"] }] },
      map: { transform: { scale: 1, tx: 0, ty: 0 } },
      selectedVariableIds: new Set(), uoaFilterEnabled: true, selectedUoa: "x",
    },
    elements: {}, beginDraw() {}, canvasWidth: () => 100, canvasHeight: () => 100,
    visibleClusterReps: () => variables, worldToScreen: identity,
    clusterRep: id => id, uoaMatches: (a, b) => a === b,
    groupColors: colors, groupPalette: palette,
  });
  controller.drawMapPoints(ctx, 100, 100);
  assert.deepEqual(fills, [0.46, 0.88, 0.10]);
});

test("visual status preserves group precedence and palette assignment is deterministic", () => {
  const groups = [
    { group_id: "iv", type: "iv", variable_ids: ["a"] },
    { group_id: "assigned", type: "custom", variable_ids: ["b"] },
  ];
  assert.equal(variableVisualStatus("a", groups, null), "iv");
  assert.equal(variableVisualStatus("b", groups, "assigned"), "active");
  assert.equal(variableVisualStatus("c", groups, null), "unassigned");
  assert.deepEqual(
    [...computePaletteAssignment(groups, [{ variable_id: "b", map_x: 0, map_y: 0 }], palette).entries()],
    [["assigned", 0]],
  );
  assert.deepEqual([...computePaletteAssignment(groups, [], palette).entries()], []);
});

test("point models contain visual decisions without canvas state", () => {
  const variables = [{ variable_id: "a", map_x: 10, map_y: 20, cluster_size: 4, uoa: "x" }];
  const points = buildMapPointModels({
    variables,
    groups: [],
    activeGroupId: null,
    selectedVariableId: "a",
    selectedVariableIds: new Set(),
    hoveredVariableId: null,
    clusterRep: (id) => id,
    worldToScreen: identity,
    transform: {},
    width: 100,
    height: 100,
    uoaFilterEnabled: true,
    selectedUoa: "y",
    uoaMatches: () => false,
    variableColorForStatus: (status) => ({ unassigned: "gray" }[status]),
  });
  assert.deepEqual(
    points.map(({ variable, screen, status, selected, uoaMatch, merged, radius, color }) => ({
      id: variable.variable_id, screen, status, selected, uoaMatch, merged, radius, color,
    })),
    [{ id: "a", screen: { x: 10, y: 20 }, status: "unassigned", selected: true, uoaMatch: false, merged: true, radius: 5.8 + 1.6 * Math.sqrt(3), color: "gray" }],
  );
});

test("important labels and label metadata remain pure", () => {
  const variable = { variable_id: "a", is_cluster_rep: true, map_x: 5, map_y: 6, similarity_neighbors: [] };
  const result = importantMapVariables({
    variables: [variable],
    variableById: new Map([["a", variable]]),
    groups: [],
    activeGroupId: null,
    focusedGroupId: null,
    seeds: { iv: ["a"], dv: [] },
    searchMatches: { iv: [], dv: [] },
    selectedVariableId: null,
    selectedVariableIds: new Set(),
    hoveredVariableId: null,
    visibleVarCount: 10,
    width: 100,
    height: 100,
    transform: {},
    phase: "select_uoa",
    isRejectedVariable: () => false,
    clusterRep: (id) => id,
    clusterMemberIds: () => ["a"],
    worldToScreen: identity,
  });
  assert.equal(result[0].isSeed, true);
  assert.equal(labelPriority(result[0]), 17);
  assert.equal(mapLabelClasses(result[0]), "seed");
  assert.deepEqual(estimateLabelSize("hello", 100, result[0]), { w: 54, h: 24 });
});

test("assigned variable labels become visible when zoom leaves few variables in view", () => {
  const ordinary = { isHovered: false, isSelected: false, isActive: false };
  assert.equal(shouldShowVariableLabel(ordinary, { isAssigned: true, fewVisible: false }), false);
  assert.equal(shouldShowVariableLabel(ordinary, { isAssigned: true, fewVisible: true }), true);
});
