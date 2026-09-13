"use strict";

import * as projectOps from "/dag_project.mjs";
import { aggregateGroupLinks as deriveGroupLinks, rawLinksBetween as lookupRawLinks,
  paperTableKeys as lookupPaperTableKeys, linkKey, pairKey } from "/dag_link_aggregation.mjs";

import * as exportData from "/dag_exports.mjs";
import { createDagExportController } from "/dag_export_controller.mjs";
import * as mapGeometry from "/map_geometry.mjs";
import { createRenderCoordinator } from "/render_coordinator.mjs";
import * as candidates from "/dag_candidates.mjs";
import * as inspector from "/dag_inspector.mjs";
import * as searchModel from "/dag_search.mjs";
import * as workflow from "/dag_workflow.mjs";
import * as visibility from "/variable_visibility.mjs";
import { dagDataSource } from "/dag_data_source.mjs";
import { createDagAppState } from "/dag_app_state.mjs";
import { createDagProjectController } from "/dag_project_controller.mjs";
import { createDagInspectorController, STUDY_DESIGN_EDGE_ID } from "/dag_inspector_controller.mjs";
import { createDagShellController } from "/dag_shell_controller.mjs";
import { createDagMapViewController } from "/dag_map_view_controller.mjs";
import { createDagMapUiController } from "/dag_map_ui_controller.mjs";
import { createDagSetupGroupController } from "/dag_setup_group_controller.mjs";
import { createDagGroupEditorController } from "/dag_group_editor_controller.mjs";
import { deriveDagView, excludedForConnectivity } from "/dag_view.mjs";
import { createDagNetworkController } from "/dag_network_controller.mjs";
import { createDagEventController } from "/dag_event_controller.mjs";
import { PERSON_UOA_SENTINEL, projectForUoa, uoaCounts,
  uoaMatches as matchesUoa } from "/dag_uoa.mjs";
import { groupingSchemaUrl, schemaPublicationId } from "/dag_data_config.mjs";
import { applyPermalink, buildPermalink, CUSTOM_SCHEMA_INSTRUCTIONS,
  permalinkInput, schemaMatchesProject } from "/dag_permalink.mjs";
import { initDagAuth } from "/dag_auth.mjs";
import { createPublicationController } from "/dag_publication.mjs";
import { writeGroupingSchemaFolder } from "/grouping_schema_writer.mjs";
import { makeZip } from "/dag_export_zip.mjs";


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
const IS_DAG2 = true;
const PROJECT_STORAGE_PREFIX = IS_DAG2 ? "dag2-project-v1" : "dag-builder-project-v2";

const state = createDagAppState();
state.interfaceMode = IS_DAG2 ? "dag2" : "classic";

window.__dagBuilderState = state;

const els = {};

function setStartupStage(message) {
  const stage = document.getElementById("startupLoadingStage");
  if (stage) stage.textContent = message;
  window.dispatchEvent(new CustomEvent("startupstage", { detail: message }));
}

function finishStartupLoading() {
  document.getElementById("startupLoading")?.setAttribute("hidden", "");
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    "uoaSearchBlock", "uoaChips", "uoaFilterBar", "uoaSelectedLabel", "uoaFilterToggle", "uoaReset",
    "dvSearchBlock", "ivSearchBlock",
    "dvInput", "dvInputLabel", "dvDefineNew", "dvSeeds", "dvResults", "dvGroupPicker",
    "ivInput", "ivInputLabel", "ivDefineNew", "ivSeeds", "ivResults", "ivGroupPicker",
    "schemaChoice", "loadSchema", "skipSchema",
    "definitionBlock", "definitionTitle", "definitionCancel", "definitionSourcesStep",
    "definitionSourceSearch", "definitionSourceList", "definitionContinue",
    "definitionPartitionStep", "definitionCounts", "definitionVariableSearch",
    "definitionVariableResults", "definitionSelectedVariables", "definitionAddNeighbors", "definitionNeighborResults",
    "definitionBack", "definitionReview",
    "definitionReviewStep", "definitionNewLabel", "definitionReviewVariables", "definitionResidualLabels",
    "definitionManualReview", "definitionValidation", "definitionReviewBack", "definitionSave",
    "workflowHint", "dagStatusBadge",
    "anchorBar", "anchorDvLabel", "anchorIvLabel", "changeDv", "changeIv", "editSplitDv", "editSplitIv", "dag2UndoBtn", "dag2RedoBtn",
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
    "dagZoomIn", "dagZoomOut", "dagFitView", "toggleVariableLabels", "toggleGroupLabels", "toggleCausalFilter", "toggleConfoundersOnly", "toggleCollidersOnly", "confounderPathLength", "toggleBottleneckedConfounders", "toggleIrrelevantConfounderLinks", "dagSelectMode", "dagBrushMode", "dagEraseMode", "fullscreenVariableMap",
    "selectionCount",
    // Undo / history
    "undoBtn", "redoBtn", "historyToggle", "actionHistory",
    // Right: group editor
    "groupEditorSection", "groupEditorTitle", "groupEditorHint", "cancelGroupEdit",
    "groupLabelInput", "groupNotesInput", "useGroupAsAnchor",
    "zoomGroup", "editSplit",
    "addNeighbors", "removeNeighbors", "clearGroupSelection",
    "groupSeedInput", "groupSeedResults",
    "includedVariables", "neighborSuggestions",
    // Right: DAG workspace
    "dagWorkspaceSection", "dagNetwork", "dagWorkspaceResizer",
    "dagLayoutSelect", "dagSvgZoomIn", "dagSvgZoomOut", "dagSvgFit", "fullscreenDag",
    "edgeInspector", "provenancePanel",
    "addEdgeToggle", "addEdgeDrawer", "closeAddEdge",
    "manualSource", "manualTarget", "manualDirection", "manualNote", "addManualEdge",
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
}

