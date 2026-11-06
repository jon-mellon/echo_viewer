import { listOwnPublishedSplits, loadPublishedSplitMembership } from "/published_split_browser.mjs";
import { previousSplitsForRole } from "/previous_split_candidates.mjs";
"use strict";

import * as projectOps from "/dag_project.mjs";
import { aggregateGroupLinks as deriveGroupLinks, rawLinksBetween as lookupRawLinks,
  paperTableKeys as lookupPaperTableKeys, applyLinkDecisions, linkKey, pairKey } from "/dag_link_aggregation.mjs";

import * as exportData from "/dag_exports.mjs";
import { createDagExportController } from "/dag_export_controller.mjs";
import { renderDagPng } from "/dag_export_image.mjs";
import { createRenderCoordinator } from "/render_coordinator.mjs";
import * as candidates from "/dag_candidates.mjs";
import * as inspector from "/dag_inspector.mjs";
import * as searchModel from "/dag_search.mjs";
import * as workflow from "/dag_workflow.mjs";
import * as visibility from "/variable_visibility.mjs";
import { createDagAppState, ensureDiagnosticFilter } from "/dag_app_state.mjs";
import { createDagProjectController } from "/dag_project_controller.mjs";
import { createDagInspectorController, STUDY_DESIGN_EDGE_ID } from "/dag_inspector_controller.mjs";
import { createDagShellController } from "/dag_shell_controller.mjs";
import { createDagSetupGroupController } from "/dag_setup_group_controller.mjs";
import { createDagGroupEditorController } from "/dag_group_editor_controller.mjs";
import { deriveDagView, excludedForConnectivity } from "/dag_view.mjs";
import { createDagNetworkController, isDagDisplayGroup } from "/dag_network_controller.mjs?v=compiled-first-v2";
import { createDagEventController } from "/dag_event_controller.mjs";
import { createGroupPalette } from "/group_palette.mjs";
import { createUoaController } from "/uoa_controller.mjs";
import { createToolbarController } from "/toolbar_controller.mjs";
import { createDefinitionWorkflowController } from "/definition_workflow_controller.mjs";
import { createCustomVariablesPresenter } from "/custom_variables_presenter.mjs";
import { createTaskViews } from "/task_views.mjs";
import { directionalPaperCounter, linksNeedingExactCounts } from "/causal_neighborhood.mjs";
import { createPublicationController } from "/dag_publication.mjs";
import { createGroupingSetController } from "/grouping_set_controller.mjs";
import { createProjectBootstrap } from "/project_bootstrap.mjs?v=compiled-first-v2";
import { dagDataSource } from "/dag_data_source.mjs?v=browser-v2";
import { incrementCompiledDag } from "/compiled_dag.mjs";
import { createPersistentViewer } from "/persistent_viewer.mjs";
import { importDraftFile, makeDraftExport } from "/draft_exchange.mjs";
import { listPreviousSessions, listLocalSchemas } from "/local_schema_store.mjs";
import { escapeHtml } from "/text_utils.mjs";
import { relevantExclusions } from "/dag_export_relevance.mjs";
import { DIAGNOSTIC_STATUSES, STATUS_MENU_LABELS, diagnosticStatusRows } from "/confounder_status.mjs";
import { diagnosticKey } from "/confounder_status.mjs";
import { effectiveStudyGraph } from "/study_graph.mjs";
import { createVariableReviewController } from "/variable_review_controller.mjs";
import { h, replaceChildren, safeUrl, setSafeUrl } from "/dom_builder.mjs";
import { hydrateSearchResult, variableSearchCatalog } from "/variable_search_catalog.mjs";
import { installLayoutDebug } from "/layout_debug.mjs";


const ROLE_LABELS = {
  possible_confounder: "Confounder candidate",
  possible_mediator: "Mediator candidate",
  possible_common_consequence_or_collider: "Common consequence",
  other_possible_cause_of_dv: "Other cause of Dep var",
  other_possible_cause_of_iv: "Other cause of Ind var",
};

const GROUP_COLORS = {
  iv: "#0072B2",
  dv: "#E69F00",
  assigned: "#009E73",
  active: "#b83b5e",
};

// Distinct colors for groups (Ind var and Dep var use GROUP_COLORS above): the Okabe-Ito
// hues in roughly the original order (teal, rose, blue, amber, ...), then deeper and lighter variants.
const GROUP_PALETTE = (() => {
  const base = ["#009E73", "#CC79A7", "#0072B2", "#E69F00", "#56B4E9", "#D55E00", "#999999"];
  const mix = (hex, target, t) => {
    const n = parseInt(hex.slice(1), 16);
    const t0 = parseInt(target.slice(1), 16);
    const ch = shift => Math.round(((n >> shift) & 255) + (((t0 >> shift) & 255) - ((n >> shift) & 255)) * t).toString(16).padStart(2, "0");
    return `#${ch(16)}${ch(8)}${ch(0)}`;
  };
  return [...base, ...base.map(c => mix(c, "#000000", 0.35)), ...base.map(c => mix(c, "#ffffff", 0.3))];
})();

// The current interface has one canonical entry point at the site root.
const state = createDagAppState("dag2");
const groupPalette = createGroupPalette({ state, colors: GROUP_COLORS, palette: GROUP_PALETTE });
let schemaBatchDepth = 0;
let schemaCommitQueued = false;
const PROJECT_STORAGE_PREFIX = state.interfaceMode === "dag2" ? "dag2-project-v1" : "dag-builder-project-v2";

