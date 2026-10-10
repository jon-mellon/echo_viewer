"use strict";

import * as projectOps from "/dag_project.mjs";
import { aggregateGroupLinks as deriveGroupLinks, rawLinksBetween as lookupRawLinks,
  paperTableKeys as lookupPaperTableKeys, applyLinkDecisions, linkKey, pairKey } from "/dag_link_aggregation.mjs";

import * as exportData from "/dag_exports.mjs";
import { createDagExportController } from "/dag_export_controller.mjs";
import { renderDagPng } from "/dag_export_image.mjs";
import * as mapGeometry from "/map_geometry.mjs";
import { createRenderCoordinator } from "/render_coordinator.mjs";
import * as candidates from "/dag_candidates.mjs";
import * as inspector from "/dag_inspector.mjs";
import * as searchModel from "/dag_search.mjs";
import * as workflow from "/dag_workflow.mjs";
import * as visibility from "/variable_visibility.mjs";
import { createDagAppState } from "/dag_app_state.mjs";
import { createDagProjectController } from "/dag_project_controller.mjs";
import { createDagInspectorController, STUDY_DESIGN_EDGE_ID } from "/dag_inspector_controller.mjs";
import { createDagShellController } from "/dag_shell_controller.mjs";
import { createDagMapViewController } from "/dag_map_view_controller.mjs";
import { createDagMapUiController } from "/dag_map_ui_controller.mjs";
import { createDagSetupGroupController } from "/dag_setup_group_controller.mjs";
import { createDagGroupEditorController } from "/dag_group_editor_controller.mjs";
import { deriveDagView, excludedForConnectivity } from "/dag_view.mjs";
import { createDagNetworkController } from "/dag_network_controller.mjs?v=compiled-first-v2";
import { createDagEventController } from "/dag_event_controller.mjs";
import { createUoaController } from "/uoa_controller.mjs";
import { createToolbarController } from "/toolbar_controller.mjs";
import { createDefinitionWorkflowController } from "/definition_workflow_controller.mjs";
import { createPublicationController } from "/dag_publication.mjs";
import { createGroupingSetController } from "/grouping_set_controller.mjs";
import { createProjectBootstrap } from "/project_bootstrap.mjs?v=compiled-first-v2";
import { dagDataSource } from "/dag_data_source.mjs?v=browser-v2";
import { incrementCompiledDag } from "/compiled_dag.mjs";
import { createPersistentViewer } from "/persistent_viewer.mjs";
import { importDraftFile, makeDraftExport } from "/draft_exchange.mjs";
import { listPreviousSessions } from "/local_schema_store.mjs";
import { escapeHtml } from "/text_utils.mjs";
import { h, replaceChildren, safeUrl, setSafeUrl } from "/dom_builder.mjs";
import { hydrateSearchResult, variableSearchCatalog } from "/variable_search_catalog.mjs";


const ROLE_LABELS = {
  possible_confounder: "Confounder candidate",
  possible_mediator: "Mediator candidate",
  possible_common_consequence_or_collider: "Common consequence",
  other_possible_cause_of_dv: "Other cause of DV",
  other_possible_cause_of_iv: "Other cause of IV",
  near_iv_dv_map_region: "Near IV/DV region",
};

const GROUP_COLORS = {
  iv: "#315f9d",
  dv: "#9b5c2e",
  assigned: "#1f7a67",
  active: "#b83b5e",
};

// Distinct colors for groups (IV and DV use GROUP_COLORS above).
const GROUP_PALETTE = [
  "#0f766e", "#9f1239", "#1d4ed8", "#b45309", "#4d7c0f",
  "#7c3aed", "#be123c", "#0369a1", "#92400e", "#047857",
  "#4338ca", "#c2410c", "#166534", "#a21caf", "#7e22ce",
  "#b91c1c", "#1e40af", "#a16207", "#065f46", "#6d28d9",
  "#0ea5e9", "#ca8a04", "#15803d", "#db2777",
];

// The current interface has one canonical entry point at the site root.
const state = createDagAppState("dag2");
let schemaBatchDepth = 0;
let schemaCommitQueued = false;
const PROJECT_STORAGE_PREFIX = state.interfaceMode === "dag2" ? "dag2-project-v1" : "dag-builder-project-v2";

window.__dagBuilderState = state;

const els = {};

function setStartupStage(message) {
  return projectBootstrap.setStartupStage(message);
}

function finishStartupLoading() {
  return projectBootstrap.finishStartupLoading();
}

function $(id) {
  return document.getElementById(id);
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return clean(value).toLowerCase();
}

function truncate(value, max = 64) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function nowIso() {
  return new Date().toISOString();
}

function initElements() {
  for (const id of [
    // Mode switcher
    "modeSwitcher",
    // Setup section
    "setupSection", "currentStepTitle",
    "dvSearchBlock", "ivSearchBlock", "instrumentSearchBlock",
    "dvInput", "dvInputLabel", "dvDefineNew", "dvSeeds", "dvResults", "dvGroupPicker",
    "ivInput", "ivInputLabel", "ivDefineNew", "ivSeeds", "ivResults", "ivGroupPicker",
    "instrumentInput", "instrumentDefineNew", "instrumentGroupPicker",
    "schemaChoice", "loadSchema", "skipSchema",
    "definitionBlock", "definitionTitle", "definitionCancel", "definitionSourcesStep",
    "definitionSourceSearch", "definitionSourceList", "definitionContinue",
    "definitionPartitionStep", "definitionCounts", "definitionVariableSearch",
    "definitionVariableResults", "definitionSelectedVariables", "definitionAddNeighbors", "definitionNeighborResults",
    "definitionBack", "definitionReview",
    "definitionReviewStep", "definitionNewLabel", "definitionReviewVariables", "definitionResidualLabels",
    "definitionManualReview", "definitionValidation", "definitionReviewBack", "definitionSave",
    "workflowHint", "dagStatusBadge",
    "variablePanel", "variablePanelDisclosure", "variablePanelCount", "variablePanelList", "variablePanelPagination",
    "anchorBar", "anchorDvLabel", "anchorIvLabel", "anchorInstrumentLabel", "instrumentRow", "changeInstrument", "changeDv", "changeIv", "editSplitDv", "editSplitIv", "dag2UndoBtn", "dag2RedoBtn",
    // Group list panel
    "groupListPanel", "groupListSort", "groupList", "groupListCount", "createGroupBtn",
    // Grouping schema
    "groupingPanel", "groupingSetSelect", "exportGroupingFolder", "publishSchema",
    "copyPermalink", "groupingSummary", "publicationStatus", "schemaPublicationBadge",
    "publishedSchemaPermalink", "publishSchemaDialog",
    // Rejected variables
    "rejectedVariablesPanel", "rejectedVariableSearch", "rejectedVariablesList",
    // Map
    "dagMapCanvas", "dagMapTooltip", "dagMapLabels", "variableLayoutSelect", "variableAssignmentCounts",
    "dagMapContextMenu",
    "dagZoomIn", "dagZoomOut", "dagFitView", "toggleVariableLabels", "toggleGroupLabels", "showUnfiltered", "toggleConfoundersOnly", "toggleCollidersOnly", "toggleExclusionViolations", "toggleExogeneity", "confounderPathLength", "toggleBottleneckedConfounders", "toggleIrrelevantConfounderLinks", "showExcludedLinks", "showExcludedFindings", "dagSelectMode", "dagBrushMode", "dagEraseMode", "fullscreenVariableMap",
    "selectionCount",
    // Undo / history
    "undoBtn", "redoBtn", "historyToggle", "actionHistory",
    // Right: group editor
    "groupEditorSection", "groupEditorTitle", "groupEditorHint", "groupDescription", "cancelGroupEdit",
    "discardGroupEdit", "localSaveStatus", "retryLocalSave", "saveIndependentCopy",
    "exportLocalDraft", "importLocalDraft", "previousSessions", "previousSessionsPanel",
    "previousSessionsList",
    "groupLabelInput", "groupNotesInput", "useGroupAsAnchor",
    "zoomGroup", "editSplit",
    "addNeighbors", "removeNeighbors", "clearGroupSelection",
    "groupSeedInput", "groupSeedResults",
    "includedVariables", "neighborSuggestions",
    // Right: DAG workspace
    "dagWorkspaceSection", "dagNetwork",
    "dagSvgZoomIn", "dagSvgZoomOut", "dagSvgFit", "fullscreenDag",
    "edgeInspector", "provenancePanel", "closeEvidencePane",
    // Export
    "exportProject", "exportWorkingMap", "projectImport", "strictDagStatus",
    "exportBib", "exportMd", "exportTex",
    // Panel resizers
    "leftResizer", "rightResizer",
  ]) {
    els[id] = $(id);
  }
  state.map.canvas = els.dagMapCanvas;
  state.map.ctx = state.map.canvas.getContext("2d");
  els.exportLocalDraft?.addEventListener("click", exportLocalDraft);
  els.previousSessions?.addEventListener("click", async () => {
    const panel = els.previousSessionsPanel;
    if (!panel.hidden) {
      panel.hidden = true;
      els.previousSessions.setAttribute("aria-expanded", "false");
      return;
    }
    try {
      await persistentViewer.flushUrl();
      const sessions = (await listPreviousSessions())
        .filter(record => record.id !== persistentViewer.sessionId);
      replaceChildren(els.previousSessionsList);
      if (!sessions.length) replaceChildren(els.previousSessionsList,
        h("p", { textContent: "No previous views saved in this browser." }));
      for (const record of sessions) {
        const url = new URL(record.url, window.location.origin);
        if (url.origin !== window.location.origin || url.searchParams.get("p") !== "1") continue;
        const button = h("button", { type: "button", className: "text-button previous-session-entry" },
          h("strong", { textContent: record.title || "Untitled view" }),
          h("span", { className: "previous-session-meta",
            textContent: `${url.searchParams.has("local_schema") ? "Local draft" : "Published schema"} · ${new Date(record.updatedAt).toLocaleString()}` }));
        button.addEventListener("click", () => {
          if ((persistentViewer.editorDirty || state.definitionDraft)
            && !window.confirm("Discard uncommitted changes and open this previous view?")) return;
          sessionStorage.setItem("echo-pending-session-restore",
            JSON.stringify({ id: record.id, url: url.href }));
          window.location.assign(url.href);
        });
        els.previousSessionsList.append(button);
      }
      panel.hidden = false;
      els.previousSessions.setAttribute("aria-expanded", "true");
    } catch (error) { els.localSaveStatus.textContent = `Could not list previous views — ${error.message}`; }
  });
  els.retryLocalSave?.addEventListener("click", () => {
    if (persistentViewer.editorOpen) void closeGroupEditor();
    else void persistentViewer.commitDecision().catch(error => console.error("Retry save failed", error));
  });
  els.saveIndependentCopy?.addEventListener("click", async () => {
    try {
      const editorWasOpen = persistentViewer.editorOpen;
      await persistentViewer.saveIndependentCopy();
      if (editorWasOpen) groupEditorController.closeGroupEditor();
      publicationController.workingCopyChanged();
    } catch (error) { els.localSaveStatus.textContent = `Not saved — ${error.message}`; }
  });
  els.importLocalDraft?.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (persistentViewer.editorDirty && !window.confirm("Discard editor changes and import this draft?")) return;
    try { window.location.assign(await importDraftFile(file)); }
    catch (error) { els.localSaveStatus.textContent = `Import failed — ${error.message}`; }
  });
}

