import test from "node:test";
import assert from "node:assert/strict";
import { createDagAppState } from "../site/dag_app_state.mjs";
import { createDagExportController } from "../site/dag_export_controller.mjs";
import { createDagInspectorController } from "../site/dag_inspector_controller.mjs";
import { createDagProjectController } from "../site/dag_project_controller.mjs";
import { dag2AnchorPickerIsActive } from "../site/dag_setup_group_controller.mjs";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("application state instances do not share mutable collections", () => {
  const first = createDagAppState(), second = createDagAppState();
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
  restored.changingAnchorSide = "iv";
  assert.equal(dag2AnchorPickerIsActive(restored, "iv", groupById), true);
  assert.equal(dag2AnchorPickerIsActive(restored, "dv", groupById), false);
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