window.__dagBuilderState = state;
installLayoutDebug();

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
    "definitionBlock", "definitionTitle", "definitionCancel", "definitionDescribeStep", "definitionDescribeNext", "definitionResumeList",
    "definitionAiWork", "definitionSourcesStep", "definitionDescribeBack",
    "definitionSourceSearch", "definitionSourceList", "definitionContinue", "definitionSourceLoadStatus", "definitionBrowsePanel", "definitionBrowseStatus", "definitionBrowseResults", "definitionBrowseJump",
    "definitionPartitionStep", "definitionLoadStatus", "definitionJevPanel", "definitionIncludedPanel",
    "definitionConceptsIntro", "definitionCountIncluded", "definitionCountExcluded", "definitionCountUnreviewed",
    "definitionSourcesSummary",
    "definitionIncludedFilter", "definitionSaveHint",
    "definitionAiStepConnect", "definitionAiStepLimit", "definitionAiStepSample", "definitionAiStepFull",
    "definitionAiConnectSummary", "definitionAiLimitSummary", "definitionAiSampleSummary", "definitionAiFullSummary",
    "definitionAiLimitText", "definitionAiSettingsLink", "definitionAiSampleHost", "definitionAiFullHost",
    "definitionAiFullText", "definitionAiApplyNote",
    "definitionAiDescription", "definitionAiConnect", "definitionAiRecheck", "definitionAiDisconnect", "definitionAiStatus", "definitionAiCost",
    "definitionAiRun", "definitionAiPreview", "definitionAiSummary", "definitionAiRows", "definitionAiFullRun", "definitionAiMore",
    "definitionAiReviewTools", "definitionAiReviewFilter", "definitionAiReviewPage", "definitionAiReviewPrev", "definitionAiReviewNext",
    "definitionAiApply", "definitionAiDiscard",
    "definitionSelectedVariables",
    "definitionBack", "definitionSelectedTitle", "definitionSaveStatus",
    "definitionNewLabel", "definitionNewDescription", "definitionResidualLabels",
    "definitionValidation", "definitionSave",
    "openCustomVariables", "customVariablesView", "customVariablesTitle", "customVariablesCreate", "customVariablesClose",
    "customVariablesFilter", "customVariablesStatus", "customVariablesTable",
    "workflowHint", "dagStatusBadge",
    "variablePanel", "variableDefineNew", "variablePanelDisclosure", "variablePanelCount", "variablePanelList", "variablePanelPagination",
    "anchorBar", "exploreFocusSelector", "exploreFocusName", "anchorDvLabel", "anchorIvLabel", "anchorInstrumentLabel", "instrumentRow", "changeInstrument", "changeDv", "changeIv", "editSplitDv", "editSplitIv", "historyStatus",
    // Group list panel
    "groupListPanel", "groupListSort", "groupList", "groupListCount", "createGroupBtn",
    // Grouping schema
    "groupingPanel", "groupingSetSelect", "exportGroupingFolder", "publishSchema",
    "copyPermalink", "groupingSummary", "publicationStatus", "schemaPublicationBadge",
    "publishSchemaDialog", "shareUnpublishedDialog", "importSchemaAction", "importSchemaDialog",
    "importSchemaChooseFile",
    // Rejected variables
    "rejectedVariablesPanel", "rejectedVariableSearch", "rejectedVariablesList",
    // Graph filters
    "toggleConfoundersOnly", "toggleCollidersOnly", "toggleExclusionViolations", "toggleExogeneity", "confounderPathLength", "toggleSparseEdges", "minimumEdgePapers", "toggleBottleneckedConfounders", "toggleIrrelevantConfounderLinks", "toggleAllExclusionLinks", "showExcludedLinks", "showExcludedFindings", "dagSelectMode", "dagBrushMode", "dagEraseMode", "fullscreenVariableMap",
    // Undo / history
    "undoBtn", "redoBtn", "historyToggle", "actionHistory",
    // Right: group editor
    "groupEditorSection", "groupEditorTitle", "groupEditorHint", "groupDescription", "cancelGroupEdit",
    "discardGroupEdit", "localSaveStatus", "retryLocalSave", "saveIndependentCopy",
    "exportLocalDraft", "importLocalDraft", "previousSessionsPanel",
    "previousSessionsList",
    "groupLabelInput", "groupNotesInput", "useGroupAsAnchor",
    "zoomGroup", "editSplit",
    "addNeighbors", "removeNeighbors", "clearGroupSelection",
    "groupSeedInput", "groupSeedResults",
    "includedVariables", "neighborSuggestions",
    // Right: DAG workspace
    "focusSearchBlock", "focusInput", "focusInputLabel", "focusGroupPicker", "focusPickerCancel",
    "dagWorkspaceSection", "dagNetwork", "dagViewTitle", "diagnosticOverlapKey", "confounderConfig", "confounderDisclosure", "confounderSummary", "confounderStatusList",
    "dagSvgZoomIn", "dagSvgZoomOut", "dagSvgFit", "fullscreenDag", "dagTable", "dagViewGraph", "dagViewTable",
    "edgeInspector", "provenancePanel", "closeEvidencePane",
    // Export
    "exportProject", "exportWorkingMap", "projectImport",
    "exportBib", "exportMd", "exportTex",
    // Panel resizers
    "leftResizer", "rightResizer",
  ]) {
    els[id] = $(id);
  }
  els.confounderDisclosure.addEventListener("toggle", renderConfounderStatuses);
  els.exportLocalDraft?.addEventListener("click", exportLocalDraft);
  // History (previous sessions) is a top-bar menu; its list is rebuilt each time it opens.
  const historyMenu = /** @type {HTMLDetailsElement | null} */ (document.getElementById("historyMenu"));
  historyMenu?.addEventListener("toggle", async () => {
    if (!historyMenu.open) return;
    try {
      await persistentViewer.flushUrl();
      const sessions = (await listPreviousSessions())
        .filter(record => record.id !== persistentViewer.sessionId);
      replaceChildren(els.previousSessionsList);
      if (!sessions.length) replaceChildren(els.previousSessionsList,
        h("p", { className: "menu-note", textContent: "No earlier sessions" }));
      for (const record of sessions) {
        const url = new URL(record.url, window.location.origin);
        if (url.origin !== window.location.origin || url.searchParams.get("p") !== "1") continue;
        const title = record.title || "Untitled view";
        const when = formatSessionTime(record.updatedAt);
        // Only the exception is worth a label: most sessions use the published schema.
        const meta = url.searchParams.has("local_schema") ? `${when} · Local draft` : when;
        const button = h("button", { type: "button", className: "menu-item previous-session-entry", title },
          h("span", { className: "previous-session-title", textContent: title }),
          h("span", { className: "previous-session-meta", textContent: meta }));
        button.addEventListener("click", () => {
          if ((persistentViewer.editorDirty || state.definitionDraft)
            && !window.confirm("Discard uncommitted changes and open this previous view?")) return;
          sessionStorage.setItem("echo-pending-session-restore",
            JSON.stringify({ id: record.id, url: url.href }));
          window.location.assign(url.href);
        });
        els.previousSessionsList.append(button);
      }
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
  // Schema menu → Import schema…: the dialog explains what importing replaces,
  // then opens the same file picker as Import → Schema draft.
  els.importSchemaAction?.addEventListener("click", () => {
    if (els.importSchemaDialog?.showModal) els.importSchemaDialog.showModal();
    else els.importLocalDraft?.click();
  });
  els.importSchemaChooseFile?.addEventListener("click", () => {
    els.importSchemaDialog?.close("import");
    els.importLocalDraft?.click();
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
  if (state.visibleCache.variables) return state.visibleCache.variables;
  let variables = visibility.visibleVariables(
    state.variables, rejectedVariableEntries(), state.clusterOf, state.clusterMembers,
  );
  if (state.definitionDraft?.step === "partition" || state.definitionDraft?.step === "review") {
    const eligible = new Set(state.definitionDraft.eligible_variable_ids || []);
    variables = variables.filter(variable => eligible.has(clusterRep(variable.variable_id)));
  }
  state.visibleCache.variables = variables;
  return variables;
}

function visibleClusterReps() {
  if (state.visibleCache.clusterReps) return state.visibleCache.clusterReps;
  const representatives = visibleVariables().filter((variable) => variable.is_cluster_rep);
  state.visibleCache.clusterReps = representatives;
  return representatives;
}

function invalidateVisibleCaches() {
  state.visibleCache.variables = null;
  state.visibleCache.clusterReps = null;
  groupPalette.invalidate();
}

function groupColor(group) { return groupPalette.groupColor(group); }


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

function takeSnapshot(kind) {
  return projectController.snapshot(kind);
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
  const next = state.undoPointer < state.undoHistory.length - 1
    ? state.undoHistory[state.undoPointer + 1]?.description : null;
  if (els.historyStatus) els.historyStatus.textContent = [last && `Undo: ${last}`, next && `Redo: ${next}`].filter(Boolean).join(" · ");
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  if (last) els.undoBtn.title = `${els.undoBtn.title} (${shortcut}Z)`;
  if (next) els.redoBtn.title = `${els.redoBtn.title} (${shortcut}Shift+Z)`;
  els.undoBtn.setAttribute("aria-label", els.undoBtn.title);
  els.redoBtn.setAttribute("aria-label", els.redoBtn.title);
  if (state.showActionHistory) renderActionHistory();
}

/** Undo or redo until the given step is the current one (-1 is before any edit). */
function jumpToHistory(pointer) {
  let guard = state.undoHistory.length + 1;
  while (state.undoPointer > pointer && guard-- > 0) projectController.undo();
  while (state.undoPointer < pointer && guard-- > 0) projectController.redo();
  void persistentViewer.commitDecision().catch(error => console.error("Could not save history jump", error));
}

/** "Today, 4:29 PM", "Yesterday, 4:12 PM", "Oct 30, 9:05 AM", or with the year when it isn't this one. */
function formatSessionTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (daysAgo === 0) return `Today, ${time}`;
  if (daysAgo === 1) return `Yesterday, ${time}`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/** The edit-history menu: newest first; steps after the current one are undone and can be redone. */
function renderActionHistory() {
  if (!state.showActionHistory || !els.actionHistory) return;
  if (!state.undoHistory.length) {
    replaceChildren(els.actionHistory, h("p", { className: "menu-note", textContent: "No edits yet" }));
    return;
  }
  const entry = (pointer, description) => {
    const current = pointer === state.undoPointer;
    return h("li", {},
      h("button", { type: "button", className: `menu-item edit-history-entry${pointer > state.undoPointer ? " undone" : ""}`,
        attrs: current ? { "aria-current": "step" } : {},
        title: current ? "Current state" : pointer > state.undoPointer ? "Redo to here" : "Undo to here",
        onclick: () => { if (!current) jumpToHistory(pointer); } },
      h("span", { textContent: description })));
  };
  const rows = state.undoHistory.map((item, index) => entry(index, item.description)).reverse();
  replaceChildren(els.actionHistory, h("ol", { className: "edit-history-steps" }, rows, entry(-1, "Start of this session")));
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
  buildCandidateQueue, aggregateGroupLinks, computeVisibleLinks, renderConfounderStatuses, renderGroupList,
  renderRejectedVariablesPanel, renderDag, refreshDagEdgeSelection,
  renderVariableComparison,
  renderSelectedEdge, renderExportStatus,
  renderMapToolbarToggles, renderUndoRedo, saveProjectLocally,
  renderModeUI, renderAnchorBar, renderStatus, renderUoaStep, renderUoaFilterBar,
  renderVariablePanel: () => setupGroupController.renderVariablePanel(),
  renderSearch, renderSetupGroupPickers, renderSeedRows, renderGroupingSetControls,
  renderGroupEditor, renderRightPanel, renderDefinition,
});

function renderAll(options) {
  renderCoordinator.renderAll(options);
  taskViews.render();
  persistentViewer.viewerChanged();
}

function rebuildProject(options) {
  renderCoordinator.rebuildProject(options);
}

function renderExploreFocus() {
  renderAnchorBar();
  setupGroupController.renderFocusPicker();
  updateDagFilters();
}

function updateDagFilters(options) {
  renderCoordinator.updateDagFilters(options);
  taskViews.render();
  persistentViewer.viewerChanged();
}

function rebuildLinkDecision() {
  renderCoordinator.rebuildLinkDecision();
}

function renderMapToolbarToggles() { return toolbarController.render(); }


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
  if (taskViews.exploring()) { taskViews.changeFocus(); return; }
  const gid = side === "dv" ? state.project?.dv_group_id
    : side === "instrument" ? state.project?.instrument_group_id : state.project?.iv_group_id;
  const group = groupById(gid);
  if (side !== "instrument" && !group) return;
  Object.assign(state, workflow.transition(state, { type: "change-anchor", side, groupId: gid }));
  const input = side === "dv" ? els.dvInput : side === "instrument" ? els.instrumentInput : els.ivInput;
  if (input) input.value = "";
  renderAll({ rebuild: false });
  setTimeout(() => { input?.focus(); }, 60);
}

function renderRightPanel() {
  setupGroupController.renderRightPanel();
  renderConfounderStatuses();
}

/** Which status list applies: confounders or colliders, in the view that shows them. */
function statusKind() {
  return state.showConfoundersOnly ? "confounders" : state.showCollidersOnly ? "colliders" : null;
}

/** Record how a confounder or collider is handled; shared by the side panel and the table. Undoable. */
function setDiagnosticStatus(kind, groupId, status, text = "") {
  variableReviewController.edit(kind, groupId, status);
}

function commitDiagnosticReview(kind, groupId, decision) {
  const spec = DIAGNOSTIC_STATUSES[kind];
  if (!spec || !groupById(groupId)) return;
  const key = diagnosticKey(state.project, kind, groupId);
  const start = performance.now();
  const before = takeSnapshot();
  state.project[spec.field] = { ...(state.project[spec.field] || {}),
    [key]: decision };
  projectController.record(`Set ${spec.noun} status: ${groupById(groupId).label}`, before);
  updateDagFilters({ allowRemovedGroups: true });
  // Save after the screen updates, in a task of its own. Start the save first: while it is pending,
  // Publish is unavailable without rebuilding the whole schema to compare it.
  setTimeout(() => {
    void persistentViewer.commitDecision().catch(error => console.error(`Could not save ${spec.noun} status`, error));
    publicationController.workingCopyChanged();
  }, 0);
  performance.measure("echo:review:commit", { start, end: performance.now() });
  void dagNetworkController.whenRendered().then(() => performance.measure("echo:review:rendered", { start, end: performance.now() }));
  // Keep keyboard focus on the moved row. On touch, focusing a select reopens its picker, and there is no keyboard focus to keep.
  if (window.matchMedia?.("(pointer: coarse)").matches) return;
  void dagNetworkController.whenRendered().then(() => {
    const selector = dagNetworkController.dagDisplay() === "table" ? ".dag-table-status" : ".variable-disposition";
    document.querySelector(`${selector}[data-group-id="${CSS.escape(groupId)}"]`)?.focus();
  });
}

function renderConfounderStatuses() {
  // Review controls now live in the variable list.
  els.confounderConfig.hidden = true;
  els.confounderStatusList.replaceChildren();
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
  // Instrument selection changes the view, but not group membership or link
  // aggregation. Keep the existing project graph and candidate queue.
  renderAll({ rebuild: false });
  updateDagFilters();
  renderUndoRedo();
  shellController.showMobilePanel("dag");
}



function toggleAnchorSearchMode(side) {
  state.anchorSearchMode[side] = state.anchorSearchMode[side] === "existing" ? "new" : "existing";
  state.seeds[side].clear();
  state.searchMatches[side] = [];
  const input = side === "dv" ? els.dvInput : els.ivInput;
  input.value = "";
  renderAll({ rebuild: false, refreshView: true });
  setTimeout(() => input.focus(), 0);
}

// ─── DAG2 category definition ────────────────────────────────────────────────

function startDefinition(role) { return definitionWorkflowController.startDefinition(role); }
function startEditSplit(groupId = null) { return definitionWorkflowController.startEditSplit(groupId); }
function cancelDefinition() { return definitionWorkflowController.cancelDefinition(); }
function definitionSources() { return definitionWorkflowController.definitionSources(); }
function continueDefinition() { return definitionWorkflowController.continueDefinition(); }
function definitionResidualIds(source) { return definitionWorkflowController.definitionResidualIds(source); }
function definitionCanReview() { return definitionWorkflowController.definitionCanReview(); }
function renderDefinition() {
  definitionWorkflowController.renderDefinition();
  customVariablesPresenter.render();
}
function saveDefinition() { return definitionWorkflowController.saveDefinition(); }
function installDefinitionHandlers() {
  definitionWorkflowController.installDefinitionHandlers();
  customVariablesPresenter.install();
}

/** Delete a custom variable: its concepts return to where they came from. Undoable. */
async function deleteCustomVariable(groupId) {
  const group = groupById(groupId);
  const before = takeSnapshot();
  const next = projectOps.deleteSplitCategories(state.project, { groupId, timestamp: nowIso() });
  if (applyProjectOperation(next) === false) throw new Error("Variable memberships are still loading. Try again in a moment.");
  for (const key of ["focusedGroupId", "activeGroupId", "selectedEvidenceGroupId"]) {
    if (state[key] === groupId) state[key] = null;
  }
  addToUndoHistory(`Deleted variable "${group?.label || groupId}"`, before);
  invalidateVisibleCaches();
  renderAll();
  await persistentViewer.commitDecision();
  publicationController.workingCopyChanged();
}

// ─── Search ───────────────────────────────────────────────────────────────────

function renderSearch(side, { renderPicker = true } = {}) {
  const input = side === "iv" ? els.ivInput : els.dvInput;
  const container = side === "iv" ? els.ivResults : els.dvResults;
  const query = input.value.trim();
  if (query && state.variableSearchStatus === "idle") void loadVariableSearchCatalog();
  const selected = state.seeds[side];
  if (state.anchorSearchMode[side] !== "new") {
    state.searchMatches[side] = [];
    container.replaceChildren();
    if (renderPicker) renderSetupGroupPicker(side);
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
      }
    });
  });
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