async function init() {
  dagDataSource.onStatus = setStartupStage;
  document.body.classList.toggle("dag2-mode", IS_DAG2);
  if (IS_DAG2) {
    document.title = "DAG Builder 2";
    document.querySelector(".panel-header h1").textContent = "DAG Builder 2";
    document.getElementById("uoaReset").textContent = "Clear";
    const exportSection = document.getElementById("exportSection");
    document.querySelector(".dag-left-panel")?.append(exportSection);
    initDagAuth();
  }
  initElements();
  installHandlers();
  installDefinitionHandlers();
  resizeMap();
  const permalink = permalinkInput();
  const publicationId = schemaPublicationId();
  await loadDagData(permalink?.get("vlayout") || "");
  setStartupStage("Preparing workspace…");
  const restored = permalink || publicationId ? false : restoreProjectLocally();
  if (restored && state.definitionDraft && IS_DAG2
      && !window.confirm("Resume the unfinished variable definition? Press Cancel to discard it.")) {
    state.definitionDraft = null;
    saveProjectLocally();
  }
  if (!restored) {
    initializeProject();
    loadLatestSchemaGroups();
    normalizeProjectDuplicateAssignments();
    if (IS_DAG2) {
      state.phase = "select_iv";
      state.workflowMode = "setup";
      state.selectedUoa = null;
      state.uoaFilterEnabled = false;
      state.filterDagByCausalRelevance = false;
    }
    if (permalink) {
      applyPermalink(permalink, state);
      state.phase = "build";
    }
  }
  if (state.data.publication_source && !state.project.publication) {
    state.project.publication = {
      ...state.data.publication_source,
      permalink: new URL(`/?schema=${state.data.publication_source.publication_id}`, window.location.origin).href,
    };
  }
  if (IS_DAG2) publicationController.initialize();
  const restoredLayoutSource = state.variableLayoutSource;
  if (restoredLayoutSource && restoredLayoutSource !== state.data.layout?.active_source) {
    await loadDagData(restoredLayoutSource);
  }
  setStartupStage("Rendering graph…");
  renderAll();
  if (state.permalinkMapViewport) {
    constrainMapTransform();
    drawMap();
  } else {
    fitMap();
  }
  if (state.permalinkDagViewport) {
    dagNetworkController.getNetwork()?.moveTo({ ...state.permalinkDagViewport, animation: false });
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  finishStartupLoading();
}

async function loadDagData(layoutSource = "") {
  state.data = await dagDataSource.load(layoutSource);
  state.variables = (state.data.variables || []).slice().sort((a, b) => a.index - b.index);
  if (state.projectStorageVariableCount === null) {
    state.projectStorageVariableCount = Number(state.data.project_storage_variable_count || state.variables.length);
  }
  state.variableLayoutSource = state.data.layout?.active_source || layoutSource || "";
  state.variableById = new Map(state.variables.map((v) => [v.variable_id, v]));
  buildDuplicateClusters();
  state.rawLinks = state.data.raw_causal_links || [];
  state.rawLinksById = new Map(state.rawLinks.map((l) => [l.raw_causal_link_id, l]));
  state.linkLookup = new Map();
  for (const link of state.rawLinks) {
    const key = linkKey(link.source_variable_id, link.target_variable_id);
    if (!state.linkLookup.has(key)) state.linkLookup.set(key, []);
    state.linkLookup.get(key).push(link.raw_causal_link_id);
  }
  state.similarityEdgeMap = new Map();
  for (const edge of state.data.similarity_edges || []) {
    state.similarityEdgeMap.set(pairKey(edge.source, edge.target), Number(edge.weight || 0));
  }
  if (state.project) normalizeProjectDuplicateAssignments();
}

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
  projectController.save();
}

function saveProjectLocally() {
  persistProjectLocally();
  if (IS_DAG2) publicationController.workingCopyChanged();
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

function addToUndoHistory(description, before) {
  projectController.record(description, before);
}

function undo() {
  projectController.undo();
}

function redo() {
  projectController.redo();
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
    els.actionHistory.innerHTML = `<div class="ah-empty">No actions yet.</div>`;
    return;
  }
  els.actionHistory.innerHTML = state.actionLog.map((entry) => `
    <div class="ah-entry">
      <span class="ah-desc">${escapeHtml(entry.description)}</span>
      <span class="ah-time">${escapeHtml(entry.time.slice(11, 19))}</span>
    </div>
  `).join("");
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
  renderRejectedVariablesPanel, renderManualEdgeControls, renderDag, renderVariableComparison,
  renderEdgeInspector, renderProvenance, renderExportStatus, renderMapModeControls,
  renderMapToolbarToggles, renderUndoRedo, drawMap, saveProjectLocally,
  renderModeUI, renderAnchorBar, renderStatus, renderUoaStep, renderUoaFilterBar,
  renderSearch, renderSetupGroupPickers, renderSeedRows, renderGroupingSetControls,
  renderGroupEditor, renderRightPanel, renderDefinition,
});

function renderAll() {
  renderCoordinator.renderAll();
  // Enrich references opportunistically while the user works. Export actions
  // await the same de-duplicated, rate-limited requests before downloading.
  exportController.warmBibliography();
}

function rebuildProject() {
  renderCoordinator.rebuildProject();
}

