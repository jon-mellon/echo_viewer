import { h, replaceChildren } from "./dom_builder.mjs";
import { CONTROL_WARNING, diagnosticKey, DIAGNOSTIC_STATUSES } from "./confounder_status.mjs";

/**
 * One review editor shared by the list and table. Every disposition saves at once and only changes how the
 * variable is drawn, except "Other reason", which asks for a private reason first. Nothing is saved until that is confirmed.
 */
export function createVariableReviewController({ state, onCommit, onCancel = () => {} }) {
  const title = h("h2", { id: "variableReviewTitle" });
  const content = h("div", { className: "variable-review-content" });
  const error = h("p", { className: "review-error", attrs: { role: "alert" }, hidden: true });
  const cancel = h("button", { type: "button", className: "btn", textContent: "Cancel" });
  const confirm = h("button", { type: "button", className: "btn btn--primary", textContent: "Confirm decision" });
  const dialog = h("dialog", { id: "variableReviewDialog", className: "publication-dialog variable-review-dialog",
    attrs: { "aria-labelledby": "variableReviewTitle" } }, title, content,
    h("div", { className: "variable-review-footer" }, error,
      h("div", { className: "publication-dialog-actions" }, cancel, confirm)));
  document.body.append(dialog);
  let pending = null;
  const label = id => state.project.groups.find(group => group.group_id === id)?.label || id;

  function close() { dialog.close(); pending = null; onCancel(); }
  cancel.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });

  function showProblem(problem) {
    error.textContent = problem?.message || String(problem);
    error.hidden = false;
  }

  function edit(kind, groupId, status) {
    const spec = DIAGNOSTIC_STATUSES[kind];
    if (!spec || kind === "colliders" || !Object.hasOwn(spec.statuses, status)) return;
    const existing = state.project[spec.field]?.[diagnosticKey(state.project, kind, groupId)] || {};
    if (status !== "removed_other") {
      onCommit(kind, groupId, { status, ...(existing.text ? { text: existing.text } : {}) });
      return;
    }
    const note = h("textarea", { id: "variableReviewNote", className: "search-input", rows: 4, value: existing.text || "", required: true,
      attrs: { "aria-label": "Reason for this decision" } });
    pending = { kind, groupId, status, scopeKey: diagnosticKey(state.project, kind, groupId), note };
    title.textContent = `${spec.statuses[status]}: ${label(groupId)}`;
    error.hidden = true;
    confirm.disabled = false;
    replaceChildren(content,
      h("p", { textContent: "This decision keeps the variable and its links on the map and shades it lighter." }),
      h("label", { className: "review-note-label", htmlFor: "variableReviewNote", textContent: "Reason (required; kept private)" }), note);
    dialog.showModal();
    note.focus();
  }

  confirm.addEventListener("click", () => {
    if (!pending) return;
    try {
      const { kind, groupId, status, note, scopeKey } = pending;
      if (diagnosticKey(state.project, kind, groupId) !== scopeKey) throw new Error("The study changed. Reopen this decision.");
      if (!note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); throw new Error("Explain the reason for this decision."); }
      dialog.close(); pending = null;
      onCommit(kind, groupId, { status, text: note.value.trim() });
    } catch (problem) { showProblem(problem); }
  });

  return { edit, cancel: close, warning: CONTROL_WARNING };
}
