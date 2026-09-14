import { h, replaceChildren } from "./dom_builder.mjs";

export function createToolbarPresenter({ state, elements, groupById, visibleVariables,
  uoaMatches, clusterRep, rejectedVariableIdSet }) {
  function assignmentCoverage() {
    const uoaActive = state.uoaFilterEnabled && state.selectedUoa;
    const variables = visibleVariables().filter(variable => !uoaActive || uoaMatches(variable.uoa, state.selectedUoa));
    const variableIds = new Set(variables.map(variable => variable.variable_id));
    const assignedIds = new Set((state.project?.groups || []).flatMap(group => group.variable_ids || [])
      .filter(variableId => variableIds.has(variableId)));
    return {
      assigned: assignedIds.size, unassigned: Math.max(0, variables.length - assignedIds.size),
      total: variables.length,
      plottedNodes: new Set(variables.map(variable => clusterRep(variable.variable_id))).size,
      rejected: rejectedVariableIdSet().size, uoaFiltered: Boolean(uoaActive),
    };
  }

  function renderAssignmentCoverage() {
    const coverage = assignmentCoverage();
    replaceChildren(elements.variableAssignmentCounts,
      h("span", { className: "coverage-count assigned", textContent: `${coverage.assigned.toLocaleString()} assigned` }),
      h("span", { className: "coverage-count unassigned", textContent: `${coverage.unassigned.toLocaleString()} unassigned` }));
    const scope = coverage.uoaFiltered ? ` for UOA “${state.selectedUoa}”` : "";
    const rejected = coverage.rejected ? `; ${coverage.rejected.toLocaleString()} rejected variables excluded` : "";
    elements.variableAssignmentCounts.title = `${coverage.total.toLocaleString()} variables${scope} represented by ${coverage.plottedNodes.toLocaleString()} plotted nodes${rejected}`;
  }

  function render(anchorsReady) {
    const layoutSources = state.data?.layout?.sources || [];
    replaceChildren(elements.variableLayoutSelect, layoutSources.map(source =>
      h("option", { value: source.source, textContent: source.label || source.source })));
    elements.variableLayoutSelect.value = state.variableLayoutSource;
    elements.variableLayoutSelect.hidden = layoutSources.length < 2;
    renderAssignmentCoverage();
    for (const [element, active] of [[elements.toggleVariableLabels, state.showVariableLabels],
      [elements.toggleGroupLabels, state.showGroupLabels], [elements.toggleCausalFilter, state.filterDagByCausalRelevance]]) {
      element.classList.toggle("active", active);
      element.setAttribute("aria-pressed", active ? "true" : "false");
    }
    const confounderCount = state.confounderGroupIds?.size || 0;
    elements.toggleConfoundersOnly.disabled = !anchorsReady;
    elements.toggleConfoundersOnly.classList.toggle("active", state.showConfoundersOnly);
    elements.toggleConfoundersOnly.setAttribute("aria-pressed", state.showConfoundersOnly ? "true" : "false");
    elements.toggleConfoundersOnly.textContent = `Confounders only (${confounderCount})`;
    elements.toggleConfoundersOnly.title = anchorsReady
      ? `Show the IV, DV, and ${confounderCount} potential common cause${confounderCount === 1 ? "" : "s"} within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"} of each anchor. Bidirectional edges are treated pessimistically as possibly running either way.`
      : "Select an IV and DV before filtering to confounders.";
    const colliderCount = state.colliderGroupIds?.size || 0;
    elements.toggleCollidersOnly.disabled = !anchorsReady;
    elements.toggleCollidersOnly.classList.toggle("active", state.showCollidersOnly);
    elements.toggleCollidersOnly.setAttribute("aria-pressed", state.showCollidersOnly ? "true" : "false");
    elements.toggleCollidersOnly.textContent = `Colliders only (${colliderCount})`;
    elements.toggleCollidersOnly.title = anchorsReady
      ? `Show the IV, DV, and ${colliderCount} potential common descendant${colliderCount === 1 ? "" : "s"} reachable from both anchors within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"}. Bidirectional edges are treated pessimistically as possibly running either way.`
      : "Select an IV and DV before filtering to colliders.";
    elements.confounderPathLength.disabled = !anchorsReady;
    elements.confounderPathLength.value = String(state.confounderMaxPathLength);
    elements.confounderPathLength.title = anchorsReady
      ? `Maximum directed-edge length of each qualifying ${state.showCollidersOnly ? "anchor-to-collider" : "confounder-to-anchor"} path. Intermediate path nodes are shown; a path cannot pass through the other anchor.`
      : "Select an IV and DV before setting a diagnostic path length.";
    const bottleneckedIds = state.showCollidersOnly ? state.bottleneckedColliderIds : state.bottleneckedConfounderIds;
    const bottleneckedCount = bottleneckedIds?.size || 0;
    const labels = [...(bottleneckedIds || [])].map(id => groupById(id)?.label || id).sort((a, b) => a.localeCompare(b));
    elements.toggleBottleneckedConfounders.hidden = false;
    elements.toggleBottleneckedConfounders.disabled = !anchorsReady;
    elements.toggleBottleneckedConfounders.classList.toggle("active", state.excludeBottleneckedConfounders);
    elements.toggleBottleneckedConfounders.setAttribute("aria-pressed", state.excludeBottleneckedConfounders ? "true" : "false");
    elements.toggleBottleneckedConfounders.textContent = `Exclude bottlenecked (${bottleneckedCount})`;
    elements.toggleBottleneckedConfounders.title = anchorsReady
      ? `${state.excludeBottleneckedConfounders ? "Currently excluding" : "Exclude"} ${bottleneckedCount} ${state.showCollidersOnly ? "collider" : "confounder"} candidate${bottleneckedCount === 1 ? "" : "s"} when every admissible witness-path pair shares an intermediate node within the current maximum path length.${labels.length ? ` Bottlenecked: ${labels.join(", ")}.` : ""}`
      : "Select an IV and DV before filtering bottlenecked diagnostic candidates.";
    const linkKeys = state.showCollidersOnly ? state.colliderLinkPairKeys : state.confounderLinkPairKeys;
    const linkCount = linkKeys?.size || 0;
    elements.toggleIrrelevantConfounderLinks.disabled = !anchorsReady;
    elements.toggleIrrelevantConfounderLinks.classList.toggle("active", state.hideIrrelevantConfounderLinks);
    elements.toggleIrrelevantConfounderLinks.setAttribute("aria-pressed", state.hideIrrelevantConfounderLinks ? "true" : "false");
    elements.toggleIrrelevantConfounderLinks.textContent = `Path links only (${linkCount})`;
    elements.toggleIrrelevantConfounderLinks.title = anchorsReady
      ? `Keep only the ${linkCount} logical link${linkCount === 1 ? "" : "s"} used by at least one currently displayed ${state.showCollidersOnly ? "collider's anchor-to-collider" : "confounder's candidate-to-anchor"} witness path.`
      : "Select an IV and DV before filtering diagnostic-path links.";
    const selectedCount = state.selectedVariableIds?.size || 0;
    if (elements.selectionCount) {
      elements.selectionCount.hidden = selectedCount === 0;
      elements.selectionCount.textContent = `${selectedCount} selected`;
    }
  }

  return { render, assignmentCoverage, renderAssignmentCoverage };
}
