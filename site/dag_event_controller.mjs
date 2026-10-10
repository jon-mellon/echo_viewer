import * as projectOps from "./dag_project.mjs";
import * as mapInteractions from "./map_interactions.mjs";

export function createDagEventController({
  state, elements: els, dagNetwork,
  renderAssignmentCoverage, activeGroup, renderNeighborSuggestions, drawMap, renderAll,
  renderSearch, fitSearchContext, prefetchVariableSearch, toggleAnchorSearchMode, finishSchemaChoice,
  changeAnchor, renderSetupGroupPicker,
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
  addToUndoHistory, clusterRep, clearHoverIntent, addVariableToGroup, clean, startEditSplit,
  dismissEvidencePane, showExcludedLinks, showExcludedFindings, startDefinition,
}) {
function installHandlers() {
  els.closeEvidencePane.addEventListener("click", dismissEvidencePane);
  els.showExcludedLinks.addEventListener("click", showExcludedLinks);
  els.showExcludedFindings.addEventListener("click", showExcludedFindings);
  // Anchor search
  els.ivInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.dvInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.instrumentInput.addEventListener("focus", () => { void prefetchVariableSearch(); });
  els.ivInput.addEventListener("input", () => {
    renderSearch("iv");
    if (state.anchorSearchMode.iv === "new") fitSearchContext("iv");
  });
  els.dvInput.addEventListener("input", () => {
    renderSearch("dv");
    if (state.anchorSearchMode.dv === "new") fitSearchContext("dv");
  });
  els.instrumentInput.addEventListener("input", () => renderSetupGroupPicker("instrument"));
  els.ivDefineNew.addEventListener("click", () => toggleAnchorSearchMode("iv"));
  els.dvDefineNew.addEventListener("click", () => toggleAnchorSearchMode("dv"));

  // Schema choice
  els.loadSchema.addEventListener("click", () => finishSchemaChoice(true));
  els.skipSchema.addEventListener("click", () => finishSchemaChoice(false));

  // Change the selected groups.
  els.changeDv.addEventListener("click", () => changeAnchor("dv"));
  els.changeIv.addEventListener("click", () => changeAnchor("iv"));
  els.changeInstrument.addEventListener("click", () => changeAnchor("instrument"));
  els.instrumentDefineNew.addEventListener("click", () => startDefinition("instrument"));
  els.editSplitDv?.addEventListener("click", () => startEditSplit(state.project.dv_group_id));
  els.editSplitIv?.addEventListener("click", () => startEditSplit(state.project.iv_group_id));

  // Mode switcher
  els.modeSwitcher.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setWorkflowMode(tab.dataset.mode));
  });

  // Group list: sort
  els.groupListSort.addEventListener("change", () => {
    state.groupListSort = els.groupListSort.value;
    renderGroupList();
  });

  // Group editor (right panel)
  els.cancelGroupEdit.addEventListener("click", closeGroupEditor);
  els.discardGroupEdit?.addEventListener("click", discardGroupEditor);
  els.useGroupAsAnchor.addEventListener("click", selectActiveAnchor);
  els.addNeighbors.addEventListener("click", addTopNeighborsToActiveGroup);
  els.removeNeighbors.addEventListener("click", removeTopNeighborsFromActiveGroup);
  els.clearGroupSelection.addEventListener("click", clearActiveGroupVariables);
  els.groupSeedInput.addEventListener("input", renderGroupSeedSearch);
  els.rejectedVariableSearch?.addEventListener("input", renderRejectedVariablesPanel);
  els.zoomGroup.addEventListener("click", () => {
    const group = activeGroup();
    if (group) fitMap(group.variable_ids);
  });
  els.editSplit?.addEventListener("click", startEditSplit);
  els.groupLabelInput.addEventListener("input", () => {
    const group = activeGroup();
    if (group) applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, { label: els.groupLabelInput.value.trim() }));
    renderGroupList();
    renderDag();
    saveProjectLocally();
  });
  els.groupNotesInput.addEventListener("input", () => {
    const group = activeGroup();
    if (group) applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, { notes: els.groupNotesInput.value }));
    saveProjectLocally();
  });

  // Grouping schema
  els.groupingSetSelect.addEventListener("change", () => {
    state.project.active_grouping_set_id = els.groupingSetSelect.value;
    applyActiveGroupingSet();
    rebuildProject();
  });
  els.exportGroupingFolder.addEventListener("click", exportGroupingFolder);
  els.copyPermalink.addEventListener("click", copyPermalink);

  // Map toolbar
  els.variableLayoutSelect.addEventListener("change", async () => {
    const requestedSource = els.variableLayoutSelect.value;
    els.variableLayoutSelect.disabled = true;
    try {
      await loadDagData(requestedSource);
      state.selectedVariableId = null;
      state.hoveredVariableId = null;
      state.selectedVariableIds.clear();
      invalidateMapCaches();
      renderAll();
      fitMap();
    } catch (error) {
      console.error("Could not change variable map layout", error);
      els.variableLayoutSelect.value = state.variableLayoutSource;
    } finally {
      els.variableLayoutSelect.disabled = false;
    }
  });
  els.dagZoomIn.addEventListener("click", () => zoomMap(canvasWidth() / 2, canvasHeight() / 2, 1.12));
  els.dagZoomOut.addEventListener("click", () => zoomMap(canvasWidth() / 2, canvasHeight() / 2, 1 / 1.12));
  els.dagFitView.addEventListener("click", () => fitMap());
  els.fullscreenVariableMap.addEventListener("click", () => toggleFullscreenPanel("variable-map"));
  els.toggleVariableLabels.addEventListener("click", () => {
    state.showVariableLabels = !state.showVariableLabels;
    renderMapToolbarToggles();
    drawMap();
  });
  els.toggleGroupLabels.addEventListener("click", () => {
    state.showGroupLabels = !state.showGroupLabels;
    renderMapToolbarToggles();
    drawMap();
  });
  els.showUnfiltered.addEventListener("click", () => {
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    rebuildProject();
  });
  els.toggleConfoundersOnly.addEventListener("click", () => {
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showConfoundersOnly = true;
    state.showCollidersOnly = false;
    rebuildProject();
  });
  els.toggleCollidersOnly.addEventListener("click", () => {
    state.showExclusionViolations = false;
    state.showExogeneity = false;
    state.showCollidersOnly = true;
    state.showConfoundersOnly = false;
    rebuildProject();
  });
  els.toggleExclusionViolations.addEventListener("click", () => {
    state.showExclusionViolations = true;
    state.showExogeneity = false;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    rebuildProject();
  });
  els.toggleExogeneity.addEventListener("click", () => {
    state.showExogeneity = true;
    state.showExclusionViolations = false;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    rebuildProject();
  });
  els.confounderPathLength.addEventListener("input", () => {
    const requested = Math.trunc(Number(els.confounderPathLength.value));
    const minimum = state.showExclusionViolations ? 2 : 1;
    if (!Number.isFinite(requested) || requested < minimum) return;
    const field = state.showExclusionViolations ? "exclusionMaxPathLength" : "confounderMaxPathLength";
    state[field] = clampNumber(requested, minimum, 99);
    els.confounderPathLength.value = String(state[field]);
    if (!state.showCollidersOnly && !state.showExclusionViolations && !state.showExogeneity) state.showConfoundersOnly = true;
    rebuildProject();
  });
  els.confounderPathLength.addEventListener("change", () => {
    const field = state.showExclusionViolations ? "exclusionMaxPathLength" : "confounderMaxPathLength";
    if (Number(els.confounderPathLength.value) < (state.showExclusionViolations ? 2 : 1)) {
      els.confounderPathLength.value = String(state[field]);
    }
  });
  els.toggleBottleneckedConfounders.addEventListener("click", () => {
    state.excludeBottleneckedConfounders = !state.excludeBottleneckedConfounders;
    if (!state.showCollidersOnly && !state.showExogeneity) state.showConfoundersOnly = true;
    rebuildProject();
  });
  els.toggleIrrelevantConfounderLinks.addEventListener("click", () => {
    state.hideIrrelevantConfounderLinks = !state.hideIrrelevantConfounderLinks;
    if (!state.showCollidersOnly && !state.showExogeneity) state.showConfoundersOnly = true;
    rebuildProject();
  });
  els.dagSelectMode.addEventListener("click", () => setMapMode("select"));
  els.dagBrushMode.addEventListener("click", () => setMapMode("draw_add"));
  els.dagEraseMode.addEventListener("click", () => setMapMode("draw_remove"));

  // Undo / redo / history
  els.undoBtn.addEventListener("click", undo);
  els.redoBtn.addEventListener("click", redo);
  els.dag2UndoBtn?.addEventListener("click", undo);
  els.dag2RedoBtn?.addEventListener("click", redo);
  els.historyToggle.addEventListener("click", () => {
    state.showActionHistory = !state.showActionHistory;
    els.actionHistory.hidden = !state.showActionHistory;
    els.historyToggle.classList.toggle("active", state.showActionHistory);
    renderActionHistory();
  });

  // DAG SVG zoom controls
  els.dagSvgZoomIn.addEventListener("click", () => {
    dagNetwork.zoomIn();
  });
  els.dagSvgZoomOut.addEventListener("click", () => {
    dagNetwork.zoomOut();
  });
  els.dagSvgFit.addEventListener("click", () => {
    dagNetwork.fit();
  });
  els.fullscreenDag.addEventListener("click", () => toggleFullscreenPanel("dag"));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.fullscreenPanel) setFullscreenPanel(null);
  });

  // Create custom group
  els.createGroupBtn.addEventListener("click", createCustomGroup);

  // Export section toggle (collapsed by default)
  const exportToggleBtn = document.getElementById("exportToggleBtn");
  const exportSection = document.getElementById("exportSection");
  if (exportToggleBtn && exportSection) {
    exportToggleBtn.addEventListener("click", () => exportSection.classList.toggle("open"));
    exportToggleBtn.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") exportSection.classList.toggle("open"); });
  }

  // Export / import
  els.exportProject.addEventListener("click", exportProject);
  els.exportWorkingMap.addEventListener("click", exportWorkingMap);
  els.projectImport.addEventListener("change", importProject);
  els.exportBib.addEventListener("click", exportBib);
  els.exportMd.addEventListener("click", exportMd);
  els.exportTex.addEventListener("click", exportTex);

  window.addEventListener("resize", () => {
    resizeMap();
    if (state.project) renderDag();
  });
  installMapHandlers();
  installDagHandlers();
  initPanelResizers();
}


