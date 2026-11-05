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
export function createCustomVariablesPresenter({ state, elements: els, truncate, normalized,
  customVariables, sourceLabels, canChange, onCreate, onEdit, onDelete,
  canExplore = () => false, onExplore = () => {}, previousSplits = () => [],
  loadPreviousSplits = () => {}, reusePreviousSplit = () => {}, schemaVariables = customVariables,
  onSplitSource = () => {}, getSchema = () => ({}), loadDetails = async () => {}, conceptLabel = id => id }) {
  let confirmingId = null;
  let deleting = false;
  let status = "";
  let expandedId = null;
  let conceptLimit = 100;

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
    const showing = Boolean(state.customVariablesOpen && !state.definitionDraft);
    document.body.classList.toggle("custom-variables-open", showing);
    els.openCustomVariables?.setAttribute("aria-pressed", String(Boolean(state.customVariablesOpen)));
    els.customVariablesView.hidden = !showing;
    if (!showing) return;
    const all = schemaVariables();
    const query = normalized(els.customVariablesFilter.value);
    const previous = previousSplits().filter(item => !all.some(group => group.group_id === item.group_id)
      && (!query || normalized([item.name, item.description, ...(item.source_labels || [])].join(" ")).includes(query)));
    const rows = all.filter(group => !query || normalized([group.label, group.description,
      ...sourceLabels(group)].join(" ")).includes(query));
    const highlight = state.customVariablesHighlight;
    if (highlight && all.some(group => group.group_id === highlight) && !status) {
      status = `Added “${all.find(group => group.group_id === highlight).label}” to this schema.`;
    }
    els.customVariablesTitle.textContent = "Edit variable schema";
    els.customVariablesFilter.hidden = !all.length && !previous.length;
    els.customVariablesStatus.textContent = status;
    els.customVariablesStatus.hidden = !status;
    if (!all.length && !previous.length) {
      replaceChildren(els.customVariablesTable, h("div", { className: "custom-variables-empty" },
        h("p", { textContent: "You have not made any custom variables yet." }),
        h("p", { className: "small-note", textContent: "Make one when an existing variable mixes things you want to study separately — for example, to take school grades out of academic achievement." })));
      return;
    }
    if (!rows.length && !previous.length) {
      replaceChildren(els.customVariablesTable, h("div", { className: "custom-variables-empty" },
        h("p", { textContent: "No custom variables match this filter." }),
        h("button", { className: "btn btn--sm", type: "button", dataset: { action: "clear-filter" }, textContent: "Clear filter" })));
      els.customVariablesTable.querySelector("button[data-action=clear-filter]")?.addEventListener("click", () => {
        els.customVariablesFilter.value = "";
        render();
        els.customVariablesFilter.focus();
      });
      return;
    }
    const busy = state.publishedSchemaHydrating || state.publishedSchemaLoadFailed || deleting;
    replaceChildren(els.customVariablesTable, h("h2", { textContent: "In this schema" }), h("table", { className: "custom-variables-grid" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", textContent: "Name" }),
        h("th", { scope: "col", textContent: "Made from" }),
        h("th", { scope: "col", className: "num", textContent: "Concepts" }),
        h("th", { scope: "col", className: "actions" }, h("span", { className: "sr-only", textContent: "Actions" })))),
      h("tbody", {}, rows.flatMap(group => [row(group, { busy, highlight }), group.group_id === expandedId ? detailsRow(group) : null]))));
    if (previous.length) {
      els.customVariablesTable.append(h("section", { className: "custom-variables-previous" },
        h("h2", { textContent: "Saved elsewhere" }),
        h("p", { className: "small-note", textContent: "Add a saved variable to this schema by splitting its source groups." }),
        ...previous.map(item => h("div", { className: "setup-group-picker-row" },
          h("div", {}, h("strong", { textContent: item.name }),
            h("span", { textContent: `From: ${(item.source_labels || item.source_group_ids || []).join(", ")}` })),
          h("button", { type: "button", className: "btn btn--sm", textContent: "Add to schema",
            attrs: { "aria-label": `Add ${item.name} to schema` },
            onclick: () => reusePreviousSplit("candidate", item) })))));
    }
    els.customVariablesTable.querySelectorAll("button[data-action]").forEach(button =>
      button.addEventListener("click", () => act(button.dataset.action, button.dataset.groupId)));
  }

  function row(group, { busy, highlight }) {
    const label = group.label || group.group_id;
    const custom = group.source === "user_split";
    const changeable = custom && canChange(group);
    const lockedTitle = "Changed by a later edit; it can no longer be edited or deleted here.";
    const sources = sourceLabels(group);
    if (confirmingId === group.group_id) {
      return h("tr", { className: "custom-variables-confirm" }, h("td", { colSpan: 4 },
        h("div", { className: "custom-variables-confirm-body" },
          h("span", { textContent: `Delete “${label}”? Its ${group.variable_ids?.length || 0} concepts go back to ${sources.join(", ") || "where they came from"}. You can undo this.` }),
          h("button", { className: "btn btn--danger", type: "button", dataset: { action: "confirm-delete", groupId: group.group_id },
            disabled: busy, textContent: deleting ? "Deleting…" : "Delete" }),
          h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "cancel-delete", groupId: group.group_id },
            disabled: deleting, textContent: "Keep" }))));
    }
    return h("tr", { className: group.group_id === highlight ? "is-highlighted" : "" },
      h("td", {}, h("strong", { textContent: label }),
        group.description ? h("span", { className: "custom-variables-definition", title: group.description,
          textContent: truncate(group.description, 140) }) : null),
      h("td", { className: sources.length ? "" : "is-empty", textContent: sources.join(", ") }),
      h("td", { className: "num", textContent: String(group.variable_ids?.length || Number(group.member_count) || 0) }),
      h("td", { className: "actions" },
        h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "inspect", groupId: group.group_id },
          textContent: "Inspect", attrs: { "aria-expanded": String(expandedId === group.group_id) } }),
        canExplore() ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "explore", groupId: group.group_id },
          textContent: "Explore", title: `Show the causes or consequences of ${label}` }) : null,
        !custom ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "split", groupId: group.group_id }, disabled: busy,
          textContent: "Create split" }) : null,
        custom ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "edit", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Edit ${label}` : lockedTitle, textContent: "Edit" }) : null,
        custom ? h("button", { className: "btn btn--ghost custom-variables-delete", type: "button", dataset: { action: "delete", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Delete ${label}` : lockedTitle, textContent: "Delete" }) : null));
  }

  function detailsRow(group) {
    const ids = group.variable_ids || [];
    return h("tr", { className: "schema-variable-details" }, h("td", { colSpan: 4 },
      h("p", { textContent: group.description || "No definition recorded." }),
      h("p", { className: "small-note", textContent: `${ids.length} concepts` }),
      h("ul", {}, ids.slice(0, conceptLimit).map(id => h("li", { textContent: conceptLabel(id) }))),
      ids.length > conceptLimit ? h("button", { type: "button", className: "btn btn--sm", textContent: "Show more concepts",
        onclick: () => { conceptLimit += 100; render(); void loadDetails(ids.slice(0, conceptLimit)).then(render).catch(() => {}); } }) : null));
  }

  async function act(action, groupId) {
    status = "";
    state.customVariablesHighlight = null;
    if (action === "inspect") {
      expandedId = expandedId === groupId ? null : groupId;
      conceptLimit = 100;
      render();
      const group = schemaVariables().find(group => group.group_id === groupId);
      if (expandedId) try { await loadDetails((group?.variable_ids || []).slice(0, conceptLimit)); render(); }
      catch (error) { status = `Some concept labels could not load: ${error.message || error}`; render(); }
      return;
    }
    if (action === "split") { onSplitSource(groupId); return; }
    if (action === "delete") { confirmingId = groupId; render(); return; }
    if (action === "cancel-delete") { confirmingId = null; render(); return; }
    if (action === "edit") { confirmingId = null; onEdit(groupId); return; }
    if (action === "explore") { close(); onExplore(groupId); return; }
    if (action !== "confirm-delete" || deleting) return;
    const label = customVariables().find(group => group.group_id === groupId)?.label || groupId;
    deleting = true;
    render();
    try {
      await onDelete(groupId);
      status = `Deleted “${label}”. Undo brings it back.`;
    } catch (error) {
      status = `Could not delete “${label}”: ${error?.message || error}`;
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
