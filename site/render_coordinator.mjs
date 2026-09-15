// Synchronous scheduling preserves event-time rendering and autosave semantics.
// Deliberately no frame batching until redundant work has been measured.
export function createRenderCoordinator(view) {
  function rebuildProject() {
    view.buildCandidateQueue();
    view.aggregateGroupLinks();
    view.computeVisibleLinks();
    view.renderGroupList();
    view.renderRejectedVariablesPanel();
    view.renderManualEdgeControls();
    view.renderDag();
    if (!view.renderVariableComparison()) {
      view.renderSelectedEdge();
    }
    view.renderExportStatus();
    view.renderMapModeControls();
    view.renderMapToolbarToggles();
    view.renderUndoRedo();
    view.drawMap();
    view.saveProjectLocally();
  }
  function renderAll() {
    view.renderModeUI();
    view.renderAnchorBar();
    view.renderStatus();
    view.renderUoaStep();
    view.renderUoaFilterBar();
    view.renderSearch("iv");
    view.renderSearch("dv");
    view.renderSetupGroupPickers();
    view.renderSeedRows();
    view.renderGroupingSetControls();
    view.renderRejectedVariablesPanel();
    view.renderGroupEditor();
    view.renderDefinition?.();
    view.renderRightPanel();
    rebuildProject();
  }
  function selectEdge() {
    view.refreshDagEdgeSelection();
    view.renderSelectedEdge();
  }
  return { renderAll, rebuildProject, selectEdge };
}