const anchorGroupSearchIndex = new searchModel.AnchorGroupSearchIndex();
function searchAnchorGroups(project, side, query, variableById, limit = 12) {
  return anchorGroupSearchIndex.search(project, side, query, variableById, state.variableSearchStatus === "ready" ? variableSearchCatalog : null, limit);
}

// Definition source categories search constituent variables through the same
// catalog as the anchor pickers; hydrated variables alone are empty at startup.
const definitionSourceSearchIndex = new searchModel.AnchorGroupSearchIndex();
function searchDefinitionSourceGroups(groups, query, limit = 60) {
  if (normalized(query) && state.variableSearchStatus === "idle") void loadVariableSearchCatalog();
  return definitionSourceSearchIndex.searchGroups(groups, state.project.groups, query, state.variableById,
    state.variableSearchStatus === "ready" ? variableSearchCatalog : null, limit);
}

const exploreSearchIndex = new searchModel.AnchorGroupSearchIndex();
function searchExploreGroups(groups, query, limit = 200) {
  if (normalized(query) && state.variableSearchStatus === "idle") void loadVariableSearchCatalog();
  return exploreSearchIndex.searchGroups(groups, state.project.groups, query, state.variableById,
    state.variableSearchStatus === "ready" ? variableSearchCatalog : null, limit);
}