function installMapHandlers() {
  const canvas = state.map.canvas;
  const touchPoints = new Map();
  const pinchedPointers = new Set();
  let pinch = null;

  function pinchGeometry() {
    const [first, second] = [...touchPoints.values()];
    return {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    };
  }

  // Suppress browser context menu so right-click can be used for draw+
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => {
    if (els.dagMapContextMenu?.hidden) return;
    if (els.dagMapContextMenu.contains(event.target)) return;
    if (event.target === canvas && event.button === 2) return;
    hideMapContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (els.dagMapContextMenu?.hidden) return;
    hideMapContextMenu();
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") {
      touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (touchPoints.size >= 2) {
        for (const id of touchPoints.keys()) pinchedPointers.add(id);
        pinch = pinchGeometry();
        state.map.brush = null;
        state.map.dragging = false;
        state.map.dragStart = null;
        state.map.moved = true;
        canvas.classList.remove("dragging");
        return;
      }
    }
    const rect = canvas.getBoundingClientRect();
    const { x, y } = mapInteractions.eventPoint(event, rect);

    if (event.button !== 2) hideMapContextMenu();

    // Right-click opens a node/region menu in inspect mode; draw modes keep the old
    // add-by-brush behavior so fast editing is still possible.
    if (event.button === 2) {
      if (state.selectedVariableIds.size) {
        event.preventDefault();
        event.stopPropagation();
        showMapContextMenu(null, event.clientX, event.clientY, [...state.selectedVariableIds]);
        drawMap();
        return;
      }
      if (!isDrawMode() && state.map.mode === "select") {
        const rep = nearestVariable(event.clientX, event.clientY, 22) || repAtPoint(event.clientX, event.clientY);
        if (rep) {
          event.preventDefault();
          event.stopPropagation();
          state.selectedVariableId = rep.variable_id;
          showMapContextMenu(rep, event.clientX, event.clientY);
          drawMap();
          return;
        }
      }
      if (!activeGroup()) return;
      canvas.setPointerCapture(event.pointerId);
      state.map.dragging = true;
      state.map.moved = false;
      state.map.brush = { action: "add", points: [{ x, y }] };
      scheduleMapDraw(false);
      return;
    }

    state.map.dragging = true;
    state.map.moved = false;
    canvas.setPointerCapture(event.pointerId);
    if (isDrawMode()) {
      // Draw is allowed with an active group, or with "Draw +" during seed selection.
      const action = mapInteractions.brushAction({
        mode: state.map.mode,
        hasActiveGroup: Boolean(activeGroup()),
        seedSelectionPhase: isSeedSelectionPhase(),
      });
      state.map.brush = { action, points: [{ x, y }] };
      scheduleMapDraw(false);
      return;
    }
    state.map.dragStart = {
      x: event.clientX,
      y: event.clientY,
      tx: state.map.transform.tx,
      ty: state.map.transform.ty,
    };
    canvas.classList.add("dragging");
  });

  canvas.addEventListener("pointermove", (event) => {
    if (touchPoints.has(event.pointerId)) {
      touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && touchPoints.size >= 2) {
        const next = pinchGeometry();
        const rect = canvas.getBoundingClientRect();
        Object.assign(state.map.transform, constrainMapTransform({
          ...state.map.transform,
          tx: state.map.transform.tx + next.x - pinch.x,
          ty: state.map.transform.ty + next.y - pinch.y,
        }));
        if (pinch.distance > 0 && next.distance > 0) {
          zoomMap(next.x - rect.left, next.y - rect.top, next.distance / pinch.distance, true);
        }
        pinch = next;
        return;
      }
      if (pinchedPointers.has(event.pointerId)) return;
    }
    if (state.map.brush) {
      const rect = canvas.getBoundingClientRect();
      const point = mapInteractions.eventPoint(event, rect);
      state.map.brush.points = mapInteractions.appendBrushPoint(state.map.brush.points, point);
      scheduleMapDraw(false);
      return;
    }
    if (state.map.dragging && state.map.dragStart) {
      const dx = event.clientX - state.map.dragStart.x;
      const dy = event.clientY - state.map.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) state.map.moved = true;
      const nextTransform = mapInteractions.panTransform(state.map.dragStart, event.clientX, event.clientY);
      Object.assign(state.map.transform, constrainMapTransform(nextTransform));
      scheduleMapDraw(false);
      return;
    }
    updateMapHover(event);
  });

  canvas.addEventListener("pointerup", (event) => {
    if (touchPoints.has(event.pointerId)) {
      touchPoints.delete(event.pointerId);
      if (pinchedPointers.has(event.pointerId)) {
        pinchedPointers.delete(event.pointerId);
        pinch = touchPoints.size >= 2 ? pinchGeometry() : null;
        drawMap();
        return;
      }
    }
    if (state.map.brush) {
      if (state.map.brush.action === "select_vars") {
        applyBrush();
      } else {
        const before = takeSnapshot();
        applyBrush();
        addToUndoHistory(`Drew boundary on group`, before);
      }
      state.map.brush = null;
      state.map.dragging = false;
      state.map.dragStart = null;
      canvas.classList.remove("dragging");
      drawMap();
      return;
    }
    const moved = state.map.moved;
    if (!moved) {
      const point = nearestVariable(event.clientX, event.clientY, 16);
      if (point) {
        if (state.fullscreenPanel) setFullscreenPanel(null);
        const variableId = clusterRep(point.variable_id);
        const priorId = clusterRep(state.selectedVariableId || "");
        if (event.shiftKey && priorId && priorId !== variableId) {
          // Shift-click compares two variables without changing group membership.
          const selection = mapInteractions.selectionAfterClick({ variableId, priorId, shiftKey: event.shiftKey });
          state.comparisonVariableIds = selection.comparisonVariableIds;
          state.selectedVariableIds = new Set(selection.selectedVariableIds);
        } else {
          const selection = mapInteractions.selectionAfterClick({ variableId, priorId, shiftKey: false });
          state.selectedVariableId = variableId;
          state.selectedVariableIds = new Set(selection.selectedVariableIds);
          state.comparisonVariableIds = selection.comparisonVariableIds;
        }
        renderAll();
      }
    }
    state.map.dragging = false;
    state.map.dragStart = null;
    canvas.classList.remove("dragging");
    // Interactive frames suppress DOM labels. Restore them once panning ends.
    if (moved) drawMap();
  });

  canvas.addEventListener("pointercancel", (event) => {
    touchPoints.delete(event.pointerId);
    pinchedPointers.delete(event.pointerId);
    pinch = touchPoints.size >= 2 ? pinchGeometry() : null;
    state.map.brush = null;
    state.map.dragging = false;
    state.map.dragStart = null;
    canvas.classList.remove("dragging");
    drawMap();
  });

  canvas.addEventListener("pointerleave", () => {
    clearHoverIntent();
    state.hoveredVariableId = null;
    els.dagMapTooltip.hidden = true;
    drawMap();
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomMap(event.clientX - rect.left, event.clientY - rect.top, event.deltaY < 0 ? 1.06 : 1 / 1.06, true);
  }, { passive: false });

  canvas.addEventListener("dblclick", (event) => {
    // With a group open, double-clicking a Voronoi cell adds its node to that group.
    const group = activeGroup();
    if (group) {
      const rep = repAtPoint(event.clientX, event.clientY);
      if (rep) {
        const before = takeSnapshot();
        const had = new Set(group.variable_ids);
        addVariableToGroup(group, rep.variable_id);
        if (group.variable_ids.some((id) => !had.has(id))) {
          addToUndoHistory(`Added "${clean(rep.display_label || rep.concept_label)}" to ${group.label}`, before);
        }
        state.selectedVariableId = rep.variable_id;
        renderAll();
      }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    zoomMap(event.clientX - rect.left, event.clientY - rect.top, 1.2);
  });
}


  return { installHandlers, installMapHandlers };
}
