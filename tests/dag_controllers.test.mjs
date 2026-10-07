import test from "node:test";
import assert from "node:assert/strict";
import { createDagAppState } from "../site/dag_app_state.mjs";
import { createDagExportController, MAX_REFERENCE_ENRICHMENTS,
  referenceEnrichmentRequests } from "../site/dag_export_controller.mjs";
import { buildBibText, METHOD_DOI } from "../site/dag_exports.mjs";
import { createDagInspectorController } from "../site/dag_inspector_controller.mjs";
import { createDagProjectController } from "../site/dag_project_controller.mjs";
import { dag2AnchorPickerIsActive } from "../site/dag_setup_group_controller.mjs";
import { createDagGroupEditorController } from "../site/dag_group_editor_controller.mjs";
import { createGroupingSetController } from "../site/grouping_set_controller.mjs";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("application state instances do not share mutable collections", () => {
  const first = createDagAppState(), second = createDagAppState();
  assert.equal(first.showConfoundersOnly, true);
  assert.equal(first.showCollidersOnly, false);
  first.seeds.iv.add("v1"); first.map.transform.scale = 3;
  assert.deepEqual([...second.seeds.iv], []);
  assert.equal(second.map.transform.scale, 1);
});

test("DAG2 anchor picker follows missing anchors even when restored workflow flags are stale", () => {
  const groups = new Map([
    ["iv", { group_id: "iv", variable_ids: ["x"] }],
    ["dv", { group_id: "dv", variable_ids: ["y"] }],
  ]);
  const groupById = id => groups.get(id) || null;
  const restored = {
    interfaceMode: "dag2", workflowMode: "group_review", phase: "build",
    project: { iv_group_id: null, dv_group_id: null }, changingAnchorSide: null,
  };
  assert.equal(dag2AnchorPickerIsActive(restored, "iv", groupById), true);
  assert.equal(dag2AnchorPickerIsActive(restored, "dv", groupById), false);
  restored.project.iv_group_id = "iv";
  assert.equal(dag2AnchorPickerIsActive(restored, "iv", groupById), false);
  assert.equal(dag2AnchorPickerIsActive(restored, "dv", groupById), true);
  restored.project.dv_group_id = "dv";
  restored.changingAnchorSide = "instrument";
  assert.equal(dag2AnchorPickerIsActive(restored, "instrument", groupById), true);
  assert.equal(dag2AnchorPickerIsActive(restored, "iv", groupById), false);
  assert.equal(dag2AnchorPickerIsActive(restored, "dv", groupById), false);
  restored.changingAnchorSide = "iv";
  assert.equal(dag2AnchorPickerIsActive(restored, "iv", groupById), true);
  assert.equal(dag2AnchorPickerIsActive(restored, "dv", groupById), false);
  assert.equal(dag2AnchorPickerIsActive(restored, "instrument", groupById), false);
});

test("a permalink keeps its restored anchors while published memberships hydrate", () => {
  const groups = new Map([
    ["iv", { group_id: "iv", variable_ids: [], member_count: 12 }],
    ["dv", { group_id: "dv", variable_ids: [], member_count: 8 }],
  ]);
  const state = {
    project: { iv_group_id: "iv", dv_group_id: "dv" },
    publishedSchemaHydrating: true,
    changingAnchorSide: null,
  };
  const groupById = id => groups.get(id) || null;
  assert.equal(dag2AnchorPickerIsActive(state, "iv", groupById), false);
  assert.equal(dag2AnchorPickerIsActive(state, "dv", groupById), false);
  state.publishedSchemaHydrating = false;
  assert.equal(dag2AnchorPickerIsActive(state, "iv", groupById), true);
});

test("DAG2 advances after the second anchor is selected", () => {
  const state = {
    interfaceMode: "dag2", workflowMode: "setup", phase: "select_dv", changingAnchorSide: null,
    project: {
      iv_group_id: "iv", dv_group_id: null,
      groups: [
        { group_id: "iv", type: "iv", label: "Exposure", variable_ids: ["x"] },
        { group_id: "dv", type: null, label: "Outcome", variable_ids: ["y"] },
      ],
    },
  };
  const groupById = id => state.project.groups.find(group => group.group_id === id);
  let advances = 0;
  const controller = createDagGroupEditorController({
    state, elements: {}, groupById, takeSnapshot: () => ({}), nowIso: () => "2026-09-29T00:00:00Z",
    clean: value => value, applyProjectOperation: project => { state.project = project; },
    setMapMode() {}, addDecision() {}, addToUndoHistory() {}, fitMap() {}, renderAll() {},
    onAnchorsReady: () => { advances += 1; },
  });

  controller.assignGroupAsAnchor("dv", "dv");

  assert.equal(state.project.dv_group_id, "dv");
  assert.equal(state.phase, "build");
  assert.equal(advances, 1);
});

