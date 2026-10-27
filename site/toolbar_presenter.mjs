import { h, replaceChildren } from "./dom_builder.mjs";

export function createToolbarPresenter({ state, elements, groupById, visibleVariables,
  uoaMatches, clusterRep, rejectedVariableIdSet }) {
  function assignmentCoverage() {
    const uoaActive = state.uoaFilterEnabled && state.selectedUoa;
    const variables = visibleVariables().filter(variable => !uoaActive || uoaMatches(variable.uoa, state.selectedUoa));
    const variableIds = new Set(variables.map(variable => variable.variable_id));
    const assignedIds = new Set();
    // A compiled graph can be used before any variable coordinates are loaded.
    // In that case there is no coverage to count, so avoid scanning all 98k
    // group memberships on every graph-filter change.
    if (variableIds.size) for (const group of state.project?.groups || []) {
      for (const id of group.variable_ids || []) if (variableIds.has(id)) assignedIds.add(id);
    }
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

  function render(anchorsReady, { includeCoverage = true } = {}) {
    if (elements.toggleSparseEdges) {
      elements.toggleSparseEdges.classList.toggle("active", state.excludeSparseEdges);
      elements.toggleSparseEdges.setAttribute("aria-pressed", state.excludeSparseEdges ? "true" : "false");
      elements.minimumEdgePapers.value = String(state.minimumEdgePapers ?? 2);
    }
    const layoutSources = state.data?.layout?.sources || [];
    replaceChildren(elements.variableLayoutSelect, layoutSources.map(source =>
      h("option", { value: source.source, textContent: source.label || source.source })));
    elements.variableLayoutSelect.value = state.variableLayoutSource;
    elements.variableLayoutSelect.hidden = layoutSources.length < 2;
    if (includeCoverage) renderAssignmentCoverage();
    for (const [element, active] of [[elements.toggleVariableLabels, state.showVariableLabels],
      [elements.toggleGroupLabels, state.showGroupLabels],
      [elements.showUnfiltered, !state.showConfoundersOnly && !state.showCollidersOnly && !state.showExclusionViolations && !state.showExogeneity]]) {
      element.classList.toggle("active", active);
      element.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (elements.diagnosticOverlapKey) {
      const showKey = anchorsReady && !state.showExogeneity
        && (state.showConfoundersOnly || state.showCollidersOnly || state.showExclusionViolations);
      elements.diagnosticOverlapKey.hidden = !showKey;
      elements.diagnosticOverlapKey.classList.toggle("collider-key", !state.showExclusionViolations && state.showConfoundersOnly);
      elements.diagnosticOverlapKey.classList.toggle("confounder-key", !state.showExclusionViolations && state.showCollidersOnly);
      const keyItem = (swatchClass, label) => h("span", { className: "diagnostic-key-item" },
        h("span", { className: `diagnostic-key-swatch ${swatchClass}`, attrs: { "aria-hidden": "true" } }), label);
      replaceChildren(elements.diagnosticOverlapKey, state.showExclusionViolations
        ? [keyItem("diagnostic-key-instrument", "Instrument"),
          keyItem("diagnostic-key-violation", "Potential violation"),
          keyItem("diagnostic-key-path", "Path on hover")]
        : [keyItem("diagnostic-key-fill", state.showConfoundersOnly ? "Confounder" : "Collider"),
          keyItem("diagnostic-key-outline", state.showConfoundersOnly ? "Also a collider" : "Also a confounder")]);
    }
    const confounderCount = state.confounderGroupIds?.size || 0;
    const instrumentReady = anchorsReady && Boolean(state.project?.instrument_group_id)
      && Boolean(groupById(state.project.instrument_group_id))
      && state.project.instrument_group_id !== state.project.iv_group_id
      && state.project.instrument_group_id !== state.project.dv_group_id;
    elements.toggleConfoundersOnly.hidden = instrumentReady;
    elements.toggleCollidersOnly.hidden = instrumentReady;
    elements.showUnfiltered.hidden = instrumentReady;
    elements.toggleExclusionViolations.hidden = !instrumentReady;
    elements.toggleExclusionViolations.disabled = !instrumentReady;
    elements.toggleExogeneity.hidden = !instrumentReady;
    elements.toggleExogeneity.disabled = !instrumentReady;
    elements.toggleExogeneity.classList.toggle("active", state.showExogeneity);
    elements.toggleExogeneity.setAttribute("aria-pressed", state.showExogeneity ? "true" : "false");
    elements.toggleExogeneity.textContent = `Exogeneity (${state.exogeneityGroupIds?.size || 0})`;
    elements.toggleExogeneity.title = `Show groups with directed paths to both the instrument and outcome within ${state.confounderMaxPathLength} links of each. Bidirectional links may run either way.`;
    elements.toggleExclusionViolations.classList.toggle("active", state.showExclusionViolations);
    elements.toggleExclusionViolations.setAttribute("aria-pressed", state.showExclusionViolations ? "true" : "false");
    elements.toggleExclusionViolations.textContent = `Exclusion restriction violations (${state.exclusionViolationIds?.size || 0})`;
    elements.toggleExclusionViolations.title = `Show directed paths from the instrument to the Dep var through at least one other group, never through the Ind var, within ${state.exclusionMaxPathLength} links.`;
    elements.toggleConfoundersOnly.disabled = !anchorsReady;
    elements.toggleConfoundersOnly.classList.toggle("active", state.showConfoundersOnly);
    elements.toggleConfoundersOnly.setAttribute("aria-pressed", state.showConfoundersOnly ? "true" : "false");
    elements.toggleConfoundersOnly.textContent = `Confounders (${confounderCount})`;
    elements.toggleConfoundersOnly.title = anchorsReady
      ? `Show the Ind var, Dep var, and ${confounderCount} potential common cause${confounderCount === 1 ? "" : "s"} within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"} of each anchor. Bidirectional edges are treated pessimistically as possibly running either way.`
      : "Select an Ind var and Dep var before filtering to confounders.";
    const colliderCount = state.colliderGroupIds?.size || 0;
    elements.toggleCollidersOnly.disabled = !anchorsReady;
    elements.toggleCollidersOnly.classList.toggle("active", state.showCollidersOnly);
    elements.toggleCollidersOnly.setAttribute("aria-pressed", state.showCollidersOnly ? "true" : "false");
    elements.toggleCollidersOnly.textContent = `Colliders (${colliderCount})`;
    elements.toggleCollidersOnly.title = anchorsReady
      ? `Show the Ind var, Dep var, and ${colliderCount} potential common descendant${colliderCount === 1 ? "" : "s"} reachable from both anchors within ${state.confounderMaxPathLength} directed edge${state.confounderMaxPathLength === 1 ? "" : "s"}. Bidirectional edges are treated pessimistically as possibly running either way.`
      : "Select an Ind var and Dep var before filtering to colliders.";
    elements.confounderPathLength.disabled = !anchorsReady;
    elements.confounderPathLength.min = state.showExclusionViolations ? "2" : "1";
    elements.confounderPathLength.value = String(state.showExclusionViolations
      ? state.exclusionMaxPathLength : state.confounderMaxPathLength);
    elements.confounderPathLength.title = anchorsReady
      && state.showExclusionViolations ? "Maximum number of directed links from the instrument to the Dep var, through at least one other group and never through the Ind var." : anchorsReady
      ? `Maximum directed-edge length of each qualifying ${state.showCollidersOnly ? "anchor-to-collider" : state.showExogeneity ? "common-cause-to-instrument-or-Dep var" : "confounder-to-anchor"} path. Intermediate path nodes are shown; a path cannot pass through the other anchor.`
      : "Select an Ind var and Dep var before setting a diagnostic path length.";
    const bottleneckedIds = state.showExogeneity ? state.bottleneckedExogeneityIds
      : state.showCollidersOnly ? state.bottleneckedColliderIds : state.bottleneckedConfounderIds;
    const bottleneckedCount = bottleneckedIds?.size || 0;
    const labels = [...(bottleneckedIds || [])].map(id => groupById(id)?.label || id).sort((a, b) => a.localeCompare(b));
    elements.toggleBottleneckedConfounders.hidden = instrumentReady && !state.showExogeneity;
    elements.toggleBottleneckedConfounders.disabled = !anchorsReady;
    elements.toggleBottleneckedConfounders.classList.toggle("active", state.excludeBottleneckedConfounders);
    elements.toggleBottleneckedConfounders.setAttribute("aria-pressed", state.excludeBottleneckedConfounders ? "true" : "false");
    elements.toggleBottleneckedConfounders.textContent = `Exclude bottlenecked (${bottleneckedCount})`;
    elements.toggleBottleneckedConfounders.title = anchorsReady
      ? `${state.excludeBottleneckedConfounders ? "Currently excluding" : "Exclude"} ${bottleneckedCount} ${state.showCollidersOnly ? "collider" : state.showExogeneity ? "common-cause" : "confounder"} candidate${bottleneckedCount === 1 ? "" : "s"} when every admissible witness-path pair shares an intermediate node within the current maximum path length.${labels.length ? ` Bottlenecked: ${labels.join(", ")}.` : ""}`
      : "Select an Ind var and Dep var before filtering bottlenecked diagnostic candidates.";
    const linkKeys = state.showExogeneity ? state.exogeneityLinkPairKeys
      : state.showCollidersOnly ? state.colliderLinkPairKeys : state.confounderLinkPairKeys;
    const linkCount = linkKeys?.size || 0;
    elements.toggleIrrelevantConfounderLinks.disabled = !anchorsReady;
    elements.toggleIrrelevantConfounderLinks.hidden = instrumentReady && !state.showExogeneity;
    elements.toggleIrrelevantConfounderLinks.classList.toggle("active", state.hideIrrelevantConfounderLinks);
    elements.toggleIrrelevantConfounderLinks.setAttribute("aria-pressed", state.hideIrrelevantConfounderLinks ? "true" : "false");
    elements.toggleIrrelevantConfounderLinks.textContent = `Path links only (${linkCount})`;
    elements.toggleIrrelevantConfounderLinks.title = anchorsReady
      ? `Keep only the ${linkCount} logical link${linkCount === 1 ? "" : "s"} used by at least one currently displayed ${state.showCollidersOnly ? "collider's anchor-to-collider" : state.showExogeneity ? "common cause's paths to the instrument and Dep var" : "confounder's candidate-to-anchor"} witness path.`
      : "Select an Ind var and Dep var before filtering diagnostic-path links.";
    elements.toggleAllExclusionLinks.hidden = !state.showExclusionViolations || !instrumentReady;
    elements.toggleAllExclusionLinks.classList.toggle("active", state.showAllExclusionLinks);
    elements.toggleAllExclusionLinks.setAttribute("aria-pressed", state.showAllExclusionLinks ? "true" : "false");
    const selectedCount = state.selectedVariableIds?.size || 0;
    if (elements.selectionCount) {
      elements.selectionCount.hidden = selectedCount === 0;
      elements.selectionCount.textContent = `${selectedCount} selected`;
    }
  }

  return { render, assignmentCoverage, renderAssignmentCoverage };
}