function init() { return projectBootstrap.init(); }

function loadDagData(layoutSource = "") { return projectBootstrap.loadDagData(layoutSource); }

// ─── Duplicate clusters ─────────────────────────────────────────────────────────
// The corrected concept layout places every substantive duplicate of a construct at
// the exact same map coordinate. We treat a shared coordinate as a duplicate cluster:
// a single representative is drawn and clicked on the map, but every underlying
// variable stays in the data model so group membership, causal links and provenance
// all remain per-variable.

function buildDuplicateClusters() {
  Object.assign(state, visibility.buildDuplicateClusters(state.variables));
  state.variableById = new Map(state.variables.map(v => [v.variable_id, v]));
}

function normalizeProjectDuplicateAssignments() {
  if (!state.project) return;
  applyProjectOperation(projectOps.normalizeDuplicateAssignments(state.project, state.clusterOf, state.clusterMembers));
}

function clusterRep(variableId) {
  return visibility.representative(variableId, state.clusterOf);
}

function clusterMemberIds(variableId) {
  return visibility.members(variableId, state.clusterOf, state.clusterMembers);
}

function clusterExactStringGroups(variableId) {
  const representative = state.variableById.get(clusterRep(variableId));
  return representative?.cluster_exact_strings || [];
}

function clusterDisplayVariable(variableId) {
  const representative = state.variableById.get(clusterRep(variableId));
  return state.variableById.get(representative?.cluster_display_variable_id) || representative;
}

function expandToClusterMembers(variableIds) {
  const out = new Set();
  for (const id of variableIds || []) {
    for (const member of clusterMemberIds(id)) out.add(member);
  }
  return [...out];
}

function rejectedVariableEntries() {
  return Array.isArray(state.project?.rejected_variables) ? state.project.rejected_variables : [];
}

function rejectedVariableIdSet() {
  return visibility.rejectedIds(rejectedVariableEntries(), state.clusterOf, state.clusterMembers);
}

function isRejectedVariable(variableId) {
  return rejectedVariableIdSet().has(variableId);
}

function visibleVariables() {
  if (state.map?._visibleVariables) return state.map._visibleVariables;
  let variables = visibility.visibleVariables(
    state.variables, rejectedVariableEntries(), state.clusterOf, state.clusterMembers,
  );
  if (state.definitionDraft?.step === "partition" || state.definitionDraft?.step === "review") {
    const eligible = new Set(state.definitionDraft.eligible_variable_ids || []);
    variables = variables.filter(variable => eligible.has(clusterRep(variable.variable_id)));
  }
  if (state.map) state.map._visibleVariables = variables;
  return variables;
}

function visibleClusterReps() {
  if (state.map?._visibleClusterReps) return state.map._visibleClusterReps;
  const representatives = visibleVariables().filter((variable) => variable.is_cluster_rep);
  if (state.map) state.map._visibleClusterReps = representatives;
  return representatives;
}

function invalidateMapCaches() {
  mapUiController.invalidateCaches();
  if (!state.map) return;
  state.map._visibleVariables = null;
  state.map._visibleClusterReps = null;
  state.map._worldSpan = null;
  state.map._groupRegions = null;
}


function initializeProject() {
  projectController.initialize();
}

function currentGroupingSchema() {
  return projectController.currentSchema();
}

function loadLatestSchemaGroups() {
  projectController.loadCurrentSchema();
}

function applyLoadedProject(payload) {
  projectController.applyLoaded(payload);
}

function projectStorageKey() {
  return projectController.storageKey();
}

function projectPayload() {
  return projectController.payload();
}

function persistProjectLocally() {
  persistentViewer.viewerChanged();
}

function saveProjectLocally() {
  persistentViewer.viewerChanged();
}

function restoreProjectLocally() {
  return projectController.restore();
}

// ─── Undo / Redo ──────────────────────────────────────────────────────────────

function takeSnapshot() {
  return projectController.snapshot();
}

function applySnapshot(serialized) {
  projectController.applySnapshot(serialized);
}

function addToUndoHistory(description, before, renderKind) {
  projectController.record(description, before, renderKind);
}

function undo() {
  projectController.undo();
  void persistentViewer.commitDecision().catch(error => console.error("Could not save undo", error));
}

function redo() {
  projectController.redo();
  void persistentViewer.commitDecision().catch(error => console.error("Could not save redo", error));
}

function renderUndoRedo() {
  els.undoBtn.disabled = state.undoPointer < 0;
  els.redoBtn.disabled = state.undoPointer >= state.undoHistory.length - 1;
  const last = state.undoPointer >= 0 ? state.undoHistory[state.undoPointer]?.description : null;
  els.undoBtn.title = last ? `Undo: ${last}` : "Nothing to undo";
  els.redoBtn.title = state.undoPointer < state.undoHistory.length - 1
    ? `Redo: ${state.undoHistory[state.undoPointer + 1]?.description}` : "Nothing to redo";
  if (els.dag2UndoBtn) {
    els.dag2UndoBtn.disabled = els.undoBtn.disabled;
    els.dag2UndoBtn.title = els.undoBtn.title;
    els.dag2RedoBtn.disabled = els.redoBtn.disabled;
    els.dag2RedoBtn.title = els.redoBtn.title;
  }
}

function renderActionHistory() {
  if (!state.showActionHistory) return;
  if (!state.actionLog.length) {
    replaceChildren(els.actionHistory, h("div", { className: "ah-empty", textContent: "No actions yet." }));
    return;
  }
  replaceChildren(els.actionHistory, state.actionLog.map(entry => h("div", { className: "ah-entry" },
    h("span", { className: "ah-desc", textContent: entry.description }),
    h("span", { className: "ah-time", textContent: entry.time.slice(11, 19) }))));
}

// ─── Mode management ──────────────────────────────────────────────────────────


function setWorkflowMode(mode) {
  if (mode === state.workflowMode) return;
  Object.assign(state, workflow.transition(state, { type: "mode", mode }));
  renderAll();
}

// ─── Event handlers ────────────────────────────────────────────────────────────

function installHandlers() { return eventController.installHandlers(); }
function toggleFullscreenPanel(panel) {
  shellController.toggleFullscreen(panel);
}

function setFullscreenPanel(panel) {
  shellController.setFullscreen(panel);
}

function initPanelResizers() {
  shellController.installResizers();
}

function installDagHandlers() {
  // vis.js handles all DAG interaction (zoom, pan, click) natively
}

// ─── Render orchestration ──────────────────────────────────────────────────────

const renderCoordinator = createRenderCoordinator({
  buildCandidateQueue, aggregateGroupLinks, computeVisibleLinks, renderGroupList,
  renderRejectedVariablesPanel, renderDag, refreshDagEdgeSelection,
  renderVariableComparison,
  renderSelectedEdge, renderExportStatus, renderMapModeControls,
  renderMapToolbarToggles, renderUndoRedo, drawMap, saveProjectLocally,
  renderModeUI, renderAnchorBar, renderStatus, renderUoaStep, renderUoaFilterBar,
  renderVariablePanel: () => setupGroupController.renderVariablePanel(),
  renderSearch, renderSetupGroupPickers, renderSeedRows, renderGroupingSetControls,
  renderGroupEditor, renderRightPanel, renderDefinition,
});

function renderAll(options) {
  renderCoordinator.renderAll(options);
  persistentViewer.viewerChanged();
  // Enrich references opportunistically while the user works. Export actions
  // await the same de-duplicated, rate-limited requests before downloading.
  exportController.warmBibliography();
}

function rebuildProject(options) {
  renderCoordinator.rebuildProject(options);
}

function rebuildLinkDecision() {
  renderCoordinator.rebuildLinkDecision();
}

function renderMapToolbarToggles() { return toolbarController.render(); }

function assignmentCoverage() { return toolbarController.assignmentCoverage(); }

function renderAssignmentCoverage() { return toolbarController.renderAssignmentCoverage(); }

// ─── Mode UI rendering ────────────────────────────────────────────────────────

function renderModeUI() {
  setupGroupController.renderMode();
}

// Show the selected groups with Change buttons. Change opens the matching Setup
// picker; the current selection remains intact until a replacement is confirmed.
function renderAnchorBar() {
  setupGroupController.renderAnchorBar();
}

function changeAnchor(side) {
  const gid = side === "dv" ? state.project?.dv_group_id
    : side === "instrument" ? state.project?.instrument_group_id : state.project?.iv_group_id;
  const group = groupById(gid);
  if (side !== "instrument" && !group) return;
  Object.assign(state, workflow.transition(state, { type: "change-anchor", side, groupId: gid }));
  const input = side === "dv" ? els.dvInput : side === "instrument" ? els.instrumentInput : els.ivInput;
  if (input) input.value = "";
  setMapMode("select");
  if (group) fitMap(group.variable_ids);
  renderAll({ rebuild: false });
  setTimeout(() => { input?.focus(); }, 60);
}