// Callers may wait on an in-flight load (later preloads queue behind it).
let variableSearchCatalogLoad = null;
function loadVariableSearchCatalog() {
  if (state.variableSearchStatus === "loading" || state.variableSearchStatus === "ready") {
    return variableSearchCatalogLoad || Promise.resolve();
  }
  variableSearchCatalogLoad = startVariableSearchCatalogLoad();
  return variableSearchCatalogLoad;
}

async function startVariableSearchCatalogLoad() {
  state.variableSearchStatus = "loading";
  state.variableSearchError = null;
  try {
    await variableSearchCatalog.loadSnapshot(state.data.snapshot.snapshot_id, {
      loadRecords: () => dagDataSource.loadVariableSearchRecords(),
    });
    await anchorGroupSearchIndex.prepare(state.project.groups, variableSearchCatalog);
    state.variableSearchStatus = "ready";
  } catch (error) {
    state.variableSearchStatus = "error";
    state.variableSearchError = error;
    console.error("Could not load variable search catalog.", error);
  }
  renderSearch("iv");
  renderSearch("dv");
  renderSetupGroupPicker("instrument");
  setupGroupController.renderFocusPicker();
  if (state.definitionDraft?.step === "sources") renderDefinition();
  taskViews.render();
}

function groupedVariableIds(excludeGroupId = null) {
  const grouped = new Set();
  for (const group of state.project?.groups || []) {
    if (excludeGroupId && group.group_id === excludeGroupId) continue;
    for (const variableId of group.variable_ids || []) grouped.add(variableId);
  }
  return grouped;
}

function restoreRejectedVariable(variableId) {
  const repId = clusterRep(variableId);
  const entry = rejectedVariableEntries().find((item) => clusterRep(item.variable_id) === repId);
  if (!entry) return;
  const memberIds = entry.member_variable_ids || [entry.variable_id];
  for (const groupId of entry.previous_group_ids || []) {
    const group = groupById(groupId);
    if (!group) continue;
    for (const memberId of memberIds) {
      if (!group.variable_ids.includes(memberId)) group.variable_ids.push(memberId);
    }
  }
  state.project = visibility.restoreRejection(state.project, repId, state.clusterOf, state.clusterMembers);
  invalidateVisibleCaches();
  addDecision("rejected_variable_restored", {
    variable_id: repId,
    member_variable_ids: memberIds,
    restored_group_ids: entry.previous_group_ids || [],
  });
  void persistentViewer.commitDecision().catch(error => console.error("Could not save restored variable", error));
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
        h("button", { className: "btn btn--sm", type: "button", dataset: { action: "restore" }, textContent: "Restore" }))))
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

/**
 * Identify's Cause, Outcome and Instrument fields. Each choice replaces that role
 * directly, so there is no step-by-step setup: the map appears as soon as both
 * a cause and an outcome are chosen.
 */
