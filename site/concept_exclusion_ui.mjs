import { h } from "./dom_builder.mjs";

export const EXCLUSION_SCOPE_NOTE =
  "Exclude removes a concept from this variable in your schema, so the map and evidence update too. "
  + "It is saved with your schema, and you can restore it below or with Undo.";

/** Concepts excluded from a group and not since restored, newest first, read from the decision log. */
export function excludedConcepts(project, group) {
  const members = new Set(group.variable_ids || []);
  const seen = new Set();
  const out = [];
  for (const decision of [...(project?.decisions || [])].reverse()) {
    const payload = decision.payload || {};
    if (payload.group_id !== group.group_id || !payload.variable_id || seen.has(payload.variable_id)) continue;
    seen.add(payload.variable_id);
    if (decision.type === "concept_excluded" && !members.has(payload.variable_id)) {
      out.push({ id: payload.variable_id, label: payload.label || payload.variable_id });
    }
  }
  return out;
}

/** The labelled button beside each concept; `dataset` lets callers delegate clicks. */
export function excludeButton({ label, groupLabel, disabled, dataset = {} }) {
  return h("button", {
    className: "group-concept-exclude", type: "button", dataset,
    attrs: { "aria-label": `Exclude ${label} from ${groupLabel}` },
    title: `Remove ${label} from this variable`,
    disabled, textContent: "Exclude",
  });
}

/** Scope note shown above the concept list. */
export function exclusionNote() {
  return h("p", { className: "small-note group-concept-note", textContent: EXCLUSION_SCOPE_NOTE });
}

/** Collapsible recovery list: each excluded concept with a Restore button. */
export function restoreList({ items, groupLabel, disabled, onRestore, dataset = id => ({ restoreConceptId: id }) }) {
  if (!items.length) return null;
  const rows = items.map(({ id, label }) => {
    const button = h("button", {
      className: "group-concept-restore", type: "button", dataset: dataset(id),
      attrs: { "aria-label": `Restore ${label} to ${groupLabel}` },
      disabled, textContent: "Restore",
    });
    button.addEventListener("click", () => onRestore(id, label));
    return h("li", {}, h("span", { textContent: label }), button);
  });
  return h("details", { className: "group-concept-excluded" },
    h("summary", { textContent: `Excluded from this variable (${items.length})` }),
    h("ul", {}, rows));
}
