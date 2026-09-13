import * as inspector from "./dag_inspector.mjs";
import * as projectOps from "./dag_project.mjs";

export const STUDY_DESIGN_EDGE_ID = "__study_design_iv_to_dv__";

export function createDagInspectorController({
  state, elements, escapeHtml, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildProject, groupById, dagGroups,
}) {
  const selectedEdge = () => state.project?.links.find(link => link.edge_id === state.selectedEdgeId) || null;
  const isDoi = id => typeof id === "string" && /^10\.\d{4,}\/\S+/.test(id.trim());

  function handleEdgeAction(link, action, manualId, excludeReason) {
    if (action === "exclude" && excludeReason === undefined) {
      const row = document.getElementById("excludeReasonRow");
      if (row) {
        row.hidden = false;
        document.getElementById("excludeReasonInput")?.focus();
      }
      return;
    }
    const before = takeSnapshot();
    if (action === "delete-manual") {
      const manual = state.project.manual_edges.find(edge => edge.edge_id === manualId);
      if (manual) {
        applyProjectOperation(projectOps.deleteManualEdge(state.project, manualId));
        addDecision("manual_edge_deleted", { edge_id: manual.edge_id });
      }
      addToUndoHistory("Removed manual edge", before);
    } else if (action === "restore") {
      applyProjectOperation(projectOps.setLinkDecision(state.project, link.edge_id, null));
      addDecision("link_restored", { edge_id: link.edge_id });
      addToUndoHistory("Restored edge", before);
    } else if (action === "exclude") {
      applyProjectOperation(projectOps.setLinkDecision(state.project, link.edge_id, {
        edge_id: link.edge_id, display_status: "excluded",
        exclude_reason: excludeReason || "", timestamp: nowIso(),
      }));
      addDecision("link_excluded", { edge_id: link.edge_id, reason: excludeReason });
      addToUndoHistory("Excluded edge", before);
    } else {
      applyProjectOperation(projectOps.setLinkDecision(state.project, link.edge_id, {
        edge_id: link.edge_id, display_status: "hidden", timestamp: nowIso(),
      }));
      addDecision("link_hidden", { edge_id: link.edge_id });
      addToUndoHistory("Hid edge", before);
    }
    rebuildProject();
  }

  function renderStudyRelation() {
    const model = inspector.studyInspector(state.project, state.rawLinksById);
    if (!model) return;
    const { sourceLabel, targetLabel, rawIds, keys } = model;
    elements.edgeInspector.className = "edge-inspector";
    elements.edgeInspector.innerHTML = `
      <strong>${escapeHtml(sourceLabel)} → ${escapeHtml(targetLabel)}</strong>
      <div>Focal study relationship; not itself an evidence link.</div>
      <div>${rawIds.length ? `${rawIds.length} evidence record(s) attached across both directions.` : "No raw evidence records attached."}</div>
      ${keys.length ? `<div>Papers/tables:<br>${keys.map(escapeHtml).join("<br>")}</div>` : ""}
    `;
  }

  function renderEdge() {
    if (state.selectedEdgeId === STUDY_DESIGN_EDGE_ID) return renderStudyRelation();
    const link = selectedEdge();
    if (!link) {
      elements.edgeInspector.className = "edge-inspector empty";
      elements.edgeInspector.textContent = "Select an edge to inspect its provenance";
      return;
    }
    const model = inspector.edgeInspector(link, state.project);
    elements.edgeInspector.className = "edge-inspector";
    elements.edgeInspector.innerHTML = `
      <strong>${escapeHtml(model.sourceLabel)} ${escapeHtml(model.arrow)} ${escapeHtml(model.targetLabel)}</strong>
      <div>${escapeHtml(link.is_target_relation ? "Target relationship. " : "")}${escapeHtml(link.edge_source)}; ${model.rawCount ? `${model.rawCount} evidence record(s)` : "no provenance"}</div>
      ${model.manual.length ? `<div>${escapeHtml(model.manual.map(edge => edge.user_note || "Manual edge").join("; "))}</div>` : ""}
      ${model.existingDecision?.display_status === "excluded" && model.existingDecision.exclude_reason
        ? `<div class="small-note" style="color:#9b5c2e"><strong>Excluded:</strong> ${escapeHtml(model.existingDecision.exclude_reason)}</div>` : ""}
      <div class="edge-actions">${model.actions.map(item => `<button class="action-button" type="button" data-edge-action="${item.action}"${item.manualId ? ` data-manual-id="${escapeHtml(item.manualId)}"` : ""}>${item.label}</button>`).join("")}</div>
      <div id="excludeReasonRow" class="exclude-reason-row" hidden>
        <textarea id="excludeReasonInput" class="dag-textarea exclude-reason-input" rows="2" placeholder="Required: why is this link excluded? (methodological assumption, covariate balance, etc.)"></textarea>
        <div class="exclude-reason-actions"><button class="primary-button" type="button" id="excludeConfirmBtn">Confirm exclusion</button><button class="text-button" type="button" id="excludeCancelBtn">Cancel</button></div>
      </div>`;
    elements.edgeInspector.querySelectorAll("button[data-edge-action]").forEach(button => {
      button.addEventListener("click", () => handleEdgeAction(link, button.dataset.edgeAction, button.dataset.manualId));
    });
    const row = elements.edgeInspector.querySelector("#excludeReasonRow");
    const input = elements.edgeInspector.querySelector("#excludeReasonInput");
    elements.edgeInspector.querySelector("#excludeConfirmBtn")?.addEventListener("click", () => {
      const reason = input.value.trim();
      if (!reason) { input.focus(); input.classList.add("input-error"); return; }
      input.classList.remove("input-error"); row.hidden = true;
      handleEdgeAction(link, "exclude", null, reason);
    });
    elements.edgeInspector.querySelector("#excludeCancelBtn")?.addEventListener("click", () => {
      row.hidden = true; input.value = "";
    });
  }

  function renderProvenance() {
    const link = selectedEdge();
    if (!link) { elements.provenancePanel.hidden = true; return; }
    elements.provenancePanel.hidden = false;
    const model = inspector.provenanceModel(link, state.project, state.rawLinksById, state.variableById);
    const manualHtml = model.manual.length
      ? `<div class="small-note"><strong>Manual annotation</strong><br>${escapeHtml(model.manual.map(edge => edge.user_note || "Manual edge added by user.").join("; "))}</div>` : "";
    if (!model.rawIds.length) {
      elements.provenancePanel.innerHTML = `${manualHtml}<div class="small-note">No raw provenance for this edge.</div>`;
      return;
    }
    const rows = model.rows.map(({ raw, source, target }) => {
      const doi = isDoi(raw.paper_id) ? raw.paper_id.trim() : null;
      const title = truncate(raw.paper_title || raw.paper_id, 44);
      const paper = doi
        ? `<a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noopener" title="${escapeHtml(raw.paper_title || doi)}">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      return `<tr><td>${paper}</td><td class="provenance-concept">${escapeHtml(source.concept)}</td><td class="provenance-classification">${escapeHtml(source.classifications.length ? source.classifications.join("; ") : "Unclassified")}</td><td class="provenance-concept">${escapeHtml(target.concept)}</td><td class="provenance-classification">${escapeHtml(target.classifications.length ? target.classifications.join("; ") : "Unclassified")}</td><td>${escapeHtml(raw.within_table_occurrence_id || "")}</td><td>${escapeHtml(raw.causal_link_existence || "")}</td><td>${escapeHtml(raw.identification_strategy || "")}</td><td>${escapeHtml(truncate(raw.target_population || "", 60))}</td></tr>`;
    }).join("");
    elements.provenancePanel.innerHTML = `${manualHtml}<table class="provenance-table"><thead><tr><th>Paper</th><th>Source concept</th><th>Source classification</th><th>Target concept</th><th>Target classification</th><th>Occurrence</th><th>Existence</th><th>Strategy</th><th>Population</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function renderManualControls() {
    const groups = dagGroups ? dagGroups() : state.project.groups.filter(group => group.variable_ids?.length);
    const sourceValue = groups.some(group => group.group_id === elements.manualSource.value) ? elements.manualSource.value : groups[0]?.group_id;
    const targetValue = groups.some(group => group.group_id === elements.manualTarget.value) ? elements.manualTarget.value : groups.find(group => group.group_id !== sourceValue)?.group_id;
    const options = groups.map(group => `<option value="${escapeHtml(group.group_id)}">${escapeHtml(group.label)}</option>`).join("");
    elements.manualSource.innerHTML = options; elements.manualTarget.innerHTML = options;
    if (sourceValue) elements.manualSource.value = sourceValue;
    if (targetValue) elements.manualTarget.value = targetValue;
    if (elements.manualSource.value === elements.manualTarget.value) {
      const alternate = groups.find(group => group.group_id !== elements.manualSource.value);
      if (alternate) elements.manualTarget.value = alternate.group_id;
    }
  }

  function addManualEdge() {
    const source = elements.manualSource.value;
    const target = elements.manualTarget.value;
    if (!source || !target || source === target) {
      window.alert("Manual edges require two distinct nonempty groups.");
      return;
    }
    const before = takeSnapshot();
    const selectedDirection = elements.manualDirection.value;
    const storedSource = selectedDirection === "target_to_source" ? target : source;
    const storedTarget = selectedDirection === "target_to_source" ? source : target;
    applyProjectOperation(projectOps.appendManualEdge(state.project, {
      edge_id: `manual_${Date.now()}_${state.project.manual_edges.length + 1}`,
      source_group_id: storedSource, target_group_id: storedTarget,
      direction: selectedDirection === "bidirectional" ? "bidirectional" : "source_to_target",
      user_note: elements.manualNote.value.trim(), created_at: nowIso(),
      created_by: "local_user", deleted: false,
    }));
    addDecision("manual_edge_created", { source_group_id: storedSource, target_group_id: storedTarget, direction: selectedDirection });
    addToUndoHistory(`Added manual edge: ${groupById(storedSource)?.label || storedSource} → ${groupById(storedTarget)?.label || storedTarget}`, before);
    elements.manualNote.value = ""; elements.addEdgeDrawer.hidden = true;
    elements.addEdgeToggle.classList.remove("active"); rebuildProject();
  }

  return { renderEdge, renderProvenance, renderManualControls, addManualEdge, selectedEdge };
}
