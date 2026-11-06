import { h, replaceChildren } from "./dom_builder.mjs";

export function diagnosticViewTitle(state, anchorsReady) {
  if (!anchorsReady) return "";
  if (state.showExclusionViolations) return "Exclusion restriction";
  if (state.showExogeneity) return "Exogeneity";
  if (state.showConfoundersOnly) return "Confounders";
  if (state.showCollidersOnly) return "Colliders";
  return "Confounders";
}

export function createToolbarPresenter({ state, elements, groupById }) {
  function render(anchorsReady) {
    if (elements.dagViewTitle) elements.dagViewTitle.textContent = diagnosticViewTitle(state, anchorsReady);
    if (elements.toggleSparseEdges) {
      elements.toggleSparseEdges.classList.toggle("active", state.excludeSparseEdges);
      elements.toggleSparseEdges.setAttribute("aria-pressed", state.excludeSparseEdges ? "true" : "false");
      // Off, no minimum applies, so the field reads 1 rather than the minimum the toggle would restore.
      elements.minimumEdgePapers.value = String(state.excludeSparseEdges ? state.minimumEdgePapers ?? 2 : 1);
    }
    if (elements.diagnosticOverlapKey) {
      const showKey = anchorsReady
        && (state.showConfoundersOnly || state.showCollidersOnly || state.showExclusionViolations || state.showExogeneity);
      elements.diagnosticOverlapKey.hidden = !showKey;
      elements.diagnosticOverlapKey.classList.toggle("collider-key", !state.showExclusionViolations && state.showConfoundersOnly);
      elements.diagnosticOverlapKey.classList.toggle("confounder-key", !state.showExclusionViolations && state.showCollidersOnly);
      const keyItem = (swatchClass, label) => h("span", { className: "diagnostic-key-item" },
        h("span", { className: `diagnostic-key-swatch ${swatchClass}`, attrs: { "aria-hidden": "true" } }), label);
      const anchorItems = [keyItem("diagnostic-key-iv", "Cause"),
        keyItem("diagnostic-key-dv", "Outcome")];
      replaceChildren(elements.diagnosticOverlapKey, state.showExogeneity
        ? [...anchorItems, keyItem("diagnostic-key-instrument", "Instrument"),
          keyItem("diagnostic-key-cause", "Potential common cause")]
        : state.showExclusionViolations
          ? [...anchorItems, keyItem("diagnostic-key-instrument", "Instrument"),
            keyItem("diagnostic-key-violation", "Exclusion violation"),
            keyItem("diagnostic-key-addressed", "Accounted for")]
          : [...anchorItems, keyItem("diagnostic-key-fill", state.showConfoundersOnly ? "Confounder" : "Collider"),
            ...(state.showConfoundersOnly ? [keyItem("diagnostic-key-addressed", "Accounted for")] : []),
            keyItem("diagnostic-key-outline", state.showConfoundersOnly ? "Also a collider" : "Also a confounder")]);
    }
    const confounderCount = state.confounderGroupIds?.size || 0;
    const instrumentReady = anchorsReady && Boolean(state.project?.instrument_group_id)
      && Boolean(groupById(state.project.instrument_group_id))
      && state.project.instrument_group_id !== state.project.iv_group_id
      && state.project.instrument_group_id !== state.project.dv_group_id;
    elements.toggleConfoundersOnly.hidden = instrumentReady;
    elements.toggleCollidersOnly.hidden = instrumentReady;
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
    elements.toggleExclusionViolations.textContent = `Exclusion (${state.exclusionViolationIds?.size || 0})`;
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
  }

  return { render };
}
