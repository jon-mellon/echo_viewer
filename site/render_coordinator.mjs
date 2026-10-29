// Render synchronously so controls reflect each edit before its event returns.
// Project persistence is coalesced separately by the project controller.
export function createRenderCoordinator(view) {
  function rebuildProject({ reuseDagGeometry = false, reuseLinks = false } = {}) {
    view.buildCandidateQueue();
    if (!reuseLinks) view.aggregateGroupLinks();
    view.computeVisibleLinks();
    view.renderVariablePanel?.();
    view.renderConfounderStatuses?.();
    view.renderGroupList();
    view.renderRejectedVariablesPanel();
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
    view.renderVariablePanel?.();
    view.renderConfounderStatuses?.();
    view.renderMapToolbarToggles();
    view.renderDag({ reuseGeometry: true, allowRemovedGroups: true });
    view.renderSelectedEdge();
    view.renderExportStatus();
    view.renderUndoRedo();
    view.saveProjectLocally();
  }
  function updateDagFilters() {
    view.computeVisibleLinks();
    view.renderVariablePanel?.();
    view.renderConfounderStatuses?.();
    view.renderGroupList();
    // Graph filters do not change variable assignments, membership or UOA.
    view.renderMapToolbarToggles({ includeCoverage: false });
    view.renderDag({ reuseGeometry: true });
    view.renderSelectedEdge();
    view.renderExportStatus();
  }
  function renderAll({ rebuild = true, reuseDagGeometry = false, refreshView = false, reuseLinks = false } = {}) {
    view.renderModeUI();
    view.renderAnchorBar();
    view.renderStatus();
    view.renderUoaStep();
    view.renderUoaFilterBar();
    view.renderSearch("iv", { renderPicker: false });
    view.renderSearch("dv", { renderPicker: false });
    view.renderSetupGroupPickers();
    view.renderSeedRows();
    view.renderGroupingSetControls();
    view.renderRejectedVariablesPanel();
    view.renderGroupEditor();
    view.renderDefinition?.();
    view.renderRightPanel();
    if (rebuild) rebuildProject({ reuseDagGeometry, reuseLinks });
    else if (refreshView) {
      view.renderVariablePanel?.();
      view.renderGroupList();
      view.renderDag({ reuseGeometry: true });
      if (!view.renderVariableComparison()) view.renderSelectedEdge();
      view.renderMapModeControls();
      view.renderMapToolbarToggles({ includeCoverage: false });
      view.drawMap();
    } else view.renderVariablePanel?.();
  }
  function selectEdge({ redraw = true } = {}) {
    view.refreshDagEdgeSelection({ redraw });
    view.renderSelectedEdge();
  }
  return { renderAll, rebuildProject, rebuildLinkDecision, updateDagFilters, selectEdge };
}
