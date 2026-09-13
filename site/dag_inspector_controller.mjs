import * as inspector from "./dag_inspector.mjs";
import * as projectOps from "./dag_project.mjs";
import { h, replaceChildren, safeUrl } from "./dom_builder.mjs";

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
    const papers = keys.length ? h("div", {}, "Papers/tables:", h("br"),
      keys.flatMap((key, index) => [index ? h("br") : null, document.createTextNode(key)])) : null;
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: `${sourceLabel} → ${targetLabel}` }),
      h("div", { textContent: "Focal study relationship; not itself an evidence link." }),
      h("div", { textContent: rawIds.length ? `${rawIds.length} evidence record(s) attached across both directions.` : "No raw evidence records attached." }), papers);
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
    const reason = model.existingDecision?.display_status === "excluded" && model.existingDecision.exclude_reason
      ? h("div", { className: "small-note", style: { color: "#9b5c2e" } }, h("strong", { textContent: "Excluded:" }), ` ${model.existingDecision.exclude_reason}`) : null;
    const reasonRow = h("div", { id: "excludeReasonRow", className: "exclude-reason-row", hidden: true },
      h("textarea", { id: "excludeReasonInput", className: "dag-textarea exclude-reason-input", rows: 2,
        placeholder: "Required: why is this link excluded? (methodological assumption, covariate balance, etc.)" }),
      h("div", { className: "exclude-reason-actions" },
        h("button", { className: "primary-button", type: "button", id: "excludeConfirmBtn", textContent: "Confirm exclusion" }),
        h("button", { className: "text-button", type: "button", id: "excludeCancelBtn", textContent: "Cancel" })));
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: `${model.sourceLabel} ${model.arrow} ${model.targetLabel}` }),
      h("div", { textContent: `${link.is_target_relation ? "Target relationship. " : ""}${link.edge_source}; ${model.rawCount ? `${model.rawCount} evidence record(s)` : "no provenance"}` }),
      model.manual.length ? h("div", { textContent: model.manual.map(edge => edge.user_note || "Manual edge").join("; ") }) : null, reason,
      h("div", { className: "edge-actions" }, model.actions.map(item => h("button", {
        className: "action-button", type: "button", dataset: { edgeAction: item.action, ...(item.manualId ? { manualId: item.manualId } : {}) }, textContent: item.label,
      }))), reasonRow);
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
    const manualNode = model.manual.length
      ? h("div", { className: "small-note" }, h("strong", { textContent: "Manual annotation" }), h("br"), model.manual.map(edge => edge.user_note || "Manual edge added by user.").join("; ")) : null;
    if (!model.rawIds.length) {
      replaceChildren(elements.provenancePanel, manualNode, h("div", { className: "small-note", textContent: "No raw provenance for this edge." }));
      return;
    }
    const rows = model.rows.map(({ raw, source, target }) => {
      const doi = isDoi(raw.paper_id) ? raw.paper_id.trim() : null;
      const title = truncate(raw.paper_title || raw.paper_id, 44);
      const paper = doi
        ? h("a", { href: safeUrl(`https://doi.org/${encodeURIComponent(doi)}`), target: "_blank", rel: "noopener", title: raw.paper_title || doi, textContent: title })
        : document.createTextNode(title);
      const cell = (text, className) => h("td", { className, textContent: text });
      return h("tr", {}, h("td", {}, paper), cell(source.concept, "provenance-concept"),
        cell(source.classifications.length ? source.classifications.join("; ") : "Unclassified", "provenance-classification"),
        cell(target.concept, "provenance-concept"), cell(target.classifications.length ? target.classifications.join("; ") : "Unclassified", "provenance-classification"),
        cell(raw.within_table_occurrence_id || ""), cell(raw.causal_link_existence || ""), cell(raw.identification_strategy || ""), cell(truncate(raw.target_population || "", 60)));
    });
    const headings = ["Paper", "Source concept", "Source classification", "Target concept", "Target classification", "Occurrence", "Existence", "Strategy", "Population"];
    replaceChildren(elements.provenancePanel, manualNode, h("table", { className: "provenance-table" },
      h("thead", {}, h("tr", {}, headings.map(label => h("th", { textContent: label })))), h("tbody", {}, rows)));
  }

  function renderManualControls() {
    const groups = dagGroups ? dagGroups() : state.project.groups.filter(group => group.variable_ids?.length);
    const sourceValue = groups.some(group => group.group_id === elements.manualSource.value) ? elements.manualSource.value : groups[0]?.group_id;
    const targetValue = groups.some(group => group.group_id === elements.manualTarget.value) ? elements.manualTarget.value : groups.find(group => group.group_id !== sourceValue)?.group_id;
    const options = () => groups.map(group => h("option", { value: group.group_id, textContent: group.label }));
    replaceChildren(elements.manualSource, options()); replaceChildren(elements.manualTarget, options());
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