function renderMapToolbarToggles() {
  const layoutSources = state.data?.layout?.sources || [];
  els.variableLayoutSelect.innerHTML = layoutSources.map((source) => `
    <option value="${escapeHtml(source.source)}">${escapeHtml(source.label || source.source)}</option>
  `).join("");
  els.variableLayoutSelect.value = state.variableLayoutSource;
  els.variableLayoutSelect.hidden = layoutSources.length < 2;
  renderAssignmentCoverage();
  els.toggleVariableLabels.classList.toggle("active", state.showVariableLabels);
  els.toggleVariableLabels.setAttribute("aria-pressed", state.showVariableLabels ? "true" : "false");
  els.toggleGroupLabels.classList.toggle("active", state.showGroupLabels);
  els.toggleGroupLabels.setAttribute("aria-pressed", state.showGroupLabels ? "true" : "false");
  els.toggleCausalFilter.classList.toggle("active", state.filterDagByCausalRelevance);
  els.toggleCausalFilter.setAttribute("aria-pressed", state.filterDagByCausalRelevance ? "true" : "false");
  const visibleGroupIds = new Set(dagGroups().map(group => group.group_id));
  const anchorsReady = visibleGroupIds.has(state.project?.iv_group_id)
    && visibleGroupIds.has(state.project?.dv_group_id);
  if (!anchorsReady) {
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
  }
  const confounderCount = state.confounderGroupIds?.size || 0;
  els.toggleConfoundersOnly.disabled = !anchorsReady;
  els.toggleConfoundersOnly.classList.toggle("active", state.showConfoundersOnly);
  els.toggleConfoundersOnly.setAttribute("aria-pressed", state.showConfoundersOnly ? "true" : "false");
  els.toggleConfoundersOnly.textContent = `Confounders only (${confounderCount})`;
  els.toggleConfoundersOnly.title = anchorsReady
    ? `Show the IV, DV, and ${confounderCount} potential common cause${confounderCount === 1 ? "" : "s"} within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"} of each anchor. Bidirectional edges are treated pessimistically as possibly running either way.`
    : "Select an IV and DV before filtering to confounders.";
  const colliderCount = state.colliderGroupIds?.size || 0;
  els.toggleCollidersOnly.disabled = !anchorsReady;
  els.toggleCollidersOnly.classList.toggle("active", state.showCollidersOnly);
  els.toggleCollidersOnly.setAttribute("aria-pressed", state.showCollidersOnly ? "true" : "false");
  els.toggleCollidersOnly.textContent = `Colliders only (${colliderCount})`;
  els.toggleCollidersOnly.title = anchorsReady
    ? `Show the IV, DV, and ${colliderCount} potential common descendant${colliderCount === 1 ? "" : "s"} reachable from both anchors within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"}. Bidirectional edges are treated pessimistically as possibly running either way.`
    : "Select an IV and DV before filtering to colliders.";
  els.confounderPathLength.disabled = !anchorsReady;
  els.confounderPathLength.value = String(state.confounderMaxPathLength);
  els.confounderPathLength.title = anchorsReady
    ? `Maximum directed-edge length of each qualifying ${state.showCollidersOnly ? "anchor-to-collider" : "confounder-to-anchor"} path. Intermediate path nodes are shown; a path cannot pass through the other anchor.`
    : "Select an IV and DV before setting a diagnostic path length.";
  const bottleneckedIds = state.showCollidersOnly
    ? state.bottleneckedColliderIds
    : state.bottleneckedConfounderIds;
  const bottleneckedCount = bottleneckedIds?.size || 0;
  const bottleneckedLabels = [...(bottleneckedIds || [])]
    .map((groupId) => groupById(groupId)?.label || groupId)
    .sort((a, b) => a.localeCompare(b));
  const bottleneckedLabelNote = bottleneckedLabels.length
    ? ` Bottlenecked: ${bottleneckedLabels.join(", ")}.`
    : "";
  els.toggleBottleneckedConfounders.hidden = false;
  els.toggleBottleneckedConfounders.disabled = !anchorsReady;
  els.toggleBottleneckedConfounders.classList.toggle("active", state.excludeBottleneckedConfounders);
  els.toggleBottleneckedConfounders.setAttribute("aria-pressed", state.excludeBottleneckedConfounders ? "true" : "false");
  els.toggleBottleneckedConfounders.textContent = `Exclude bottlenecked (${bottleneckedCount})`;
  els.toggleBottleneckedConfounders.title = anchorsReady
    ? `${state.excludeBottleneckedConfounders ? "Currently excluding" : "Exclude"} ${bottleneckedCount} ${state.showCollidersOnly ? "collider" : "confounder"} candidate${bottleneckedCount === 1 ? "" : "s"} when every admissible witness-path pair shares an intermediate node within the current maximum path length.${bottleneckedLabelNote}`
    : "Select an IV and DV before filtering bottlenecked diagnostic candidates.";
  const diagnosticLinkPairKeys = state.showCollidersOnly
    ? state.colliderLinkPairKeys
    : state.confounderLinkPairKeys;
  const diagnosticLinkCount = diagnosticLinkPairKeys?.size || 0;
  els.toggleIrrelevantConfounderLinks.disabled = !anchorsReady;
  els.toggleIrrelevantConfounderLinks.classList.toggle("active", state.hideIrrelevantConfounderLinks);
  els.toggleIrrelevantConfounderLinks.setAttribute("aria-pressed", state.hideIrrelevantConfounderLinks ? "true" : "false");
  els.toggleIrrelevantConfounderLinks.textContent = `Path links only (${diagnosticLinkCount})`;
  els.toggleIrrelevantConfounderLinks.title = anchorsReady
    ? `Keep only the ${diagnosticLinkCount} logical link${diagnosticLinkCount === 1 ? "" : "s"} used by at least one currently displayed ${state.showCollidersOnly ? "collider's anchor-to-collider" : "confounder's candidate-to-anchor"} witness path.`
    : "Select an IV and DV before filtering diagnostic-path links.";
  const selectedCount = state.selectedVariableIds?.size || 0;
  if (els.selectionCount) {
    els.selectionCount.hidden = selectedCount === 0;
    els.selectionCount.textContent = `${selectedCount} selected`;
  }
}

function assignmentCoverage() {
  const uoaActive = state.uoaFilterEnabled && state.selectedUoa;
  const variables = visibleVariables().filter(
    (variable) => !uoaActive || uoaMatches(variable.uoa, state.selectedUoa)
  );
  const variableIds = new Set(variables.map((variable) => variable.variable_id));
  const assignedIds = new Set(
    (state.project?.groups || [])
      .flatMap((group) => group.variable_ids || [])
      .filter((variableId) => variableIds.has(variableId))
  );
  const plottedNodes = new Set(variables.map((variable) => clusterRep(variable.variable_id))).size;
  return {
    assigned: assignedIds.size,
    unassigned: Math.max(0, variables.length - assignedIds.size),
    total: variables.length,
    plottedNodes,
    rejected: rejectedVariableIdSet().size,
    uoaFiltered: Boolean(uoaActive),
  };
}

function renderAssignmentCoverage() {
  const coverage = assignmentCoverage();
  els.variableAssignmentCounts.innerHTML = `
    <span class="coverage-count assigned">${coverage.assigned.toLocaleString()} assigned</span>
    <span class="coverage-count unassigned">${coverage.unassigned.toLocaleString()} unassigned</span>
  `;
  const scope = coverage.uoaFiltered ? ` for UOA “${state.selectedUoa}”` : "";
  const rejected = coverage.rejected ? `; ${coverage.rejected.toLocaleString()} rejected variables excluded` : "";
  els.variableAssignmentCounts.title = `${coverage.total.toLocaleString()} variables${scope} represented by ${coverage.plottedNodes.toLocaleString()} plotted nodes${rejected}`;
}

// ─── Mode UI rendering ────────────────────────────────────────────────────────

function renderModeUI() {
  setupGroupController.renderMode();
}

// Show the current IV/DV anchors with a "Change" button outside Setup, so the user can
// re-pick either anchor at any time. Change returns to the corresponding Setup picker;
// the current anchor remains intact until a replacement is confirmed.
function renderAnchorBar() {
  setupGroupController.renderAnchorBar();
}

