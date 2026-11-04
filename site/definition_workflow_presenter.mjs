import { h, replaceChildren } from "./dom_builder.mjs";

export function createDefinitionWorkflowPresenter({ state, elements: els, normalized, clusterRep, truncate,
  definitionSources, definitionResidualIds, definitionCanReview, searchSourceGroups,
  clusterDisplayVariable,
  onSourceSelection, onResidualLabel, onCancel,
  browseState, onChoosePublishedSplit }) {
  let renderedStep = null;
  const INCLUDED_LIST_LIMIT = 300;
  const fmt = value => Number(value || 0).toLocaleString();

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
        h("p", { className: "small-note", textContent: "Use the AI suggestions above to include concepts." }))
      : !rows.length ? h("div", { className: "definition-list-empty" },
        h("p", { textContent: "No included concepts match." }),
        h("button", { type: "button", className: "btn btn--sm", dataset: { clearSearch: "definitionIncludedFilter" }, textContent: "Clear filter" }))
        : [...rows.slice(0, INCLUDED_LIST_LIMIT).map(({ id, label }) => h("div", { className: "definition-included-row", role: "listitem" },
          h("span", { textContent: label, title: label }))),
        rows.length > INCLUDED_LIST_LIMIT ? h("p", { className: "small-note", textContent: `${fmt(rows.length - INCLUDED_LIST_LIMIT)} more. Filter to find one.` }) : null]);
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
    if (!counts.included) return "Include at least one concept to save: use the AI suggestions or an existing split.";
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
    renderIncluded(draft, summary);
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
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function install() {
    // Each step's footer has its own Cancel, beside Next (or Save).
    for (const button of document.querySelectorAll(".definition-cancel")) button.addEventListener("click", onCancel);
    els.definitionBrowseJump.addEventListener("click", () => {
      els.definitionBrowsePanel.scrollIntoView({ behavior: "smooth", block: "start" });
      els.definitionBrowseResults.querySelector("button[data-split-index]")?.focus({ preventScroll: true });
    });
    els.definitionSourceList.addEventListener("click", event => {
      const target = /** @type {HTMLElement} */ (event.target).closest("button[data-clear-search]");
      if (target) clearSearch(target.dataset.clearSearch);
    });
    els.definitionIncludedFilter.addEventListener("input", render);
    els.definitionIncludedPanel.addEventListener("click", event => {
      const target = /** @type {HTMLElement} */ (event.target).closest("button");
      if (target?.dataset.clearSearch) clearSearch(target.dataset.clearSearch);
    });
  }

  function render() {
    const draft = state.definitionDraft;
    const stepChanged = draft?.step !== renderedStep;
    renderedStep = draft?.step || null;
    const isSpatial = draft?.step === "partition";
    document.body.classList.toggle("definition-active", Boolean(draft));
    document.body.classList.toggle("defining-variable", isSpatial);
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
    if (draft.step === "describe") {
      if (document.activeElement !== els.definitionNewLabel) els.definitionNewLabel.value = draft.new_label || "";
      if (document.activeElement !== els.definitionNewDescription) els.definitionNewDescription.value = draft.new_description || "";
      els.definitionDescribeNext.textContent = "Next";
      els.definitionDescribeBack.hidden = draft.mode === "edit";
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
        ? `Next: name it, using ${count} concepts in ${selected.size} variable${selected.size === 1 ? "" : "s"}` : "Pick at least one variable";
      // Splits others published from the same variables: offered, never required.
      const showBrowse = Boolean(selected.size);
      els.definitionBrowsePanel.hidden = !showBrowse;
      els.definitionBrowseJump.hidden = !showBrowse;
      els.definitionBrowseJump.disabled = browseState.loading || !browseState.rows.length;
      els.definitionBrowseJump.textContent = browseState.error ? "Previous splits unavailable"
        : browseState.loading ? "Checking previous splits…"
          : browseState.rows.length
            ? `View ${browseState.rows.length} previous split${browseState.rows.length === 1 ? "" : "s"}`
            : "No previous splits found";
      if (showBrowse) {
        els.definitionBrowseStatus.textContent = browseState.error || (browseState.loading
          ? "Looking for variables others made from these…"
          : browseState.rows.length
            ? "Use a published split to fill in the name, definition and concepts. You can edit them next."
            : "No previous published splits found for these source variables. You can still create a new split.");
        replaceChildren(els.definitionBrowseResults, browseState.rows.map((row, index) =>
          h("article", { className: "definition-browse-card" },
            h("strong", { textContent: row.name }),
            ...(row.is_own ? [h("span", { className: "small-note", textContent: "Your published split" })] : []),
            h("p", { textContent: row.description }),
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
    els.definitionSourceLoadStatus.hidden = true;
    els.definitionSourceLoadStatus.textContent = "";
  }

  function showLoadError(error) {
    els.definitionSourceLoadStatus.textContent = `Could not load source concepts: ${error?.message || error}. Try again.`;
    els.definitionSourceLoadStatus.hidden = false;
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

  return { render, install, showDescribeError, showSaveError, clearDescriptionValidation, setContinueLoading, showLoadError,
    showSavedRuns };
}
