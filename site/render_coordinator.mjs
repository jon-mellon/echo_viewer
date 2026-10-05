// Render synchronously so controls reflect each edit before its event returns.
// Project persistence is coalesced separately by the project controller.
export function createRenderCoordinator(view) {
  function rebuildProject({ reuseDagGeometry = false } = {}) {
    view.buildCandidateQueue();
    view.aggregateGroupLinks();
    view.computeVisibleLinks();
    view.renderGroupList();
    view.renderRejectedVariablesPanel();
    view.renderManualEdgeControls();
    view.renderDag({ reuseGeometry: reuseDagGeometry });
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
  function rebuildLinkDecision() {
    view.aggregateGroupLinks();
    view.computeVisibleLinks();
    view.renderDag({ reuseGeometry: true });
    view.renderSelectedEdge();
    view.renderExportStatus();
    view.renderUndoRedo();
    view.saveProjectLocally();
  }
  function renderAll({ rebuild = true, reuseDagGeometry = false } = {}) {
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
    if (rebuild) rebuildProject({ reuseDagGeometry });
  }
  function selectEdge() {
    view.refreshDagEdgeSelection();
    view.renderSelectedEdge();
  }
  return { renderAll, rebuildProject, rebuildLinkDecision, selectEdge };
}