function changeAnchor(side) {
  const gid = side === "dv" ? state.project?.dv_group_id : state.project?.iv_group_id;
  const group = groupById(gid);
  if (!group) return;
  Object.assign(state, workflow.transition(state, { type: "change-anchor", side, groupId: gid }));
  const input = side === "dv" ? els.dvInput : els.ivInput;
  if (input) input.value = "";
  setMapMode("select");
  fitMap(group.variable_ids);
  renderAll();
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

function startDefinition(role) {
  if (!IS_DAG2 || !["iv", "dv"].includes(role)) return;
  state.definitionDraft = {
    role, step: "sources", source_group_ids: [], source_snapshot: [],
    eligible_variable_ids: [], new_variable_ids: [], new_label: "",
    residual_labels: {}, manual_edge_dispositions: {},
  };
  state.selectedVariableIds.clear();
  invalidateMapCaches();
  renderAll();
  els.definitionSourceSearch.focus();
}

function startEditSplit(groupId = null) {
  const context = projectOps.editableSplitContext(state.project, groupId ? groupId : activeGroup());
  if (!context) return;
  const { splitId, newGroup, residuals } = context;
  const eligible = [...new Set([...newGroup.variable_ids, ...residuals.flatMap(group => group.variable_ids)]
    .map(clusterRep))];
  state.definitionDraft = {
    mode: "edit", split_id: splitId, existing_new_group_id: newGroup.group_id,
    role: ["iv", "dv"].includes(newGroup.type) ? newGroup.type : null,
    step: "partition", source_group_ids: residuals.map(group => group.group_id),
    source_snapshot: [newGroup, ...residuals].map(group => ({ group_id: group.group_id,
      label: group.label, variable_ids: [...group.variable_ids], updated_at: group.updated_at || null })),
    eligible_variable_ids: eligible,
    new_variable_ids: [...new Set(newGroup.variable_ids.map(clusterRep))],
    new_label: newGroup.label || "",
    residual_labels: Object.fromEntries(residuals.map(group => [group.group_id, group.label || ""])),
    manual_edge_dispositions: {},
  };
  state.activeGroupId = null;
  state.selectedVariableIds = new Set(state.definitionDraft.new_variable_ids);
  invalidateMapCaches();
  setMapMode("select");
  renderAll();
  fitMap(eligible);
}

function cancelDefinition() {
  state.definitionDraft = null;
  state.selectedVariableIds.clear();
  state.selectedVariableId = null;
  invalidateMapCaches();
  setMapMode("select");
  renderAll();
}

function definitionSources() {
  const ids = new Set(state.definitionDraft?.source_group_ids || []);
  return (state.project?.groups || []).filter(group => ids.has(group.group_id));
}

function continueDefinition() {
  const draft = state.definitionDraft;
  const sources = definitionSources();
  if (!draft || !sources.length) return;
  draft.source_snapshot = sources.map(group => ({ group_id: group.group_id, label: group.label,
    variable_ids: [...group.variable_ids], updated_at: group.updated_at || null }));
  draft.eligible_variable_ids = [...new Set(sources.flatMap(group =>
    group.variable_ids.map(clusterRep)))];
  draft.new_variable_ids = [];
  draft.residual_labels = Object.fromEntries(sources.map(group =>
    [group.group_id, `Other: ${group.label || group.group_id}`]));
  draft.manual_edge_dispositions = Object.fromEntries(affectedDefinitionManualEdges()
    .map(edge => [edge.edge_id, "keep"]));
  draft.step = "partition";
  state.selectedVariableIds.clear();
  invalidateMapCaches();
  setMapMode("select");
  renderAll();
  fitMap(draft.eligible_variable_ids);
}

function definitionResidualIds(source) {
  const carved = new Set(state.definitionDraft?.new_variable_ids || []);
  return [...new Set(source.variable_ids.map(clusterRep))].filter(id => !carved.has(id));
}

function toggleDefinitionVariable(variableId, add = null) {
  const draft = state.definitionDraft;
  if (!draft || draft.step !== "partition") return;
  const id = clusterRep(variableId);
  if (!draft.eligible_variable_ids.includes(id)) return;
  const selected = new Set(draft.new_variable_ids);
  const shouldAdd = add === null ? !selected.has(id) : add;
  if (shouldAdd) selected.add(id); else selected.delete(id);
  draft.new_variable_ids = [...selected];
  state.selectedVariableIds = new Set(draft.new_variable_ids);
  state.selectedVariableId = id;
  invalidateMapCaches();
  renderAll();
}

function affectedDefinitionManualEdges() {
  const sources = new Set(state.definitionDraft?.source_group_ids || []);
  return (state.project?.manual_edges || []).filter(edge => !edge.deleted
    && (sources.has(edge.source_group_id) || sources.has(edge.target_group_id)));
}

function definitionCanReview() {
  const draft = state.definitionDraft;
  return Boolean(draft?.new_variable_ids?.length && definitionSources().every(source =>
    definitionResidualIds(source).length));
}

function definitionNeighbors() {
  const draft = state.definitionDraft;
  if (!draft?.new_variable_ids?.length) return [];
  const eligible = new Set(draft.eligible_variable_ids);
  const selected = new Set(draft.new_variable_ids);
  const best = new Map();
  for (const id of draft.new_variable_ids) {
    for (const neighbor of state.variableById.get(id)?.similarity_neighbors || []) {
      const rep = clusterRep(neighbor.variable_id);
      if (!eligible.has(rep) || selected.has(rep)) continue;
      const current = best.get(rep);
      if (!current || Number(neighbor.llm_rank || 99) < Number(current.llm_rank || 99)
          || Number(neighbor.cosine_similarity || 0) > Number(current.cosine_similarity || 0)) {
        best.set(rep, { ...neighbor, variable_id: rep });
      }
    }
  }
  return [...best.values()].sort((a, b) => Number(a.llm_rank || 99) - Number(b.llm_rank || 99)
    || Number(b.cosine_similarity || 0) - Number(a.cosine_similarity || 0)).slice(0, 12);
}

function renderDefinition() {
  const draft = state.definitionDraft;
  const wasSpatial = document.body.classList.contains("defining-variable");
  const isSpatial = Boolean(draft && draft.step !== "sources");
  document.body.classList.toggle("defining-variable", isSpatial);
  // The map is display:none in the normal DAG2 layout, so its initial canvas
  // backing store is 1x1. Resize only after the browser has laid out the
  // temporary spatial workspace, including when a saved draft is resumed.
  if (isSpatial && !wasSpatial) requestAnimationFrame(() => {
    resizeMap();
    fitMap(draft.eligible_variable_ids);
  });
  els.definitionBlock.hidden = !draft;
  if (!draft) return;
  els.definitionTitle.textContent = draft.mode === "edit" ? "Edit split"
    : `Define new ${draft.role.toUpperCase()}`;
  els.definitionSourcesStep.hidden = draft.step !== "sources";
  els.definitionPartitionStep.hidden = draft.step !== "partition";
  els.definitionReviewStep.hidden = draft.step !== "review";
  els.definitionBack.hidden = draft.mode === "edit";
  if (draft.step === "sources") {
    const query = normalized(els.definitionSourceSearch.value);
    const selected = new Set(draft.source_group_ids);
    const groups = (state.project.groups || []).map((group, index) =>
      searchModel.anchorGroupSearchMatch(group, query, index, state.variableById))
      .filter(item => item.group.variable_ids?.length && item.matches).slice(0, 60);
    els.definitionSourceList.innerHTML = groups.map(({ group, variableMatch }) => `
      <div class="definition-source-row"><label><span class="definition-source-main">
        <strong>${escapeHtml(group.label || group.group_id)}</strong>
        <span>${new Set(group.variable_ids.map(clusterRep)).size} canonical</span></span>
        ${variableMatch ? `<span class="setup-group-variable-match">Matched: ${escapeHtml(truncate(variableMatch, 72))}</span>` : ""}</label>
        <input type="checkbox" data-source-id="${escapeHtml(group.group_id)}" ${selected.has(group.group_id) ? "checked" : ""}></div>`).join("");
    els.definitionSourceList.querySelectorAll("input[data-source-id]").forEach(input => input.addEventListener("change", () => {
      const ids = new Set(draft.source_group_ids);
      if (input.checked) ids.add(input.dataset.sourceId); else ids.delete(input.dataset.sourceId);
      draft.source_group_ids = [...ids];
      renderDefinition(); persistProjectLocally();
    }));
    const count = definitionSources().reduce((sum, group) =>
      sum + new Set(group.variable_ids.map(clusterRep)).size, 0);
    els.definitionContinue.disabled = !selected.size;
    els.definitionContinue.textContent = selected.size
      ? `Continue with ${selected.size} categories (${count} variables)` : "Choose categories to continue";
  } else if (draft.step === "partition") {
    const residualText = definitionSources().map(source =>
      `${source.label}: ${definitionResidualIds(source).length} leftover`).join(" · ");
    els.definitionCounts.textContent = `${draft.new_variable_ids.length} in new variable · ${residualText}`;
    els.definitionReview.disabled = !definitionCanReview();
    const selectedIds = new Set(draft.new_variable_ids);
    const matches = searchVariables(els.definitionVariableSearch.value, visibleVariables().length)
      .filter(variable => !selectedIds.has(clusterRep(variable.variable_id)))
      .slice(0, 30);
    els.definitionVariableResults.innerHTML = matches.map(variable => {
      const id = clusterRep(variable.variable_id);
      return `<button class="result-button" type="button" data-variable-id="${escapeHtml(id)}">
        <strong>${escapeHtml(variable.display_label || variable.concept_label || id)}</strong>
        <span>${escapeHtml(truncate(variable.raw_variable_text || variable.concept_label, 90))}</span>
        <span>In leftover — click to add</span></button>`;
    }).join("");
    els.definitionVariableResults.querySelectorAll("button[data-variable-id]").forEach(button =>
      button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.variableId)));
    els.definitionSelectedVariables.innerHTML = draft.new_variable_ids.length
      ? draft.new_variable_ids.map(id => {
        const variable = clusterDisplayVariable(id) || state.variableById.get(id);
        return `<button class="definition-selected-variable" type="button" data-selected-variable-id="${escapeHtml(id)}"
          title="Remove from new group"><span>${escapeHtml(variable?.display_label || variable?.concept_label || id)}</span><b>×</b></button>`;
      }).join("")
      : `<div class="small-note">No variables picked yet. Click a point, search result, or draw around variables.</div>`;
    els.definitionSelectedVariables.querySelectorAll("button[data-selected-variable-id]").forEach(button =>
      button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.selectedVariableId, false)));
    const neighbors = definitionNeighbors();
    els.definitionAddNeighbors.disabled = !neighbors.length;
    els.definitionNeighborResults.innerHTML = neighbors.map(neighbor => {
      const variable = clusterDisplayVariable(neighbor.variable_id) || state.variableById.get(neighbor.variable_id);
      return `<button class="result-button" type="button" data-neighbor-id="${escapeHtml(neighbor.variable_id)}">
        <strong>${escapeHtml(variable?.display_label || variable?.concept_label || neighbor.variable_id)}</strong>
        <span>LLM rank ${escapeHtml(neighbor.llm_rank || "")}; cosine ${Number(neighbor.cosine_similarity || 0).toFixed(3)}</span></button>`;
    }).join("");
    els.definitionNeighborResults.querySelectorAll("button[data-neighbor-id]").forEach(button =>
      button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.neighborId, true)));
  } else {
    els.definitionNewLabel.value = draft.new_label || "";
    els.definitionReviewVariables.innerHTML = draft.new_variable_ids.map(id => {
      const variable = clusterDisplayVariable(id) || state.variableById.get(id);
      return `<div class="definition-review-variable">${escapeHtml(variable?.display_label || variable?.concept_label || id)}</div>`;
    }).join("");
    els.definitionResidualLabels.innerHTML = definitionSources().map(source => `
      <div class="definition-residual-row"><label class="dag-label" for="residual_${escapeHtml(source.group_id)}">
        Leftover from ${escapeHtml(source.label || source.group_id)} (${definitionResidualIds(source).length})</label>
        <input id="residual_${escapeHtml(source.group_id)}" class="search-input" data-residual-id="${escapeHtml(source.group_id)}"
          value="${escapeHtml(draft.residual_labels[source.group_id] || "")}"></div>`).join("");
    els.definitionResidualLabels.querySelectorAll("input[data-residual-id]").forEach(input =>
      input.addEventListener("input", () => { draft.residual_labels[input.dataset.residualId] = input.value; persistProjectLocally(); }));
    const affected = draft.mode === "edit" ? [] : affectedDefinitionManualEdges();
    els.definitionManualReview.innerHTML = affected.length
      ? `<h3>Review affected manual records</h3>${affected.map(edge => `<div class="definition-manual-row">
          <div>${escapeHtml(groupById(edge.source_group_id)?.label || edge.source_group_id)} → ${escapeHtml(groupById(edge.target_group_id)?.label || edge.target_group_id)}</div>
          <select class="select-input" data-manual-id="${escapeHtml(edge.edge_id)}">
            <option value="keep">Keep with leftover</option><option value="move">Move to new variable</option><option value="remove">Remove</option>
          </select></div>`).join("")}` : "";
    els.definitionManualReview.querySelectorAll("select[data-manual-id]").forEach(select => {
      select.value = draft.manual_edge_dispositions[select.dataset.manualId] || "keep";
      select.addEventListener("change", () => { draft.manual_edge_dispositions[select.dataset.manualId] = select.value; persistProjectLocally(); });
    });
    els.definitionSave.textContent = draft.mode === "edit" ? "Update split"
      : `Save and use as ${draft.role.toUpperCase()}`;
  }
}

