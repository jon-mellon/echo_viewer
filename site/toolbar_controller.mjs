import { createToolbarPresenter } from "./toolbar_presenter.mjs";

export function createToolbarController({ state, elements, dagGroups, groupById, visibleVariables,
  uoaMatches, clusterRep, rejectedVariableIdSet }) {
  const presenter = createToolbarPresenter({ state, elements, groupById, visibleVariables,
    uoaMatches, clusterRep, rejectedVariableIdSet });

  function render(options) {
    const visibleGroupIds = new Set(dagGroups().map(group => group.group_id));
    // Causes and consequences have one variable instead of a study design, so the
    // shared Filters controls are usable as soon as it is chosen.
    const exploring = state.task === "causes" || state.task === "consequences";
    const anchorsReady = exploring ? Boolean(state.explore?.[state.task]?.focusId)
      : visibleGroupIds.has(state.project?.iv_group_id) && visibleGroupIds.has(state.project?.dv_group_id);
    presenter.render(anchorsReady, options);
  }

  return { render, assignmentCoverage: presenter.assignmentCoverage,
    renderAssignmentCoverage: presenter.renderAssignmentCoverage };
}
