import { h, replaceChildren } from "./dom_builder.mjs";

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
  loadPreviousSplits = () => {}, reusePreviousSplit = () => {} }) {
  let confirmingId = null;
  let deleting = false;
  let status = "";

  function open() {
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
    const all = customVariables();
    const query = normalized(els.customVariablesFilter.value);
    const previous = previousSplits().filter(item => !all.some(group => group.group_id === item.group_id)
      && (!query || normalized([item.name, item.description].join(" ")).includes(query)));
    const rows = all.filter(group => !query || normalized([group.label, group.description,
      ...sourceLabels(group)].join(" ")).includes(query));
    const highlight = state.customVariablesHighlight;
    if (highlight && all.some(group => group.group_id === highlight) && !status) {
      status = `Saved “${all.find(group => group.group_id === highlight).label}”.`;
    }
    els.customVariablesTitle.textContent = `Custom variables${all.length ? ` (${all.length})` : ""}`;
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
    replaceChildren(els.customVariablesTable, h("table", { className: "custom-variables-grid" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", textContent: "Name" }),
        h("th", { scope: "col", textContent: "Made from" }),
        h("th", { scope: "col", className: "num", textContent: "Concepts" }),
        h("th", { scope: "col", className: "actions" }, h("span", { className: "sr-only", textContent: "Actions" })))),
      h("tbody", {}, rows.map(group => row(group, { busy, highlight })))));
    if (previous.length) {
      els.customVariablesTable.append(h("section", { className: "custom-variables-previous" },
        h("h2", { textContent: "Your previous splits" }),
        h("p", { className: "small-note", textContent: "Reuse a previous split in the current schema." }),
        ...previous.map(item => h("div", { className: "setup-group-picker-row" },
          h("div", {}, h("strong", { textContent: item.name }),
            h("span", { textContent: item.is_local ? "Saved local draft" : "Published" })),
          h("button", { type: "button", className: "btn btn--sm", textContent: "⑂ Reuse",
            attrs: { "aria-label": `Reuse previous split ${item.name}` },
            onclick: () => reusePreviousSplit("candidate", item) })))));
    }
    els.customVariablesTable.querySelectorAll("button[data-action]").forEach(button =>
      button.addEventListener("click", () => act(button.dataset.action, button.dataset.groupId)));
  }

  function row(group, { busy, highlight }) {
    const label = group.label || group.group_id;
    const changeable = canChange(group);
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
      h("td", { textContent: sources.join(", ") || "—" }),
      h("td", { className: "num", textContent: String(group.variable_ids?.length || Number(group.member_count) || 0) }),
      h("td", { className: "actions" },
        canExplore() ? h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "explore", groupId: group.group_id },
          textContent: "Explore", title: `Show the causes or consequences of ${label}` }) : null,
        h("button", { className: "btn btn--ghost", type: "button", dataset: { action: "edit", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Edit ${label}` : lockedTitle, textContent: "Edit" }),
        h("button", { className: "btn btn--ghost custom-variables-delete", type: "button", dataset: { action: "delete", groupId: group.group_id },
          disabled: busy || !changeable, title: changeable ? `Delete ${label}` : lockedTitle, textContent: "Delete" })));
  }

  async function act(action, groupId) {
    status = "";
    state.customVariablesHighlight = null;
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
  }

  return { install, render, open, close };
}
