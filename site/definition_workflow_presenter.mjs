import { reviewTerms } from "./definition_batch_review.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createDefinitionWorkflowPresenter({ state, elements: els, normalized, clusterRep, truncate,
  definitionSources, definitionResidualIds, definitionCanReview, searchSourceGroups,
  clusterDisplayVariable, definitionNeighbors, resizeMap, fitMap,
  onSourceSelection, onClassify, onResidualLabel, canUndoBatch,
  browseState, onChoosePublishedSplit }) {
  let renderedStep = null;
  let reviewedDraft = null;
  let statusFilter = "unreviewed";
  let activeTerm = "";
  let termPage = 0;
  let currentTermIds = [];
  const PAGE_SIZE = 20;
  const INCLUDED_LIST_LIMIT = 300;
  const RELATED_LIMIT = 8;
  const fmt = value => Number(value || 0).toLocaleString();
  const STATUSES = [
    { key: "unreviewed", label: "Unreviewed" },
    { key: "included", label: "Included" },
    { key: "excluded", label: "Excluded" },
    { key: "all", label: "All" },
  ];

  const labelFor = id => {
    const variable = clusterDisplayVariable(id) || state.variableById.get(id);
    return variable?.display_label || variable?.concept_label || id;
  };

  /** The one source of truth for the counts: every eligible concept is in exactly one status. */
  function classification(draft) {
    const selected = new Set(draft.new_variable_ids || []);
    const reviewed = new Set(draft.reviewed_variable_ids || []);
    const status = id => selected.has(id) ? "included" : reviewed.has(id) ? "excluded" : "unreviewed";
    const counts = { included: 0, excluded: 0, unreviewed: 0, all: draft.eligible_variable_ids.length };
    for (const id of draft.eligible_variable_ids) counts[status(id)] += 1;
    return { selected, status, counts };
  }

  function sideButtons(id, label, current) {
    const button = (side, text, verb) => {
      const active = current === (side === "in" ? "included" : "excluded");
      return h("button", { type: "button", className: active ? "active" : "",
        dataset: { classify: active ? "clear" : side, variableId: id },
        title: active ? "Click again to mark it unreviewed" : "",
        attrs: { "aria-pressed": active ? "true" : "false", "aria-label": `${verb} “${label}”` }, textContent: text });
    };
    return h("div", { className: "definition-side-buttons", role: "group", attrs: { "aria-label": `Classify ${label}` } },
      button("in", "In", "Include"), button("out", "Out", "Exclude"));
  }

  function renderBrowse(draft, { status, counts }) {
    if (reviewedDraft !== draft) {
      reviewedDraft = draft;
      statusFilter = draft.mode === "edit" ? "all" : "unreviewed";
      activeTerm = "";
      termPage = 0;
    }
    const variables = draft.eligible_variable_ids.map(id => ({ id, label: labelFor(id) }));
    const terms = reviewTerms(variables, draft.new_variable_ids, 40);
    if (activeTerm && !terms.some(term => term.word === activeTerm)) activeTerm = "";
    replaceChildren(els.definitionStatusFilter, STATUSES.map(entry => h("button", {
      type: "button", className: "btn", dataset: { status: entry.key },
      attrs: { "aria-pressed": String(entry.key === statusFilter) },
      textContent: `${entry.label} ${fmt(counts[entry.key])}`,
    })));
    replaceChildren(els.definitionTermSelect,
      h("option", { value: "", textContent: terms.length ? "Common terms" : "No common terms" }),
      terms.map(term => h("option", { value: term.word, selected: term.word === activeTerm,
        textContent: `${term.word} (${fmt(term.ids.length)})` })));
    els.definitionTermSelect.disabled = !terms.length;
    els.definitionTermSelect.value = activeTerm;
    replaceChildren(els.definitionActiveFilters, activeTerm ? h("button", {
      type: "button", className: "definition-filter-chip", dataset: { clearTerm: "true" },
      attrs: { "aria-label": `Remove the common term filter “${activeTerm}”` },
    }, h("span", { textContent: `Common term: ${activeTerm}` }), h("b", { attrs: { "aria-hidden": "true" }, textContent: "×" })) : null);
    els.definitionActiveFilters.hidden = !activeTerm;

    const query = normalized(els.definitionConceptSearch.value);
    const termIds = activeTerm ? new Set(terms.find(term => term.word === activeTerm)?.ids || []) : null;
    const filtered = variables.filter(variable => (statusFilter === "all" || status(variable.id) === statusFilter)
      && (!termIds || termIds.has(variable.id))
      && (!query || normalized(variable.label).includes(query)))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    termPage = Math.max(0, Math.min(termPage, pageCount - 1));
    const start = termPage * PAGE_SIZE;
    const shown = filtered.slice(start, start + PAGE_SIZE);
    currentTermIds = shown.map(variable => variable.id);
    els.definitionTermSummary.textContent = filtered.length
      ? `Showing ${fmt(start + 1)}–${fmt(start + shown.length)} of ${fmt(filtered.length)}` : "";
    const emptyMessage = query || termIds ? "No matching concepts."
      : statusFilter === "unreviewed" ? "Every concept has been classified."
        : statusFilter === "included" ? "No concepts included yet."
          : statusFilter === "excluded" ? "No concepts excluded yet." : "No concepts.";
    replaceChildren(els.definitionTermItems, shown.length ? shown.map(({ id, label }) =>
      h("div", { className: `definition-sort-row is-${status(id)}`, role: "listitem", dataset: { termVariableId: id } },
        h("span", { className: "definition-sort-label", textContent: label }),
        sideButtons(id, label, status(id))))
      : h("div", { className: "definition-list-empty" },
        h("p", { textContent: emptyMessage }),
        query || termIds ? h("button", { type: "button", className: "btn btn--sm", dataset: { clearFilters: "true" }, textContent: "Clear search and filters" })
          : statusFilter !== "all" ? h("button", { type: "button", className: "btn btn--sm", dataset: { showAll: "true" }, textContent: "Show all concepts" }) : null));
    els.definitionTermPage.textContent = `Page ${termPage + 1} of ${pageCount}`;
    els.definitionTermPrev.disabled = termPage === 0;
    els.definitionTermNext.disabled = termPage >= pageCount - 1;
    els.definitionTermPrev.parentElement.hidden = pageCount <= 1;
    els.definitionTermToNew.textContent = `Include these ${shown.length}`;
    els.definitionTermToLeftover.textContent = `Exclude these ${shown.length}`;
    els.definitionTermToNew.hidden = els.definitionTermToLeftover.hidden = !shown.length;
    els.definitionTermToNew.disabled = shown.every(({ id }) => status(id) === "included");
    els.definitionTermToLeftover.disabled = shown.every(({ id }) => status(id) === "excluded");
    els.definitionUndoBatch.hidden = !canUndoBatch();
  }

  function renderIncluded(draft, { counts }) {
    els.definitionSelectedTitle.textContent = `Included concepts (${fmt(counts.included)})`;
    els.definitionIncludedFilter.hidden = counts.included <= 8;
    const query = normalized(els.definitionIncludedFilter.hidden ? "" : els.definitionIncludedFilter.value);
    const rows = draft.new_variable_ids.map(id => ({ id, label: labelFor(id) }))
      .filter(row => !query || normalized(row.label).includes(query))
      .sort((a, b) => a.label.localeCompare(b.label));
    replaceChildren(els.definitionSelectedVariables, !counts.included
      ? h("div", { className: "definition-list-empty" },
        h("p", { textContent: "No concepts included yet." }),
        h("p", { className: "small-note", textContent: "Choose In next to a concept to add it here." }))
      : !rows.length ? h("div", { className: "definition-list-empty" },
        h("p", { textContent: "No included concepts match." }),
        h("button", { type: "button", className: "btn btn--sm", dataset: { clearSearch: "definitionIncludedFilter" }, textContent: "Clear filter" }))
        : [...rows.slice(0, INCLUDED_LIST_LIMIT).map(({ id, label }) => h("div", { className: "definition-included-row", role: "listitem" },
          h("span", { textContent: label, title: label }),
          h("button", { type: "button", className: "definition-remove", dataset: { classify: "out", variableId: id },
            title: "Remove (marks it excluded)", attrs: { "aria-label": `Remove “${label}” from included` }, textContent: "×" }))),
        rows.length > INCLUDED_LIST_LIMIT ? h("p", { className: "small-note", textContent: `${fmt(rows.length - INCLUDED_LIST_LIMIT)} more. Filter to find one.` }) : null]);
    const neighbors = counts.included ? definitionNeighbors().slice(0, RELATED_LIMIT) : [];
    els.definitionRelated.hidden = !neighbors.length;
    els.definitionAddNeighbors.textContent = `Include all ${neighbors.length}`;
    replaceChildren(els.definitionNeighborResults, neighbors.map(neighbor => {
      const label = labelFor(neighbor.variable_id);
      return h("div", { className: "definition-related-row", role: "listitem" },
        h("span", { textContent: label, title: label }),
        h("button", { type: "button", className: "btn btn--sm", dataset: { classify: "in", variableId: neighbor.variable_id },
          attrs: { "aria-label": `Include “${label}”` }, textContent: "Include" }));
    }));
  }

  function renderSources(draft, { selected }) {
    const sources = definitionSources();
    els.definitionSourcesSummary.textContent = sources.length === 1 ? "What stays in the original variable"
      : `What stays in the ${fmt(sources.length)} original variables`;
    const focused = [...els.definitionResidualLabels.querySelectorAll("input[data-residual-id]")]
      .includes(/** @type {any} */ (document.activeElement));
    if (focused) return;
    // One row per original variable: how many of its concepts move, how many
    // stay, and the name what stays will have. Nothing left blocks Save.
    replaceChildren(els.definitionResidualLabels, h("table", { className: "definition-sources-grid" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", textContent: "Original variable" }),
        h("th", { scope: "col", className: "num", textContent: "Moving" }),
        h("th", { scope: "col", className: "num", textContent: "Staying" }),
        h("th", { scope: "col", textContent: "Name after the move" }))),
      h("tbody", {}, sources.map(source => {
        const label = source.label || source.group_id;
        const total = new Set(source.variable_ids.map(clusterRep));
        const included = [...total].filter(id => selected.has(id)).length;
        const stays = definitionResidualIds(source).length;
        return h("tr", { className: stays ? "" : "is-emptied" },
          h("th", { scope: "row" }, h("span", { textContent: label, title: label }),
            h("span", { className: "small-note definition-source-total", textContent: `${fmt(total.size)} concepts` })),
          h("td", { className: "num", textContent: fmt(included) }),
          h("td", { className: "num", textContent: fmt(stays),
            title: stays ? "" : "At least one concept must stay; exclude one to save." }),
          h("td", {}, h("input", { className: "search-input", dataset: { residualId: source.group_id },
            value: draft.residual_labels[source.group_id] || "", placeholder: `${label} (unchanged)`,
            attrs: { "aria-label": `Name for what stays in ${label}` } })));
      }))));
    els.definitionResidualLabels.querySelectorAll("input[data-residual-id]").forEach(input =>
      input.addEventListener("input", () => onResidualLabel(input.dataset.residualId, input.value)));
  }

  function saveHint(draft, counts) {
    if (draft.details_loading) return "Loading concepts…";
    if (!counts.included) return "Include at least one concept to save.";
    const emptied = definitionSources().find(source => !definitionResidualIds(source).length);
    return emptied ? `Leave at least one concept in “${emptied.label}” to save.` : "";
  }

  function renderPartition(draft) {
    const name = String(draft.new_label || "").trim() || "the new variable";
    els.definitionConceptsIntro.textContent = `Select which concepts belong in “${truncate(name, 60)}”.`;
    els.definitionConceptsIntro.title = name;
    const summary = classification(draft);
    const { counts } = summary;
    els.definitionCountIncluded.textContent = fmt(counts.included);
    els.definitionCountExcluded.textContent = fmt(counts.excluded);
    els.definitionCountUnreviewed.textContent = fmt(counts.unreviewed);
    renderSources(draft, summary);
    if (state.definitionMethod !== "jev") {
      renderBrowse(draft, summary);
      renderIncluded(draft, summary);
    }
    const hint = saveHint(draft, counts);
    els.definitionSave.disabled = Boolean(hint) || !definitionCanReview();
    els.definitionSaveHint.textContent = hint;
    els.definitionSave.textContent = draft.mode === "edit" ? "Save changes"
      : draft.role === "candidate" ? "Save variable" : `Save and use as ${draft.role.toUpperCase()}`;
    els.definitionBack.textContent = draft.mode === "edit" ? "Back to name" : "Back";
  }

  /** Empty a search box, show everything again, and put the cursor back in it. */
  function clearSearch(id) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    if (!input) return;
    input.value = "";
    termPage = 0;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function install() {
    els.definitionSourceList.addEventListener("click", event => {
      const target = /** @type {HTMLElement} */ (event.target).closest("button[data-clear-search]");
      if (target) clearSearch(target.dataset.clearSearch);
    });
    els.definitionConceptSearch.addEventListener("input", () => { termPage = 0; render(); });
    els.definitionIncludedFilter.addEventListener("input", render);
    els.definitionTermSelect.addEventListener("change", () => { activeTerm = els.definitionTermSelect.value; termPage = 0; render(); });
    els.definitionTermPrev.addEventListener("click", () => { termPage -= 1; render(); els.definitionTermItems.scrollIntoView({ block: "nearest" }); });
    els.definitionTermNext.addEventListener("click", () => { termPage += 1; render(); els.definitionTermItems.scrollIntoView({ block: "nearest" }); });
    // One delegated handler for every In / Out / Remove / Include button and filter control.
    els.definitionManualPanel.addEventListener("click", event => {
      const target = /** @type {HTMLElement} */ (event.target).closest("button");
      if (!target) return;
      if (target.dataset.clearSearch) { clearSearch(target.dataset.clearSearch); return; }
      if (target.dataset.status) { statusFilter = target.dataset.status; termPage = 0; render(); return; }
      if (target.dataset.clearTerm) { activeTerm = ""; termPage = 0; render(); return; }
      if (target.dataset.showAll) { statusFilter = "all"; termPage = 0; render(); return; }
      if (target.dataset.clearFilters) {
        activeTerm = ""; els.definitionConceptSearch.value = ""; termPage = 0; render();
        els.definitionConceptSearch.focus(); return;
      }
      if (target.dataset.classify && target.dataset.variableId) onClassify(target.dataset.variableId, target.dataset.classify);
    });
  }

  function render() {
    const draft = state.definitionDraft;
    const stepChanged = draft?.step !== renderedStep;
    renderedStep = draft?.step || null;
    const wasSpatial = document.body.classList.contains("defining-variable");
    const isSpatial = draft?.step === "partition";
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
    if (stepChanged) {
      // Each step starts at its top: in the side panel on a phone, in the
      // creation page that replaces the map on a wide screen.
      const scroller = window.matchMedia?.("(max-width: 840px)").matches
        ? document.querySelector(".dag-left-panel") : document.getElementById("definitionWorkspace");
      requestAnimationFrame(() => { scroller?.scrollTo(0, 0); });
      els.definitionSaveStatus.hidden = true;
    }
    const name = String(draft.new_label || "").trim();
    els.definitionTitle.textContent = draft.mode === "edit" ? `Edit “${truncate(name || "variable", 48)}”`
      : draft.role === "candidate" ? "Create a variable" : `Create a new ${draft.role.toUpperCase()}`;
    // Editing keeps the variables it came from, so its middle step is skipped.
    els.definitionBlock.classList.toggle("definition-editing", draft.mode === "edit");
    els.definitionDescribeStep.hidden = draft.step !== "describe";
    els.definitionSourcesStep.hidden = draft.step !== "sources";
    els.definitionPartitionStep.hidden = draft.step !== "partition";
    els.definitionLoadStatus.hidden = !draft.details_loading && !draft.details_error;
    els.definitionLoadStatus.textContent = draft.details_error
      ? `Some concept details could not load: ${draft.details_error}. You can still edit this variable.`
      : draft.details_loading ? "Loading concepts…" : "";
    const jevMode = state.definitionMethod === "jev";
    els.definitionJevPanel.hidden = !jevMode;
    els.definitionManualPanel.hidden = jevMode;
    els.definitionMethodJev.setAttribute("aria-pressed", String(jevMode));
    els.definitionMethodManual.setAttribute("aria-pressed", String(!jevMode));
    els.definitionMapPreviewStatus.hidden = !jevMode || !state.definitionAiPreviewIds;
    if (draft.step === "describe") {
      if (document.activeElement !== els.definitionNewLabel) els.definitionNewLabel.value = draft.new_label || "";
      if (document.activeElement !== els.definitionNewDescription) els.definitionNewDescription.value = draft.new_description || "";
      els.definitionDescribeNext.textContent = "Next";
    } else if (draft.step === "sources") {
      const query = normalized(els.definitionSourceSearch.value);
      const selected = new Set(draft.source_group_ids);
      const groups = searchSourceGroups((state.project.groups || []).filter(group => group.variable_ids?.length), query, 60);
      const searchNote = query && state.variableSearchStatus !== "ready"
        ? h("div", { className: "small-note", textContent: state.variableSearchStatus === "error"
          ? "Concept search could not be loaded; only variable names are searched."
          : "Loading concept search… variable names match for now." }) : null;
      // Chosen variables stay at the top so they remain visible while searching.
      const chosen = definitionSources().filter(group => !groups.some(row => row.group.group_id === group.group_id))
        .map(group => ({ group, variableMatch: "" }));
      const noMatch = query && !groups.length ? h("div", { className: "definition-list-empty" },
        h("p", { textContent: "No matching variables." }),
        h("button", { type: "button", className: "btn btn--sm", dataset: { clearSearch: "definitionSourceSearch" }, textContent: "Clear search" })) : null;
      replaceChildren(els.definitionSourceList, [...(searchNote ? [searchNote] : []), ...(noMatch ? [noMatch] : []), ...[...chosen, ...groups].map(({ group, variableMatch }) =>
        h("label", { className: `definition-source-row${selected.has(group.group_id) ? " is-selected" : ""}` }, h("span", { className: "definition-source-copy" },
          h("span", { className: "definition-source-main" }, h("strong", { textContent: group.label || group.group_id }),
            h("span", { textContent: `${new Set(group.variable_ids.map(clusterRep)).size} concepts` })),
          variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched: ${truncate(variableMatch, 72)}` }) : null),
        h("input", { type: "checkbox", dataset: { sourceId: group.group_id }, checked: selected.has(group.group_id) })))]);
      els.definitionSourceList.querySelectorAll("input[data-source-id]").forEach(input =>
        input.addEventListener("change", () => onSourceSelection(input.dataset.sourceId, input.checked)));
      const count = definitionSources().reduce((sum, group) =>
        sum + new Set(group.variable_ids.map(clusterRep)).size, 0);
      els.definitionContinue.disabled = !selected.size;
      els.definitionContinue.textContent = selected.size
        ? `Next: choose from ${count} concepts in ${selected.size} variable${selected.size === 1 ? "" : "s"}` : "Pick at least one variable";
      // Splits others published from the same variables: offered, never required.
      const showBrowse = Boolean(selected.size) && (browseState.loading || browseState.error || browseState.rows.length);
      els.definitionBrowsePanel.hidden = !showBrowse;
      if (showBrowse) {
        els.definitionBrowseStatus.textContent = browseState.error || (browseState.loading
          ? "Looking for variables others made from these…"
          : "Start from one of these to reuse its choice of concepts. Your name and definition are kept.");
        replaceChildren(els.definitionBrowseResults, browseState.rows.map((row, index) =>
          h("article", { className: "definition-browse-card" },
            h("strong", { textContent: row.name }), h("p", { textContent: row.description }),
            h("button", { type: "button", className: "btn", dataset: { splitIndex: String(index) },
              textContent: "Start from this", disabled: browseState.loading }))));
        els.definitionBrowseResults.querySelectorAll("button[data-split-index]").forEach(button =>
          button.addEventListener("click", () => onChoosePublishedSplit(browseState.rows[Number(button.dataset.splitIndex)])));
      }
    } else if (draft.step === "partition") {
      renderPartition(draft);
    }
  }

  function showDescribeError(message) {
    els.definitionValidation.textContent = message;
    els.definitionValidation.classList.add("is-error");
    const field = /name/i.test(message) && !/definition/i.test(message) ? els.definitionNewLabel
      : /called/.test(message) ? els.definitionNewLabel : els.definitionNewDescription;
    field.setAttribute("aria-invalid", "true");
    field.focus();
  }

  function showSaveError(error) {
    els.definitionSaveStatus.textContent = error?.message || String(error);
    els.definitionSaveStatus.hidden = false;
  }

  function clearDescriptionValidation() {
    els.definitionNewLabel.removeAttribute("aria-invalid");
    els.definitionNewDescription.removeAttribute("aria-invalid");
    els.definitionValidation.classList.remove("is-error");
    els.definitionValidation.textContent = "At least 20 characters.";
  }

  function setContinueLoading() {
    els.definitionContinue.disabled = true;
    els.definitionContinue.textContent = "Loading concepts…";
  }

  function showLoadError(error) {
    els.definitionContinue.title = `Could not load variables: ${error?.message || error}`;
  }

  /** Saved AI splits offered under the method choice; an empty list hides it. */
  function showSavedRuns(rows) {
    els.definitionResumeList.hidden = !rows.length;
    replaceChildren(els.definitionResumeList, rows.length ? [
      h("h3", { textContent: "Or pick up an unfinished AI sort" }),
      ...rows.map(row => {
        const resume = h("button", { className: "btn btn--sm", type: "button", textContent: "Resume", disabled: !row.usable });
        resume.addEventListener("click", row.onResume);
        const discard = h("button", { className: "btn btn--ghost", type: "button", textContent: "Discard" });
        discard.addEventListener("click", row.onDiscard);
        return h("div", { className: "definition-resume-row" },
          h("div", {},
            h("strong", { textContent: row.title }),
            h("span", { className: "small-note", textContent: row.detail }),
            row.note ? h("span", { className: "small-note", textContent: row.note }) : null),
          resume, discard);
      })] : []);
  }

  function setJevPreviewStatus(ids, mode) {
    els.definitionMapPreviewStatus.hidden = !ids || state.definitionMethod === "manual";
    els.definitionMapPreviewStatus.textContent = ids
      ? `AI ${mode === "test" ? "sample" : "full"} preview only · ${ids.length} suggested for new` : "";
  }

  return { render, install, showDescribeError, showSaveError, clearDescriptionValidation, setContinueLoading, showLoadError,
    setJevPreviewStatus, showSavedRuns, selectedTermIds: () => [...currentTermIds] };
}
