import { h, replaceChildren } from "./dom_builder.mjs";
import { CONTROL_WARNING, diagnosticKey, DIAGNOSTIC_STATUSES } from "./confounder_status.mjs";

/**
 * One review editor shared by the list and table. Every disposition saves at once and only changes how the
 * variable is drawn, except "Other reason", which asks for a private reason first, and "Affects outcome only via cause"
 * on a confounder, which first lists the other variables the map already shows between it and the outcome and asks
 * the user to agree they do not apply. Nothing is saved until that is confirmed.
 * `mediatorsFor(groupId)` returns the group IDs m with confounder → m → outcome, leaving out the claimed cause.
 */
export function createVariableReviewController({ state, onCommit, onCancel = () => {}, mediatorsFor = () => [] }) {
  const title = h("h2", { id: "variableReviewTitle" });
  const content = h("div", { className: "variable-review-content" });
  const error = h("p", { className: "review-error", attrs: { role: "alert" }, hidden: true });
  const cancel = h("button", { type: "button", className: "btn", textContent: "Cancel" });
  const confirm = h("button", { type: "button", className: "btn btn--primary", textContent: "Confirm status" });
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
    const mediators = kind === "confounders" && status === "causes_y_only_via_x" ? mediatorsFor(groupId) : [];
    if (mediators.length) {
      const agree = h("input", { type: "checkbox", id: "variableReviewAgree" });
      const outcome = label(state.project.dv_group_id), cause = label(state.project.iv_group_id);
      pending = { kind, groupId, status, scopeKey: diagnosticKey(state.project, kind, groupId), agree };
      title.textContent = `${spec.statuses[status]}: ${label(groupId)}`;
      error.hidden = true;
      confirm.disabled = false;
      replaceChildren(content,
        h("p", { textContent: `This status says ${label(groupId)} affects ${outcome} only via ${cause}. The map already shows other routes from ${label(groupId)} to ${outcome}:` }),
        h("ul", { className: "only-via-mediators" }, mediators.map(id => h("li", { textContent: `${label(groupId)} → ${label(id)} → ${outcome}` }))),
        h("label", { className: "review-note-label", htmlFor: "variableReviewAgree" }, agree,
          ` I have checked these routes and they do not apply.`));
      dialog.showModal();
      agree.focus();
      return;
    }
    if (status !== "removed_other") {
      onCommit(kind, groupId, { status, ...(existing.text ? { text: existing.text } : {}) });
      return;
    }
    const note = h("textarea", { id: "variableReviewNote", className: "search-input", rows: 4, value: existing.text || "", required: true,
      attrs: { "aria-label": "Reason for this status" } });
    pending = { kind, groupId, status, scopeKey: diagnosticKey(state.project, kind, groupId), note };
    title.textContent = `${spec.statuses[status]}: ${label(groupId)}`;
    error.hidden = true;
    confirm.disabled = false;
    replaceChildren(content,
      h("p", { textContent: "This status keeps the variable and its links on the map and shades it lighter." }),
      h("label", { className: "review-note-label", htmlFor: "variableReviewNote", textContent: "Reason (required; kept private)" }), note);
    dialog.showModal();
    note.focus();
  }

  confirm.addEventListener("click", () => {
    if (!pending) return;
    try {
      const { kind, groupId, status, note, agree, scopeKey } = pending;
      if (diagnosticKey(state.project, kind, groupId) !== scopeKey) throw new Error("The project changed. Reopen this status.");
      if (agree) {
        if (!agree.checked) { agree.setAttribute("aria-invalid", "true"); agree.focus(); throw new Error("Tick the box to confirm these routes do not apply."); }
        const existing = state.project[DIAGNOSTIC_STATUSES[kind].field]?.[scopeKey] || {};
        dialog.close(); pending = null;
        onCommit(kind, groupId, { status, ...(existing.text ? { text: existing.text } : {}) });
        return;
      }
      if (!note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); throw new Error("Explain the reason for this status."); }
      dialog.close(); pending = null;
      onCommit(kind, groupId, { status, text: note.value.trim() });
    } catch (problem) { showProblem(problem); }
  });

  return { edit, cancel: close, warning: CONTROL_WARNING };
}