function saveDefinition() {
  const draft = state.definitionDraft;
  if (!draft) return;
  draft.new_label = clean(els.definitionNewLabel.value);
  for (const input of els.definitionResidualLabels.querySelectorAll("input[data-residual-id]")) {
    draft.residual_labels[input.dataset.residualId] = clean(input.value);
  }
  try {
    for (const snap of draft.source_snapshot) {
      const current = groupById(snap.group_id);
      if (!current || JSON.stringify(current.variable_ids) !== JSON.stringify(snap.variable_ids)) {
        throw new Error(`Source category ${snap.label} changed while this definition was open.`);
      }
    }
    const before = takeSnapshot();
    const newGroupId = draft.existing_new_group_id || `g_split_${Date.now()}`;
    const operation = draft.mode === "edit" ? projectOps.updateSplitCategories : projectOps.splitCategories;
    const next = operation(state.project, {
      sourceGroupIds: draft.source_group_ids, newGroupId, newLabel: draft.new_label,
      residualLabels: draft.residual_labels,
      newVariableIds: expandToClusterMembers(draft.new_variable_ids), timestamp: nowIso(),
      role: draft.role, manualEdgeDispositions: draft.manual_edge_dispositions,
      splitId: draft.split_id,
    });
    applyProjectOperation(next);
    state.definitionDraft = null;
    state.selectedVariableIds.clear();
    state.activeGroupId = null;
    state.focusedGroupId = newGroupId;
    state.phase = "build";
    state.workflowMode = "group_review";
    state.changingAnchorSide = null;
    invalidateMapCaches();
    addToUndoHistory(draft.mode === "edit" ? `Updated split "${draft.new_label}"`
      : `Defined "${draft.new_label}" as ${draft.role.toUpperCase()}`, before);
    setMapMode("select");
    renderAll();
  } catch (error) {
    els.definitionValidation.textContent = error?.message || String(error);
  }
}