function renderRightPanel() {
  setupGroupController.renderRightPanel();
}

// ─── Setup phase rendering ────────────────────────────────────────────────────

function renderStatus() {
  setupGroupController.renderStatus();
}

function workflowHint() {
  return setupGroupController.hint();
}

function renderSetupGroupPickers() {
  setupGroupController.renderSetupPickers();
}

function renderSetupGroupPicker(side) {
  setupGroupController.renderSetupPicker(side);
}

function assignGroupAsInstrument(groupId) {
  const group = groupId ? groupById(groupId) : null;
  if (groupId && (!group?.variable_ids?.length
    || groupId === state.project.iv_group_id || groupId === state.project.dv_group_id)) return;
  state.project.instrument_group_id = groupId;
  state.showExclusionViolations = Boolean(groupId);
  state.showExogeneity = false;
  state.showConfoundersOnly = !groupId;
  state.showCollidersOnly = false;
  Object.assign(state, workflow.transition(state, {
    type: "anchor-selected", side: "instrument", groupId,
  }));
  setMapMode("select");
  if (group) fitMap(group.variable_ids);
  renderAll();
}



function toggleAnchorSearchMode(side) {
  state.anchorSearchMode[side] = state.anchorSearchMode[side] === "existing" ? "new" : "existing";
  state.seeds[side].clear();
  state.searchMatches[side] = [];
  const input = side === "dv" ? els.dvInput : els.ivInput;
  input.value = "";
  renderAll();
  setTimeout(() => input.focus(), 0);
}

// ─── DAG2 category definition ────────────────────────────────────────────────

function startDefinition(role) { return definitionWorkflowController.startDefinition(role); }
function startEditSplit(groupId = null) { return definitionWorkflowController.startEditSplit(groupId); }
function cancelDefinition() { return definitionWorkflowController.cancelDefinition(); }
function definitionSources() { return definitionWorkflowController.definitionSources(); }
function continueDefinition() { return definitionWorkflowController.continueDefinition(); }
function definitionResidualIds(source) { return definitionWorkflowController.definitionResidualIds(source); }
function toggleDefinitionVariable(variableId, add = null) { return definitionWorkflowController.toggleDefinitionVariable(variableId, add); }
function definitionCanReview() { return definitionWorkflowController.definitionCanReview(); }
function definitionNeighbors() { return definitionWorkflowController.definitionNeighbors(); }
function renderDefinition() { return definitionWorkflowController.renderDefinition(); }
function saveDefinition() { return definitionWorkflowController.saveDefinition(); }
function installDefinitionHandlers() { return definitionWorkflowController.installDefinitionHandlers(); }

// ─── Search ───────────────────────────────────────────────────────────────────

function renderSearch(side) {
  const input = side === "iv" ? els.ivInput : els.dvInput;
  const container = side === "iv" ? els.ivResults : els.dvResults;
  const query = input.value.trim();
  if (query && state.variableSearchStatus === "idle") void loadVariableSearchCatalog();
  const selected = state.seeds[side];
  if (state.anchorSearchMode[side] !== "new") {
    state.searchMatches[side] = [];
    container.replaceChildren();
    renderSetupGroupPicker(side);
    return;
  }
  if (query && state.variableSearchStatus !== "ready") {
    state.searchMatches[side] = [];
    replaceChildren(container, h("div", { className: "small-note", textContent:
      state.variableSearchStatus === "error"
        ? "Variable search could not be loaded."
        : "Loading variable search…" }));
    return;
  }
  const matches = query ? searchVariables(query, 16) : [];
  state.searchMatches[side] = matches.map((v) => v.variable_id);
  replaceChildren(container, matches.map(v => h("button", { className: "result-button", type: "button", dataset: { side, variableId: v.variable_id } },
    h("strong", { textContent: v.display_label || v.concept_label }),
    h("span", { textContent: truncate(v.raw_variable_text || v.concept_label, 110) }),
    h("span", { textContent: `${v.paper_id || "unknown paper"} ${selected.has(v.variable_id) ? "(selected)" : ""}` }))));
  container.querySelectorAll(".result-button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const variableId = btn.dataset.variableId;
      if (!variableId) return;
      btn.disabled = true;
      if (!await hydrateSearchResult(variableId, hydrateVariableDetails, state.variableById)) return;
      if (selected.has(variableId)) selected.delete(variableId);
      else selected.add(variableId);
      state.selectedVariableId = variableId;
      if (side === "dv" && state.phase === "select_dv" && selected.size) {
        beginTargetGroup("dv");
      } else if (side === "iv" && state.phase === "select_iv" && selected.size) {
        beginTargetGroup("iv");
      } else {
        const group = activeGroup();
        if (group && group.type === side) addVariableToGroup(group, variableId);
        renderAll();
        fitNeighborhood([...selected]);
      }
    });
  });
}

function fitSearchContext(side) {
  const previewIds = (state.searchMatches[side] || []).slice(0, 5);
  if (previewIds.length) fitNeighborhood(previewIds, 12);
  else drawMap();
}

function searchVariables(query, limit = 20) {
  return variableSearchCatalog.searchVariables(query, limit, {
    selectedUoa: state.selectedUoa,
    uoaFilterEnabled: state.uoaFilterEnabled, uoaMatches,
  });
}

function searchVisibleVariables(query, limit = 20) {
  return searchModel.searchVariables(query, {
    variables: visibleVariables(), selectedUoa: state.selectedUoa,
    uoaFilterEnabled: state.uoaFilterEnabled, uoaMatches,
  }, limit);
}

function searchAnchorGroups(project, side, query, variableById, limit = 12) {
  const catalogMatches = query && state.variableSearchStatus === "ready"
    ? variableSearchCatalog.searchVariables(query, variableSearchCatalog.records.length)
    : [];
  const searchRecordById = new Map(catalogMatches.map(record => [record.variable_id, record]));
  return searchModel.searchAnchorGroups(project, side, query, variableById, limit, searchRecordById);
}

async function loadVariableSearchCatalog() {
  if (state.variableSearchStatus === "loading" || state.variableSearchStatus === "ready") return;
  state.variableSearchStatus = "loading";
  state.variableSearchError = null;
  try {
    await variableSearchCatalog.load();
    state.variableSearchStatus = "ready";
  } catch (error) {
    state.variableSearchStatus = "error";
    state.variableSearchError = error;
    console.error("Could not load variable search catalog.", error);
  }
  renderSearch("iv");
  renderSearch("dv");
}

function groupedVariableIds(excludeGroupId = null) {
  const grouped = new Set();
  for (const group of state.project?.groups || []) {
    if (excludeGroupId && group.group_id === excludeGroupId) continue;
    for (const variableId of group.variable_ids || []) grouped.add(variableId);
  }
  return grouped;
}

function renderRejectedVariablesPanel() {
  if (!els.rejectedVariablesPanel || !els.rejectedVariablesList || !els.rejectedVariableSearch) return;
  const entries = rejectedVariableEntries().slice().sort((a, b) =>
    (a.label || a.variable_id || "").localeCompare(b.label || b.variable_id || "")
  );
  const query = normalized(els.rejectedVariableSearch.value);
  const filtered = query
    ? entries.filter((entry) => normalized([
        entry.label,
        entry.variable_id,
        entry.reason,
        ...(entry.member_variable_ids || []),
      ].join(" ")).includes(query))
    : entries;
  els.rejectedVariablesPanel.hidden = entries.length === 0;
  replaceChildren(els.rejectedVariablesList, filtered.length
    ? filtered.map(entry => h("div", { className: "group-row group-row-rejected rejected-variable-row", dataset: { variableId: entry.variable_id } },
      h("div", { className: "group-row-head" }, h("strong", { textContent: entry.label || entry.variable_id }),
        h("span", { className: "group-row-meta", textContent: `${entry.member_variable_ids?.length || 1} vars` })),
      h("span", { textContent: entry.reason || "low_quality" }), h("div", { className: "group-row-footer" },
        h("span", { className: "group-status-label rejected", textContent: "rejected variable" }),
        h("button", { className: "action-button", type: "button", dataset: { action: "restore" }, textContent: "Restore" }))))
    : h("div", { className: "small-note", textContent: "No rejected variables match this search." }));
  els.rejectedVariablesList.querySelectorAll("button[data-action='restore']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("[data-variable-id]");
      if (!row) return;
      const before = takeSnapshot();
      restoreRejectedVariable(row.dataset.variableId);
      addToUndoHistory("Restored rejected variable", before);
      rebuildProject();
    });
  });
}

// ─── UOA filter helpers ────────────────────────────────────────────────────────

function getAllUoaParts() {
  return uoaController.getAllParts();
}

function uoaMatches(variableUoa, selected) {
  return uoaController.matches(variableUoa, selected);
}

function uoaSupportedByAnchors(uoa) {
  return uoaController.supportedByAnchors(uoa);
}

function renderUoaStep() {
  return uoaController.renderStep();
}

function selectUoa(uoa) {
  return uoaController.select(uoa);
}

function renderUoaFilterBar() {
  return uoaController.renderFilterBar();
}

function renderSeedRows() {
  return uoaController.renderSeeds();
}

// ─── Target group setup ───────────────────────────────────────────────────────