function chooseIdentifyVariable(side, groupId) {
  if (side === "instrument") {
    assignGroupAsInstrument(groupId);
    // Choosing an instrument ends setup; with the cause or outcome still empty it has not ended.
    if (!state.project.iv_group_id || !state.project.dv_group_id) {
      state.workflowMode = "setup";
      state.phase = state.project.iv_group_id ? "select_dv" : "select_iv";
      persistentViewer.viewerChanged();
    }
    return;
  }
  if (!groupId) {
    // The × in a Cause or Outcome field: the role is left empty until another variable is chosen.
    const label = groupById(state.project?.[`${side}_group_id`])?.label;
    const before = takeSnapshot("anchors");
    if (!applyProjectOperation(projectOps.clearAnchor(state.project, side))) return;
    state.identifyExclusion = null;
    // A link with a role missing must say it is mid-setup, or reopening it is refused.
    state.workflowMode = "setup";
    state.phase = state.project.iv_group_id ? "select_dv" : "select_iv";
    state.selectedEdgeId = null;
    state.selectedEvidenceGroupId = null;
    addToUndoHistory(`Remove "${label || side}" as ${side === "iv" ? "cause" : "outcome"}`, before, "anchors");
    renderAll({ reuseLinks: true });
    setupGroupController.renderIdentifyPicker();
    return;
  }
  if (groupId === state.project?.[`${side}_group_id`] && groupById(groupId)?.variable_ids?.length) {
    renderAll({ rebuild: false });
    return;
  }
  // Replacing a role, rather than stepping through setup, goes straight to the map.
  state.changingAnchorSide = side;
  assignGroupAsAnchor(side, groupId);
  state.changingAnchorSide = null;
  setupGroupController.renderIdentifyPicker();
}
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
  const linkDecisionOnly = oldProject && next.groups === oldProject.groups
    && Object.keys(next).length === Object.keys(oldProject).length
    && Object.keys(next).every(key => key === "link_decisions" || next[key] === oldProject[key]);
  if (linkDecisionOnly) {
    // Display decisions are applied by aggregateGroupLinks. Evidence ownership
    // and compiled occurrence counts are unchanged, so do not rescan members.
    projectController.applyOperation(next, { preserveMembership: true });
    return true;
  }
  const findingOnly = oldProject && next.groups === oldProject.groups
    && Object.keys(next).length === Object.keys(oldProject).length
    && Object.keys(next).every(key => key === "finding_decisions" || next[key] === oldProject[key]);
  if (projectOps.isAnchorOnlyChange(oldProject, next)) {
    // Compiled evidence nodes/edges do not contain anchor roles. Candidates and
    // anchor-dependent visibility are refreshed by the following render pass.
    projectController.applyOperation(next, { preserveMembership: true });
    publicationController?.workingCopyChanged?.();
    return true;
  }
  const anchorChanged = oldProject && ["iv_group_id", "dv_group_id", "instrument_group_id"]
    .some(key => oldProject[key] !== next[key]);
  const structural = project => JSON.stringify({
    groups: (project?.groups || []).map(group => [group.group_id, group.label, group.notes,
      group.variable_ids, group.excluded_nearby_variable_ids]),
    rejected: project?.rejected_variables || [],
    decisions: project?.link_decisions || {},
    findings: project?.finding_decisions || {},
  });
  const schemaChanged = findingOnly || (oldProject && structural(oldProject) !== structural(next));
  const asSchema = project => ({ finding_decisions: project?.finding_decisions || {},
    groups: (project?.groups || []).map(group => ({
    group_id: group.group_id, label: group.label || "", variable_ids: [...(group.variable_ids || [])],
    ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
  })) });
  const oldSchema = findingOnly
    ? { groups: oldProject.groups, finding_decisions: oldProject.finding_decisions || {} }
    : asSchema(oldProject);
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
    const newSchema = findingOnly
      ? { groups: oldSchema.groups, finding_decisions: next.finding_decisions || {} }
      : asSchema(next);
    const owner = schema => new Map(schema.groups.flatMap(group => group.variable_ids.map(id => [id, group.group_id])));
    const changedIds = (() => {
      if (findingOnly) return [];
      const before = owner(oldSchema), after = owner(newSchema);
      return [...new Set([...before.keys(), ...after.keys()])]
        .filter(id => before.get(id) !== after.get(id));
    })();
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
      const cachedRawLinks = batchedRawIds.map(id => state.rawLinksById.get(id)).filter(Boolean);
      const missingRawIds = batchedRawIds.filter(id => !state.rawLinksById.has(id));
      const updatePromise = Promise.all([
        batchedIds.length ? dagDataSource.loadIncidentRawLinks(batchedIds) : [],
        missingRawIds.length ? dagDataSource.loadRawLinksByIds(missingRawIds) : [],
      ]).then(parts => {
        const incidentRawLinks = [...new Map([...cachedRawLinks, ...parts.flat()]
          .map(link => [link.raw_causal_link_id, link])).values()];
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
        if (batchedIds.length) renderAll();
        else rebuildLinkDecision();
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
    const variablesPromise = dagDataSource.loadVariableMetadata(missing, state.variableLayoutSource, { mapOnly: skipNeighbors });
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
    invalidateVisibleCaches();
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
  // The new variable's members come from the AI or an existing split, never from the map.
  if (group?.group_id === "__definition_new__") return;
  return groupEditorController.addVariableToGroup(group, variableId);
}
function addVariableSetToGroup(group, ids) {
  if (group?.group_id === "__definition_new__") return;
  return groupEditorController.addVariableSetToGroup(group, ids);
}
function removeVariableFromGroup(group, variableId) {
  if (group?.group_id === "__definition_new__") return;
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

// A temporary note beside the brand for completed operations. It clears itself
// unless something else has written to the status in the meantime.
let briefNoticeTimer = null;
function notifyBriefly(message) {
  const status = els.localSaveStatus;
  if (!status) return;
  clearTimeout(briefNoticeTimer);
  status.textContent = message;
  briefNoticeTimer = setTimeout(() => {
    if (status.textContent === message) status.textContent = "";
  }, 5000);
}

function currentWorkingGroupingSchema() { return groupingSetController.workingSchema(); }

const persistentViewer = createPersistentViewer({
  state,
  getSchema: currentWorkingGroupingSchema,
  getViewport: () => {
    const network = dagNetworkController.getNetwork();
    // An empty or unsized graph reports a meaningless scale; saving it would
    // make a reopened link zoom to nothing.
    const scale = network?.getScale();
    state.dagViewport = network && Number.isFinite(scale) && scale > 0 && scale < 1e4
      ? { scale, position: network.getViewPosition() } : null;
  },
  status: message => {
    // Routine saves show as a small icon; anything else (errors, editing, notices) as text.
    const saving = message.startsWith("Saving");
    const saved = message.startsWith("Saved");
    const indicator = document.getElementById("localSaveIndicator");
    if (indicator) {
      indicator.hidden = !saving && !saved;
      indicator.dataset.state = saving ? "saving" : "saved";
      const label = saving ? "Saving in this browser…" : "Saved in this browser";
      indicator.title = label;
      indicator.setAttribute("aria-label", label);
    }
    if (els.localSaveStatus) els.localSaveStatus.textContent = saving || saved || message === "Published schema" ? "" : message;
    if (els.retryLocalSave) els.retryLocalSave.hidden = !message.startsWith("Not saved");
    if (els.saveIndependentCopy) els.saveIndependentCopy.hidden =
      !message.includes("Schema revision changed");
  },
  onDiscard: invalidateVisibleCaches,
});

const variableReviewController = createVariableReviewController({ state, onCommit: commitDiagnosticReview,
  onCancel: () => { taskViews.render(); if (dagNetworkController.dagDisplay() === "table") void dagNetworkController.renderDag({ reuseGeometry: true }); } });

const taskViews = createTaskViews({
  state, searchGroups: searchExploreGroups, searchStatus: () => state.variableSearchStatus,
  paperSupport: linkPaperSupport, loadPaperSupport: () => void loadLinkSupport(linkPaperSupport().links),
  isDisplayGroup: isDagDisplayGroup,
  // A new variable updates the anchor bar, picker and graph, like a distance change,
  // instead of re-rendering all of Identify's setup.
  onExploreChange: () => renderExploreFocus(),
  onFocusPicking: () => { renderAnchorBar(); setupGroupController.renderFocusPicker(); taskViews.render(); },
  onPickerInput: () => setupGroupController.renderFocusPicker(),
  onSetupNeeded: () => shellController.showMobilePanel("controls"),
  // Each task shows its own graph, so rebuild it from the project's links.
  // Between causes and consequences only the anchor bar, picker and graph change.
  onTaskChange: ({ previous, task }) => {
    dismissEvidenceForTask();
    const bothExplore = [previous, task].every(name => name === "causes" || name === "consequences");
    if (bothExplore) renderExploreFocus(); else renderAll({ reuseLinks: true });
  },
  openEvidence: edgeId => { inspectDagEdge(edgeId); shellController.showMobilePanel("dag"); },
  onRowHover: row => dagNetworkController.hoverExploreRow(row),
  onChooseIdentify: (side, groupId) => chooseIdentifyVariable(side, groupId),
  onIdentifyPicking: () => { setupGroupController.renderIdentifyPicker(); taskViews.render(); },
  onIdentifyRowHover: groupId => groupId ? dagNetworkController.highlightConfounderPaths(groupId)
    : dagNetworkController.clearConfounderPathHover(),
  onIdentifyExcludedChange: () => updateDagFilters(),
  onReviewVariable: (kind, id, status) => variableReviewController.edit(kind, id, status),
  onEditVariableSchema: () => customVariablesPresenter.open(),
  // A row opens the variable's definition and concepts in the evidence pane, as clicking its node does.
  onOpenIdentifyVariable: groupId => {
    if (state.fullscreenPanel) setFullscreenPanel(null);
    state.selectedEdgeId = null;
    state.comparisonVariableIds = [];
    state.selectedEvidenceGroupId = groupId;
    renderCoordinator.selectEdge();
    taskViews.refreshSelection();
    persistentViewer.viewerChanged();
    shellController.showMobilePanel("dag");
  },

  placeEvidencePane: () => shellController.placeEvidencePane(),
  onChange: () => persistentViewer.viewerChanged(), prepareReset: () => persistentViewer.prepareReset(), whenReady: () => persistentViewer.whenReady(),
});
taskViews.install();

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

// ─── Candidate queue ──────────────────────────────────────────────────────────

function buildCandidateQueue() {
  // Only Identify's setup uses the queue; it is rebuilt when switching back.
  if (taskViews.exploring()) return;
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
    h("div", { className: "small-note", textContent: `${rows.length} extracted evidence record${rows.length === 1 ? "" : "s"}; only “present” claims create DAG edges; “absent” and “uncertain” are shown for reference.` }));
  const evidenceRows = rows.map((link) => {
    const doi = isDoi(link.paper_id) ? link.paper_id.trim() : null;
    const paper = truncate(link.paper_title || link.paper_id, 44);
    const paperCell = doi ? h("a", { href: safeUrl(`https://doi.org/${encodeURIComponent(doi)}`), target: "_blank", rel: "noopener", title: link.paper_title || doi, textContent: paper }) : document.createTextNode(paper);
    return h("tr", {}, h("td", { textContent: link.direction }), h("td", {}, paperCell),
      h("td", { textContent: link.causal_link_existence || "present" }), h("td", { textContent: (link.identification_strategy || "").replaceAll("_", " ") }),
      h("td", { textContent: truncate(link.target_population || "", 60) }));
  });
  const headings = ["Direction", "Paper", "Claim", "Strategy", "Population"];
  replaceChildren(els.provenancePanel, h("table", { className: "provenance-table" },
    h("thead", {}, h("tr", {}, headings.map(label => h("th", { textContent: label })))), h("tbody", {}, evidenceRows)));
  return true;
}

function hasAnyMapping(sourceIds, targetIds) {
  return rawLinksBetween(sourceIds, targetIds).length > 0;
}

// Per-finding paper support. The sparse-edge filter needs it for every group
// link. Causes and consequences read the paper counts already in the aggregated
// DAG, and need it only for links a local edit touched (which carry no keys).
let linkSupportPromise = null;
let linkSupportFailed = false;
let sparseWaitingForSupport = false;
function missingLinkSupportIds(links = state.project?.links || []) {
  return [...new Set(links.flatMap(link =>
    [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])]))]
    .filter(id => !state.edgeSupportById.has(id) && !state.rawLinksById.has(id));
}
function loadLinkSupport(links) {
  if (linkSupportPromise) return linkSupportPromise;
  const missing = missingLinkSupportIds(links);
  if (!missing.length) return Promise.resolve(true);
  const supportCache = state.edgeSupportById;
  linkSupportPromise = dagDataSource.loadRawLinkSupportByIds(missing).then(rows => {
    if (state.edgeSupportById !== supportCache) return false;
    const returned = new Set(rows.map(row => row.raw_causal_link_id));
    if (missing.some(id => !returned.has(id))) {
      throw new Error("Some sparse edge evidence is unavailable in this snapshot");
    }
    for (const row of rows) state.edgeSupportById.set(row.raw_causal_link_id, row);
    linkSupportFailed = false;
    return true;
  }).catch(error => {
    if (state.edgeSupportById === supportCache) {
      linkSupportFailed = true;
      console.error("Could not load sparse edge evidence", error);
    }
    return false;
  }).finally(() => {
    linkSupportPromise = null;
    // An explore view waiting on these counts redraws now.
    if (taskViews.exploring()) updateDagFilters();
  });
  return linkSupportPromise;
}
// What the causes and consequences views need to count papers: nothing, unless
// an edit left some links without paper keys, in which case only those links'
// findings are fetched. Remembered per links array, since it scans every link.
let exactCountLinks = { links: null, needing: [] };
function linkPaperSupport() {
  const links = state.project?.links || [];
  if (exactCountLinks.links !== links) exactCountLinks = { links, needing: linksNeedingExactCounts(links) };
  const { needing } = exactCountLinks;
  if (!needing.length) return { status: "ready", papersFor: directionalPaperCounter() };
  if (linkSupportFailed) return { status: "failed", papersFor: directionalPaperCounter() };
  if (missingLinkSupportIds(needing).length) return { status: "loading", papersFor: null, links: needing };
  return { status: "ready", papersFor: directionalPaperCounter(state.edgeSupportById, state.rawLinksById),
    cacheKey: state.edgeSupportById };
}