function installDefinitionHandlers() {
  els.definitionCancel.addEventListener("click", cancelDefinition);
  els.definitionSourceSearch.addEventListener("input", renderDefinition);
  els.definitionContinue.addEventListener("click", continueDefinition);
  els.definitionVariableSearch.addEventListener("input", renderDefinition);
  els.definitionAddNeighbors.addEventListener("click", () => {
    const selected = new Set(state.definitionDraft?.new_variable_ids || []);
    for (const neighbor of definitionNeighbors().slice(0, 8)) selected.add(neighbor.variable_id);
    state.definitionDraft.new_variable_ids = [...selected];
    state.selectedVariableIds = new Set(selected);
    invalidateMapCaches();
    renderAll();
  });
  els.definitionBack.addEventListener("click", () => {
    state.definitionDraft.step = "sources"; state.selectedVariableIds.clear();
    invalidateMapCaches(); renderAll();
  });
  els.definitionReview.addEventListener("click", () => {
    if (!definitionCanReview()) return;
    state.definitionDraft.step = "review"; renderAll();
  });
  els.definitionReviewBack.addEventListener("click", () => {
    state.definitionDraft.new_label = clean(els.definitionNewLabel.value);
    state.definitionDraft.step = "partition"; renderAll();
  });
  els.definitionNewLabel.addEventListener("input", () => {
    if (state.definitionDraft) state.definitionDraft.new_label = els.definitionNewLabel.value;
    persistProjectLocally();
  });
  els.definitionSave.addEventListener("click", saveDefinition);
}

// ─── Search ───────────────────────────────────────────────────────────────────

function renderSearch(side) {
  const input = side === "iv" ? els.ivInput : els.dvInput;
  const container = side === "iv" ? els.ivResults : els.dvResults;
  const query = input.value.trim();
  const selected = state.seeds[side];
  if (state.anchorSearchMode[side] !== "new") {
    state.searchMatches[side] = [];
    container.innerHTML = "";
    renderSetupGroupPicker(side);
    return;
  }
  const matches = query ? searchVariables(query, 16) : [];
  state.searchMatches[side] = matches.map((v) => v.variable_id);
  container.innerHTML = matches.map((v) => `
    <button class="result-button" type="button" data-side="${side}" data-variable-id="${escapeHtml(v.variable_id)}">
      <strong>${escapeHtml(v.display_label || v.concept_label)}</strong>
      <span>${escapeHtml(truncate(v.raw_variable_text || v.concept_label, 110))}</span>
      <span>${escapeHtml(v.paper_id || "unknown paper")} ${selected.has(v.variable_id) ? "(selected)" : ""}</span>
    </button>
  `).join("");
  container.querySelectorAll(".result-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const variableId = btn.dataset.variableId;
      if (!variableId) return;
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
  return searchModel.searchVariables(query, {
    variables: visibleVariables(), selectedUoa: state.selectedUoa,
    uoaFilterEnabled: state.uoaFilterEnabled, uoaMatches,
  }, limit);
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
  els.rejectedVariablesList.innerHTML = filtered.length
    ? filtered.map((entry) => `
      <div class="group-row group-row-rejected rejected-variable-row" data-variable-id="${escapeHtml(entry.variable_id)}">
        <div class="group-row-head">
          <strong>${escapeHtml(entry.label || entry.variable_id)}</strong>
          <span class="group-row-meta">${escapeHtml(String(entry.member_variable_ids?.length || 1))} vars</span>
        </div>
        <span>${escapeHtml(entry.reason || "low_quality")}</span>
        <div class="group-row-footer">
          <span class="group-status-label rejected">rejected variable</span>
          <button class="action-button" type="button" data-action="restore">Restore</button>
        </div>
      </div>
    `).join("")
    : `<div class="small-note">No rejected variables match this search.</div>`;
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
  return uoaCounts(visibleVariables());
}

function uoaMatches(variableUoa, selected) {
  return matchesUoa(variableUoa, selected);
}

function uoaSupportedByAnchors(uoa) {
  if (!IS_DAG2) return true;
  return [state.project?.iv_group_id, state.project?.dv_group_id].every(groupId => {
    const group = groupById(groupId);
    return group?.variable_ids?.some(variableId =>
      uoaMatches(state.variableById.get(variableId)?.uoa, uoa));
  });
}

function renderUoaStep() {
  if (!els.uoaChips) return;
  const parts = getAllUoaParts();
  if (!parts.length) {
    els.uoaChips.innerHTML = `<p class="small-note">No unit-of-analysis data found.</p>`;
    return;
  }
  const personCount = visibleVariables().filter(v => uoaMatches(v.uoa, PERSON_UOA_SENTINEL)).length;
  const personDisabled = !uoaSupportedByAnchors(PERSON_UOA_SENTINEL);
  const personChip = personCount > 0 ? `
    <button class="uoa-chip uoa-chip-combined${state.selectedUoa === PERSON_UOA_SENTINEL ? " active" : ""}" type="button" data-uoa="${PERSON_UOA_SENTINEL}"${personDisabled ? ' disabled title="The selected IV and DV do not both contain person-level variables"' : ""}>
      person (all)<span class="uoa-count">${personCount}</span>
    </button>
  ` : "";
  els.uoaChips.innerHTML = personChip + parts.map(([part, count]) => {
    const disabled = !uoaSupportedByAnchors(part);
    return `
    <button class="uoa-chip${state.selectedUoa === part ? " active" : ""}" type="button" data-uoa="${escapeHtml(part)}"${disabled ? ' disabled title="The selected IV and DV do not both contain this unit of analysis"' : ""}>
      ${escapeHtml(part)}<span class="uoa-count">${count}</span>
    </button>
  `;
  }).join("");
  els.uoaChips.querySelectorAll(".uoa-chip").forEach(btn => {
    btn.addEventListener("click", () => selectUoa(btn.dataset.uoa));
  });
}

function selectUoa(uoa) {
  if (!uoaSupportedByAnchors(uoa)) return;
  Object.assign(state, workflow.transition(state, {
    type: "uoa", uoa, nextPhase: IS_DAG2 ? "build" : undefined,
  }));
  renderAll();
}

function renderUoaFilterBar() {
  if (!state.selectedUoa) {
    els.uoaFilterBar.hidden = true;
    return;
  }
  els.uoaFilterBar.hidden = false;
  els.uoaSelectedLabel.textContent = state.selectedUoa === PERSON_UOA_SENTINEL ? "person (all)" : state.selectedUoa;
  els.uoaFilterToggle.checked = state.uoaFilterEnabled;
}

function renderSeedRows() {
  renderSeedRow("iv", els.ivSeeds);
  renderSeedRow("dv", els.dvSeeds);
}

function renderSeedRow(side, container) {
  container.innerHTML = [...state.seeds[side]].map((variableId) => {
    const v = state.variableById.get(variableId);
    return `
      <span class="chip" title="${escapeHtml(v?.display_label || variableId)}">
        ${escapeHtml(truncate(v?.display_label || variableId, 34))}
        <button type="button" data-side="${side}" data-variable-id="${escapeHtml(variableId)}">×</button>
      </span>
    `;
  }).join("");
  container.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.seeds[btn.dataset.side].delete(btn.dataset.variableId);
      renderAll();
    });
  });
}

