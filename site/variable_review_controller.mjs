import { h, replaceChildren } from "./dom_builder.mjs";
import { CLAIM_STATUSES, CONTROL_WARNING, diagnosticKey, DIAGNOSTIC_STATUSES } from "./confounder_status.mjs";
import { graphClaimPreview, confirmGraphClaim, bypassPath, bypassPaths, effectKey, claimConflicts } from "./study_graph.mjs";

/** One review editor shared by the list and table. Nothing is saved until confirmed. */
export function createVariableReviewController({ state, onCommit, onCancel = () => {} }) {
  const title = h("h2", { id: "variableReviewTitle" });
  const content = h("div", { className: "variable-review-content" });
  // The footer stays in view on a phone, so the outcome and Confirm are never below the fold.
  const statusLine = h("p", { className: "review-status", attrs: { role: "status" }, hidden: true });
  const conflicts = h("p", { className: "review-conflicts", attrs: { role: "status" }, hidden: true });
  const error = h("p", { className: "review-error", attrs: { role: "alert" }, hidden: true });
  const cancel = h("button", { type: "button", className: "btn", textContent: "Cancel" });
  const confirm = h("button", { type: "button", className: "btn btn--primary", textContent: "Confirm decision" });
  const dialog = h("dialog", { id: "variableReviewDialog", className: "publication-dialog variable-review-dialog",
    attrs: { "aria-labelledby": "variableReviewTitle" } }, title, content,
    h("div", { className: "variable-review-footer" }, statusLine, conflicts, error,
      h("div", { className: "publication-dialog-actions" }, cancel, confirm)));
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

  function claimContent(preview, existing) {
    const cause = label(preview.x), source = label(preview.source), target = label(preview.target);
    const selected = new Set([...preview.suggested, ...(existing.status === pending.status ? existing.rejected_effects || [] : [])].map(effectKey));
    // One checkbox state per link, however many paths share it.
    const inputs = new Map();
    const pathList = h("div", { className: "review-paths" });
    const rendered = new Set();
    const pathBlocks = [];
    const isChecked = key => Boolean(inputs.get(key)?.[0]?.checked);

    function addPath(path) {
      const key = path.join("\u0000");
      if (rendered.has(key)) return;
      rendered.add(key);
      const effects = path.slice(1).map((targetId, index) => ({ sourceId: path[index], targetId }));
      const badge = h("span", { className: "review-path-badge" });
      const edges = effects.map(effect => {
        const id = effectKey(effect);
        const input = h("input", { type: "checkbox", checked: inputs.has(id) ? isChecked(id) : selected.has(id),
          attrs: { "aria-label": effectLabel(effect) }, onchange: event => {
            for (const twin of inputs.get(id)) twin.checked = event.target.checked;
            update();
          } });
        if (!inputs.has(id)) inputs.set(id, []);
        inputs.get(id).push(input);
        pending.effects.set(id, effect);
        return h("label", { className: "review-edge-choice" }, input, h("span", { textContent: effectLabel(effect) }));
      });
      const block = h("div", { className: "review-path" },
        h("div", { className: "review-path-head" }, h("span", { className: "review-path-route", textContent: path.map(label).join(" → ") }), badge),
        ...edges);
      pathBlocks.push({ effects, badge, block });
      pathList.append(block);
    }

    const rejected = () => [...pending.effects.entries()].filter(([id]) => isChecked(id)).map(([, effect]) => effect);
    pending.rejected = rejected;
    function update() {
      const chosen = rejected(), chosenKeys = new Set(chosen.map(effectKey));
      const remaining = preview.effects.filter(effect => !chosenKeys.has(effectKey(effect)));
      // Paths beyond the first ones listed appear as earlier ones are cut, so every claim can be completed.
      let path = bypassPath(remaining, preview.source, preview.target, preview.x);
      if (path && !rendered.has(path.join("\u0000"))) addPath(path);
      for (const { effects, badge, block } of pathBlocks) {
        const cut = effects.some(effect => chosenKeys.has(effectKey(effect)));
        badge.textContent = cut ? "Cut" : "Still open";
        block.classList.toggle("is-cut", cut);
      }
      path = bypassPath(remaining, preview.source, preview.target, preview.x);
      statusLine.hidden = !path && !preview.candidates.length;
      statusLine.classList.toggle("is-blocking", Boolean(path));
      statusLine.textContent = path
        ? `Tick at least one link on each open path to confirm. Still open: ${path.map(label).join(" → ")}.`
        : `No path from ${source} to ${target} avoids ${cause} any more.`;
      confirm.disabled = Boolean(path);
      const found = claimConflicts(state.project, preview, chosen);
      conflicts.hidden = !found.length;
      conflicts.textContent = found.length ? `This contradicts an earlier claim about ${found.map(effectLabel).join(", ")}. Both decisions stay on record; you can confirm, or cancel and revise the earlier one.` : "";
    }

    const { paths, truncated } = bypassPaths(preview.effects, preview.source, preview.target, preview.x);
    for (const path of paths) addPath(path);
    content.append(
      h("p", { textContent: `Claim: ${source} affects ${target} only through ${cause}. This applies to this study only; the evidence and the variable schema are unchanged.` }),
      h("h3", { textContent: "Adds" }),
      h("p", { className: "review-asserted" }, h("strong", { textContent: `${source} → ${cause}` }),
        h("span", { textContent: preview.assertedExists ? " · already in the graph" : " · new, drawn as a dotted line" })),
      h("h3", { textContent: `Paths that avoid ${cause}` }),
      paths.length
        ? h("p", { className: "small-note", textContent: `Tick the links you believe do not exist. Each path needs at least one.${truncated ? " The shortest paths are listed; any others appear as these are cut." : ""} Cycles are allowed.` })
        : h("p", { className: "small-note", textContent: `No path from ${source} to ${target} avoids ${cause}, so nothing is removed.` }),
      pathList);
    update();
  }

  function edit(kind, groupId, status) {
    const spec = DIAGNOSTIC_STATUSES[kind];
    if (!spec || kind === "colliders" || !Object.hasOwn(spec.statuses, status)) return;
    const existing = state.project[spec.field]?.[diagnosticKey(state.project, kind, groupId)] || {};
    if (!CLAIM_STATUSES.has(status) && status !== "removed_other") {
      onCommit(kind, groupId, { status, ...(existing.text ? { text: existing.text } : {}) });
      return;
    }
    pending = { kind, groupId, status, scopeKey: diagnosticKey(state.project, kind, groupId), preview: null, note: null, effects: new Map() };
    title.textContent = `${spec.statuses[status]}: ${label(groupId)}`;
    error.hidden = true; conflicts.hidden = true; statusLine.hidden = true;
    confirm.disabled = false;
    replaceChildren(content);
    try {
      if (status === "removed_other") {
        const note = h("textarea", { id: "variableReviewNote", className: "search-input", rows: 4, value: existing.text || "", required: true,
          attrs: { "aria-label": "Reason for removing this variable" } });
        pending.note = note;
        content.append(h("p", { textContent: "This removes the whole variable and its links from this study's graph. The reusable variable schema is unchanged. Diagnostics will be recalculated." }),
          h("label", { className: "review-note-label", htmlFor: "variableReviewNote", textContent: "Reason (required; kept private)" }), note);
      } else {
        const preview = graphClaimPreview(state.project, kind, groupId, status);
        pending.preview = preview;
        claimContent(preview, existing);
      }
    } catch (problem) { showProblem(problem); confirm.disabled = true; }
    dialog.showModal();
    if (pending.note) pending.note.focus(); else cancel.focus();
  }

  confirm.addEventListener("click", () => {
    if (!pending) return;
    try {
      const { kind, groupId, status, note, preview, rejected, scopeKey } = pending;
      if (diagnosticKey(state.project, kind, groupId) !== scopeKey) throw new Error("The study changed. Reopen this decision.");
      if (note && !note.value.trim()) { note.setAttribute("aria-invalid", "true"); note.focus(); throw new Error("Explain why this variable is removed."); }
      const decision = preview ? confirmGraphClaim(state.project, preview, rejected()) : { status, text: note.value.trim() };
      dialog.close(); pending = null;
      onCommit(kind, groupId, decision);
    } catch (problem) { showProblem(problem); }
  });

  return { edit, cancel: close, warning: CONTROL_WARNING };
}