// Causes and consequences draw one variable's neighborhood through the same
// graph and evidence pane as Identify; the diagnostics belong to Identify.
function computeExploreLinks() {
  state.studyGraph = null;
  const { graph } = taskViews.neighborhood();
  state.componentGroupIds = graph.groupIds;
  state.visibleLinks = graph.links;
  state.exploreLayout = graph.layout;
  for (const key of ["confounderGroupIds", "confounderPathGroupIds", "bottleneckedConfounderIds",
    "colliderGroupIds", "colliderPathGroupIds", "bottleneckedColliderIds", "exclusionViolationIds",
    "exclusionPathIds", "exclusionLinkPairKeys", "exogeneityGroupIds", "exogeneityPathGroupIds",
    "exogeneityLinkPairKeys", "bottleneckedExogeneityIds", "confounderLinkPairKeys", "colliderLinkPairKeys"]) {
    state[key] = new Set();
  }
  for (const key of ["confounderPathsByGroup", "colliderPathsByGroup", "exclusionPathsByGroup", "exogeneityPathsByGroup"]) {
    state[key] = new Map();
  }
}

function computeVisibleLinks() {
  if (taskViews.exploring()) { computeExploreLinks(); return; }
  ensureDiagnosticFilter(state);
  // Links carry their papers per direction; only those an edit stripped of
  // paper keys need their findings fetched before sparse edges can be judged.
  const sparseNeeding = state.excludeSparseEdges ? linksNeedingExactCounts(state.project?.links || []) : [];
  const missingSparseEvidence = sparseNeeding.length ? missingLinkSupportIds(sparseNeeding) : [];
  if (missingSparseEvidence.length && !sparseWaitingForSupport) {
    sparseWaitingForSupport = true;
    void loadLinkSupport(sparseNeeding).then(loaded => {
      sparseWaitingForSupport = false;
      if (!loaded && linkSupportFailed) state.excludeSparseEdges = false;
      updateDagFilters();
    });
  }
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
  const studyGraph = effectiveStudyGraph({ ...state.project, groups: dagGroups() });
  state.studyGraph = studyGraph;
  const view = deriveDagView({
    groups: studyGraph.groups,
    links: studyGraph.links,
    ivId: state.project.iv_group_id,
    dvId: state.project.dv_group_id,
    instrumentId: state.project.instrument_group_id,
    maxPathLength: state.confounderMaxPathLength,
    exclusionMaxPathLength: state.exclusionMaxPathLength,
    excludeBottlenecked: state.excludeBottleneckedConfounders,
    excludeSparseEdges: state.excludeSparseEdges && !missingSparseEvidence.length,
    minimumEdgePapers: state.minimumEdgePapers,
    edgeSupportById: state.edgeSupportById,
    rawLinksById: state.rawLinksById,
    filterByCausalRelevance: false,
    showConfoundersOnly: state.showConfoundersOnly,
    showCollidersOnly: state.showCollidersOnly,
    showExclusionViolations: state.showExclusionViolations,
    showExogeneity: state.showExogeneity,
    hideIrrelevantDiagnosticLinks: state.hideIrrelevantConfounderLinks,
    showAllExclusionLinks: state.showAllExclusionLinks,
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
      const button = h("button", { className: "btn btn--sm", type: "button",
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
      const restore = h("button", { className: "btn btn--ghost", type: "button", textContent: "Restore" });
      restore.addEventListener("click", () => {
        const before = takeSnapshot();
        if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, null)) === false) return;
        addDecision("finding_restored", { raw_causal_link_id: id });
        addToUndoHistory("Restored finding", before, "finding-decision");
        rebuildLinkDecision();
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
function refreshDagEdgeSelection(options) {
  const refreshed = dagNetworkController.refreshEdgeSelection(options);
  taskViews.refreshSelection();
  // The open link is part of the permalink, however it was selected.
  persistentViewer.viewerChanged();
  return refreshed;
}
function minimumDagScale() { return dagNetworkController.minimumDagScale(); }

// ─── Edge inspector + provenance ──────────────────────────────────────────────

let pendingEdgeEvidencePromise = null;

function renderSelectedEdgePanels() {
  if (!state.selectedEdgeId && !state.selectedEvidenceGroupId && !els.edgeInspector.hidden
    && els.edgeInspector.classList.contains("excluded-links-list")) return;
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
  // The incremental evidence update will rebuild the graph when its incident
  // links arrive. Update the visible selection now instead of rebuilding twice.
  if (state.compiledDagUpdating) renderAll({ rebuild: false, refreshView: true });
  else renderAll();
  if (state.activeGroupId && !persistentViewer.editorOpen) {
    void persistentViewer.commitDecision().then(() =>
      publicationController.workingCopyChanged()).catch(error =>
      console.error("Could not save concept exclusion", error));
  }
}

function renderSelectedEdge() {
  if (!state.selectedEdgeId && !state.selectedEvidenceGroupId && !els.edgeInspector.hidden
    && els.edgeInspector.classList.contains("excluded-links-list")) return;
  if (!state.selectedEdgeId && state.selectedEvidenceGroupId && inspectorController.renderGroupDefinition()) return;
  const selected = inspectorController.selectedEdge();
  const owners = new Map();
  if (selected && Object.keys(state.project.finding_decisions || {}).length) {
    for (const group of state.project.groups) {
      for (const id of group.variable_ids || []) owners.set(id, group.group_id);
    }
  }
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
    const loadSources = async () => {
      if (!missing.length) return [];
      const panel = await dagDataSource.loadPanelEvidence(rawIds);
      if (!panel) return dagDataSource.loadRawLinksByIds(missing);
      for (const variable of panel.variables) {
        if (!state.variableById.has(variable.variable_id)) state.variableById.set(variable.variable_id, variable);
      }
      return panel.links;
    };
    const load = loadSources().then(async links => {
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

// The open evidence is per task; clear what the old task showed so the pane
// matches the new task's selection (restored by the task views).
function dismissEvidenceForTask() {
  state.selectedVariableIds.clear();
  state.comparisonVariableIds = [];
  if (!state.selectedEdgeId) {
    els.edgeInspector.hidden = true;
    els.provenancePanel.hidden = true;
    els.closeEvidencePane.hidden = true;
  }
}

function dismissEvidencePane() {
  els.provenancePanel.scrollLeft = 0;
  els.closeEvidencePane.closest(".dag-ws-footer").scrollLeft = 0;
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
  // Shown as the Causal diagram export's tooltip.
  els.exportWorkingMap.title = cycle || bidirectional
    ? "Not a strict DAG: has cycles or two-way links"
    : "Valid strict DAG";
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

// ─── Geometry helpers ──────────────────────────────────────────────────────────

function groupCoherence(variableIds) {
  return candidates.groupCoherence(variableIds, state.similarityEdgeMap);
}



const uoaController = createUoaController({
  state, elements: els, visibleVariables, groupById, clusterRep, truncate, renderAll,
});

const toolbarController = createToolbarController({ state, elements: els, dagGroups, groupById });

const definitionWorkflowController = createDefinitionWorkflowController({
  state, elements: els, activeGroup, clusterRep, invalidateVisibleCaches, renderAll,
  previousSplits: savedSplitOptions,
  selectedGroupForRole,
  groupById, persistProjectLocally, getReturnUrl: () => persistentViewer.currentUrl() || location.href, visibleVariables,
  searchVariables: searchVisibleVariables, searchSourceGroups: searchDefinitionSourceGroups,
  clusterDisplayVariable, expandToClusterMembers, nowIso, applyProjectOperation,
  takeSnapshot, addToUndoHistory, clean, normalized, truncate,
  hydrateVariableDetails: ids => hydrateVariableDetails(ids, { skipNeighbors: true }),
  commitSchema: async () => {
    await persistentViewer.commitDecision();
    previousSplitsLoaded = false;
    publicationController.workingCopyChanged();
  },
  onCommitFailureRestored: () => persistentViewer.clearSaveFailure(),
  onFocusDefined: groupId => taskViews.chooseFocus(groupId),
  onInstrumentReady: () => shellController.showMobilePanel("dag"),
  prewarmEvidence: async () => {
    if (await dagDataSource.prewarmVariableMap(state.variableLayoutSource)) return;
    await dagDataSource.ensureEvidenceConnection({ variableIds: [], prewarmMapFiles: true });
    // DuckDB fetches the remote layout metadata when it creates this view.
    // Do that while the source picker is open instead of after Continue.
    await dagDataSource.ensureVariableLayouts();
  },
});

let previousSplitRows = [];
function selectedGroupForRole(role) {
  return role === "candidate" && !state.customVariablesOpen ? taskViews.focus().groupId
    : state.project?.[`${role}_group_id`];
}
function savedSplitOptions(role) {
  return previousSplitsForRole(previousSplitRows, state.project, role, selectedGroupForRole(role));
}
let previousSplitsLoading = false;
let previousSplitsLoaded = false;
function loadPreviousSplits(force = false) {
  if (previousSplitsLoading || (previousSplitsLoaded && !force)) return;
  previousSplitsLoading = true;
  void Promise.allSettled([listOwnPublishedSplits(), listLocalSchemas()]).then(async ([published, local]) => {
    const localRows = local.status === "fulfilled" ? local.value.flatMap(record =>
      (record.schema?.groups || []).filter(group => group.source === "user_split"
        && group.provenance?.operation === "split_categories" && Array.isArray(group.provenance.source_group_ids))
        .map(group => ({ group_id: group.group_id, split_id: group.provenance.split_id || group.group_id,
          origin_split_id: group.provenance.reused_from_split_id || group.provenance.split_id || group.group_id,
          origin_group_id: group.provenance.reused_from_group_id || group.group_id,
          source_group_ids: group.provenance.source_group_ids, name: group.label, description: group.description,
          source_group_by_variable: group.provenance.source_group_by_variable,
          source_labels: group.provenance.source_group_ids.map(id => {
            const source = record.schema.groups.find(candidate => candidate.group_id === id);
            return source && group.provenance.split_id && source.provenance?.split_id === group.provenance.split_id
              ? source.provenance.prior_label || source.label || id : source?.label || id;
          }),
          local_variable_ids: group.variable_ids, published_at: record.updatedAt || "", is_local: true }))) : [];
    const publishedRows = await Promise.allSettled((published.status === "fulfilled" ? published.value : [])
      .filter(row => row.source_group_by_variable).map(async row => ({ ...row,
        local_variable_ids: await loadPublishedSplitMembership(row) })));
    previousSplitRows = [...localRows, ...publishedRows.flatMap(result => result.status === "fulfilled" ? [result.value] : [])];
    previousSplitsLoaded = true;
    setupGroupController.renderFocusPicker();
    setupGroupController.renderIdentifyPicker();
    customVariablesPresenter.render();
  }).finally(() => { previousSplitsLoading = false; });
}
function reusePreviousSplit(role, row) { definitionWorkflowController.reusePreviousSplit(role, row); }

const customVariablesPresenter = createCustomVariablesPresenter({
  state, elements: els, truncate, normalized,
  customVariables: () => (state.project?.groups || []).filter(group => group.source === "user_split")
    .sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""))),
  schemaVariables: () => [...(state.project?.groups || [])].sort((a, b) =>
    Number(b.source === "user_split") - Number(a.source === "user_split")
      || String(a.label || "").localeCompare(String(b.label || ""))),
  getSchema: currentWorkingGroupingSchema,
  loadDetails: ids => hydrateVariableDetails(ids, { skipNeighbors: true }),
  conceptLabel: id => state.variableById.get(id)?.display_label || state.variableById.get(id)?.concept_label || id,
  onSplitSource: id => definitionWorkflowController.browsePreviousForSource("candidate", id),
  sourceLabels: group => (group.provenance?.source_group_ids || []).map(id => groupById(id)?.label).filter(Boolean),
  canChange: group => Boolean(projectOps.customVariableContext(state.project, group.group_id)),
  onCreate: () => startDefinition("candidate"),
  onEdit: groupId => startEditSplit(groupId),
  onDelete: deleteCustomVariable,
  previousSplits: savedSplitOptions, loadPreviousSplits, reusePreviousSplit,
  splitsLoading: () => previousSplitsLoading || !previousSplitsLoaded,
  canExplore: () => taskViews.exploring(),
  onExplore: groupId => taskViews.chooseFocus(groupId),
});

const projectController = createDagProjectController({
  state, storage: window.localStorage, storagePrefix: PROJECT_STORAGE_PREFIX,
  nowIso, invalidateVisibleCaches, renderAll, rebuildLinkDecision, renderUndoRedo, renderActionHistory,
});

const inspectorController = createDagInspectorController({
  state, elements: els, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildLinkDecision, renderAll,
  persistFindingDecision,
  loadConceptLabels: ids => dagDataSource.loadVariableProvenance(ids),
  loadVisibleLinkEndpoints: ids => dagDataSource.loadRawLinkEndpointsByIds(ids),
  excludeConcept: excludeGroupConcept,
});

const groupEditorController = createDagGroupEditorController({
  state, elements: els, applyProjectOperation, groupById, takeSnapshot,
  expandToClusterMembers, nowIso, clean,
  addToUndoHistory, renderAll, addDecision, setWorkflowMode, groupedVariableIds,
  searchVariables, clusterMemberIds, rejectedVariableIdSet, uoaMatches,
  applyActiveGroupingSet, rebuildProject,
  escapeHtml, truncate, hydrateVariableDetails,
  beginEditor: () => persistentViewer.beginEditor(),
  onAnchorsReady: () => shellController.showMobilePanel("dag"),
});

const setupGroupController = createDagSetupGroupController({
  state, elements: els, escapeHtml, normalized, truncate, groupById,
  assignGroupAsAnchor, assignGroupAsInstrument, renderAll,
  roleLabels: ROLE_LABELS, dagProjectView, startDefinition, startEditSplit,
  canEditSplit: group => Boolean(projectOps.editableSplitContext(state.project, group)),
  searchAnchorGroups, beginEditor: () => persistentViewer.beginEditor(),
  exploreFocus: () => taskViews.focus(), searchFocusGroups: query => taskViews.searchFocusGroups(query),
  onChooseFocus: groupId => taskViews.chooseFocus(groupId),
  identifyPicking: () => taskViews.identifySide(), onChooseIdentify: (side, groupId) => taskViews.chooseIdentify(side, groupId),
  onCancelIdentify: () => taskViews.cancelIdentify(),
  canChangeCustom: group => Boolean(projectOps.customVariableContext(state.project, group.group_id)),
  previousSplits: savedSplitOptions, loadPreviousSplits, reusePreviousSplit,
  browsePreviousForSource: (role, id) => definitionWorkflowController.browsePreviousForSource(role, id),
  deleteCustom: deleteCustomVariable,
  loadConceptLabels: ids => dagDataSource.loadVariableProvenance(ids),
  loadVisibleLinkEndpoints: ids => dagDataSource.loadRawLinkEndpointsByIds(ids),
  excludeConcept: excludeGroupConcept,
});

const dagNetworkController = createDagNetworkController({
  state, elements: els, visApi: vis, clusterRep, groupColor, dagGroups, groupById,
  renderAll, exploreRows: () => taskViews.neighborhood().included,
  onNodeHover: id => taskViews.highlightRow(id),
  onSetStatus: (kind, groupId, status, text) => setDiagnosticStatus(kind, groupId, status, text),
  onViewportChange: continuous => persistentViewer.viewerChanged(continuous),
  selectEdge: () => {
    if (state.fullscreenPanel) setFullscreenPanel(null);
    state.selectedEvidenceGroupId = null;
    // The interaction clears vis's segment selection and redraws the network.
    renderCoordinator.selectEdge({ redraw: false });
    persistentViewer.viewerChanged();
  },
  selectGroup: id => {
    if (state.fullscreenPanel) setFullscreenPanel(null);
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
  if (state.fullscreenPanel) setFullscreenPanel(null);
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
  state, elements: els, renderDag,
  getNetwork: () => dagNetworkController.getNetwork(),
  isDagFullyVisible: () => dagNetworkController.isFullyVisible(),
  dismissEvidencePane,
});

let publicationController;
const exportController = createDagExportController({
  state, elements: els, rejectedVariableEntries, rejectedVariableIdSet,
  projectPayload, aggregateGroupLinks, computeVisibleLinks, nowIso,
  getExclusionRelevance: () => relevantExclusions({
    project: state.project, groups: dagGroups(), links: state.project.links,
    rawLinksById: state.rawLinksById,
    viewOptions: {
      maxPathLength: state.confounderMaxPathLength,
      exclusionMaxPathLength: state.exclusionMaxPathLength,
      excludeBottlenecked: state.excludeBottleneckedConfounders,
      excludeSparseEdges: state.excludeSparseEdges,
      minimumEdgePapers: state.minimumEdgePapers,
      edgeSupportById: state.edgeSupportById,
      rawLinksById: state.rawLinksById,
      showConfoundersOnly: state.showConfoundersOnly,
      showCollidersOnly: state.showCollidersOnly,
      showExclusionViolations: state.showExclusionViolations,
      showExogeneity: state.showExogeneity,
      hideIrrelevantDiagnosticLinks: state.hideIrrelevantConfounderLinks,
      showAllExclusionLinks: state.showAllExclusionLinks,
    },
  }),
  getPublicPermalink: async () => (await publicationController?.publicPermalink())?.permalink || null,
  getDagPngBytes: () => renderDagPng(dagNetworkController.getNetwork(), els.dagNetwork),
  loadFindingVariableLabels: async ids => new Map(
    (await dagDataSource.loadVariableProvenance(ids)).map(row =>
      [row.variable_id, row.concept_label || row.display_label || ""])),
  ensureEvidenceLoaded: async () => {
    while (state.compiledDagUpdatePromise) {
      const pending = state.compiledDagUpdatePromise;
      await pending;
      if (state.compiledDagUpdatePromise === pending) break;
    }
    aggregateGroupLinks();
    computeVisibleLinks();
    const loadMissing = async ids => {
      const missing = [...new Set(ids)].filter(id => !state.rawLinksById.has(id));
      if (!missing.length) return;
      for (const link of await dagDataSource.loadRawLinksByIds(missing)) {
        state.rawLinksById.set(link.raw_causal_link_id, link);
        if (!state.rawLinks.some(existing => existing.raw_causal_link_id === link.raw_causal_link_id)) {
          state.rawLinks.push(link);
        }
      }
    };
    await loadMissing((state.visibleLinks || []).flatMap(link => [
      ...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || []),
    ]));
    try {
      await loadMissing(Object.keys(state.project.finding_decisions || {}));
    } catch (error) {
      console.warn("Could not load some excluded finding details for export.", error);
    }
  },
});

publicationController = createPublicationController({
  elements: {
    get publish() { return els.publishSchema; },
    get status() { return els.publicationStatus; },
    get badge() { return els.schemaPublicationBadge; },
    get menuButton() { return document.querySelector("#schemaMenu > summary"); },
    get confirmation() { return els.publishSchemaDialog; },
    get shareWarning() { return els.shareUnpublishedDialog; },
    get share() { return els.copyPermalink; },
  },
  getWorkingSchema: currentWorkingGroupingSchema,
  getCompiledDag: () => state.compiledDagValid && !state.compiledDagUpdating ? state.compiledDag : null,
  canPublish: () => !state.publishedSchemaHydrating && !state.publishedSchemaLoadFailed
    && persistentViewer.canPublish,
  notify: notifyBriefly,
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
  state, initElements, installHandlers, installDefinitionHandlers,
  restoreProjectLocally, initializeProject, loadLatestSchemaGroups,
  normalizeProjectDuplicateAssignments, saveProjectLocally, publicationController,
  renderAll, dagNetworkController,
  buildDuplicateClusters, linkKey, pairKey, loadVariableSearchCatalog,
  onLocalSchemaLoaded: record => persistentViewer.setLoadedRecord(record),
  waitForReadyBeforeShowing: () => new URL(location.href).searchParams.has("code")
    && Boolean(sessionStorage.getItem("echo-openrouter-definition-draft-v1")),
  onReady: async () => {
    persistentViewer.start();
    await definitionWorkflowController.resumeAfterOAuth();
    void publicationController.refreshPublicationState();
    // Compiled-DAG browsing and catalog search need no raw evidence engine.
    // Definitions, evidence details, and exports start it on explicit intent;
    // speculative startup used to deliver a large lookup conversion during
    // the user's first search/anchor selection.
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
  activeGroup, renderNeighborSuggestions, renderAll,
  renderSearch, prefetchVariableSearch: loadVariableSearchCatalog,
  toggleAnchorSearchMode, finishSchemaChoice, changeAnchor, renderSetupGroupPicker,
  setWorkflowMode, renderGroupList, closeGroupEditor, discardGroupEditor, selectActiveAnchor,
  addTopNeighborsToActiveGroup, removeTopNeighborsFromActiveGroup, clearActiveGroupVariables,
  renderGroupSeedSearch, renderRejectedVariablesPanel, applyProjectOperation,
  saveProjectLocally, applyActiveGroupingSet, rebuildProject, updateDagFilters, exportGroupingFolder,
  copyPermalink, toggleFullscreenPanel, renderMapToolbarToggles, clampNumber,
  undo, redo, renderActionHistory, renderDag, setFullscreenPanel,
  createCustomGroup, exportProject, exportWorkingMap, importProject, exportBib, exportMd,
  exportTex, installDagHandlers, initPanelResizers, takeSnapshot,
  addToUndoHistory, clusterRep, addVariableToGroup, clean,
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
      missing ? h("a", { href: "?new=1", textContent: "Start new view" }) : null));
});
