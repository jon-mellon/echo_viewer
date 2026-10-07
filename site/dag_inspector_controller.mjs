import * as inspector from "./dag_inspector.mjs";
import * as projectOps from "./dag_project.mjs";
import { h, replaceChildren, safeUrl } from "./dom_builder.mjs";

export const STUDY_DESIGN_EDGE_ID = "__study_design_iv_to_dv__";
export const STUDY_INSTRUMENT_EDGE_ID = "__study_design_instrument_to_iv__";

export function createDagInspectorController({
  state, elements, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildLinkDecision,
}) {
  const selectedEdge = () => state.project?.links.find(link => link.edge_id === state.selectedEdgeId) || null;
  let pendingExclude = null;
  const clearPendingExclude = () => { pendingExclude = null; };
  const diagnosticView = () => ({
    showConfoundersOnly: state.showConfoundersOnly,
    showCollidersOnly: state.showCollidersOnly,
    showExclusionViolations: state.showExclusionViolations,
    showExogeneity: state.showExogeneity,
    confounderPathsByGroup: state.confounderPathsByGroup,
    colliderPathsByGroup: state.colliderPathsByGroup,
    exclusionPathsByGroup: state.exclusionPathsByGroup,
    exogeneityPathsByGroup: state.exogeneityPathsByGroup,
  });
  const isDoi = id => typeof id === "string" && /^10\.\d{4,}\/\S+/.test(id.trim());
  const edgeSourcesLoading = link => {
    if (!link || !state.pendingEdgeEvidence) return false;
    const rawIds = [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])];
    return rawIds.some(id => !state.rawLinksById.has(id));
  };
  const loadingSources = () => h("div", {
    className: "edge-sources-loading", role: "status", ariaLive: "polite",
  }, h("span", { className: "inline-spinner", ariaHidden: "true" }), h("span", { textContent: "Loading sources…" }));

  function handleEdgeAction(link, action, excludeReason) {
    if (!["exclude", "restore"].includes(action)) return;
    if (action === "exclude" && excludeReason === undefined) {
      pendingExclude = { edgeId: link.edge_id, reason: "" };
      const row = document.getElementById("excludeReasonRow");
      if (row) {
        row.hidden = false;
        document.getElementById("excludeReasonInput")?.focus();
      }
      return;
    }
    const before = takeSnapshot();
    if (action === "restore") {
      applyProjectOperation(projectOps.setLinkDecision(state.project, link.edge_id, null));
      addDecision("link_restored", { edge_id: link.edge_id });
      addToUndoHistory("Restored edge", before, "link-decision");
    } else if (action === "exclude") {
      clearPendingExclude();
      applyProjectOperation(projectOps.setLinkDecision(state.project, link.edge_id, {
        edge_id: link.edge_id, display_status: "excluded",
        exclude_reason: excludeReason || "", timestamp: nowIso(),
      }));
      addDecision("link_excluded", { edge_id: link.edge_id, reason: excludeReason });
      addToUndoHistory("Excluded edge", before, "link-decision");
    }
    rebuildLinkDecision();
  }

  function renderStudyRelation() {
    if (state.selectedEdgeId === STUDY_INSTRUMENT_EDGE_ID) {
      const instrument = state.project?.groups.find(group => group.group_id === state.project.instrument_group_id);
      const iv = state.project?.groups.find(group => group.group_id === state.project.iv_group_id);
      if (!instrument || !iv) return;
      elements.edgeInspector.className = "edge-inspector";
      elements.edgeInspector.hidden = false;
      elements.closeEvidencePane.hidden = false;
      elements.provenancePanel.hidden = true;
      replaceChildren(elements.edgeInspector,
        h("strong", { textContent: `${instrument.label} → ${iv.label}` }),
        h("div", { textContent: "Selected instrument relationship; not itself an evidence link." }));
      return;
    }
    const model = inspector.studyInspector(state.project, state.rawLinksById);
    if (!model) return;
    const { sourceLabel, targetLabel, rawIds, keys } = model;
    elements.edgeInspector.className = "edge-inspector";
    elements.edgeInspector.hidden = false;
    elements.closeEvidencePane.hidden = false;
    const papers = keys.length ? h("div", {}, "Papers/tables:", h("br"),
      keys.flatMap((key, index) => [index ? h("br") : null, document.createTextNode(key)])) : null;
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: `${sourceLabel} → ${targetLabel}` }),
      h("div", { textContent: "Focal study relationship; not itself an evidence link." }),
      h("div", { textContent: rawIds.length ? `${rawIds.length} evidence record(s) attached across both directions.` : "No raw evidence records attached." }), papers);
  }

  function renderGroupDefinition() {
    const group = state.project?.groups.find(item => item.group_id === state.selectedEvidenceGroupId);
    if (!group) return false;
    elements.edgeInspector.className = "edge-inspector group-definition-inspector";
    elements.edgeInspector.hidden = false;
    elements.closeEvidencePane.hidden = false;
    elements.provenancePanel.hidden = true;
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: group.label || group.group_id }),
      h("div", { className: "small-note", textContent: "Group definition" }),
      h("p", { textContent: group.description || (state.publishedSchemaHydrating
        ? "Definition loading…" : "No definition available for this group.") }));
    return true;
  }

  function renderEdge() {
    if (state.selectedEdgeId === STUDY_DESIGN_EDGE_ID
      || state.selectedEdgeId === STUDY_INSTRUMENT_EDGE_ID) return renderStudyRelation();
    const link = selectedEdge();
    if (!link) {
      elements.edgeInspector.hidden = true;
      elements.closeEvidencePane.hidden = true;
      return;
    }
    const model = inspector.edgeInspector(link, state.project, diagnosticView());
    if (pendingExclude && pendingExclude.edgeId !== link.edge_id) clearPendingExclude();
    const sourcesLoading = edgeSourcesLoading(link);
    elements.edgeInspector.className = "edge-inspector";
    elements.edgeInspector.hidden = false;
    elements.closeEvidencePane.hidden = false;
    const reason = model.existingDecision?.display_status === "excluded" && model.existingDecision.exclude_reason
      ? h("div", { className: "small-note", style: { color: "#9b5c2e" } }, h("strong", { textContent: "Excluded:" }), ` ${model.existingDecision.exclude_reason}`) : null;
    const reasonRow = h("div", { id: "excludeReasonRow", className: "exclude-reason-row", hidden: !pendingExclude },
      h("textarea", { id: "excludeReasonInput", className: "dag-textarea exclude-reason-input", rows: 2,
        value: pendingExclude?.reason || "",
        placeholder: "Required: why is this link excluded? (methodological assumption, covariate balance, etc.)" }),
      h("div", { className: "exclude-reason-actions" },
        h("button", { className: "primary-button", type: "button", id: "excludeConfirmBtn", textContent: "Confirm exclusion" }),
        h("button", { className: "text-button", type: "button", id: "excludeCancelBtn", textContent: "Cancel" })));
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: `${model.sourceLabel} ${model.arrow} ${model.targetLabel}` }),
      h("div", { textContent: `${link.is_target_relation ? "Target relationship. " : ""}${link.edge_source}; ${sourcesLoading ? "sources loading" : model.rawCount ? `${model.rawCount} evidence record(s)` : "no provenance"}` }),
      sourcesLoading ? loadingSources() : null,
      reason,
      h("div", { className: "edge-actions" }, model.actions.map(item => h("button", {
        className: "action-button", type: "button", dataset: { edgeAction: item.action }, textContent: item.label,
      }))), reasonRow);
    elements.edgeInspector.querySelectorAll("button[data-edge-action]").forEach(button => {
      button.addEventListener("click", () => handleEdgeAction(link, button.dataset.edgeAction));
    });
    const row = elements.edgeInspector.querySelector("#excludeReasonRow");
    const input = elements.edgeInspector.querySelector("#excludeReasonInput");
    input.addEventListener("input", () => { if (pendingExclude) pendingExclude.reason = input.value; });
    elements.edgeInspector.querySelector("#excludeConfirmBtn")?.addEventListener("click", () => {
      const reason = input.value.trim();
      if (!reason) { input.focus(); input.classList.add("input-error"); return; }
      input.classList.remove("input-error"); row.hidden = true;
      handleEdgeAction(link, "exclude", reason);
    });
    elements.edgeInspector.querySelector("#excludeCancelBtn")?.addEventListener("click", () => {
      row.hidden = true; input.value = ""; clearPendingExclude();
    });
  }

  function renderProvenance() {
    const link = selectedEdge();
    if (!link) { elements.provenancePanel.hidden = true; return; }
    elements.provenancePanel.hidden = false;
    if (edgeSourcesLoading(link)) {
      replaceChildren(elements.provenancePanel, loadingSources());
      return;
    }
    const model = inspector.provenanceModel(
      link, state.project, state.rawLinksById, state.variableById, diagnosticView(),
    );
    if (!model.rawIds.length) {
      replaceChildren(elements.provenancePanel, h("div", { className: "small-note", textContent: "No raw provenance for this edge." }));
      return;
    }
    const renderRow = ({ raw, source, target }) => {
      const doi = isDoi(raw.paper_id) ? raw.paper_id.trim() : null;
      const title = truncate(raw.paper_title || raw.paper_id, 44);
      const paper = doi
        ? h("a", { href: safeUrl(`https://doi.org/${encodeURIComponent(doi)}`), target: "_blank", rel: "noopener", title: raw.paper_title || doi, textContent: title })
        : document.createTextNode(title);
      const cell = (text, className) => h("td", { className, textContent: text });
      const conceptCell = (concept, variableId) => {
        if (state.variableById.has(variableId)) return cell(concept, "provenance-concept");
        return h("td", { className: "provenance-concept" }, state.pendingEdgeEvidence
          ? h("span", { className: "concept-loading", role: "status" },
            h("span", { className: "inline-spinner", ariaHidden: "true" }),
            h("span", { textContent: "Loading…" }))
          : h("span", { textContent: "Concept unavailable" }));
      };
      return h("tr", {}, h("td", {}, paper), conceptCell(source.concept, raw.source_variable_id),
        conceptCell(target.concept, raw.target_variable_id),
        cell(raw.causal_link_existence || ""), cell((raw.identification_strategy || "").replaceAll("_", " ")), cell(truncate(raw.target_population || "", 60)));
    };
    const headings = ["Paper", "Source concept", "Target concept", "Existence", "Strategy", "Population"];
    replaceChildren(elements.provenancePanel,
      model.sections.map(section => h("section", { className: "provenance-direction" },
        h("h3", { textContent: `Evidence for ${section.sourceLabel} → ${section.targetLabel}` }),
        h("table", { className: "provenance-table provenance-table--edge" },
          h("thead", {}, h("tr", {}, headings.map(label => h("th", { textContent: label })))),
          h("tbody", {}, section.rows.length ? section.rows.map(renderRow)
            : h("tr", {}, h("td", { colSpan: headings.length, textContent: "No evidence records for this direction." })))))));
  }

  return { renderEdge, renderProvenance, renderGroupDefinition, selectedEdge, clearPendingExclude };
}