test("untouched published schema does not gain an empty hidden-variable field", () => {
  const schema = {
    schema_version: "groupings-v3", grouping_set_id: "published", label: "Published",
    description: "Fixture", membership_unit: "canonical_variable",
    cache_compatibility: { record_signature: "records" },
    built_against: { record_signature: "records", snapshot_id: "snapshot" },
    migration_provenance: { source: "fixture" },
    groups: [{ group_id: "g1", label: "Group", notes: "Notes", source: "fixture", variable_ids: ["v1"] }],
    rejected_variables: [],
  };
  const state = {
    data: { grouping_sets: [schema] }, clusterOf: new Map(),
    project: { active_grouping_set_id: "published", groups: schema.groups.map(group => ({ ...group })) },
  };
  const controller = createGroupingSetController({
    state, elements: {}, publicationController: {}, exportController: {},
    rejectedVariableEntries: () => [], rejectedVariableIdSet: () => new Set(),
    applyProjectOperation() {}, normalizeProjectDuplicateAssignments() {}, groupById() {}, nowIso: () => "",
  });
  assert.deepEqual(controller.workingSchema(), schema);
});

test("project controller preserves live group identity and owns history transitions", () => {
  const state = createDagAppState();
  state.data = { generated_at: "fixture", default_grouping_set_id: "none", grouping_sets: [] };
  state.projectStorageVariableCount = 0;
  let renders = 0;
  const controller = createDagProjectController({
    state, storage: memoryStorage(), storagePrefix: "test", nowIso: () => "2026-09-10T00:00:00Z",
    invalidateMapCaches() {}, renderAll: () => renders++, renderUndoRedo() {}, renderActionHistory() {},
  });
  controller.initialize();
  const original = { group_id: "g1", label: "Before", variable_ids: ["v1"] };
  state.project.groups.push(original);
  const before = controller.snapshot();
  controller.applyOperation({ ...state.project, groups: [{ ...original, label: "After" }] });
  assert.equal(state.project.groups[0], original);
  assert.equal(original.label, "After");
  controller.record("rename", before);
  controller.undo();
  assert.equal(state.project.groups[0].label, "Before");
  assert.equal(renders, 1);
});

test("edge-decision undo and redo refresh only links; group edits still rebuild", () => {
  const state = createDagAppState();
  state.data = { generated_at: "fixture", default_grouping_set_id: "none", grouping_sets: [] };
  const calls = [];
  const controller = createDagProjectController({
    state, storage: memoryStorage(), storagePrefix: "test", nowIso: () => "2026-09-10T00:00:00Z",
    invalidateMapCaches: () => calls.push("invalidate"),
    renderAll: () => calls.push("full"),
    rebuildLinkDecision: () => calls.push("links"),
    renderUndoRedo() {}, renderActionHistory() {},
  });
  controller.initialize();
  const beforeDecision = controller.snapshot();
  state.project.link_decisions.edge = { display_status: "excluded" };
  controller.record("Excluded edge", beforeDecision, "link-decision");
  controller.undo();
  assert.deepEqual(state.project.link_decisions, {});
  controller.redo();
  assert.equal(state.project.link_decisions.edge.display_status, "excluded");
  assert.deepEqual(calls, ["links", "links"]);

  const beforeGroup = controller.snapshot();
  state.project.groups.push({ group_id: "g", variable_ids: ["v"] });
  controller.record("Added group", beforeGroup);
  controller.undo();
  assert.deepEqual(calls.slice(-2), ["invalidate", "full"]);
});