// ─── Target group setup ───────────────────────────────────────────────────────

function beginTargetGroup(side) { return groupEditorController.beginTargetGroup(side); }
function promoteGroupToAnchor(side, groupId) { return groupEditorController.promoteGroupToAnchor(side, groupId); }
function assignGroupAsAnchor(side, groupId) { return groupEditorController.assignGroupAsAnchor(side, groupId); }
function seedLabel(side) { return groupEditorController.seedLabel(side); }
// Event handlers retain group references through edits. Apply pure results while
// preserving those identities; snapshots deliberately replace them on undo.
function applyProjectOperation(next) {
  projectController.applyOperation(next);
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
function closeGroupEditor() { return groupEditorController.closeGroupEditor(); }
function renderGroupEditor() { return groupEditorController.renderGroupEditor(); }
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

function activeGroupingSet() {
  return (state.data.grouping_sets || []).find((s) => s.grouping_set_id === state.project.active_grouping_set_id)
    || (state.data.grouping_sets || [])[0];
}

async function copyPermalink() {
  if (IS_DAG2) return publicationController.share();
  const schema = activeGroupingSet();
  if (!schemaMatchesProject(schema, state.project)) return window.alert(CUSTOM_SCHEMA_INSTRUCTIONS);
  const dataVersion = state.data?.snapshot?.snapshot_id;
  if (!dataVersion) return window.alert("This dataset has no immutable snapshot ID, so an exact permalink cannot be created.");
  const url = buildPermalink({ location: window.location, schemaUrl: groupingSchemaUrl(), dataVersion, state });
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
  else window.prompt("Copy this permalink:", url);
}

function currentWorkingGroupingSchema() {
  const source = activeGroupingSet() || {};
  const canonicalByVariableId = state.clusterOf;
  const owners = new Map();
  const groups = state.project.groups.filter(group => group.variable_ids?.length).map(group => {
    const variable_ids = [...new Set(group.variable_ids.map(id => canonicalByVariableId.get(id) || id))].sort();
    for (const id of variable_ids) {
      const owner = owners.get(id);
      if (owner && owner !== group.group_id) throw new Error(`Canonical variable ${id} belongs to both ${owner} and ${group.group_id}.`);
      owners.set(id, group.group_id);
    }
    return {
      group_id: group.group_id,
      label: group.label || "",
      notes: group.notes || "",
      source: group.source || "project_export",
      ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
      variable_ids,
    };
  });
  const rejected_variables = rejectedVariableEntries().map(entry => ({
    variable_id: entry.variable_id,
    member_variable_ids: [...new Set(entry.member_variable_ids || [])].sort(),
    label: entry.label || "",
    reason: entry.reason || "low_quality",
    flagged_at: "",
    previous_group_ids: [...new Set(entry.previous_group_ids || [])].sort(),
  }));
  return {
    schema_version: "groupings-v2",
    grouping_set_id: source.grouping_set_id || state.project.active_grouping_set_id,
    label: source.label || "Published working schema",
    description: source.description || "Published working grouping schema.",
    cache_compatibility: structuredClone(source.cache_compatibility || state.data.cache_compatibility || {}),
    built_against: structuredClone(source.built_against || source.cache_compatibility || state.data.cache_compatibility || {}),
    membership_unit: "canonical_variable",
    ...(source.migration_provenance ? { migration_provenance: structuredClone(source.migration_provenance) } : {}),
    groups,
    rejected_variables,
    hidden_variable_ids: [...rejectedVariableIdSet()].sort(),
  };
}

function renderGroupingSetControls() {
  setupGroupController.renderGroupingControls();
}

function applyActiveGroupingSet() {
  const groupingSet = activeGroupingSet();
  if (!groupingSet) return [];
  if (IS_DAG2) {
    applyProjectOperation(projectOps.replaceSchemaGroups(
      state.project, groupingSet, state.clusterOf, state.clusterMembers,
    ));
    normalizeProjectDuplicateAssignments();
    const iv = groupById(state.project.iv_group_id);
    const dv = groupById(state.project.dv_group_id);
    const anchorsReady = Boolean(iv?.variable_ids?.length && dv?.variable_ids?.length);
    state.phase = anchorsReady ? "build" : "select_iv";
    state.workflowMode = anchorsReady ? "group_review" : "setup";
    state.changingAnchorSide = null;
    if (!anchorsReady) {
      state.selectedUoa = null;
      state.uoaFilterEnabled = false;
    }
    return groupingSet.groups.map(group => group.group_id);
  }
  const result = projectOps.importSchemaGroups(state.project, groupingSet, state.linkLookup, nowIso());
  applyProjectOperation(result.project);
  if (!result.anchorsReady) state.filterDagByCausalRelevance = false;
  return result.loadedGroupIds;
}

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
  state.project.candidate_queue = state.candidateQueue;
}

// ─── Unified group list ───────────────────────────────────────────────────────

function renderGroupList() {
  setupGroupController.renderGroupList();
}

// ─── Grouping schema folder export ───────────────────────────────────────────

async function exportGroupingFolder() {
  const button = els.exportGroupingFolder;
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Building ZIP…";
  try {
    const timestamp = nowIso();
    const schema = currentWorkingGroupingSchema();
    const folder = await writeGroupingSchemaFolder(schema);
    const archive = makeZip([...folder].map(([name, data]) => ({ name, data })));
    state.project.grouping_exports.push({
      grouping_set_id: schema.grouping_set_id,
      exported_at: timestamp,
      format: "groupings-v2-folder",
    });
    exportController.downloadBlob(new Blob([archive], { type: "application/zip" }), "grouping_schema.zip");
  } catch (error) {
    console.error("Could not export grouping schema folder", error);
    window.alert(error?.message || "Could not export the grouping schema folder.");
  } finally {
    button.textContent = originalLabel;
    button.disabled = false;
  }
}

// ─── DAG / Link aggregation ───────────────────────────────────────────────────