function beginTargetGroup(side) { return groupEditorController.beginTargetGroup(side); }
function promoteGroupToAnchor(side, groupId) { return groupEditorController.promoteGroupToAnchor(side, groupId); }
function assignGroupAsAnchor(side, groupId) { return groupEditorController.assignGroupAsAnchor(side, groupId); }
function seedLabel(side) { return groupEditorController.seedLabel(side); }
// Event handlers retain group references through edits. Apply pure results while
// preserving those identities; snapshots deliberately replace them on undo.
function applyProjectOperation(next) {
  if (state.publishedSchemaHydrating || state.publishedSchemaLoadFailed) {
    if (els.publicationStatus) {
      els.publicationStatus.textContent = "Group memberships are still loading. Editing will unlock when they are ready.";
      els.publicationStatus.classList.add("publication-error");
    }
    return false;
  }
  const oldProject = state.project;
  const anchorChanged = oldProject && ["iv_group_id", "dv_group_id", "instrument_group_id"]
    .some(key => oldProject[key] !== next[key]);
  const structural = project => JSON.stringify({
    groups: (project?.groups || []).map(group => [group.group_id, group.label, group.notes,
      group.variable_ids, group.excluded_nearby_variable_ids]),
    rejected: project?.rejected_variables || [],
    decisions: project?.link_decisions || {},
    findings: project?.finding_decisions || {},
  });
  const schemaChanged = oldProject && structural(oldProject) !== structural(next);
  const asSchema = project => ({ finding_decisions: project?.finding_decisions || {},
    groups: (project?.groups || []).map(group => ({
    group_id: group.group_id, label: group.label || "", variable_ids: [...(group.variable_ids || [])],
    ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
  })) });
  const oldSchema = asSchema(oldProject);
  projectController.applyOperation(next);
  if (schemaChanged || anchorChanged) publicationController?.workingCopyChanged?.();
  if (schemaChanged && !state.activeGroupId && !state.definitionDraft && !schemaBatchDepth
    && !persistentViewer.editorOpen && !schemaCommitQueued) {
    schemaCommitQueued = true;
    queueMicrotask(() => {
      schemaCommitQueued = false;
      void persistentViewer.commitDecision().then(() =>
        publicationController?.workingCopyChanged?.()).catch(error =>
          console.error("Could not save schema change", error));
    });
  }
  if (state.compiledDagValid && state.compiledDag && oldProject) {
    const newSchema = asSchema(next);
    const owner = schema => new Map(schema.groups.flatMap(group => group.variable_ids.map(id => [id, group.group_id])));
    const before = owner(oldSchema), after = owner(newSchema);
    const changedIds = [...new Set([...before.keys(), ...after.keys()])]
      .filter(id => before.get(id) !== after.get(id));
    const changedRawIds = [...new Set([...Object.keys(oldSchema.finding_decisions),
      ...Object.keys(newSchema.finding_decisions)])].filter(id =>
      (oldSchema.finding_decisions[id]?.display_status === "excluded")
        !== (newSchema.finding_decisions[id]?.display_status === "excluded"));
    const revision = (state.compiledDagRevision || 0) + 1;
    state.compiledDagRevision = revision;
    if (!changedIds.length && !changedRawIds.length && !state.compiledDagUpdating) {
      state.compiledDag = incrementCompiledDag({ compiledDag: state.compiledDag, oldSchema, newSchema,
        incidentRawLinks: [], project: next });
    } else {
      state.compiledDagUpdating = true;
      state.compiledUpdateBaseSchema ||= oldSchema;
      state.compiledUpdateTargetSchema = newSchema;
      state.compiledUpdateChangedIds ||= new Set();
      for (const id of changedIds) state.compiledUpdateChangedIds.add(id);
      state.compiledUpdateChangedRawIds ||= new Set();
      for (const id of changedRawIds) state.compiledUpdateChangedRawIds.add(id);
      const batchedIds = [...state.compiledUpdateChangedIds];
      const batchedRawIds = [...state.compiledUpdateChangedRawIds];
      const batchBaseSchema = state.compiledUpdateBaseSchema;
      const updatePromise = Promise.all([
        batchedIds.length ? dagDataSource.loadIncidentRawLinks(batchedIds) : [],
        batchedRawIds.length ? dagDataSource.loadRawLinksByIds(batchedRawIds) : [],
      ]).then(parts => {
        const incidentRawLinks = [...new Map(parts.flat().map(link => [link.raw_causal_link_id, link])).values()];
        if (state.compiledDagRevision !== revision) return;
        for (const link of incidentRawLinks) {
          if (!state.rawLinksById.has(link.raw_causal_link_id)) state.rawLinks.push(link);
          state.rawLinksById.set(link.raw_causal_link_id, link);
          const key = linkKey(link.source_variable_id, link.target_variable_id);
          if (!state.linkLookup.has(key)) state.linkLookup.set(key, []);
          if (!state.linkLookup.get(key).includes(link.raw_causal_link_id)) state.linkLookup.get(key).push(link.raw_causal_link_id);
        }
        state.compiledDag = incrementCompiledDag({ compiledDag: state.compiledDag, oldSchema: batchBaseSchema,
          newSchema: state.compiledUpdateTargetSchema, incidentRawLinks, project: state.project });
        state.compiledUpdateBaseSchema = null;
        state.compiledUpdateTargetSchema = null;
        state.compiledUpdateChangedIds = null;
        state.compiledUpdateChangedRawIds = null;
        state.compiledDagUpdating = false;
        renderAll();
      }).catch(error => {
        if (state.compiledDagRevision !== revision) return;
        state.compiledDagUpdating = false;
        state.compiledDagValid = false;
        state.compiledUpdateBaseSchema = null;
        state.compiledUpdateTargetSchema = null;
        state.compiledUpdateChangedIds = null;
        state.compiledUpdateChangedRawIds = null;
        console.warn("Incremental DAG update failed; a full local recomputation is required.", error);
      }).finally(() => {
        if (state.compiledDagUpdatePromise === updatePromise) state.compiledDagUpdatePromise = null;
      });
      state.compiledDagUpdatePromise = updatePromise;
    }
  }
}

function ensureGroup(group) { return groupEditorController.ensureGroup(group); }
function activeGroup() {
  if (state.definitionDraft?.step === "partition") return {
    group_id: "__definition_new__", label: "New variable",
    variable_ids: expandToClusterMembers(state.definitionDraft.new_variable_ids),
    type: state.definitionDraft.role,
  };
  return groupEditorController.activeGroup();
}
function createCustomGroup() { return groupEditorController.createCustomGroup(); }
async function closeGroupEditor() {
  try {
    await persistentViewer.finishEditor();
    groupEditorController.closeGroupEditor();
    publicationController.workingCopyChanged();
  } catch (error) {
    console.error("Could not commit schema editor changes", error);
  }
}

function discardGroupEditor() {
  persistentViewer.discardEditor();
  groupEditorController.closeGroupEditor();
}
const loadedNeighborRecords = new WeakSet();
const pendingNeighborRecords = new WeakMap();

function applyVariableNeighbors(variables, rows) {
  const byVariable = new Map();
  const displayedById = new Map(state.variables.map(variable => [variable.variable_id, variable]));
  for (const row of rows) {
    if (!byVariable.has(row.variable_id)) byVariable.set(row.variable_id, []);
    byVariable.get(row.variable_id).push({ variable_id: row.neighbor_variable_id,
      index: row.neighbor_index, cosine_similarity: row.cosine_similarity,
      llm_rank: row.llm_rank, embedding_rank: row.embedding_rank,
      is_substantive_duplicate: row.is_substantive_duplicate });
  }
  for (const variable of variables) {
    if (state.variableById.get(variable.variable_id) !== variable) continue;
    const suggestions = byVariable.get(variable.variable_id) || [];
    variable.similarity_neighbors = suggestions;
    loadedNeighborRecords.add(variable);
    // Cluster construction copies variable records for map/search views.
    const displayed = displayedById.get(variable.variable_id);
    if (displayed) displayed.similarity_neighbors = suggestions;
  }
  if (state.definitionDraft?.step === "partition") renderDefinition();
}

async function hydrateVariableNeighbors(variableIds) {
  const variables = [...new Set(variableIds || [])].map(id => state.variableById.get(id)).filter(Boolean);
  const missing = variables.filter(variable =>
    !loadedNeighborRecords.has(variable) && !pendingNeighborRecords.has(variable));
  if (missing.length) {
    const pending = dagDataSource.loadNeighbors(missing.map(variable => variable.variable_id))
      .then(rows => applyVariableNeighbors(missing, rows))
      .finally(() => missing.forEach(variable => pendingNeighborRecords.delete(variable)));
    for (const variable of missing) pendingNeighborRecords.set(variable, pending);
  }
  await Promise.all([...new Set(variables.map(variable => pendingNeighborRecords.get(variable)).filter(Boolean))]);
}

async function hydrateVariableDetails(variableIds, { skipNeighbors = false } = {}) {
  const requested = [...new Set(variableIds || [])];
  const missing = requested.filter(id => !state.variableById.has(id));
  if (missing.length) {
    const variablesPromise = dagDataSource.loadVariableMetadata(missing, state.variableLayoutSource);
    const neighborsPromise = skipNeighbors ? null : dagDataSource.loadNeighbors(missing);
    const [variables, neighbors] = skipNeighbors
      ? [await variablesPromise, null]
      : await Promise.all([variablesPromise, neighborsPromise]);
    for (const variable of variables) {
      if (variable.field_preview_json) variable.field_preview = JSON.parse(variable.field_preview_json);
      if (variable.metadata_blob_json) variable.metadata_blob = JSON.parse(variable.metadata_blob_json);
      variable.similarity_neighbors = [];
      state.variableById.set(variable.variable_id, variable);
    }
    state.variables = [...state.variableById.values()].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    buildDuplicateClusters();
    invalidateMapCaches();
    if (!skipNeighbors) applyVariableNeighbors(variables, neighbors);
  }
  if (!skipNeighbors) await hydrateVariableNeighbors(requested);
}