test("autosave coalesces edits and flushes the latest project on page hide", () => {
  const state = createDagAppState();
  state.data = { generated_at: "fixture", default_grouping_set_id: "none", grouping_sets: [] };
  state.projectStorageVariableCount = 0;
  const writes = [];
  const listeners = new Map();
  const lifecycleTarget = {
    addEventListener(name, listener) { listeners.set(name, listener); },
    document: { visibilityState: "visible" },
  };
  const controller = createDagProjectController({
    state, storage: { setItem(key, value) { writes.push({ key, value }); } },
    storagePrefix: "test", nowIso: () => "2026-09-10T00:00:00Z",
    invalidateMapCaches() {}, renderAll() {}, renderUndoRedo() {}, renderActionHistory() {},
    lifecycleTarget,
  });
  controller.initialize();
  state.project.project_id = "first";
  controller.save();
  state.project.project_id = "latest";
  controller.save();
  assert.equal(writes.length, 0);
  listeners.get("pagehide")();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].value).project_id, "latest");
  controller.save();
  lifecycleTarget.document.visibilityState = "hidden";
  listeners.get("visibilitychange")();
  assert.equal(writes.length, 2);
});

test("export controller snapshots mutable viewer data at its boundary", () => {
  const state = createDagAppState();
  state.data = { cache_compatibility: { fingerprint: "fixture" } };
  state.project = { groups: [{ group_id: "g", label: "Before" }] };
  const controller = createDagExportController({
    state, elements: { exportBib: {}, exportMd: {}, exportTex: {} },
    rejectedVariableEntries: () => [], rejectedVariableIdSet: () => new Set(),
    projectPayload: () => ({}), aggregateGroupLinks() {}, computeVisibleLinks() {}, nowIso: () => "",
  });
  const captured = controller.captureInput();
  state.project.groups[0].label = "After";
  assert.equal(captured.project.groups[0].label, "Before");
});

test("large bibliography exports retain every DOI while bounding metadata requests", () => {
  const dois = Array.from({ length: 2107 }, (_, index) => `10.1234/paper-${index}`);
  const requested = referenceEnrichmentRequests(dois);
  assert.equal(requested[0], METHOD_DOI);
  assert.ok(requested.length <= MAX_REFERENCE_ENRICHMENTS + 1);
  const bibliography = buildBibText(dois, new Map()).bibText;
  assert.match(bibliography, /10\.1234\/paper-2106/);
});

test("export controller waits for lazy evidence before taking its snapshot", async () => {
  const state = createDagAppState();
  state.data = { cache_compatibility: {} };
  state.project = { groups: [] };
  state.visibleLinks = [{ a_to_b_raw_link_ids: ["r1"] }];
  let release;
  const evidenceReady = new Promise(resolve => { release = resolve; });
  const controller = createDagExportController({
    state, elements: { exportBib: {}, exportMd: {}, exportTex: {} },
    rejectedVariableEntries: () => [], rejectedVariableIdSet: () => new Set(),
    projectPayload: () => ({}), aggregateGroupLinks() {}, computeVisibleLinks() {}, nowIso: () => "",
    ensureEvidenceLoaded: async () => {
      await evidenceReady;
      state.rawLinksById.set("r1", { raw_causal_link_id: "r1", paper_id: "10.1234/loaded" });
    },
  });
  let settled = false;
  const pending = controller.prepareExportInput().then(input => { settled = true; return input; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  const input = await pending;
  assert.equal(input.rawLinksById.get("r1").paper_id, "10.1234/loaded");
});

test("document export stops before evidence loading when no public permalink is available", async () => {
  const state = createDagAppState();
  state.data = { cache_compatibility: {} };
  state.project = { groups: [] };
  let evidenceLoads = 0;
  const controller = createDagExportController({
    state, elements: { exportBib: {}, exportMd: {}, exportTex: {} },
    rejectedVariableEntries: () => [], rejectedVariableIdSet: () => new Set(),
    projectPayload: () => ({}), aggregateGroupLinks() {}, computeVisibleLinks() {}, nowIso: () => "",
    getPublicPermalink: async () => null,
    ensureEvidenceLoaded: async () => { evidenceLoads += 1; },
  });
  await controller.exportMd();
  assert.equal(evidenceLoads, 0);
});

test("inspector controller resolves selected edges without owning graph state", () => {
  const state = createDagAppState();
  state.project = { links: [{ edge_id: "e1" }] }; state.selectedEdgeId = "e1";
  const controller = createDagInspectorController({ state, elements: {} });
  assert.equal(controller.selectedEdge(), state.project.links[0]);
});
