import * as searchModel from "./dag_search.mjs";
import { reviewTerms } from "./definition_batch_review.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createDefinitionWorkflowPresenter({ state, elements: els, normalized, clusterRep, truncate,
  definitionSources, definitionResidualIds, definitionCanReview, searchVariables, searchSourceGroups, visibleVariables,
  clusterDisplayVariable, definitionNeighbors, resizeMap, fitMap,
  onSourceSelection, onToggleVariable, onResidualLabel, canUndoBatch,
  browseState, onChoosePublishedSplit }) {
  let renderedStep = null;
  let reviewedDraft = null;
  let activeTerm = null;
  let termPage = 0;
  let currentTermIds = [];
  const PAGE_SIZE = 20;
  const SELECTED_LIST_LIMIT = 40;

  function renderTermReview(draft, selectedIds) {
    if (reviewedDraft !== draft) {
      reviewedDraft = draft;
      activeTerm = draft.mode === "edit" ? "all" : "unreviewed";
      termPage = 0;
    }
    const variables = draft.eligible_variable_ids.map(id => {
      const variable = clusterDisplayVariable(id) || state.variableById.get(id);
      return { id, label: variable?.display_label || variable?.concept_label || id };
    });
    const terms = reviewTerms(variables, selectedIds);
    const reviewed = new Set(draft.reviewed_variable_ids || []);
    const unreviewedIds = variables.filter(variable => !reviewed.has(variable.id)).map(variable => variable.id);
    if (activeTerm === "unreviewed" && !unreviewedIds.length) activeTerm = "all";
    if (!['all', 'unreviewed'].includes(activeTerm) && !terms.some(term => term.word === activeTerm)) activeTerm = "all";
    const filters = [
      { key: "unreviewed", label: `Unreviewed · ${unreviewedIds.length}` },
      { key: "all", label: `All · ${variables.length}` },
      ...terms.map(term => ({ key: term.word, label: `${term.word} · ${term.ids.length}` })),
    ];
    replaceChildren(els.definitionTermChips, filters.map(filter => h("button", {
      type: "button", dataset: { term: filter.key }, className: filter.key === activeTerm ? "active" : "",
      attrs: { "aria-pressed": filter.key === activeTerm ? "true" : "false" },
      textContent: filter.label,
    })));
    els.definitionTermChips.querySelectorAll("button[data-term]").forEach(button =>
      button.addEventListener("click", () => { activeTerm = button.dataset.term; termPage = 0; render(); }));
    const term = terms.find(entry => entry.word === activeTerm);
    const filtered = variables.filter(variable => activeTerm === "all"
      || (activeTerm === "unreviewed" ? !reviewed.has(variable.id) : term?.ids.includes(variable.id)))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    termPage = Math.max(0, Math.min(termPage, pageCount - 1));
    const shown = filtered.slice(termPage * PAGE_SIZE, (termPage + 1) * PAGE_SIZE);
    const ids = shown.map(variable => variable.id);
    currentTermIds = ids;
    const inNew = ids.filter(id => selectedIds.has(id)).length;
    els.definitionTermSummary.textContent = activeTerm === "unreviewed"
      ? `${unreviewedIds.length} still to review · ${shown.length} shown`
      : `${filtered.length} ${activeTerm === "all" ? "variables" : `contain “${activeTerm}”`} · ${inNew} shown in new variable`;
    replaceChildren(els.definitionTermItems, shown.map(variable => {
      const { id, label } = variable;
      const selected = selectedIds.has(id);
      return h("div", { className: "definition-sort-row", dataset: { termVariableId: id } },
        h("span", { className: "definition-sort-label", textContent: label }),
        h("div", { className: "definition-side-buttons" },
          h("button", { type: "button", className: selected ? "active" : "", dataset: { side: "new" },
            attrs: { "aria-pressed": selected ? "true" : "false", "aria-label": `Put ${label} in new variable` }, textContent: "New" }),
          h("button", { type: "button", className: !selected && reviewed.has(id) ? "active" : "",
            dataset: { side: "leftover" }, attrs: { "aria-pressed": !selected && reviewed.has(id) ? "true" : "false",
              "aria-label": `Keep ${label} in leftover` }, textContent: "Leftover" })));
    }));
    els.definitionTermItems.querySelectorAll(".definition-sort-row").forEach(row =>
      row.querySelectorAll("button[data-side]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(row.dataset.termVariableId, button.dataset.side === "new"))));
    els.definitionTermPage.textContent = `${termPage + 1} of ${pageCount}`;
    els.definitionTermPrev.disabled = termPage === 0;
    els.definitionTermNext.disabled = termPage >= pageCount - 1;
    els.definitionTermToNew.textContent = `Move shown ${ids.length} to new`;
    els.definitionTermToLeftover.textContent = `Move shown ${ids.length} to leftover`;
    els.definitionTermToNew.disabled = !ids.length || ids.every(id => selectedIds.has(id) && reviewed.has(id));
    els.definitionTermToLeftover.disabled = !ids.length || ids.every(id => !selectedIds.has(id) && reviewed.has(id));
    els.definitionUndoBatch.hidden = !canUndoBatch();
  }

  function changeTermPage(direction) {
    termPage += direction;
    render();
  }
  function render() {
    const draft = state.definitionDraft;
    const stepChanged = draft?.step !== renderedStep;
    renderedStep = draft?.step || null;
    const wasSpatial = document.body.classList.contains("defining-variable");
    const isSpatial = Boolean(draft && draft.step !== "sources");
    document.body.classList.toggle("definition-active", Boolean(draft));
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
    if (stepChanged && window.matchMedia?.("(max-width: 840px)").matches) {
      requestAnimationFrame(() => { document.querySelector(".dag-left-panel")?.scrollTo(0, 0); });
    }
    els.definitionTitle.textContent = draft.mode === "edit" ? "Edit split"
      : draft.role === "candidate" ? "Define new variable" : `Define new ${draft.role.toUpperCase()}`;
    els.definitionMethodStep.hidden = draft.step !== "sources" || Boolean(state.definitionMethod);
    const aiSetup = state.definitionMethod === "jev" && !state.definitionAiReady;
    els.definitionAiSetupStep.hidden = draft.step !== "sources" || !aiSetup;
    els.definitionSourcesStep.hidden = draft.step !== "sources" || !state.definitionMethod || aiSetup;
    const setupHost = draft.step === "sources" ? els.definitionAiSetupHost : els.definitionJevPanel;
    if (els.definitionAiSetup.parentElement !== setupHost) setupHost.prepend(els.definitionAiSetup);
    els.definitionAiWork.hidden = aiSetup;
    els.definitionAiResults.hidden = aiSetup;
    els.definitionChosenMethod.textContent = state.definitionMethod === "manual" ? "Sort manually"
      : state.definitionMethod === "browse" ? "Browse user splits" : "Classify with AI";
    els.definitionPartitionStep.hidden = draft.step !== "partition";
    els.definitionLoadStatus.hidden = !draft.details_loading && !draft.details_error;
    els.definitionLoadStatus.textContent = draft.details_error
      ? `Some variable details could not load: ${draft.details_error}. You can still edit this split.`
      : draft.details_loading ? "Loading variable details…" : "";
    els.definitionReviewStep.hidden = draft.step !== "review";
    els.definitionBack.hidden = draft.mode === "edit";
    const jevMode = state.definitionMethod !== "manual";
    els.definitionJevPanel.hidden = !jevMode;
    els.definitionManualPanel.hidden = jevMode;
    els.definitionMethodJev.setAttribute("aria-pressed", String(jevMode));
    els.definitionMethodManual.setAttribute("aria-pressed", String(!jevMode));
    els.definitionMapPreviewStatus.hidden = !jevMode || !state.definitionAiPreviewIds;
    if (draft.step === "sources") {
      const query = normalized(els.definitionSourceSearch.value);
      const selected = new Set(draft.source_group_ids);
      const groups = searchSourceGroups((state.project.groups || []).filter(group => group.variable_ids?.length), query, 60);
      const searchNote = query && state.variableSearchStatus !== "ready"
        ? h("div", { className: "small-note", textContent: state.variableSearchStatus === "error"
          ? "Variable search could not be loaded; only category names are searched."
          : "Loading variable search… category names match for now." }) : null;
      replaceChildren(els.definitionSourceList, [...(searchNote ? [searchNote] : []), ...groups.map(({ group, variableMatch }) =>
        h("label", { className: "definition-source-row" }, h("span", { className: "definition-source-copy" },
          h("span", { className: "definition-source-main" }, h("strong", { textContent: group.label || group.group_id }),
            h("span", { textContent: `${new Set(group.variable_ids.map(clusterRep)).size} variables` })),
          variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched: ${truncate(variableMatch, 72)}` }) : null),
        h("input", { type: "checkbox", dataset: { sourceId: group.group_id }, checked: selected.has(group.group_id) })))]);
      els.definitionSourceList.querySelectorAll("input[data-source-id]").forEach(input =>
        input.addEventListener("change", () => onSourceSelection(input.dataset.sourceId, input.checked)));
      const count = definitionSources().reduce((sum, group) =>
        sum + new Set(group.variable_ids.map(clusterRep)).size, 0);
      els.definitionContinue.disabled = !selected.size;
      els.definitionContinue.textContent = selected.size
        ? `Continue with ${selected.size} categories (${count} variables)` : "Choose categories to continue";
      els.definitionBrowsePanel.hidden = state.definitionMethod !== "browse";
      els.definitionContinue.hidden = state.definitionMethod === "browse";
      if (state.definitionMethod === "browse") {
        els.definitionBrowseStatus.textContent = browseState.error || (browseState.loading
          ? "Finding published splits…" : !selected.size
            ? "Choose a source category to see published splits."
            : browseState.rows.length ? `${browseState.rows.length} published splits for these categories.`
              : "No approved splits found for these categories yet.");
        replaceChildren(els.definitionBrowseResults, browseState.rows.map((row, index) =>
          h("article", { className: "definition-browse-card" },
            h("strong", { textContent: row.name }), h("p", { textContent: row.description }),
            h("button", { type: "button", className: "toolbar-button", dataset: { splitIndex: String(index) },
              textContent: "Use this split", disabled: browseState.loading }))));
        els.definitionBrowseResults.querySelectorAll("button[data-split-index]").forEach(button =>
          button.addEventListener("click", () => onChoosePublishedSplit(browseState.rows[Number(button.dataset.splitIndex)])));
      }
    } else if (draft.step === "partition") {
      const residualText = definitionSources().map(source =>
        `${source.label}: ${definitionResidualIds(source).length} leftover`).join(" · ");
      els.definitionCounts.textContent = `${draft.new_variable_ids.length} in new variable · ${residualText}`;
      els.definitionReview.disabled = !definitionCanReview();
      els.definitionReview.textContent = draft.published_split ? "Use split" : "Name and review";
      const selectedIds = new Set(draft.new_variable_ids);
      renderTermReview(draft, selectedIds);
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
        ? [h("div", { className: "small-note", textContent: `${draft.new_variable_ids.length} variables in the new group${draft.new_variable_ids.length > SELECTED_LIST_LIMIT ? ` · showing the first ${SELECTED_LIST_LIMIT}` : ""}. Use the sorter above to inspect more.` }),
          ...draft.new_variable_ids.slice(0, SELECTED_LIST_LIMIT).map(id => {
          const variable = clusterDisplayVariable(id) || state.variableById.get(id);
          return h("button", { className: "definition-selected-variable", type: "button", dataset: { selectedVariableId: id }, title: "Remove from new group" },
            h("span", { textContent: variable?.display_label || variable?.concept_label || id }), h("b", { textContent: "×" }));
        })]
        : h("div", { className: "small-note", textContent: "No variables picked yet. Click a point, search result, or draw around variables." }));
      els.definitionSelectedVariables.querySelectorAll("button[data-selected-variable-id]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(button.dataset.selectedVariableId, false)));
      const neighbors = definitionNeighbors();
      els.definitionAddNeighbors.disabled = !neighbors.length;
      replaceChildren(els.definitionNeighborResults, neighbors.map(neighbor => {
        const variable = clusterDisplayVariable(neighbor.variable_id) || state.variableById.get(neighbor.variable_id);
        return h("button", { className: "result-button", type: "button", dataset: { neighborId: neighbor.variable_id } },
          h("strong", { textContent: variable?.display_label || variable?.concept_label || neighbor.variable_id }),
          h("span", { textContent: neighbor.map_distance ? "Nearby on map" :
            `LLM rank ${neighbor.llm_rank || ""}; cosine ${Number(neighbor.cosine_similarity || 0).toFixed(3)}` }));
      }));
      els.definitionNeighborResults.querySelectorAll("button[data-neighbor-id]").forEach(button =>
        button.addEventListener("click", () => onToggleVariable(button.dataset.neighborId, true)));
    } else {
      els.definitionNewLabel.value = draft.new_label || "";
      els.definitionNewDescription.value = draft.new_description || "";
      replaceChildren(els.definitionReviewVariables,
        h("div", { className: "small-note", textContent: `${draft.new_variable_ids.length} variables in the new group${draft.new_variable_ids.length > SELECTED_LIST_LIMIT ? ` · showing the first ${SELECTED_LIST_LIMIT}` : ""}. Go back to inspect or change them.` }),
        draft.new_variable_ids.slice(0, SELECTED_LIST_LIMIT).map(id => {
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
      els.definitionSave.textContent = draft.mode === "edit" ? "Update split"
        : draft.role === "candidate" ? "Save variable" : `Save and use as ${draft.role.toUpperCase()}`;
    }
  }

  function showValidationError(error) {
    els.definitionValidation.textContent = error?.message || String(error);
  }

  function clearDescriptionValidation() {
    els.definitionNewDescription.removeAttribute("aria-invalid");
    els.definitionValidation.textContent = "Enter at least 20 characters for the group definition.";
  }

  function setContinueLoading() {
    els.definitionContinue.disabled = true;
    els.definitionContinue.textContent = "Loading selected variables…";
  }

  function showLoadError(error) {
    els.definitionContinue.title = `Could not load variables: ${error?.message || error}`;
  }

  function setJevPreviewStatus(ids, mode) {
    els.definitionMapPreviewStatus.hidden = !ids || state.definitionMethod === "manual";
    els.definitionMapPreviewStatus.textContent = ids
      ? `AI ${mode === "test" ? "sample" : "full"} preview only · ${ids.length} suggested for new` : "";
  }

  return { render, showValidationError, clearDescriptionValidation, setContinueLoading, showLoadError,
    setJevPreviewStatus, selectedTermIds: () => [...currentTermIds], changeTermPage };
}