function aggregateGroupLinks() {
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
  els.provenancePanel.hidden = false;
  if (!rows.length) {
    els.edgeInspector.innerHTML = `
      <strong>Variable comparison</strong>
      <div>${escapeHtml(sourceLabel)} ↔ ${escapeHtml(targetLabel)}</div>
      <div class="small-note">No evidence about a link between these variables.</div>
    `;
    els.provenancePanel.innerHTML = "";
    return true;
  }

  els.edgeInspector.innerHTML = `
    <strong>Evidence between variables</strong>
    <div>${escapeHtml(sourceLabel)} ↔ ${escapeHtml(targetLabel)}</div>
    <div class="small-note">${rows.length} extracted evidence record${rows.length === 1 ? "" : "s"}; “present” supports a link and “absent” records evidence against one.</div>
  `;
  const evidenceRows = rows.map((link) => {
    const doi = isDoi(link.paper_id) ? link.paper_id.trim() : null;
    const paper = truncate(link.paper_title || link.paper_id, 44);
    const paperCell = doi
      ? `<a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noopener" title="${escapeHtml(link.paper_title || doi)}">${escapeHtml(paper)}</a>`
      : escapeHtml(paper);
    return `<tr>
      <td>${link.direction}</td><td>${paperCell}</td>
      <td>${escapeHtml(link.causal_link_existence || "")}</td>
      <td>${escapeHtml(link.identification_strategy || "")}</td>
      <td>${escapeHtml(truncate(link.target_population || "", 60))}</td>
    </tr>`;
  }).join("");
  els.provenancePanel.innerHTML = `
    <table class="provenance-table">
      <thead><tr><th>Direction</th><th>Paper</th><th>Evidence</th><th>Strategy</th><th>Population</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table>
  `;
  return true;
}

function hasAnyMapping(sourceIds, targetIds) {
  return rawLinksBetween(sourceIds, targetIds).length > 0;
}

function computeVisibleLinks() {
  const view = deriveDagView({
    groups: dagGroups(),
    links: state.project.links,
    ivId: state.project.iv_group_id,
    dvId: state.project.dv_group_id,
    maxPathLength: state.confounderMaxPathLength,
    excludeBottlenecked: state.excludeBottleneckedConfounders,
    filterByCausalRelevance: state.filterDagByCausalRelevance,
    showConfoundersOnly: state.showConfoundersOnly,
    showCollidersOnly: state.showCollidersOnly,
    hideIrrelevantDiagnosticLinks: state.hideIrrelevantConfounderLinks,
  });
  state.filterDagByCausalRelevance = view.filterByCausalRelevance;
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
function renderDag() { return dagNetworkController.renderDag(); }
function minimumDagScale() { return dagNetworkController.minimumDagScale(); }

// ─── Edge inspector + provenance ──────────────────────────────────────────────

function renderEdgeInspector() {
  inspectorController.renderEdge();
}


function renderProvenance() {
  inspectorController.renderProvenance();
}

// ─── Manual edge form ─────────────────────────────────────────────────────────

function renderManualEdgeControls() {
  inspectorController.renderManualControls();
}

function addManualEdge() {
  inspectorController.addManualEdge();
}

// ─── Export / Import ──────────────────────────────────────────────────────────

async function importProject(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    applyLoadedProject(payload);
    const layoutSource = state.variableLayoutSource;
    if (layoutSource && layoutSource !== state.data.layout?.active_source) {
      await loadDagData(layoutSource);
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
  return dagProjectView().groups.filter((g) => g.variable_ids?.length);
}

function dagProjectView() {
  return projectForUoa(
    state.project, state.variableById, state.selectedUoa, state.uoaFilterEnabled,
  );
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
    if (link.display_status === "hidden") continue;
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

function drawMap(options) { return mapUiController.drawMap(options); }
function drawMapPoints(ctx, width, height) { return mapUiController.drawMapPoints(ctx, width, height); }
function ensureGlobalVoronoiCells() { return mapUiController.ensureGlobalVoronoiCells(); }
function applyBrush() { return mapUiController.applyBrush(); }
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

const projectController = createDagProjectController({
  state, storage: window.localStorage, storagePrefix: PROJECT_STORAGE_PREFIX,
  nowIso, invalidateMapCaches, renderAll, renderUndoRedo, renderActionHistory,
});

const inspectorController = createDagInspectorController({
  state, elements: els, escapeHtml, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildProject, groupById, dagGroups,
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
  escapeHtml, truncate,
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
});

const setupGroupController = createDagSetupGroupController({
  state, elements: els, escapeHtml, normalized, truncate, groupById,
  assignGroupAsAnchor, setMapMode, renderAll, roleLabels: ROLE_LABELS, dagProjectView, startDefinition,
  canEditSplit: group => Boolean(projectOps.editableSplitContext(state.project, group)),
});

const dagNetworkController = createDagNetworkController({
  state, elements: els, visApi: vis, clusterRep, groupColor, dagGroups, groupById,
  drawMap, setMapMode, renderAll, selectEdge: () => renderCoordinator.selectEdge(),
});

const shellController = createDagShellController({
  state, elements: els, resizeMap, fitMap, renderDag,
  getNetwork: () => dagNetworkController.getNetwork(),
});

const exportController = createDagExportController({
  state, elements: els, rejectedVariableEntries, rejectedVariableIdSet,
  projectPayload, aggregateGroupLinks, computeVisibleLinks, nowIso,
});

const publicationController = createPublicationController({
  elements: {
    get publish() { return els.publishSchema; },
    get status() { return els.publicationStatus; },
    get badge() { return els.schemaPublicationBadge; },
    get permalink() { return els.publishedSchemaPermalink; },
    get confirmation() { return els.publishSchemaDialog; },
    get share() { return els.copyPermalink; },
  },
  getWorkingSchema: currentWorkingGroupingSchema,
  getPublicationState: () => state.project?.publication || null,
  getPermalinkState: () => {
    const network = dagNetworkController.getNetwork();
    state.dagViewport = network ? { scale: network.getScale(), position: network.getViewPosition() } : null;
    return state;
  },
  setPublicationState: publication => { state.project.publication = publication; },
  saveWorkingState: persistProjectLocally,
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
  renderSearch, fitSearchContext, toggleAnchorSearchMode, finishSchemaChoice, changeAnchor,
  setWorkflowMode, renderGroupList, closeGroupEditor, selectActiveAnchor,
  addTopNeighborsToActiveGroup, removeTopNeighborsFromActiveGroup, clearActiveGroupVariables,
  renderGroupSeedSearch, renderRejectedVariablesPanel, fitMap, applyProjectOperation,
  saveProjectLocally, applyActiveGroupingSet, rebuildProject, exportGroupingFolder,
  copyPermalink, loadDagData, invalidateMapCaches, zoomMap, canvasWidth,
  canvasHeight, toggleFullscreenPanel, renderMapToolbarToggles, clampNumber, setMapMode,
  undo, redo, renderActionHistory, renderDag, setFullscreenPanel, addManualEdge,
  createCustomGroup, exportProject, exportWorkingMap, importProject, exportBib, exportMd,
  exportTex, resizeMap, installDagHandlers, initPanelResizers, hideMapContextMenu,
  showMapContextMenu, isDrawMode, nearestVariable, repAtPoint, scheduleMapDraw,
  isSeedSelectionPhase, constrainMapTransform, updateMapHover, applyBrush, takeSnapshot,
  addToUndoHistory, clusterRep, clearHoverIntent, addVariableToGroup, clean,
  startEditSplit,
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

init().catch((error) => {
  document.body.innerHTML = `<main class="panel-section"><h1>DAG Builder</h1><p>${escapeHtml(error?.message || error)}</p></main>`;
});
