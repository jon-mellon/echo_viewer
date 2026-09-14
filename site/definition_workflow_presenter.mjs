import * as searchModel from "./dag_search.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createDefinitionWorkflowPresenter({ state, elements: els, normalized, clusterRep, truncate,
  definitionSources, definitionResidualIds, definitionCanReview, searchVariables, visibleVariables,
  clusterDisplayVariable, definitionNeighbors, affectedDefinitionManualEdges, groupById, resizeMap, fitMap,
  onSourceSelection, onToggleVariable, onResidualLabel, onManualDisposition }) {
  function render() {
    const draft = state.definitionDraft;
    const wasSpatial = document.body.classList.contains("defining-variable");
    const isSpatial = Boolean(draft && draft.step !== "sources");
    document.body.classList.toggle("defining-variable", isSpatial);
    // The map is display:none in the normal DAG2 layout, so its initial canvas
    // backing store is 1x1. Resize only after the browser has laid out the
    // temporary spatial workspace, including when a saved draft is resumed.
    if (isSpatial && !wasSpatial) requestAnimationFrame(() => {
      resizeMap();
      fitMap(draft.eligible_variable_ids);
    });
    els.definitionBlock.hidden = !draft;
    if (!draft) return;
    els.definitionTitle.textContent = draft.mode === "edit" ? "Edit split"
      : `Define new ${draft.role.toUpperCase()}`;
    els.definitionSourcesStep.hidden = draft.step !== "sources";
    els.definitionPartitionStep.hidden = draft.step !== "partition";
    els.definitionReviewStep.hidden = draft.step !== "review";
    els.definitionBack.hidden = draft.mode === "edit";
    if (draft.step === "sources") {
      const query = normalized(els.definitionSourceSearch.value);
      const selected = new Set(draft.source_group_ids);
      const groups = (state.project.groups || []).map((group, index) =>
        searchModel.anchorGroupSearchMatch(group, query, index, state.variableById))
        .filter(item => item.group.variable_ids?.length && item.matches).slice(0, 60);
      replaceChildren(els.definitionSourceList, groups.map(({ group, variableMatch }) =>
        h("div", { className: "definition-source-row" }, h("label", {},
          h("span", { className: "definition-source-main" }, h("strong", { textContent: group.label || group.group_id }),
            h("span", { textContent: `${new Set(group.variable_ids.map(clusterRep)).size} canonical` })),
          variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched: ${truncate(variableMatch, 72)}` }) : null),
        h("input", { type: "checkbox", dataset: { sourceId: group.group_id }, checked: selected.has(group.group_id) }))));
      els.definitionSourceList.querySelectorAll("input[data-source-id]").forEach(input =>
        input.addEventListener("change", () => onSourceSelection(input.dataset.sourceId, input.checked)));
      const count = definitionSources().reduce((sum, group) =>
        sum + new Set(group.variable_ids.map(clusterRep)).size, 0);
      els.definitionContinue.disabled = !selected.size;
      els.definitionContinue.textContent = selected.size
        ? `Continue with ${selected.size} categories (${count} variables)` : "Choose categories to continue";
    } else if (draft.step === "partition") {
      const residualText = definitionSources().map(source =>
        `${source.label}: ${definitionResidualIds(source).length} leftover`).join(" · ");
      els.definitionCounts.textContent = `${draft.new_variable_ids.length} in new variable · ${residualText}`;
      els.definitionReview.disabled = !definitionCanReview();
      const selectedIds = new Set(draft.new_variable_ids);
      const matches = searchVariables(els.definitionVariableSearch.value, visibleVariables().length)
        .filter(variable => !selectedIds.has(clusterRep(variable.variable_id)))
        .slice(0, 30);
      replaceChildren(els.definitionVariableResults, matches.map(variable => {
        const id = clusterRep(variable.variable_id);
        return h("button", { className: "result-button", type: "button", dataset: { variableId: id } },
          h("strong", { textContent: variable.display_label || variable.concept_label || id }),
          h("span", { textContent: truncate(variable.raw_variable_text || variable.concept_label, 90) }),
          h("span", { textContent: "In leftover — click to add" }));
      }));
      els.definitionVariableResults.querySelectorAll("button[data-variable-id]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(button.dataset.variableId)));
      replaceChildren(els.definitionSelectedVariables, draft.new_variable_ids.length
        ? draft.new_variable_ids.map(id => {
          const variable = clusterDisplayVariable(id) || state.variableById.get(id);
          return h("button", { className: "definition-selected-variable", type: "button", dataset: { selectedVariableId: id }, title: "Remove from new group" },
            h("span", { textContent: variable?.display_label || variable?.concept_label || id }), h("b", { textContent: "×" }));
        })
        : h("div", { className: "small-note", textContent: "No variables picked yet. Click a point, search result, or draw around variables." }));
      els.definitionSelectedVariables.querySelectorAll("button[data-selected-variable-id]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(button.dataset.selectedVariableId, false)));
      const neighbors = definitionNeighbors();
      els.definitionAddNeighbors.disabled = !neighbors.length;
      replaceChildren(els.definitionNeighborResults, neighbors.map(neighbor => {
        const variable = clusterDisplayVariable(neighbor.variable_id) || state.variableById.get(neighbor.variable_id);
        return h("button", { className: "result-button", type: "button", dataset: { neighborId: neighbor.variable_id } },
          h("strong", { textContent: variable?.display_label || variable?.concept_label || neighbor.variable_id }),
          h("span", { textContent: `LLM rank ${neighbor.llm_rank || ""}; cosine ${Number(neighbor.cosine_similarity || 0).toFixed(3)}` }));
      }));
      els.definitionNeighborResults.querySelectorAll("button[data-neighbor-id]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(button.dataset.neighborId, true)));
    } else {
      els.definitionNewLabel.value = draft.new_label || "";
      replaceChildren(els.definitionReviewVariables, draft.new_variable_ids.map(id => {
        const variable = clusterDisplayVariable(id) || state.variableById.get(id);
        return h("div", { className: "definition-review-variable", textContent: variable?.display_label || variable?.concept_label || id });
      }));
      replaceChildren(els.definitionResidualLabels, definitionSources().map(source => {
        const inputId = `residual_${source.group_id}`;
        return h("div", { className: "definition-residual-row" },
          h("label", { className: "dag-label", htmlFor: inputId, textContent: `Leftover from ${source.label || source.group_id} (${definitionResidualIds(source).length})` }),
          h("input", { id: inputId, className: "search-input", dataset: { residualId: source.group_id }, value: draft.residual_labels[source.group_id] || "" }));
      }));
      els.definitionResidualLabels.querySelectorAll("input[data-residual-id]").forEach(input =>
        input.addEventListener("input", () => onResidualLabel(input.dataset.residualId, input.value)));
      const affected = draft.mode === "edit" ? [] : affectedDefinitionManualEdges();
      replaceChildren(els.definitionManualReview, affected.length ? [h("h3", { textContent: "Review affected manual records" }),
        affected.map(edge => h("div", { className: "definition-manual-row" },
          h("div", { textContent: `${groupById(edge.source_group_id)?.label || edge.source_group_id} → ${groupById(edge.target_group_id)?.label || edge.target_group_id}` }),
          h("select", { className: "select-input", dataset: { manualId: edge.edge_id } },
            h("option", { value: "keep", textContent: "Keep with leftover" }), h("option", { value: "move", textContent: "Move to new variable" }),
            h("option", { value: "remove", textContent: "Remove" }))))] : []);
      els.definitionManualReview.querySelectorAll("select[data-manual-id]").forEach(select => {
        select.value = draft.manual_edge_dispositions[select.dataset.manualId] || "keep";
        select.addEventListener("change", () => onManualDisposition(select.dataset.manualId, select.value));
      });
      els.definitionSave.textContent = draft.mode === "edit" ? "Update split"
        : `Save and use as ${draft.role.toUpperCase()}`;
    }
  }

  function showValidationError(error) {
    els.definitionValidation.textContent = error?.message || String(error);
  }

  return { render, showValidationError };
}
