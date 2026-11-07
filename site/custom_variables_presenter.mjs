import { h, replaceChildren } from "./dom_builder.mjs";
import { variableSchema, studyDecisionBundle } from "./schema_views.mjs";
import { publicSchemaProjection } from "./public_schema_projection.mjs";

/**
 * The Custom variables page: a filterable table of the variables the user made
 * by moving concepts out of existing ones, with Create, Edit and Delete. It
 * takes the graph's place while open (body.custom-variables-open). Creating or
 * editing hands over to the create-a-variable steps, and the page comes back
 * when they are saved or cancelled.
 */
export function createCustomVariablesPresenter({ state, elements: els, normalized,
  customVariables, sourceLabels, canChange, onCreate, onEdit, onDelete,
  previousSplits = () => [],
  loadPreviousSplits = () => {}, reusePreviousSplit = () => {}, splitsLoading = () => false, splitsError = () => false, schemaVariables = customVariables,
  onSplitSource = () => {}, getSchema = () => ({}), loadDetails = async () => {}, conceptLabel = id => id }) {
  let confirmingId = null;
  let deleting = false;
  let status = "";
  let expandedId = null;
  let conceptLimit = 100;
  let detailsLoading = false;
  let detailsRequest = 0;

  async function loadVisibleDetails(group) {
    const request = ++detailsRequest;
    detailsLoading = true;
    render();
    try {
      await loadDetails((group?.variable_ids || []).slice(0, conceptLimit));
    } catch (error) {
      if (request === detailsRequest) status = `Some concept labels could not load: ${error.message || error}`;
    } finally {
      if (request === detailsRequest) { detailsLoading = false; render(); }
    }
  }

  function open() {
    els.openCustomVariables?.closest("details")?.removeAttribute("open");
    state.customVariablesOpen = true;
    confirmingId = null;
    status = "";
    loadPreviousSplits(true);
    render();
    els.customVariablesFilter.focus();
  }

  function close() {
    state.customVariablesOpen = false;
    state.customVariablesHighlight = null;
    confirmingId = null;
    render();
    els.openCustomVariables?.focus();
  }

  function render() {
    const start = performance.now();
    try { renderView(); } finally {
      if (state.customVariablesOpen) performance.measure("echo:schema-page:render", { start, end: performance.now() });
    }
  }

  function renderView() {
    const showing = Boolean(state.customVariablesOpen && !state.definitionDraft);
    document.body.classList.toggle("custom-variables-open", showing);
    els.openCustomVariables?.setAttribute("aria-pressed", String(Boolean(state.customVariablesOpen)));
    els.customVariablesView.hidden = !showing;
    if (!showing) return;
    const all = schemaVariables();
    const query = normalized(els.customVariablesFilter.value);
    const previous = previousSplits().filter(item => !all.some(group => group.group_id === item.group_id)
      && (!query || normalized([item.name, item.description, ...(item.source_labels || [])].join(" ")).includes(query)));
    // Your own variables lead; the built-in ones follow. Each group stays alphabetical.
    const rows = all.filter(group => !query || normalized([group.label, group.description,
      ...sourceLabels(group)].join(" ")).includes(query))
      .sort((a, b) => Number(b.source === "user_split") - Number(a.source === "user_split"));
    const highlight = state.customVariablesHighlight;
    if (state.customVariablesNotice) { status = state.customVariablesNotice; state.customVariablesNotice = ""; }
    if (highlight && all.some(group => group.group_id === highlight) && !status) {
      status = `Added “${all.find(group => group.group_id === highlight).label}” to this schema.`;
    }
    els.customVariablesTitle.textContent = "Edit variable schema";
    els.customVariablesFilter.hidden = !all.length;
    els.customVariablesStatus.textContent = status;
    els.customVariablesStatus.hidden = !status;
    const busy = state.publishedSchemaHydrating || state.publishedSchemaLoadFailed || deleting;
    // Saved variables from elsewhere come first: they are what you add; the schema list below is what you have.
    const sections = [];
    // Always shown, so it is clear whether there is anything to reuse and whether the search has finished.
    const loadingSplits = splitsLoading();
    sections.push(h("section", { className: "custom-variables-previous" },
      h("h2", {}, "Saved in other schemas", previous.length ? h("span", { className: "picker-count", textContent: ` · ${previous.length}` }) : null),
      previous.length ? h("p", { className: "small-note", textContent: "Add one to this schema by splitting its source groups." }) : null,
      ...previous.map(item => h("div", { className: "setup-group-picker-row" },
        h("div", {}, h("strong", { textContent: item.name }),
          h("span", { textContent: `From: ${(item.source_labels || item.source_group_ids || []).join(", ")}` })),
        h("button", { type: "button", className: "btn btn--sm", textContent: "Add to schema",
          attrs: { "aria-label": `Add ${item.name} to schema` },
          onclick: () => reusePreviousSplit("candidate", item, { addDirectly: true }) }))),
      loadingSplits ? h("p", { className: "small-note concept-loading", role: "status" },
        h("span", { className: "inline-spinner", ariaHidden: "true" }), "Looking for saved variables…")
        : splitsError() ? h("div", { role: "status" },
          h("p", { className: "small-note custom-variables-none", textContent: "Some saved variables could not be loaded." }),
          h("button", { type: "button", className: "btn btn--sm", textContent: "Retry", onclick: () => { loadPreviousSplits(true); render(); } }))
        : previous.length ? null : h("p", { className: "small-note custom-variables-none", role: "status",
          textContent: query ? "No saved variable matches this filter."
            : "Nothing saved in other schemas yet. Variables you create elsewhere will appear here, ready to add." })));
    sections.push(h("h2", { textContent: "In this schema" }), rows.length
      ? h("table", { className: "custom-variables-grid" },
        h("thead", {}, h("tr", {},
          h("th", { scope: "col", textContent: "Name" }),
          h("th", { scope: "col", className: "num", textContent: "Concepts" }),
          h("th", { scope: "col", className: "actions" }, h("span", { className: "sr-only", textContent: "Actions" })))),
        h("tbody", {}, rows.flatMap(group => [row(group, { busy, highlight }), group.group_id === expandedId ? detailsRow(group) : null])))
      : h("div", { className: "custom-variables-empty" },
        h("p", { textContent: "No variable in this schema matches this filter." }),
        h("button", { className: "btn btn--sm", type: "button", dataset: { action: "clear-filter" }, textContent: "Clear filter" })));
    replaceChildren(els.customVariablesTable, ...sections);
    els.customVariablesTable.querySelector("button[data-action=clear-filter]")?.addEventListener("click", () => {
      els.customVariablesFilter.value = "";
      render();
      els.customVariablesFilter.focus();
    });
    els.customVariablesTable.querySelectorAll("button[data-action]:not([data-action=clear-filter])").forEach(button =>
      button.addEventListener("click", () => act(button.dataset.action, button.dataset.groupId)));
  }

  function row(group, { busy, highlight }) {
    const label = group.label || group.group_id;
    const custom = group.source === "user_split";
    const changeable = custom && canChange(group);
    const lockedTitle = "Changed by a later edit; it can no longer be edited or removed here.";
    const sources = sourceLabels(group);
    if (confirmingId === group.group_id) {
      return h("tr", { className: "custom-variables-confirm" }, h("td", { colSpan: 3 },
        h("div", { className: "custom-variables-confirm-body" },
          h("span", { textContent: `Remove “${label}” from this schema? Its ${group.variable_ids?.length || 0} concepts go back to ${sources.join(", ") || "where they came from"}. You can undo this.` }),
          h("button", { className: "btn btn--danger", type: "button", dataset: { action: "confirm-delete", groupId: group.group_id },
            disabled: busy, textContent: deleting ? "Removing…" : "Remove" }),
          h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "cancel-delete", groupId: group.group_id },
            disabled: deleting, textContent: "Keep" }))));
    }
    return h("tr", { className: group.group_id === highlight ? "is-highlighted" : "" },
      // Whether a variable is custom, and what it was split from, is what this page is for.
      h("td", {}, h("strong", { textContent: label }),
        custom ? h("span", { className: "custom-variables-tag", textContent: "Custom" }) : null,
        h("span", { className: "custom-variables-count", textContent: `${(group.variable_ids?.length || Number(group.member_count) || 0).toLocaleString("en-US")} concepts` }),
        custom && sources.length ? h("span", { className: "custom-variables-sources", textContent: `Split from ${sources.join(", ")}` }) : null),
      h("td", { className: "num", textContent: String(group.variable_ids?.length || Number(group.member_count) || 0) }),
      h("td", { className: "actions" },
        h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "inspect", groupId: group.group_id },
          textContent: "Inspect", attrs: { "aria-expanded": String(expandedId === group.group_id) } }),
        !custom ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "split", groupId: group.group_id }, disabled: busy,
          textContent: "Create split" }) : null,
        custom ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "edit", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Edit ${label}` : lockedTitle, textContent: "Edit" }) : null,
        custom ? h("button", { className: "btn btn--ghost custom-variables-delete", type: "button", dataset: { action: "delete", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Remove ${label} from schema` : lockedTitle, textContent: "Remove from schema" }) : null));
  }

  function detailsRow(group) {
    const ids = group.variable_ids || [];
    return h("tr", { className: "schema-variable-details" }, h("td", { colSpan: 3 },
      h("p", { textContent: group.description || "No definition recorded." }),
      h("p", { className: "small-note", textContent: `${ids.length} concepts` }),
      detailsLoading ? h("span", { className: "concept-loading", role: "status" },
        h("span", { className: "inline-spinner", ariaHidden: "true" }), "Loading concepts…")
        : h("ul", {}, ids.slice(0, conceptLimit).map(id => h("li", { textContent: conceptLabel(id) }))),
      !detailsLoading && ids.length > conceptLimit ? h("button", { type: "button", className: "btn btn--sm", textContent: "Show more concepts",
        onclick: () => { conceptLimit += 100; void loadVisibleDetails(group); } }) : null));
  }

  async function act(action, groupId) {
    status = "";
    state.customVariablesHighlight = null;
    if (action === "inspect") {
      expandedId = expandedId === groupId ? null : groupId;
      conceptLimit = 100;
      const group = schemaVariables().find(group => group.group_id === groupId);
      if (expandedId) void loadVisibleDetails(group);
      else { detailsRequest++; detailsLoading = false; render(); }
      return;
    }
    if (action === "split") { onSplitSource(groupId); return; }
    if (action === "delete") { confirmingId = groupId; render(); return; }
    if (action === "cancel-delete") { confirmingId = null; render(); return; }
    if (action === "edit") { confirmingId = null; onEdit(groupId); return; }
    if (action !== "confirm-delete" || deleting) return;
    const label = customVariables().find(group => group.group_id === groupId)?.label || groupId;
    deleting = true;
    render();
    try {
      await onDelete(groupId);
      status = `Removed “${label}” from this schema. Undo brings it back.`;
    } catch (error) {
      status = `Could not remove “${label}”: ${error?.message || error}`;
    } finally {
      deleting = false;
      confirmingId = null;
      render();
    }
  }

  function install() {
    els.openCustomVariables?.addEventListener("click", () => (state.customVariablesOpen ? close() : open()));
    els.customVariablesClose.addEventListener("click", close);
    els.customVariablesCreate.addEventListener("click", () => { status = ""; state.customVariablesHighlight = null; onCreate(); });
    els.customVariablesFilter.addEventListener("input", render);
    const exportJson = (payload, filename) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = h("a", { href: url, download: filename });
      link.click(); URL.revokeObjectURL(url);
    };
    document.getElementById("exportVariableSchema")?.addEventListener("click", () => exportJson(variableSchema(getSchema()), "variable-schema.json"));
    document.getElementById("exportStudyDecisions")?.addEventListener("click", () => exportJson(studyDecisionBundle(publicSchemaProjection(getSchema())), "study-decisions.json"));
  }

  return { install, render, open, close };
}