function renderGroupEditor() {
  const group = state.project?.groups?.find(item => item.group_id === state.activeGroupId);
  // Definition source loading only fetches map records. The group editor uses
  // neighbors for its suggestions, so fetch them if this group is opened later.
  const missing = (group?.variable_ids || []).filter(id => {
    const variable = state.variableById.get(id);
    return !variable || !loadedNeighborRecords.has(variable);
  });
  if (!state.definitionDraft && missing.length && !state.pendingVariableMetadata) {
    state.pendingVariableMetadata = true;
    void hydrateVariableDetails(missing).then(() => {
      state.pendingVariableMetadata = false;
      renderAll();
    }).catch(error => {
      state.pendingVariableMetadata = false;
      console.warn("Could not lazily load group variable metadata.", error);
    });
  }
  const result = groupEditorController.renderGroupEditor();
  if ((state.publishedSchemaHydrating || state.publishedSchemaLoadFailed) && els.groupEditorSection) {
    els.groupEditorSection.querySelectorAll("input, textarea, select, button").forEach(control => {
      if (control === els.cancelGroupEdit || control === els.zoomGroup) return;
      control.disabled = true;
      control.title = "Editing unlocks when all published-schema memberships have loaded.";
    });
  }
  return result;
}
function renderGroupSeedSearch() { return groupEditorController.renderGroupSeedSearch(); }
function renderNeighborSuggestions(group) { return groupEditorController.renderNeighborSuggestions(group); }
function addVariableToGroup(group, variableId) {
  if (group?.group_id === "__definition_new__") return toggleDefinitionVariable(variableId, true);
  return groupEditorController.addVariableToGroup(group, variableId);
}
function addVariableSetToGroup(group, ids) {
  if (group?.group_id === "__definition_new__") {
    for (const id of ids) toggleDefinitionVariable(id, true);
    return;
  }
  return groupEditorController.addVariableSetToGroup(group, ids);
}
function removeVariableFromGroup(group, variableId) {
  if (group?.group_id === "__definition_new__") return toggleDefinitionVariable(variableId, false);
  return groupEditorController.removeVariableFromGroup(group, variableId);
}
function addTopNeighborsToActiveGroup() { return groupEditorController.addTopNeighborsToActiveGroup(); }
function removeTopNeighborsFromActiveGroup() { return groupEditorController.removeTopNeighborsFromActiveGroup(); }
function clearActiveGroupVariables() { return groupEditorController.clearActiveGroupVariables(); }
function selectActiveAnchor() { return groupEditorController.selectActiveAnchor(); }
function finishSchemaChoice(loadSchema) { return groupEditorController.finishSchemaChoice(loadSchema); }
// ─── Grouping set management ──────────────────────────────────────────────────

function activeGroupingSet() { return groupingSetController.active(); }

function copyPermalink() { return groupingSetController.copyPermalink(); }

function currentWorkingGroupingSchema() { return groupingSetController.workingSchema(); }

const persistentViewer = createPersistentViewer({
  state,
  getSchema: currentWorkingGroupingSchema,
  getViewport: () => {
    const network = dagNetworkController.getNetwork();
    state.dagViewport = network
      ? { scale: network.getScale(), position: network.getViewPosition() } : null;
  },
  status: message => {
    if (els.localSaveStatus) els.localSaveStatus.textContent = message;
    if (els.retryLocalSave) els.retryLocalSave.hidden = !message.startsWith("Not saved");
    if (els.saveIndependentCopy) els.saveIndependentCopy.hidden =
      !message.includes("Schema revision changed");
  },
  onDiscard: invalidateMapCaches,
});

function exportLocalDraft() {
  const schema = currentWorkingGroupingSchema();
  const payload = makeDraftExport({
    schema, url: persistentViewer.currentUrl("export-pending") || window.location.href,
    basePublicationId: state.data?.publication_source?.publication_id || "",
    basePublicationHash: state.data?.publication_source?.content_hash || "",
  });
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)],
    { type: "application/json" }));
  const link = document.createElement("a");
  setSafeUrl(link, "href", objectUrl);
  link.download = `echo-draft-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistentViewer.flushUrl();
});

function renderGroupingSetControls() {
  setupGroupController.renderGroupingControls();
}

function applyActiveGroupingSet() { return groupingSetController.applyActive(); }

function candidateInputs() {
  return { variables: state.variableById, similarityEdgeMap: state.similarityEdgeMap, linkLookup: state.linkLookup };
}

function createDensityCandidateGroup() {
  const group = candidates.createDensityCandidateGroup(state.project, candidateInputs(), {
    visibleVariables: visibleVariables(), transform: state.map.transform,
    width: canvasWidth(), height: canvasHeight(), groupId: `density_${Date.now()}`,
    createdAt: nowIso(), updatedAt: nowIso(),
  });
  if (!group) return null;
  ensureGroup(group);
  addDecision("density_candidate_created", { group_id: group.group_id, variable_ids: group.variable_ids });
  return group;
}



// ─── Candidate queue ──────────────────────────────────────────────────────────

function buildCandidateQueue() {
  state.candidateQueue = candidates.buildCandidateQueue(state.project, candidateInputs());
}

// ─── Unified group list ───────────────────────────────────────────────────────

function renderGroupList() {
  setupGroupController.renderGroupList();
}

// ─── Grouping schema folder export ───────────────────────────────────────────

function exportGroupingFolder() { return groupingSetController.exportFolder(); }

// ─── DAG / Link aggregation ───────────────────────────────────────────────────

function aggregateGroupLinks() {
  // Migrate saved decisions from the former Hide action before rendering/export.
  for (const decision of Object.values(state.project.link_decisions || {})) {
    if (decision.display_status === "hidden") decision.display_status = "excluded";
  }
  if (state.compiledDagValid && state.compiledDag) {
    state.project.links = applyLinkDecisions(state.compiledDag.edges || [], state.project.link_decisions);
    return;
  }
  state.project.links = deriveGroupLinks({
    project: dagProjectView(), linkLookup: state.linkLookup, rawLinksById: state.rawLinksById,
  });
}

function paperTableKeys(rawLinkIds) {
  return lookupPaperTableKeys(rawLinkIds, state.rawLinksById);
}

function rawLinksBetween(sourceIds, targetIds) {
  return lookupRawLinks(sourceIds, targetIds, state.linkLookup);
}

function comparisonVariables() {
  const ids = (state.comparisonVariableIds || [])
    .map((variableId) => clusterRep(variableId))
    .filter(Boolean);
  if (ids.length !== 2 || ids[0] === ids[1]) return null;
  const [source, target] = ids.map((variableId) => state.variableById.get(variableId));
  return source && target ? { source, target } : null;
}

function renderVariableComparison() {
  const comparison = comparisonVariables();
  if (!comparison) return false;

  const { source, target } = comparison;
  const forwardIds = rawLinksBetween(clusterMemberIds(source.variable_id), clusterMemberIds(target.variable_id));
  const reverseIds = rawLinksBetween(clusterMemberIds(target.variable_id), clusterMemberIds(source.variable_id));
  const { rows, sourceLabel, targetLabel } = inspector.variableComparison(
    source, target, forwardIds, reverseIds, state.rawLinksById,
  );

  els.edgeInspector.className = "edge-inspector variable-comparison";
  els.edgeInspector.hidden = false;
  els.closeEvidencePane.hidden = false;
  els.provenancePanel.hidden = false;
  if (!rows.length) {
    replaceChildren(els.edgeInspector, h("strong", { textContent: "Variable comparison" }),
      h("div", { textContent: `${sourceLabel} ↔ ${targetLabel}` }),
      h("div", { className: "small-note", textContent: "No evidence about a link between these variables." }));
    els.provenancePanel.replaceChildren();
    return true;
  }

  replaceChildren(els.edgeInspector, h("strong", { textContent: "Evidence between variables" }),
    h("div", { textContent: `${sourceLabel} ↔ ${targetLabel}` }),
    h("div", { className: "small-note", textContent: `${rows.length} extracted evidence record${rows.length === 1 ? "" : "s"}; “present” supports a link and “absent” records evidence against one.` }));
  const evidenceRows = rows.map((link) => {
    const doi = isDoi(link.paper_id) ? link.paper_id.trim() : null;
    const paper = truncate(link.paper_title || link.paper_id, 44);
    const paperCell = doi ? h("a", { href: safeUrl(`https://doi.org/${encodeURIComponent(doi)}`), target: "_blank", rel: "noopener", title: link.paper_title || doi, textContent: paper }) : document.createTextNode(paper);
    return h("tr", {}, h("td", { textContent: link.direction }), h("td", {}, paperCell),
      h("td", { textContent: link.causal_link_existence || "" }), h("td", { textContent: (link.identification_strategy || "").replaceAll("_", " ") }),
      h("td", { textContent: truncate(link.target_population || "", 60) }));
  });
  const headings = ["Direction", "Paper", "Evidence", "Strategy", "Population"];
  replaceChildren(els.provenancePanel, h("table", { className: "provenance-table" },
    h("thead", {}, h("tr", {}, headings.map(label => h("th", { textContent: label })))), h("tbody", {}, evidenceRows)));
  return true;
}

function hasAnyMapping(sourceIds, targetIds) {
  return rawLinksBetween(sourceIds, targetIds).length > 0;
}

