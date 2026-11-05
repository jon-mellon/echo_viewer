import { h, replaceChildren } from "./dom_builder.mjs";
import { CLAIM_STATUSES, CONTROL_WARNING, diagnosticKey, DIAGNOSTIC_STATUSES } from "./confounder_status.mjs";
import { graphClaimPreview, confirmGraphClaim, bypassPath, effectKey, claimConflicts } from "./study_graph.mjs";

/** One review editor shared by the list and table. Nothing is saved until confirmed. */
export function createVariableReviewController({ state, onCommit, onCancel = () => {} }) {
  const title = h("h2", { id: "variableReviewTitle" });
  const content = h("div", { className: "variable-review-content" });
  const error = h("p", { className: "review-error", attrs: { role: "alert" }, hidden: true });
  const cancel = h("button", { type: "button", className: "btn", textContent: "Cancel" });
  const confirm = h("button", { type: "button", className: "btn btn--primary", textContent: "Confirm decision" });
  const dialog = h("dialog", { id: "variableReviewDialog", className: "publication-dialog variable-review-dialog",
    attrs: { "aria-labelledby": "variableReviewTitle" } }, title, content, error,
    h("div", { className: "mini-toolbar" }, cancel, confirm));
  document.body.append(dialog);
  let pending = null;
  const label = id => state.project.groups.find(group => group.group_id === id)?.label || id;
  const effectLabel = effect => `${label(effect.sourceId)} → ${label(effect.targetId)}`;

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
    if (!CLAIM_STATUSES.has(status) && status !== "removed_other") {
      onCommit(kind, groupId, { status, ...(existing.text ? { text: existing.text } : {}) });
      return;
    }
    pending = { kind, groupId, status, scopeKey: diagnosticKey(state.project, kind, groupId), preview: null, note: null, inputs: [] };
    title.textContent = `${spec.statuses[status]}: ${label(groupId)}`;
    error.hidden = true;
    confirm.disabled = false;
    replaceChildren(content);
    try {
      if (status === "removed_other") {
        const note = h("textarea", { className: "search-input", rows: 4, value: existing.text || "", required: true,
          attrs: { "aria-label": "Reason for removing this variable" } });
        pending.note = note;
        content.append(h("p", { textContent: "This removes the whole variable and its incident links from this study's graph. The reusable variable schema is unchanged. Diagnostics will be recalculated." }),
          h("label", {}, "Reason (required; private)", note));
      } else {
        const preview = graphClaimPreview(state.project, kind, groupId, status);
        pending.preview = preview;
        const selected = new Set([...preview.suggested, ...(existing.status === status ? existing.rejected_effects || [] : [])].map(effectKey));
        const candidates = h("div", { className: "review-edge-choices" });
        const witness = h("p", { className: "small-note", attrs: { role: "status" } });
        const conflicts = h("p", { className: "review-conflicts", attrs: { role: "status" }, hidden: true });
        const update = () => {
          const rejected = pending.inputs.filter(item => item.input.checked).map(item => item.effect);
          const rejectedKeys = new Set(rejected.map(effectKey));
          const path = bypassPath(preview.effects.filter(effect => !rejectedKeys.has(effectKey(effect))), preview.source, preview.target, preview.x);
          witness.textContent = path ? `Still bypasses ${label(preview.x)}: ${path.map(label).join(" → ")}. Choose which direct effects to reject.`
            : `No remaining path bypasses ${label(preview.x)}.`;
          confirm.disabled = Boolean(path);
          const found = claimConflicts(state.project, preview, rejected);
          conflicts.hidden = !found.length;
          conflicts.textContent = found.length ? `Direct contradiction with earlier claims: ${found.map(effectLabel).join(", ")}. Both decisions will remain inspectable; asserted effects are shown as dotted where evidence is absent. You may confirm or cancel and revise the earlier decision.` : "";
        };
        for (const effect of preview.candidates) {
          const input = h("input", { type: "checkbox", checked: selected.has(effectKey(effect)), onchange: update });
          pending.inputs.push({ effect, input });
          candidates.append(h("label", { className: "review-edge-choice" }, input, effectLabel(effect)));
        }
        content.append(h("p", { textContent: `X is ${label(preview.x)}. Y is ${label(state.project.dv_group_id)}. This is a claim for the current study, not a change to the evidence or variable schema.` }),
          h("h3", { textContent: "Direct effect into X" }),
          h("p", { textContent: `${effectLabel(preview.asserted[0])}. An existing direct effect is retained; a newly asserted effect is drawn with a dotted line.` }),
          h("h3", { textContent: "Direct effects to reject" }),
          h("p", { className: "small-note", textContent: "Only direct bypass edges are preselected. For longer paths, choose the relationships you believe do not exist. Cycles are allowed." }),
          candidates, witness, conflicts);
        if (!preview.candidates.length) candidates.append(h("p", { textContent: "No bypassing effects need to be rejected." }));
        update();
      }
    } catch (problem) { showProblem(problem); confirm.disabled = true; }
    dialog.showModal();
    if (pending.note) pending.note.focus(); else cancel.focus();
  }

  confirm.addEventListener("click", () => {
    if (!pending) return;
    try {
      const { kind, groupId, status, note, preview, inputs, scopeKey } = pending;
      if (diagnosticKey(state.project, kind, groupId) !== scopeKey) throw new Error("The study changed. Reopen this decision.");
      if (note && !note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); throw new Error("Explain why this variable is removed."); }
      const decision = preview ? confirmGraphClaim(state.project, preview, inputs.filter(item => item.input.checked).map(item => item.effect))
        : { status, text: note.value.trim() };
      dialog.close(); pending = null;
      onCommit(kind, groupId, decision);
    } catch (problem) { showProblem(problem); }
  });

  return { edit, cancel: close, warning: CONTROL_WARNING };
}
