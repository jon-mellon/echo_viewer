import * as mapCanvas from "./map_canvas_renderer.mjs";
import * as mapGeometry from "./map_geometry.mjs";
import * as mapInteractions from "./map_interactions.mjs";
import * as mapRenderModel from "./map_render_model.mjs";
import * as projectOps from "./dag_project.mjs";
import * as visibility from "./variable_visibility.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createDagMapUiController({
  state, elements: els, beginDraw, canvasWidth, canvasHeight, worldToScreen, screenToWorld,
  visibleClusterReps, dagGroups, activeGroup, uoaMatches, clusterRep, clusterMemberIds,
  clusterDisplayVariable, clusterExactStringGroups, expandToClusterMembers, groupById,
  applyProjectOperation, nowIso, takeSnapshot, addToUndoHistory, addDecision, addVariableToGroup,
  addVariableSetToGroup, removeVariableFromGroup, beginTargetGroup, setMapMode,
  renderAll, rebuildProject, invalidateMapCaches, rejectedVariableEntries,
  rejectedVariableIdSet, isRejectedVariable, clean, escapeHtml, truncate,
  groupColors: GROUP_COLORS, groupPalette: GROUP_PALETTE,
}) {
function drawMap({ includeLabels = true } = {}) {
  beginDraw(includeLabels);
  const ctx = state.map.ctx;
  if (!ctx) return;
  const width = canvasWidth();
  const height = canvasHeight();
  ctx.clearRect(0, 0, width, height);
  state.map._visibleVarCount = countViewportVariables(width, height);
  drawVoronoiBackground(ctx, width, height);
  if (!state.map._groupRegions) {
    state.map._groupRegions = computeGroupRegions(displayGroups());
  }
  drawMapGroups(ctx);
  drawMapPoints(ctx, width, height);
  if (includeLabels) {
    renderMapLabels(width, height);
    els.dagMapLabels.style.visibility = "";
  } else {
    els.dagMapLabels.style.visibility = "hidden";
  }
  drawBrush(ctx);
}

// Faint outline of every node's Voronoi cell, so the whole tessellation is visible and
// users can see (and double-click) the cell each node owns, even when unselected.
function drawVoronoiBackground(ctx, width, height) {
  mapCanvas.drawVoronoiBackground(ctx, ensureGlobalVoronoiCells(), width, height, state.map.transform);
}

function displayGroups() {
  const draft = state.definitionDraft;
  if (!draft || !["partition", "review"].includes(draft.step)) return state.project?.groups || [];
  const carved = new Set(draft.new_variable_ids || []);
  const sources = new Set(draft.source_group_ids || []);
  const residuals = (state.project?.groups || []).map(group => sources.has(group.group_id)
    ? { ...group, variable_ids: (group.variable_ids || []).filter(id => !carved.has(clusterRep(id))) }
    : group);
  return [{
    group_id: "__definition_new__",
    label: "New group",
    type: "custom",
    variable_ids: [...carved],
  }, ...residuals];
}

function drawMapGroups(ctx) {
  const groups = displayGroups();
  const visibleReps = new Set(visibleClusterReps().map(variable => variable.variable_id));
  for (const group of groups) {
    if (!group.variable_ids?.length) continue;
    if (!group.variable_ids.some(id => visibleReps.has(clusterRep(id)))) continue;
    const active = group.group_id === "__definition_new__" || group.group_id === state.activeGroupId;
    // Every group is drawn as the union
    // of its members' fixed global Voronoi cells (see computeGroupRegions). Because
    // each node's cell is fixed regardless of group membership, adding a member only
    // adds its cell to the union: the colored area can never shrink.
    const region = state.map._groupRegions?.get(group.group_id);
    if (region?.territories?.length) drawGroupRegion(ctx, group, region, active);
    else drawGroupMemberHalos(ctx, group, active);
  }
}

function drawGroupMemberHalos(ctx, group, active) {
  const visibleReps = new Set(visibleClusterReps().map(variable => variable.variable_id));
  const visibleGroup = { ...group, variable_ids: [...new Set((group.variable_ids || [])
    .map(clusterRep).filter(id => visibleReps.has(id) && !isRejectedVariable(id)))] };
  if (!visibleGroup.variable_ids.length) return;
  mapCanvas.drawGroupMemberHalos(ctx, visibleGroup, active, {
    transform: state.map.transform, variables: state.variableById, colors: GROUP_COLORS,
  });
}

// ─── Map viewport and geometry cache ──────────────────────────────────────────


// Count variables in the current viewport (caps at 101 for perf).
function countViewportVariables(width, height) {
  let n = 0;
  for (const v of visibleClusterReps()) {
    const s = worldToScreen(v.map_x, v.map_y);
    if (s.x > -10 && s.x < width + 10 && s.y > -10 && s.y < height + 10) if (++n > 100) return n;
  }
  return n;
}

// Global Voronoi cells — one fixed world-space polygon per node (representative).
// Computed once from the layout (node positions never change during a session), so a
// node's cell does NOT depend on group membership. A group's region is the union of
// its members' cells, which makes the colored area monotonic: adding a member can only
// add its (fixed) cell. Cached permanently.
let _globalVoronoiCells = null;

function ensureGlobalVoronoiCells() {
  if (_globalVoronoiCells) return _globalVoronoiCells;
  const representatives = visibleClusterReps().map(v => ({ id: v.variable_id, x: v.map_x, y: v.map_y }));
  if (!representatives.length) return new Map();
  _globalVoronoiCells = mapGeometry.computeVoronoiCells(representatives);
  return _globalVoronoiCells;
}

// A group's region = union of the global Voronoi cells of its member representatives.
// (Coincident duplicates share one representative, hence one cell — duplicates merge
// naturally.) Returns world-space territory polygons; drawGroupRegion projects them.
function computeGroupRegions(groups) {
  return mapGeometry.computeGroupRegions(groups, {
    cells: ensureGlobalVoronoiCells(),
    clusterRep,
    variables: state.variableById,
    transform: null,
  });
}

function drawGroupRegion(ctx, group, region, active) {
  mapCanvas.drawGroupRegion(ctx, region, active, {
    color: groupColor(group), width: canvasWidth(), height: canvasHeight(), transform: state.map.transform,
  });
}


function drawMapPoints(ctx, width, height) {
  const groups = displayGroups();
  const definitionActiveId = state.definitionDraft?.new_variable_ids?.length ? "__definition_new__" : state.activeGroupId;
  const points = mapRenderModel.buildMapPointModels({
    variables: visibleClusterReps(),
    groups,
    activeGroupId: definitionActiveId,
    selectedVariableId: state.selectedVariableId,
    selectedVariableIds: state.selectedVariableIds,
    hoveredVariableId: state.hoveredVariableId,
    clusterRep,
    worldToScreen: mapGeometry.worldToScreen,
    transform: state.map.transform,
    width,
    height,
    uoaFilterEnabled: state.uoaFilterEnabled,
    selectedUoa: state.selectedUoa,
    uoaMatches,
    variableColorForStatus: variableColor,
  });
  mapCanvas.drawMapPoints(ctx, points);
}

function importantMapVariables() {
  return mapRenderModel.importantMapVariables({
    variables: visibleClusterReps(),
    variableById: state.variableById,
    groups: state.project?.groups || [],
    activeGroupId: state.activeGroupId,
    focusedGroupId: state.focusedGroupId,
    seeds: state.seeds,
    searchMatches: state.searchMatches,
    selectedVariableId: state.selectedVariableId,
    selectedVariableIds: state.selectedVariableIds,
    hoveredVariableId: state.hoveredVariableId,
    visibleVarCount: state.map._visibleVarCount,
    width: canvasWidth(),
    height: canvasHeight(),
    transform: state.map.transform,
    phase: state.phase,
    isRejectedVariable,
    clusterRep,
    clusterMemberIds,
    worldToScreen: mapGeometry.worldToScreen,
  });
}

function renderMapLabels(width, height) {
  const variableLabels = [];
  const groupLabels = [];
  const occupied = [];
  const fewVisible = (state.map._visibleVarCount ?? 999) <= 50;

  // Build set of variable IDs belonging to groups
  const assignedVarIds = new Set();
  for (const g of (state.project?.groups || [])) {
    for (const id of g.variable_ids || []) assignedVarIds.add(id);
  }

  // Variable labels — rendered first (lower z-order), suppressed inside groups
  // except for high-priority states and far zoom-in.
  if (state.showVariableLabels) {
    const ordered = importantMapVariables().sort((a, b) => labelPriority(b) - labelPriority(a));
    for (const item of ordered) {
      const v = item.variable;
      if (!mapRenderModel.shouldShowVariableLabel(item, {
        isAssigned: assignedVarIds.has(v.variable_id),
        fewVisible,
      })) continue;
      const screen = worldToScreen(v.map_x, v.map_y);
      if (screen.x < -160 || screen.x > width + 160 || screen.y < -70 || screen.y > height + 70) continue;
      const displayVariable = clusterDisplayVariable(v.variable_id) || v;
      const baseText = displayVariable.display_label || displayVariable.concept_label || v.variable_id;
      const text = v.cluster_size > 1 ? `${baseText}  ×${v.cluster_size}` : baseText;
      const maxWidth = item.isSeed || item.isActive || item.isSelected ? 360 : 280;
      const size = estimateLabelSize(text, maxWidth, item);
      // Force placement when zoomed in far (every visible point deserves a label).
      const force = fewVisible || item.isSearch || labelPriority(item) >= 20;
      const placed = placeLabel(screen, size, occupied, width, height, force);
      if (!placed) continue;
      occupied.push(placed);
      variableLabels.push(h("div", { className: `map-label ${mapLabelClasses(item)}`, dataset: { variableId: v.variable_id },
        title: text, textContent: text, style: { left: `${placed.x.toFixed(1)}px`, top: `${placed.y.toFixed(1)}px`, maxWidth: `${maxWidth}px`, transform: "none" } }));
    }
  }

  // Group-level labels — rendered last so they sit above variable labels in DOM z-order.
  // Their bounding boxes are added to occupied AFTER variable labels so variable labels
  // don't avoid them, but group labels always win visually.
  if (state.showGroupLabels) {
    for (const [groupId, region] of (state.map._groupRegions || new Map())) {
      const group = groupById(groupId);
      if (!group?.label) continue;
      const color = groupColor(group);
      const labelRegions = region.components?.length ? region.components : [region];
      for (const labelRegion of labelRegions) {
        const screenAnchor = worldToScreen(labelRegion.cx, labelRegion.cy);
        const { x: cx, y: cy } = screenAnchor;
        if (cx < -10 || cx > width + 10 || cy < -10 || cy > height + 10) continue;
        groupLabels.push(h("div", { className: "map-label group-region-label", title: group.label, textContent: group.label,
          style: { left: `${cx.toFixed(1)}px`, top: `${cy.toFixed(1)}px`, color, borderColor: hexToRgba(color, 0.35), transform: "translate(-50%,-50%)" } }));
      }
    }
  }

  replaceChildren(els.dagMapLabels, variableLabels, groupLabels);
}

function estimateLabelSize(text, maxWidth, item) {
  return mapRenderModel.estimateLabelSize(text, maxWidth, item);
}

function placeLabel(screen, size, occupied, width, height, force) {
  return mapGeometry.placeLabel(screen, size, occupied, width, height, force);
}

function labelPriority(item) {
  return mapRenderModel.labelPriority(item);
}

function mapLabelClasses(item) {
  return mapRenderModel.mapLabelClasses(item);
}

function drawBrush(ctx) {
  mapCanvas.drawBrush(ctx, state.map.brush, GROUP_COLORS);
}

function applyBrush() {
  const brush = state.map.brush;
  if (!brush?.points || brush.points.length < 3) return;
  const group = activeGroup();
  if (brush.action === "select_vars") {
    const picked = [];
    for (const v of visibleClusterReps()) {
      if (brushHitsRepresentative(v, brush.points)) picked.push(v.variable_id);
    }
    state.selectedVariableIds = new Set(picked);
    state.selectedVariableId = picked[picked.length - 1] || null;
    renderAll();
    return;
  }
  // Draw-to-seed: no group yet, drawing during DV/IV selection picks the enclosed
  // variables as the seed set and opens the target group.
  if (!group && isSeedSelectionPhase() && brush.action !== "remove") {
    const side = state.phase === "select_dv" ? "dv" : "iv";
    const picked = [];
    for (const v of visibleClusterReps()) {
      const screen = worldToScreen(v.map_x, v.map_y);
      if (pointInPolygon(screen, brush.points)) picked.push(v.variable_id);
    }
    if (!picked.length) return;
    for (const id of picked) state.seeds[side].add(id);
    state.selectedVariableId = picked[picked.length - 1];
    beginTargetGroup(side);
    return;
  }
  if (!group) return;
  if (group.group_id === "__definition_new__") {
    const selected = new Set(state.definitionDraft?.new_variable_ids || []);
    const eligible = new Set(state.definitionDraft?.eligible_variable_ids || []);
    const picked = [];
    for (const v of visibleClusterReps()) {
      if (!brushHitsRepresentative(v, brush.points)) continue;
      const id = clusterRep(v.variable_id);
      if (!eligible.has(id)) continue;
      picked.push(id);
      if (brush.action === "remove") selected.delete(id); else selected.add(id);
    }
    state.definitionDraft.new_variable_ids = [...selected];
    state.selectedVariableIds = new Set(selected);
    state.selectedVariableId = picked[picked.length - 1] || state.selectedVariableId;
    renderAll();
    return;
  }
  const before = new Set(group.variable_ids);
  const changed = [];
  const picked = [];
  for (const v of visibleClusterReps()) {
    if (!brushHitsRepresentative(v, brush.points)) continue;
    picked.push(v.variable_id);
    if (brush.action === "remove") {
      if (before.has(v.variable_id)) changed.push(v.variable_id);
      removeVariableFromGroup(group, v.variable_id);
    } else {
      if (!before.has(v.variable_id)) changed.push(v.variable_id);
      addVariableToGroup(group, v.variable_id);
    }
  }
  state.selectedVariableIds = new Set(picked);
  state.selectedVariableId = picked[picked.length - 1] || state.selectedVariableId;
  ensureBoundaryGeometry(group).polygons.push({
    action: brush.action,
    points: brush.points.map((p) => screenToWorld(p.x, p.y)),
    changed_variable_ids: changed,
    created_at: nowIso(),
  });
  if (changed.length) {
    addDecision("boundary_drawn", { group_id: group.group_id, action: brush.action, changed_variable_ids: changed });
  }
  renderAll();
}

function ensureBoundaryGeometry(group) {
  if (!group.boundary_geometry || typeof group.boundary_geometry !== "object") group.boundary_geometry = {};
  if (!Array.isArray(group.boundary_geometry.polygons)) group.boundary_geometry.polygons = [];
  return group.boundary_geometry;
}

function pointInPolygon(point, polygon) { return mapGeometry.pointInPolygon(point, polygon); }

function brushHitsRepresentative(variable, brushPoints) {
  const screen = worldToScreen(variable.map_x, variable.map_y);
  return pointInPolygon(screen, brushPoints);
}

function variableVisualStatus(variableId) {
  return mapRenderModel.variableVisualStatus(variableId, state.project?.groups, state.activeGroupId);
}

function variableColor(status) {
  return mapRenderModel.variableColor(status, GROUP_COLORS);
}

let _paletteAssignmentSig = null;
let _paletteAssignment = new Map(); // group_id -> palette index

function invalidateCaches() {
  _globalVoronoiCells = null;
  _paletteAssignmentSig = null;
  _paletteAssignment = new Map();
}

function computePaletteAssignment() {
  const groups = state.project?.groups || [];
  const sig = groups.map(g => g.group_id + ":" + g.variable_ids.join(",")).join("|");
  if (sig === _paletteAssignmentSig) return;
  _paletteAssignmentSig = sig;
  _paletteAssignment = mapRenderModel.computePaletteAssignment(groups, state.variables, GROUP_PALETTE);
}

function groupColor(group) {
  if (group.group_id === "__definition_new__") return GROUP_COLORS.active;
  computePaletteAssignment();
  return mapRenderModel.groupColor(group, {
    activeGroupId: state.activeGroupId,
    groupColors: GROUP_COLORS,
    palette: GROUP_PALETTE,
    paletteAssignment: _paletteAssignment,
  });
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Cell under the cursor = nearest site (the defining property of a Voronoi cell).
function repAtPoint(clientX, clientY) {
  return nearestVariable(clientX, clientY, Infinity);
}

// Delayed, cell-based hover: hovering anywhere inside a node's Voronoi cell reveals that
// node's info after a short dwell. Jitter within the same cell does not reset the timer.
let _hoverTimer = null;
let _hoverPendingRep = null;
let _hoverActiveRep = null;
let _hoverClient = { x: 0, y: 0 };
const HOVER_DELAY_MS = 350;

function clearHoverIntent() {
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  _hoverPendingRep = null;
  _hoverActiveRep = null;
}

function updateMapHover(event) {
  _hoverClient = { x: event.clientX, y: event.clientY };
  const rep = repAtPoint(event.clientX, event.clientY);
  const repId = rep ? rep.variable_id : null;

  if (repId === _hoverActiveRep) {
    // Tooltip already shown for this cell — let it follow the cursor.
    if (rep) showMapTooltip(rep, event.clientX, event.clientY);
    return;
  }
  if (repId === _hoverPendingRep) return; // still dwelling on the same cell; keep waiting

  // Entered a different cell (or empty space): hide the old tooltip and schedule anew.
  if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
  if (_hoverActiveRep) {
    _hoverActiveRep = null;
    state.hoveredVariableId = null;
    els.dagMapTooltip.hidden = true;
    drawMap();
  }
  _hoverPendingRep = repId;
  if (!repId) return;
  _hoverTimer = setTimeout(() => {
    _hoverTimer = null;
    _hoverActiveRep = repId;
    _hoverPendingRep = null;
    const v = state.variableById.get(repId);
    if (!v) return;
    state.hoveredVariableId = repId;
    showMapTooltip(v, _hoverClient.x, _hoverClient.y);
    drawMap();
  }, HOVER_DELAY_MS);
}

function nearestVariable(clientX, clientY, threshold) {
  const rect = state.map.canvas.getBoundingClientRect();
  return mapInteractions.nearestVariable(
    visibleClusterReps(),
    mapInteractions.eventPoint({ clientX, clientY }, rect),
    threshold,
    state.map.transform,
    mapGeometry.worldToScreen,
  );
}

function showMapTooltip(variable, clientX, clientY) {
  const members = clusterMemberIds(variable.variable_id)
    .map((variableId) => state.variableById.get(variableId))
    .filter(Boolean);
  const displayVariable = clusterDisplayVariable(variable.variable_id) || variable;
  const exactStrings = clusterExactStringGroups(variable.variable_id);
  const duplicatePreview = members.length > 1 ? [
    h("div", { className: "tooltip-duplicate-heading", textContent: `${members.length} variables · ${exactStrings.length} exact strings` }),
    h("div", { className: "tooltip-duplicate-list" }, exactStrings.slice(0, 5).map(entry => h("div", {}, entry.label, " ", h("strong", { textContent: `×${entry.count}` }))),
      exactStrings.length > 5 ? h("div", { textContent: `…and ${exactStrings.length - 5} more exact strings` }) : null),
    h("span", { textContent: "Right-click the node to inspect every distinct string." }),
  ] : [];
  replaceChildren(els.dagMapTooltip, h("strong", { textContent: displayVariable.display_label || displayVariable.concept_label }),
    h("span", { textContent: displayVariable.paper_id || "unknown paper" }), h("span", { textContent: displayVariable.raw_variable_text || "" }),
    h("span", { textContent: displayVariable.uoa ? `UOA: ${displayVariable.uoa}` : "" }), duplicatePreview);
  els.dagMapTooltip.hidden = false;
  const rect = state.map.canvas.getBoundingClientRect();
  const x = clientX - rect.left + 14;
  const y = clientY - rect.top + 14;
  els.dagMapTooltip.style.left = `${Math.max(8, Math.min(x, rect.width - 540))}px`;
  els.dagMapTooltip.style.top = `${Math.max(8, Math.min(y, rect.height - 220))}px`;
}

function duplicateDetailsHtml(variable) {
  const members = clusterMemberIds(variable.variable_id)
    .map((variableId) => state.variableById.get(variableId))
    .filter(Boolean);
  if (members.length <= 1) return null;
  const exactStrings = clusterExactStringGroups(variable.variable_id);
  return h("details", { className: "duplicate-details", open: true },
    h("summary", { textContent: `${members.length} merged variables · ${exactStrings.length} exact strings` }),
    h("div", { className: "duplicate-member-list" }, exactStrings.map(entry => h("div", { className: "duplicate-member" },
      h("strong", { textContent: entry.label }), h("span", { className: "duplicate-string-count", textContent: `×${entry.count}` })))));
}

function hideMapContextMenu() {
  if (!els.dagMapContextMenu) return;
  state.mapContextMenu.variableIds = [];
  state.mapContextMenu.variableId = null;
  state.mapContextMenu.query = "";
  els.dagMapContextMenu.hidden = true;
  els.dagMapContextMenu.replaceChildren();
}

function removeVariablesFromAllGroups(variableIds) {
  const result = projectOps.removeMembersEverywhere(state.project, variableIds);
  applyProjectOperation(result.project);
  return result.previousGroupIds;
}

function flagVariableSetLowQuality(variableIds) {
  const repIds = [...new Set((variableIds || []).map((id) => clusterRep(id)).filter(Boolean))];
  if (!repIds.length) return;
  const allMemberIds = [...new Set(repIds.flatMap((repId) => clusterMemberIds(repId)))];
  const previousGroupIds = removeVariablesFromAllGroups(allMemberIds);
  const entries = [];
  for (const repId of repIds) {
    const variable = state.variableById.get(repId);
    if (!variable) continue;
    const memberIds = clusterMemberIds(repId);
    entries.push({
      variable_id: repId,
      member_variable_ids: memberIds.slice(),
      label: variable.display_label || variable.concept_label || repId,
      reason: "low_quality",
      flagged_at: nowIso(),
      previous_group_ids: previousGroupIds,
    });
  }
  state.project = visibility.rejectVariables(state.project, entries, state.clusterOf, state.clusterMembers);
  if (allMemberIds.includes(state.selectedVariableId)) state.selectedVariableId = null;
  if (allMemberIds.includes(state.hoveredVariableId)) {
    state.hoveredVariableId = null;
    els.dagMapTooltip.hidden = true;
  }
  state.selectedVariableIds = new Set();
  hideMapContextMenu();
  invalidateMapCaches();
  addDecision("variable_flagged_low_quality", {
    variable_ids: repIds,
    member_variable_ids: allMemberIds,
    previous_group_ids: previousGroupIds,
  });
}

function flagVariableLowQuality(variableId) {
  flagVariableSetLowQuality([variableId]);
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
  invalidateMapCaches();
  addDecision("rejected_variable_restored", {
    variable_id: repId,
    member_variable_ids: memberIds,
    restored_group_ids: entry.previous_group_ids || [],
  });
}

function contextMenuTargetGroups(variableId) {
  const selectedIds = [...new Set((state.mapContextMenu.variableIds || []).map((id) => clusterRep(id)).filter(Boolean))];
  const blockedIds = new Set(selectedIds.flatMap((id) => clusterMemberIds(id)));
  return (state.project?.groups || [])
    .filter((group) => group.variable_ids?.length)
    .filter((group) => {
      if (selectedIds.length) return !blockedIds.size || !group.variable_ids.every((id) => blockedIds.has(id));
      return !group.variable_ids.includes(variableId);
    })
    .sort((a, b) => {
      const aActive = a.group_id === state.activeGroupId ? 0 : 1;
      const bActive = b.group_id === state.activeGroupId ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return groupStatusOrder(a) - groupStatusOrder(b) || (a.label || "").localeCompare(b.label || "");
    });
}

function showMapContextMenu(variable, clientX, clientY, variableIds = null) {
  if (!els.dagMapContextMenu) return;
  state.mapContextMenu.variableIds = Array.isArray(variableIds) ? variableIds.slice() : [];
  state.mapContextMenu.variableId = variable?.variable_id || null;
  state.mapContextMenu.clientX = clientX;
  state.mapContextMenu.clientY = clientY;
  state.mapContextMenu.query = "";
  renderMapContextMenu();
}

function contextMenuItem(title, description, dataset) {
  return h("button", { className: "map-context-menu-item", type: "button", dataset },
    h("div", {}, h("strong", { textContent: title }), h("span", { textContent: description })));
}

function contextMenuSearch() {
  return h("input", { className: "map-context-menu-search", type: "search", placeholder: "Search groups", value: state.mapContextMenu.query });
}

function flagContextAction(action, title, description) {
  return h("div", { className: "map-context-menu-actions" }, contextMenuItem(title, description, { action }));
}

function renderMapContextMenu() {
  if (!els.dagMapContextMenu) return;
  const selectedIds = [...new Set((state.mapContextMenu.variableIds || []).map((id) => clusterRep(id)).filter(Boolean))];
  const isBatchSelection = selectedIds.length > 0;
  const variable = state.variableById.get(state.mapContextMenu.variableId || "");
  if (!variable && !isBatchSelection) {
    hideMapContextMenu();
    return;
  }
  if (state.definitionDraft?.step === "partition") {
    const ids = isBatchSelection ? selectedIds : [clusterRep(variable.variable_id)];
    const selected = new Set(state.definitionDraft.new_variable_ids || []);
    const allIncluded = ids.every(id => selected.has(id));
    const rect = state.map.canvas.getBoundingClientRect();
    replaceChildren(els.dagMapContextMenu,
      h("div", { className: "map-context-menu-title", textContent: isBatchSelection ? `${ids.length} selected variables` : (clusterDisplayVariable(variable.variable_id)?.display_label || variable.variable_id) }),
      contextMenuItem(allIncluded ? "Return to source leftovers" : "Add to new variable", "Applies only within this definition draft.", { definitionAction: allIncluded ? "remove" : "add" }));
    els.dagMapContextMenu.querySelector("button[data-definition-action]").addEventListener("click", buttonEvent => {
      const add = buttonEvent.currentTarget.dataset.definitionAction === "add";
      for (const id of ids) {
        if (add) selected.add(id); else selected.delete(id);
      }
      state.definitionDraft.new_variable_ids = [...selected];
      state.selectedVariableIds = new Set(selected);
      hideMapContextMenu();
      renderAll();
    });
    els.dagMapContextMenu.hidden = false;
    const position = mapInteractions.contextMenuPosition({ ...state.mapContextMenu, rect,
      menuWidth: Math.min(360, rect.width - 16), menuHeight: 140 });
    els.dagMapContextMenu.style.left = `${position.left}px`;
    els.dagMapContextMenu.style.top = `${position.top}px`;
    return;
  }
  if (isBatchSelection) {
    const query = clean(state.mapContextMenu.query).toLowerCase();
    const allTargets = contextMenuTargetGroups(selectedIds[0]);
    const targets = query
      ? allTargets.filter((group) => {
          const haystack = [group.label, group.group_id, group.notes, group.type]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        })
      : allTargets;
    const rect = state.map.canvas.getBoundingClientRect();
    replaceChildren(els.dagMapContextMenu,
      h("div", { className: "map-context-menu-title", textContent: `${selectedIds.length} selected variables` }),
      flagContextAction("flag-low-quality-batch", "Delete selected nodes", "Remove all selected variables from the viewer and save them as rejected."),
      h("div", { className: "map-context-menu-subtitle", textContent: "Selection created with Draw +. You can delete it or move the whole selection into one group." }),
      contextMenuSearch(), h("div", { className: "map-context-menu-list" }, targets.map(group =>
        contextMenuItem(group.label || group.group_id, `Add ${selectedIds.length} selected vars · ${group.variable_ids?.length || 0} vars`, { groupId: group.group_id }))));
    els.dagMapContextMenu.querySelector("[data-action='flag-low-quality-batch']")?.addEventListener("click", () => {
      if (!window.confirm(`Flag ${selectedIds.length} selected variables as low quality and remove them from the viewer?`)) return;
      const before = takeSnapshot();
      flagVariableSetLowQuality(selectedIds);
      addToUndoHistory(`Flagged ${selectedIds.length} variables low quality`, before);
      rebuildProject();
    });
    els.dagMapContextMenu.querySelectorAll("button[data-group-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = groupById(btn.dataset.groupId);
        if (!group) return;
        const before = takeSnapshot();
        addVariableSetToGroup(group, selectedIds);
        state.selectedVariableIds = new Set();
        state.selectedVariableId = selectedIds[selectedIds.length - 1] || null;
        hideMapContextMenu();
        addToUndoHistory(`Added ${selectedIds.length} variables to "${group.label}"`, before);
        rebuildProject();
      });
    });
    els.dagMapContextMenu.hidden = false;
    const searchInput = els.dagMapContextMenu.querySelector(".map-context-menu-search");
    searchInput?.addEventListener("input", () => {
      state.mapContextMenu.query = searchInput.value;
      renderMapContextMenu();
    });
    const menuWidth = Math.min(360, rect.width - 16);
    const menuHeight = Math.min(340, Math.max(140, els.dagMapContextMenu.offsetHeight || 220));
    const position = mapInteractions.contextMenuPosition({ ...state.mapContextMenu, rect, menuWidth, menuHeight });
    els.dagMapContextMenu.style.left = `${position.left}px`;
    els.dagMapContextMenu.style.top = `${position.top}px`;
    if (searchInput) {
      searchInput.focus();
      const end = searchInput.value.length;
      searchInput.setSelectionRange(end, end);
    }
    return;
  }
  const shouldRefocusSearch = document.activeElement?.classList?.contains("map-context-menu-search");
  const query = clean(state.mapContextMenu.query).toLowerCase();
  const allTargets = contextMenuTargetGroups(variable.variable_id);
  const targets = query
    ? allTargets.filter((group) => {
        const haystack = [group.label, group.group_id, group.notes, group.type]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : allTargets;
  const rect = state.map.canvas.getBoundingClientRect();
  const duplicateDetails = duplicateDetailsHtml(variable);
  const displayVariable = clusterDisplayVariable(variable.variable_id) || variable;
  const common = [h("div", { className: "map-context-menu-title", textContent: displayVariable.display_label || displayVariable.concept_label || variable.variable_id }),
    duplicateDetails, flagContextAction("flag-low-quality", "Flag low quality variable", "Remove it from the viewer and save it as rejected.")];
  if (!targets.length) {
    replaceChildren(els.dagMapContextMenu, common,
      h("div", { className: "map-context-menu-subtitle", textContent: query ? "No matching groups." : "No eligible groups to add this variable to." }),
      allTargets.length ? contextMenuSearch() : null);
  } else {
    replaceChildren(els.dagMapContextMenu, common,
      h("div", { className: "map-context-menu-subtitle", textContent: "Add this variable to an existing group" }), contextMenuSearch(),
      h("div", { className: "map-context-menu-list" }, targets.map(group =>
        contextMenuItem(group.label || group.group_id, `${group.variable_ids?.length || 0} vars`, { groupId: group.group_id, variableId: variable.variable_id }))));
    els.dagMapContextMenu.querySelectorAll("button[data-group-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const group = groupById(btn.dataset.groupId);
        const variableId = btn.dataset.variableId;
        if (!group || !variableId) return;
        const before = takeSnapshot();
        addVariableToGroup(group, variableId);
        addToUndoHistory(`Added variable to "${group.label}"`, before);
        state.selectedVariableId = variableId;
        hideMapContextMenu();
        rebuildProject();
      });
    });
  }
  els.dagMapContextMenu.querySelector("[data-action='flag-low-quality']")?.addEventListener("click", () => {
    if (!window.confirm("Flag this variable as low quality and remove it from the viewer?")) return;
    const before = takeSnapshot();
    flagVariableLowQuality(variable.variable_id);
    addToUndoHistory("Flagged low quality variable", before);
    rebuildProject();
  });
  els.dagMapContextMenu.hidden = false;
  const searchInput = els.dagMapContextMenu.querySelector(".map-context-menu-search");
  searchInput?.addEventListener("input", () => {
    state.mapContextMenu.query = searchInput.value;
    renderMapContextMenu();
  });
  if (searchInput && (shouldRefocusSearch || !query)) {
    searchInput.focus();
    const end = searchInput.value.length;
    searchInput.setSelectionRange(end, end);
  }
  const menuWidth = Math.min(360, rect.width - 16);
  const menuHeight = Math.min(340, Math.max(120, els.dagMapContextMenu.offsetHeight || 220));
  const position = mapInteractions.contextMenuPosition({ ...state.mapContextMenu, rect, menuWidth, menuHeight });
  els.dagMapContextMenu.style.left = `${position.left}px`;
  els.dagMapContextMenu.style.top = `${position.top}px`;
}


  return {
    drawMap, drawMapPoints, ensureGlobalVoronoiCells, invalidateCaches, applyBrush, ensureBoundaryGeometry, pointInPolygon, brushHitsRepresentative,
    variableVisualStatus, variableColor, computePaletteAssignment, groupColor, hexToRgba,
    repAtPoint, clearHoverIntent, updateMapHover, nearestVariable, showMapTooltip,
    duplicateDetailsHtml, hideMapContextMenu, removeVariablesFromAllGroups,
    flagVariableSetLowQuality, flagVariableLowQuality, restoreRejectedVariable,
    contextMenuTargetGroups, showMapContextMenu, renderMapContextMenu,
  };
}