function computeVisibleLinks() {
  const instrumentId = state.project.instrument_group_id;
  if (instrumentId && (instrumentId === state.project.iv_group_id
    || instrumentId === state.project.dv_group_id
    || !dagGroups().some(group => group.group_id === instrumentId))) {
    state.project.instrument_group_id = null;
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showConfoundersOnly = true;
  }
  const excludedCount = state.project.links.filter(link => link.display_status === "excluded").length;
  els.showExcludedLinks.hidden = excludedCount === 0;
  els.showExcludedLinks.textContent = `Excluded links (${excludedCount})`;
  const excludedFindingCount = Object.keys(state.project.finding_decisions || {}).length;
  els.showExcludedFindings.hidden = excludedFindingCount === 0;
  els.showExcludedFindings.textContent = `Excluded findings (${excludedFindingCount})`;
  const view = deriveDagView({
    groups: dagGroups(),
    links: state.project.links,
    ivId: state.project.iv_group_id,
    dvId: state.project.dv_group_id,
    instrumentId: state.project.instrument_group_id,
    maxPathLength: state.confounderMaxPathLength,
    exclusionMaxPathLength: state.exclusionMaxPathLength,
    excludeBottlenecked: state.excludeBottleneckedConfounders,
    filterByCausalRelevance: false,
    showConfoundersOnly: state.showConfoundersOnly,
    showCollidersOnly: state.showCollidersOnly,
    showExclusionViolations: state.showExclusionViolations,
    showExogeneity: state.showExogeneity,
    hideIrrelevantDiagnosticLinks: state.hideIrrelevantConfounderLinks,
  });
  state.componentGroupIds = view.componentGroupIds;
  state.visibleLinks = view.visibleLinks;
  state.confounderGroupIds = view.confounders.confounderIds;
  state.confounderPathGroupIds = view.confounders.pathIds;
  state.confounderPathsByGroup = view.confounders.pathsByGroup;
  state.confounderLinkPairKeys = view.confounders.linkPairKeys;
  state.bottleneckedConfounderIds = view.confounders.bottleneckedIds;
  state.colliderGroupIds = view.colliders.colliderIds;
  state.colliderPathGroupIds = view.colliders.pathIds;
  state.colliderPathsByGroup = view.colliders.pathsByGroup;
  state.colliderLinkPairKeys = view.colliders.linkPairKeys;
  state.bottleneckedColliderIds = view.colliders.bottleneckedIds;
  state.exclusionViolationIds = view.exclusionViolations.violationIds;
  state.exclusionPathIds = view.exclusionViolations.pathIds;
  state.exclusionPathsByGroup = view.exclusionViolations.pathsByGroup;
  state.exclusionLinkPairKeys = view.exclusionViolations.linkPairKeys;
  state.exogeneityGroupIds = view.exogeneity.confounderIds;
  state.exogeneityPathGroupIds = view.exogeneity.pathIds;
  state.exogeneityPathsByGroup = view.exogeneity.pathsByGroup;
  state.exogeneityLinkPairKeys = view.exogeneity.linkPairKeys;
  state.bottleneckedExogeneityIds = view.exogeneity.bottleneckedIds;
}

function showExcludedLinks() {
  const links = state.project.links.filter(link => link.display_status === "excluded");
  if (!links.length) return;
  state.selectedEdgeId = null;
  state.selectedEvidenceGroupId = null;
  els.edgeInspector.className = "edge-inspector excluded-links-list";
  els.edgeInspector.hidden = false;
  els.provenancePanel.hidden = true;
  els.closeEvidencePane.hidden = false;
  replaceChildren(els.edgeInspector,
    h("strong", { textContent: "Excluded links" }),
    ...links.map(link => {
      const model = inspector.edgeInspector(link, state.project);
      const button = h("button", { className: "action-button", type: "button",
        textContent: `${model.sourceLabel} ${model.arrow} ${model.targetLabel}` });
      button.addEventListener("click", () => inspectDagEdge(link.edge_id));
      return button;
    }));
  refreshDagEdgeSelection();
}

function persistFindingDecision() {
  if (state.activeGroupId && !persistentViewer.editorOpen) {
    void persistentViewer.commitDecision().then(() =>
      publicationController.workingCopyChanged()).catch(error =>
      console.error("Could not save finding exclusion", error));
  }
}

async function showExcludedFindings() {
  const ids = Object.keys(state.project.finding_decisions || {});
  if (!ids.length) return;
  state.selectedEdgeId = null;
  state.selectedEvidenceGroupId = null;
  els.edgeInspector.className = "edge-inspector excluded-links-list";
  els.edgeInspector.hidden = false;
  els.provenancePanel.hidden = true;
  els.closeEvidencePane.hidden = false;
  replaceChildren(els.edgeInspector, h("strong", { textContent: "Excluded findings" }),
    h("div", { className: "small-note", textContent: "Loading findings…" }));
  refreshDagEdgeSelection();
  try {
    const missing = ids.filter(id => !state.rawLinksById.has(id));
    if (missing.length) for (const raw of await dagDataSource.loadRawLinksByIds(missing)) {
      state.rawLinksById.set(raw.raw_causal_link_id, raw);
    }
  } catch (error) {
    console.warn("Could not load excluded findings.", error);
  }
  if (state.selectedEdgeId || state.selectedEvidenceGroupId || els.edgeInspector.hidden) return;
  replaceChildren(els.edgeInspector, h("strong", { textContent: "Excluded findings" }),
    ...ids.filter(id => state.project.finding_decisions?.[id]).map(id => {
      const raw = state.rawLinksById.get(id);
      const source = state.variableById.get(raw?.source_variable_id)?.concept_label || raw?.source_variable_id || "";
      const target = state.variableById.get(raw?.target_variable_id)?.concept_label || raw?.target_variable_id || "";
      const label = raw ? `${truncate(raw.paper_title || raw.paper_id || id, 44)} · ${source} → ${target}` : id;
      const code = state.project.finding_decisions[id]?.reason_code;
      const reason = code === "not_relevant_to_target_population" ? "Not relevant to target population"
        : code === "concept_miscategorized" ? "Concept miscategorized"
          : code === "other" ? "Other" : "";
      const restore = h("button", { className: "text-button", type: "button", textContent: "Restore" });
      restore.addEventListener("click", () => {
        const before = takeSnapshot();
        if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, null)) === false) return;
        addDecision("finding_restored", { raw_causal_link_id: id });
        addToUndoHistory("Restored finding", before, "finding-decision");
        renderAll();
        persistFindingDecision();
        if (Object.keys(state.project.finding_decisions || {}).length) void showExcludedFindings();
        else { els.edgeInspector.hidden = true; els.closeEvidencePane.hidden = true; }
      });
      return h("div", { className: "excluded-finding-item" },
        h("span", { textContent: `${label}${reason ? ` · ${reason}` : ""}` }), restore);
    }));
}

// ─── DAG vis.js rendering ─────────────────────────────────────────────────────

function clampNumber(...args) { return dagNetworkController.clampNumber(...args); }
function visNetworkOptions(...args) { return dagNetworkController.visNetworkOptions(...args); }
function dagStudyArrowCorridor(...args) { return dagNetworkController.dagStudyArrowCorridor(...args); }
function routedDagData(...args) { return dagNetworkController.routedDagData(...args); }
function routedDagDataFromRoutes(...args) { return dagNetworkController.routedDagDataFromRoutes(...args); }
function dagVisibleGroups() { return dagNetworkController.dagVisibleGroups(); }
function highlightConfounderPaths(id) { return dagNetworkController.highlightConfounderPaths(id); }
function clearConfounderPathHover() { return dagNetworkController.clearConfounderPathHover(); }
function clearLogicalDagEdgeHover() { return dagNetworkController.clearLogicalDagEdgeHover(); }
function renderDag(options) { return dagNetworkController.renderDag(options); }
function refreshDagEdgeSelection(options) { return dagNetworkController.refreshEdgeSelection(options); }
function minimumDagScale() { return dagNetworkController.minimumDagScale(); }

// ─── Edge inspector + provenance ──────────────────────────────────────────────

let pendingEdgeEvidencePromise = null;

function renderSelectedEdgePanels() {
  inspectorController.renderEdge();
  inspectorController.renderProvenance();
}

function excludeGroupConcept(groupId, variableId, label) {
  const group = groupById(groupId);
  if (!group?.variable_ids.includes(variableId)) return;
  if (state.publishedSchemaHydrating || state.publishedSchemaLoadFailed) return;
  if (!window.confirm(`Exclude “${label}” from “${group.label || groupId}”? This removes the concept from the schema and updates the DAG.`)) return;
  const before = takeSnapshot();
  const next = projectOps.removeMembers(state.project, groupId, [variableId], nowIso());
  if (applyProjectOperation(next) === false) return;
  addDecision("concept_excluded", { group_id: groupId, variable_id: variableId });
  addToUndoHistory(`Excluded concept from "${group.label || groupId}"`, before);
  renderAll();
  if (state.activeGroupId && !persistentViewer.editorOpen) {
    void persistentViewer.commitDecision().then(() =>
      publicationController.workingCopyChanged()).catch(error =>
      console.error("Could not save concept exclusion", error));
  }
}

function renderSelectedEdge() {
  if (!state.selectedEdgeId && state.selectedEvidenceGroupId && inspectorController.renderGroupDefinition()) return;
  const selected = (state.project?.links || []).find(edge => edge.edge_id === state.selectedEdgeId);
  const owners = new Map((state.project?.groups || []).flatMap(group =>
    (group.variable_ids || []).map(id => [id, group.group_id])));
  const rawIds = [...new Set([...(selected?.a_to_b_raw_link_ids || []), ...(selected?.b_to_a_raw_link_ids || []),
    ...(selected ? Object.keys(state.project.finding_decisions || {}) : [])])];
  const missing = rawIds.filter(id => !state.rawLinksById.has(id));
  const loadedVariableIds = () => [...new Set(rawIds.flatMap(id => {
    const link = state.rawLinksById.get(id);
    if (selected && state.project.finding_decisions?.[id]) {
      const sourceOwner = owners.get(link?.source_variable_id);
      const targetOwner = owners.get(link?.target_variable_id);
      if (!((sourceOwner === selected.group_a && targetOwner === selected.group_b)
        || (sourceOwner === selected.group_b && targetOwner === selected.group_a))) return [];
    }
    return link ? [link.source_variable_id, link.target_variable_id] : [];
  }).filter(Boolean))];
  const missingVariables = loadedVariableIds().filter(id => !state.variableById.has(id));
  if ((missing.length || missingVariables.length) && !pendingEdgeEvidencePromise) {
    const loadingEdgeId = state.selectedEdgeId;
    state.pendingEdgeEvidence = true;
    const load = (missing.length ? dagDataSource.loadRawLinksByIds(missing) : Promise.resolve([])).then(async links => {
      for (const link of links) state.rawLinksById.set(link.raw_causal_link_id, link);
      // Show paper and study rows immediately; labels can arrive separately.
      renderSelectedEdgePanels();
      const variableIds = loadedVariableIds().filter(id => !state.variableById.has(id));
      if (variableIds.length) {
        const variables = await dagDataSource.loadVariableProvenance(variableIds);
        for (const variable of variables) state.variableById.set(variable.variable_id, variable);
      }
    }).catch(error => {
      console.warn("Could not lazily load aggregate-edge evidence.", error);
    }).finally(() => {
      if (pendingEdgeEvidencePromise !== load) return;
      pendingEdgeEvidencePromise = null;
      state.pendingEdgeEvidence = false;
      // A changed selection needs its own query. Re-rendering the same edge
      // must not retry forever if a record is missing or a request failed.
      if (state.selectedEdgeId === loadingEdgeId) renderSelectedEdgePanels();
      else renderSelectedEdge();
    });
    pendingEdgeEvidencePromise = load;
  }
  renderSelectedEdgePanels();
}

