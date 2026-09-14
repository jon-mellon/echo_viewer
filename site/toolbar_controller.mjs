import { createToolbarPresenter } from "./toolbar_presenter.mjs";

export function createToolbarController({ state, elements, dagGroups, groupById, visibleVariables,
  uoaMatches, clusterRep, rejectedVariableIdSet }) {
  const presenter = createToolbarPresenter({ state, elements, groupById, visibleVariables,
    uoaMatches, clusterRep, rejectedVariableIdSet });

  function render() {
    const visibleGroupIds = new Set(dagGroups().map(group => group.group_id));
    const anchorsReady = visibleGroupIds.has(state.project?.iv_group_id)
      && visibleGroupIds.has(state.project?.dv_group_id);
    if (!anchorsReady) {
      state.showConfoundersOnly = false;
      state.showCollidersOnly = false;
    }
    presenter.render(anchorsReady);
  }

  return { render, assignmentCoverage: presenter.assignmentCoverage,
    renderAssignmentCoverage: presenter.renderAssignmentCoverage };
}
