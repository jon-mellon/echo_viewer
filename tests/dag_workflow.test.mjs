import test from "node:test";
import assert from "node:assert/strict";
import { transition, missingAnchorWorkflow } from "../site/dag_workflow.mjs";
import { prepareLoadedProject } from "../site/project_persistence.mjs";
import { buildGroupEditorModel } from "../site/dag_group_editor.mjs";

test("editor display preserves member order, fallbacks and setup-only anchor action", () => {
  const group = { type: "dv", variable_ids: ["v", "missing"], label: "Outcome" };
  const context = { variables: new Map([["v", { display_label: "Variable", raw_variable_text: "Raw" }]]),
    workflowMode: "setup", phase: "define_dv" };
  const before = structuredClone(group);
  const model = buildGroupEditorModel(group, context);
  assert.equal(model.title, "Dependent variable group");
  assert.equal(model.choosingAnchor, true);
  assert.equal(model.anchorButtonLabel, "Use as DV");
  assert.equal(model.notes, "");
  assert.deepEqual(model.members, [
    { variableId: "v", label: "Variable", title: "Raw" },
    { variableId: "missing", label: "missing", title: "" },
  ]);
  assert.equal(buildGroupEditorModel(group, { ...context, workflowMode: "group_review" }).choosingAnchor, false);
  assert.equal(buildGroupEditorModel(null, context), null);
  assert.deepEqual(group, before);
});

test("focus, open, review and import transitions preserve their distinct behavior", () => {
  const state = { phase: "select_iv", workflowMode: "setup", activeGroupId: "old", focusedGroupId: "old" };
  assert.deepEqual(transition(state, { type: "focus-group", groupId: "new" }), { focusedGroupId: "new" });
  assert.deepEqual(transition(state, { type: "open-editor", groupId: "new" }),
    { activeGroupId: "new", focusedGroupId: "new" });
  assert.deepEqual(transition(state, { type: "review-group", groupId: "new" }),
    { workflowMode: "group_review", activeGroupId: "new", focusedGroupId: "new" });
  assert.equal(step(state, { type: "grouping-imported", groupId: "new", anchorsReady: false }).phase, "select_iv");
  assert.equal(step(state, { type: "grouping-imported", groupId: "new", anchorsReady: true }).phase, "build");
  assert.deepEqual(transition(state, { type: "clear-editor" }), { activeGroupId: null, focusedGroupId: null });
  assert.deepEqual(transition(state, { type: "reset-uoa" }), { selectedUoa: null, uoaFilterEnabled: true, phase: "select_uoa" });
});

const step = (state, event) => ({ ...state, ...transition(state, event) });
test("initial setup proceeds UOA → DV editor → IV editor → schema → review", () => {
  let state = { workflowMode: "setup", phase: "select_uoa" };
  state = step(state, { type: "uoa", uoa: "people" });
  assert.equal(state.phase, "select_dv");
  state = step(state, { type: "open-editor", side: "dv", groupId: "d" });
  assert.equal(state.phase, "define_dv");
  state = step(state, { type: "anchor-selected", side: "dv", groupId: "d", fromEditor: true });
  assert.equal(state.phase, "select_iv");
  assert.equal(state.activeGroupId, null);
  state = step(state, { type: "open-editor", side: "iv", groupId: "i" });
  state = step(state, { type: "anchor-selected", side: "iv", groupId: "i", fromEditor: true });
  assert.equal(state.phase, "schema_choice");
  state = step(state, { type: "finish-schema" });
  assert.equal(state.workflowMode, "group_review");
  assert.equal(state.phase, "build");
});

test("DAG2 setup proceeds IV → DV → optional UOA without a schema-choice step", () => {
  let state = { interfaceMode: "dag2", workflowMode: "setup", phase: "select_iv" };
  state = step(state, { type: "anchor-selected", side: "iv", groupId: "i" });
  assert.equal(state.phase, "select_dv");
  assert.equal(state.workflowMode, "setup");
  state = step(state, { type: "anchor-selected", side: "dv", groupId: "d" });
  assert.equal(state.phase, "build");
  assert.equal(state.workflowMode, "group_review");
  state = step(state, { type: "uoa", uoa: "person", nextPhase: "build" });
  assert.equal(state.phase, "build");
  assert.equal(state.selectedUoa, "person");
  state = step(state, { type: "reset-uoa", nextPhase: "build", filterEnabled: false });
  assert.equal(state.phase, "build");
  assert.equal(state.selectedUoa, null);
  assert.equal(state.uoaFilterEnabled, false);
});

test("anchor replacement clears only that side and confirmation returns to review", () => {
  const initial = {
    workflowMode: "group_review", phase: "build", changingAnchorSide: null,
    seeds: { iv: new Set(["x"]), dv: new Set(["y"]) },
    anchorSearchMode: { iv: "new", dv: "existing" }, searchMatches: { iv: ["x"], dv: ["y"] },
  };
  const state = step(initial, { type: "change-anchor", side: "iv", groupId: "old" });
  assert.equal(state.phase, "select_iv");
  assert.equal(state.focusedGroupId, "old");
  assert.equal(state.seeds.iv.size, 0);
  assert.deepEqual([...initial.seeds.iv], ["x"]);
  assert.deepEqual([...state.seeds.dv], ["y"]);
  const replacement = step(state, { type: "anchor-selected", side: "iv", groupId: "new", fromEditor: true });
  assert.equal(replacement.phase, "build");
  assert.equal(replacement.changingAnchorSide, null);
  assert.equal(replacement.focusedGroupId, "new");
  assert.equal(step(state, { type: "mode", mode: "group_review" }).changingAnchorSide, null);
});

test("closing an unfinished editor returns to its picker; missing schema anchors reset setup", () => {
  assert.deepEqual(transition({ phase: "define_dv" }, { type: "close-editor" }),
    { phase: "select_dv", activeGroupId: null, focusedGroupId: null });
  const loaded = prepareLoadedProject({
    schema_version: "dag-builder-project-v1", groups: [], phase: "build",
    workflowMode: "group_review", selectedUoa: "people",
  }, { defaults: {}, currentLayoutSource: "", schema: { grouping_set_id: "s", groups: [] },
    clusterOf: new Map(), clusterMembers: new Map() });
  assert.equal(loaded.phase, missingAnchorWorkflow("people").phase);
  assert.equal(loaded.workflowMode, "setup");
});