function dismissEvidencePane() {
  inspectorController.clearPendingExclude();
  state.selectedEdgeId = null;
  state.selectedEvidenceGroupId = null;
  state.comparisonVariableIds = [];
  state.selectedVariableIds.clear();
  els.edgeInspector.hidden = true;
  els.provenancePanel.hidden = true;
  els.closeEvidencePane.hidden = true;
  refreshDagEdgeSelection();
}

// ─── Export / Import ──────────────────────────────────────────────────────────

let importProjectRevision = 0;

async function importProject(event) {
  const revision = ++importProjectRevision;
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (revision !== importProjectRevision) return;
    applyLoadedProject(payload);
    const layoutSource = state.variableLayoutSource;
    if (layoutSource && layoutSource !== state.data.layout?.active_source) {
      await loadDagData(layoutSource);
      if (revision !== importProjectRevision) return;
    }
    renderAll();
  } catch (error) {
    window.alert(error?.message || "Could not import project.");
  }
}

function initializeProjectShape() {
  return projectController.createProject();
}

function renderExportStatus() {
  const cycle = detectDirectedCycle();
  const bidirectional = state.project.links.some((l) => l.direction_type === "BIDIRECTIONAL" && l.display_status !== "excluded");
  els.strictDagStatus.textContent = cycle || bidirectional
    ? "Strict DAG export unavailable until bidirectional links and cycles are resolved."
    : "Strict DAG export conditions are currently satisfied.";
}

// ─── Decision log ──────────────────────────────────────────────────────────────

function addDecision(type, payload) {
  projectController.addDecision(type, payload);
}

// ─── Group helpers ─────────────────────────────────────────────────────────────

function dagGroups() {
  return dagProjectView().groups.filter((g) => g.variable_ids?.length
    || ((state.publishedSchemaHydrating || state.publishedSchemaLoadFailed)
      && Number(g.member_count) > 0));
}

function dagProjectView() {
  return uoaController.projectView();
}

function groupById(groupId) {
  return state.project.groups.find((g) => g.group_id === groupId) || null;
}

function selectedEdge() {
  return inspectorController.selectedEdge();
}

// ─── Map helpers ──────────────────────────────────────────────────────────────


function detectDirectedCycle(groups = dagGroups(), links = state.project.links) {
  const graph = new Map();
  for (const g of groups) graph.set(g.group_id, []);
  for (const link of links) {
    if (excludedForConnectivity(link)) continue;
    if (link.direction_type === "BIDIRECTIONAL" && !link.is_target_relation) return true;
    if (link.direction_type === "A_TO_B") graph.get(link.group_a)?.push(link.group_b);
    if (link.direction_type === "B_TO_A") graph.get(link.group_b)?.push(link.group_a);
  }
  const visiting = new Set();
  const visited = new Set();
  function dfs(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) || []) { if (dfs(next)) return true; }
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  for (const node of graph.keys()) { if (dfs(node)) return true; }
  return false;
}

// ─── Map mode controls ────────────────────────────────────────────────────────

function setMapMode(mode) {
  mapViewController.setMode(mode);
}

function isDrawMode(mode = state.map.mode) {
  return mapViewController.isDrawMode(mode);
}

// During DV/IV selection the user can draw a boundary before picking a seed; the
// enclosed variables become the seed set and open the target group directly.
function isSeedSelectionPhase() {
  return mapViewController.isSeedSelectionPhase();
}

function renderMapModeControls() {
  mapViewController.renderModeControls();
}

// ─── Map rendering ────────────────────────────────────────────────────────────

function resizeMap() {
  mapViewController.resize();
}

function canvasWidth() { return mapViewController.canvasWidth(); }
function canvasHeight() { return mapViewController.canvasHeight(); }

function visibleVariableBounds() {
  return mapViewController.visibleBounds();
}

function constrainMapTransform(transform) {
  return mapViewController.constrain(transform);
}

function globalWorldSpan() {
  return mapViewController.worldSpan();
}

function fitMap(variableIds = null) {
  mapViewController.fit(variableIds);
}

function fitNeighborhood(variableIds, neighborLimit = 48) {
  mapViewController.fitNeighborhood(variableIds, neighborLimit);
}

function zoomMap(screenX, screenY, factor, interactive = false) {
  mapViewController.zoom(screenX, screenY, factor, interactive);
}

function worldToScreen(x, y) {
  return mapViewController.worldToScreen(x, y);
}

function screenToWorld(x, y) {
  return mapViewController.screenToWorld(x, y);
}

function scheduleMapDraw(includeLabels = false) {
  mapViewController.schedule(includeLabels);
}

function scheduleSettledMapDraw(delayMs = 100) {
  mapViewController.scheduleSettled(delayMs);
}

function drawMap(options) {
  const result = mapUiController.drawMap(options);
  persistentViewer.viewerChanged(true);
  return result;
}
function drawMapPoints(ctx, width, height) { return mapUiController.drawMapPoints(ctx, width, height); }
function ensureGlobalVoronoiCells() { return mapUiController.ensureGlobalVoronoiCells(); }
function applyBrush() {
  schemaBatchDepth += 1;
  try { return mapUiController.applyBrush(); }
  finally {
    schemaBatchDepth -= 1;
    if (!schemaBatchDepth && !state.definitionDraft && !state.activeGroupId) {
      void persistentViewer.commitDecision().catch(error =>
        console.error("Could not save brush edits", error));
    }
  }
}
function groupColor(group) { return mapUiController.groupColor(group); }
function repAtPoint(clientX, clientY) { return mapUiController.repAtPoint(clientX, clientY); }
function clearHoverIntent() { return mapUiController.clearHoverIntent(); }
function updateMapHover(event) { return mapUiController.updateMapHover(event); }
function nearestVariable(clientX, clientY, threshold) { return mapUiController.nearestVariable(clientX, clientY, threshold); }
function showMapTooltip(variable, clientX, clientY) { return mapUiController.showMapTooltip(variable, clientX, clientY); }
function hideMapContextMenu() { return mapUiController.hideMapContextMenu(); }
function flagVariableLowQuality(variableId) { return mapUiController.flagVariableLowQuality(variableId); }
function restoreRejectedVariable(variableId) { return mapUiController.restoreRejectedVariable(variableId); }
function showMapContextMenu(variable, clientX, clientY, variableIds = null) {
  return mapUiController.showMapContextMenu(variable, clientX, clientY, variableIds);
}

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function groupCoherence(variableIds) {
  return candidates.groupCoherence(variableIds, state.similarityEdgeMap);
}



function groupCentroid(variableIds) { return mapGeometry.centroid(variableIds, state.variableById); }

function distance(a, b) { return mapGeometry.distance(a, b); }

const uoaController = createUoaController({
  state, elements: els, visibleVariables, groupById, clusterRep, truncate, renderAll,
});

const toolbarController = createToolbarController({
  state, elements: els, dagGroups, groupById, visibleVariables, uoaMatches,
  clusterRep, rejectedVariableIdSet,
});

const definitionWorkflowController = createDefinitionWorkflowController({
  state, elements: els, activeGroup, clusterRep, invalidateMapCaches, renderAll, drawMap,
  setMapMode, fitMap, groupById, persistProjectLocally, visibleVariables,
  searchVariables: searchVisibleVariables,
  clusterDisplayVariable, expandToClusterMembers, nowIso, applyProjectOperation,
  takeSnapshot, addToUndoHistory, clean, normalized, truncate, resizeMap,
  hydrateVariableDetails: ids => hydrateVariableDetails(ids, { skipNeighbors: true }),
  hydrateNeighbors: hydrateVariableNeighbors,
  commitSchema: async () => {
    await persistentViewer.commitDecision();
    publicationController.workingCopyChanged();
  },
  onCommitFailureRestored: () => persistentViewer.clearSaveFailure(),
  prewarmEvidence: async () => {
    await dagDataSource.ensureEvidenceConnection();
    // DuckDB fetches the remote layout metadata when it creates this view.
    // Do that while the source picker is open instead of after Continue.
    await dagDataSource.ensureVariableLayouts();
  },
});

const projectController = createDagProjectController({
  state, storage: window.localStorage, storagePrefix: PROJECT_STORAGE_PREFIX,
  nowIso, invalidateMapCaches, renderAll, rebuildLinkDecision, renderUndoRedo, renderActionHistory,
});

const inspectorController = createDagInspectorController({
  state, elements: els, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildLinkDecision, renderAll,
  persistFindingDecision,
  loadConceptLabels: ids => dagDataSource.loadVariableProvenance(ids),
  loadVisibleLinkEndpoints: ids => dagDataSource.loadRawLinkEndpointsByIds(ids),
  excludeConcept: excludeGroupConcept,
});

const mapViewController = createDagMapViewController({
  state, elements: els, activeGroup, visibleVariables, isRejectedVariable, drawMap,
});

const groupEditorController = createDagGroupEditorController({
  state, elements: els, applyProjectOperation, groupById, takeSnapshot,
  expandToClusterMembers, nowIso, clean, setMapMode, fitNeighborhood, fitMap,
  addToUndoHistory, renderAll, addDecision, setWorkflowMode, groupedVariableIds,
  searchVariables, clusterMemberIds, rejectedVariableIdSet, uoaMatches,
  fitSearchContext, applyActiveGroupingSet, rebuildProject, createDensityCandidateGroup,
  escapeHtml, truncate, hydrateVariableDetails,
  beginEditor: () => persistentViewer.beginEditor(),
  onAnchorsReady: () => shellController.showMobilePanel("dag"),
});

