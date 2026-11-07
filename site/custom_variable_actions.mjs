import { h } from "./dom_builder.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
// Lucide "pencil" and "trash-2".
const ICONS = {
  pencil: ["M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4"],
  plus: ["M5 12h14", "M12 5v14"],
  trash: ["M3 6h18", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", "M10 11v6", "M14 11v6"],
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({ class: "lucide", width: "16", height: "16", viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    svg.setAttribute(key, value);
  }
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Edit (pencil) and delete (trash) buttons for a custom variable's row in the
 * side panel. Delete asks once inline (Delete / Keep); it can be undone.
 */
export function customVariableActions({ group, canChange = () => true, onEdit = () => {}, onDelete = async () => {} }) {
  const label = group.label || group.group_id;
  const changeable = canChange(group);
  const locked = "Changed by a later edit; it can no longer be edited or deleted here.";
  const wrap = h("span", { className: "custom-row-actions" });
  const showIcons = () => {
    wrap.replaceChildren(
      h("button", { type: "button", className: "btn btn--icon btn--ghost custom-row-edit", disabled: !changeable,
        title: changeable ? `Edit ${label}` : locked, attrs: { "aria-label": `Edit ${label}` },
        onclick: () => onEdit(group.group_id) }, icon("pencil")),
      h("button", { type: "button", className: "btn btn--icon btn--ghost custom-row-delete", disabled: !changeable,
        title: changeable ? `Delete ${label}` : locked, attrs: { "aria-label": `Delete ${label}` },
        onclick: () => showConfirm() }, icon("trash")));
  };
  const showConfirm = () => {
    const keep = h("button", { type: "button", className: "btn btn--sm btn--ghost", textContent: "Keep",
      onclick: () => { showIcons(); wrap.querySelector(".custom-row-delete")?.focus(); } });
    const remove = h("button", { type: "button", className: "btn btn--sm btn--danger", textContent: "Delete",
      title: `Delete ${label}; its concepts go back to where they came from. You can undo this.`,
      onclick: async () => {
        remove.disabled = keep.disabled = true;
        remove.textContent = "Deleting…";
        try { await onDelete(group.group_id); } catch (error) {
          console.error("Could not delete custom variable", error);
          showIcons();
        }
      } });
    wrap.replaceChildren(remove, keep);
    remove.focus();
  };
  showIcons();
  return wrap;
}

/** The "Create" button in the side panel's Custom variables heading. */
export function createVariableButton(onCreate, { label = "Create", className = "btn btn--sm btn--ghost" } = {}) {
  return h("button", { type: "button", className: `${className} custom-create`,
    title: "Create a variable from concepts in existing variables", onclick: () => onCreate() },
  icon("plus"), h("span", { textContent: label }));
}