const mapUiController = createDagMapUiController({
  state, elements: els,
  beginDraw: (includeLabels) => mapViewController.beginDraw(includeLabels),
  canvasWidth, canvasHeight, worldToScreen, screenToWorld, visibleClusterReps,
  dagGroups, activeGroup, uoaMatches, clusterRep, clusterMemberIds,
  clusterDisplayVariable, clusterExactStringGroups, expandToClusterMembers, groupById,
  applyProjectOperation, nowIso, takeSnapshot, addToUndoHistory, addDecision, addVariableToGroup,
  addVariableSetToGroup, removeVariableFromGroup, beginTargetGroup, setMapMode,
  renderAll, rebuildProject, invalidateMapCaches, rejectedVariableEntries,
  rejectedVariableIdSet, isRejectedVariable, clean, escapeHtml, truncate,
  groupColors: GROUP_COLORS, groupPalette: GROUP_PALETTE,
  schemaChanged: () => { void persistentViewer.commitDecision().catch(error =>
    console.error("Could not save restored variable", error)); },
});

const setupGroupController = createDagSetupGroupController({
  state, elements: els, escapeHtml, normalized, truncate, groupById,
  assignGroupAsAnchor, assignGroupAsInstrument, setMapMode, renderAll,
  roleLabels: ROLE_LABELS, dagProjectView, startDefinition,
  canEditSplit: group => Boolean(projectOps.editableSplitContext(state.project, group)),
  searchAnchorGroups, beginEditor: () => persistentViewer.beginEditor(),
});

const dagNetworkController = createDagNetworkController({
  state, elements: els, visApi: vis, clusterRep, groupColor, dagGroups, groupById,
  drawMap, setMapMode, renderAll,
  onViewportChange: continuous => persistentViewer.viewerChanged(continuous),
  selectEdge: () => {
    state.selectedEvidenceGroupId = null;
    // The interaction clears vis's segment selection and redraws the network.
    renderCoordinator.selectEdge({ redraw: false });
    persistentViewer.viewerChanged();
  },
  selectGroup: id => {
    state.selectedEdgeId = null;
    state.comparisonVariableIds = [];
    state.selectedEvidenceGroupId = id;
    renderCoordinator.selectEdge();
    persistentViewer.viewerChanged();
  },
});

// Programmatic edge selection keeps browser regression tests on the same
// inspector path as a graph click, without depending on canvas coordinates.
export function inspectDagEdge(edgeId) {
  state.selectedEvidenceGroupId = null;
  state.selectedEdgeId = edgeId;
  renderCoordinator.selectEdge();
}

export function whenDagRendered() {
  return dagNetworkController.whenRendered();
}

export function isDagEdgeRendered(edgeId) {
  return dagNetworkController.isEdgeRendered(edgeId);
}

export function renderedDagEdgeIds() {
  return dagNetworkController.renderedEdgeIds();
}

const shellController = createDagShellController({
  state, elements: els, resizeMap, fitMap, renderDag,
  getNetwork: () => dagNetworkController.getNetwork(),
  dismissEvidencePane,
});

let publicationController;
const exportController = createDagExportController({
  state, elements: els, rejectedVariableEntries, rejectedVariableIdSet,
  projectPayload, aggregateGroupLinks, computeVisibleLinks, nowIso,
  getPublicPermalink: async () => (await publicationController?.publicPermalink())?.permalink || null,
  getDagPngBytes: () => renderDagPng(dagNetworkController.getNetwork(), els.dagNetwork),
  ensureEvidenceLoaded: async () => {
    while (state.compiledDagUpdatePromise) {
      const pending = state.compiledDagUpdatePromise;
      await pending;
      if (state.compiledDagUpdatePromise === pending) break;
    }
    aggregateGroupLinks();
    computeVisibleLinks();
    const rawIds = [...new Set((state.visibleLinks || []).flatMap(link => [
      ...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || []),
    ]))];
    const missing = rawIds.filter(id => !state.rawLinksById.has(id));
    if (!missing.length) return;
    const links = await dagDataSource.loadRawLinksByIds(missing);
    for (const link of links) {
      state.rawLinksById.set(link.raw_causal_link_id, link);
      if (!state.rawLinks.some(existing => existing.raw_causal_link_id === link.raw_causal_link_id)) {
        state.rawLinks.push(link);
      }
    }
  },
});

publicationController = createPublicationController({
  elements: {
    get publish() { return els.publishSchema; },
    get status() { return els.publicationStatus; },
    get badge() { return els.schemaPublicationBadge; },
    get permalink() { return els.publishedSchemaPermalink; },
    get confirmation() { return els.publishSchemaDialog; },
    get share() { return els.copyPermalink; },
  },
  getWorkingSchema: currentWorkingGroupingSchema,
  getCompiledDag: () => state.compiledDagValid && !state.compiledDagUpdating ? state.compiledDag : null,
  canPublish: () => !state.publishedSchemaHydrating && !state.publishedSchemaLoadFailed
    && persistentViewer.canPublish,
  getCompileInput: async () => {
    if (state.compiledDagValid && !state.compiledDagUpdating) {
      return { project: dagProjectView(), linkLookup: state.linkLookup, rawLinksById: state.rawLinksById };
    }
    const rawLinks = await dagDataSource.loadAllRawLinks();
    return { project: dagProjectView(), rawLinks };
  },
  getPublicationState: () => state.project?.publication || null,
  getPermalinkState: () => {
    const network = dagNetworkController.getNetwork();
    state.dagViewport = network ? { scale: network.getScale(), position: network.getViewPosition() } : null;
    return state;
  },
  setPublicationState: publication => {
    state.project.publication = publication;
    void persistentViewer.markPublished(publication);
  },
  saveWorkingState: persistProjectLocally,
});

const groupingSetController = createGroupingSetController({
  state, elements: els, publicationController, exportController,
  rejectedVariableEntries, rejectedVariableIdSet, applyProjectOperation,
  normalizeProjectDuplicateAssignments, groupById, nowIso,
});

const projectBootstrap = createProjectBootstrap({
  state, initElements, installHandlers, installDefinitionHandlers, resizeMap,
  restoreProjectLocally, initializeProject, loadLatestSchemaGroups,
  normalizeProjectDuplicateAssignments, saveProjectLocally, publicationController,
  renderAll, constrainMapTransform, drawMap, fitMap, dagNetworkController,
  buildDuplicateClusters, linkKey, pairKey, loadVariableSearchCatalog,
  onLocalSchemaLoaded: record => persistentViewer.setLoadedRecord(record),
  onReady: () => {
    persistentViewer.start();
    void publicationController.refreshPublicationState();
    if (!state.project?.links?.some(link => (link.a_to_b_raw_link_ids?.length || 0)
      + (link.b_to_a_raw_link_ids?.length || 0) > 0)) return;
    const prewarm = () => { void dagDataSource.ensureEvidenceConnection().catch(() => {}); };
    if ("requestIdleCallback" in window) requestIdleCallback(prewarm, { timeout: 3000 });
    else setTimeout(prewarm, 0);
  },
});

// Stable adapter names keep event wiring and browser smoke-test hooks simple.
const captureExportInput = () => exportController.captureInput();
const exportBib = () => exportController.exportBib();
const exportMd = () => exportController.exportMd();
const exportTex = () => exportController.exportTex();
const exportProject = () => exportController.exportProject();
const exportWorkingMap = () => exportController.exportWorkingMap();
const eventController = createDagEventController({
  state, elements: els, dagNetwork: dagNetworkController,
  renderAssignmentCoverage, activeGroup, renderNeighborSuggestions, drawMap, renderAll,
  renderSearch, fitSearchContext, prefetchVariableSearch: loadVariableSearchCatalog,
  toggleAnchorSearchMode, finishSchemaChoice, changeAnchor, renderSetupGroupPicker,
  setWorkflowMode, renderGroupList, closeGroupEditor, discardGroupEditor, selectActiveAnchor,
  addTopNeighborsToActiveGroup, removeTopNeighborsFromActiveGroup, clearActiveGroupVariables,
  renderGroupSeedSearch, renderRejectedVariablesPanel, fitMap, applyProjectOperation,
  saveProjectLocally, applyActiveGroupingSet, rebuildProject, exportGroupingFolder,
  copyPermalink, loadDagData, invalidateMapCaches, zoomMap, canvasWidth,
  canvasHeight, toggleFullscreenPanel, renderMapToolbarToggles, clampNumber, setMapMode,
  undo, redo, renderActionHistory, renderDag, setFullscreenPanel,
  createCustomGroup, exportProject, exportWorkingMap, importProject, exportBib, exportMd,
  exportTex, resizeMap, installDagHandlers, initPanelResizers, hideMapContextMenu,
  showMapContextMenu, isDrawMode, nearestVariable, repAtPoint, scheduleMapDraw,
  isSeedSelectionPhase, constrainMapTransform, updateMapHover, applyBrush, takeSnapshot,
  addToUndoHistory, clusterRep, clearHoverIntent, addVariableToGroup, clean,
  startEditSplit, startDefinition, dismissEvidencePane,
  showExcludedLinks, showExcludedFindings,
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

init().catch((error) => {
  const missing = String(error?.message || error).startsWith("Local schema unavailable");
  const input = h("input", { type: "file", accept: "application/json,.json" });
  if (missing) input.addEventListener("change", async () => {
    try { if (input.files?.[0]) window.location.assign(await importDraftFile(input.files[0])); }
    catch (importError) { window.alert(`Could not import draft: ${importError.message}`); }
  });
  replaceChildren(document.body,
    h("main", { className: "panel-section" }, h("h1", { textContent: missing ? "Local schema unavailable" : "Echo could not open this view" }),
      h("p", { textContent: error?.message || error }),
      missing ? h("label", { textContent: "Import draft" }, input) : null,
      missing ? h("a", { href: "/?new=1", textContent: "Start new view" }) : null));
});
