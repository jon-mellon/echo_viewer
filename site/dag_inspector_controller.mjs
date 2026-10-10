import * as inspector from "./dag_inspector.mjs";
import * as projectOps from "./dag_project.mjs";
import { h, replaceChildren, safeUrl } from "./dom_builder.mjs";

export const STUDY_DESIGN_EDGE_ID = "__study_design_iv_to_dv__";
export const STUDY_INSTRUMENT_EDGE_ID = "__study_design_instrument_to_iv__";

export function createDagInspectorController({
  state, elements, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildLinkDecision,
  renderAll = () => {},
  persistFindingDecision = () => {},
  loadConceptLabels = async () => [],
  loadVisibleLinkEndpoints = async () => [],
  excludeConcept = () => {},
}) {
  const selectedEdge = () => state.project?.links.find(link => link.edge_id === state.selectedEdgeId) || null;
  let pendingExclude = null;
  let pendingFindingId = null;
  const conceptLabels = new Map();
  const resolvedConceptIds = new Set();
  const pendingConceptPages = new Map();
  const failedConceptPages = new Set();
  const orderedConceptsByView = new Map();
  const rawEndpointsById = new Map();
  const pendingConceptViews = new Map();
  const failedConceptViews = new Set();
  let conceptGroupId = null;
  let conceptViewKey = null;
  let conceptPage = 0;
  const conceptPageSize = 10;
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
    if (conceptGroupId !== group.group_id) {
      conceptGroupId = group.group_id;
      conceptPage = 0;
    }
    const ids = group.variable_ids || [];
    const count = ids.length || (state.publishedSchemaHydrating ? Number(group.member_count) || 0 : 0);
    const visibleRawIds = [...new Set((state.visibleLinks || [])
      .filter(link => link.group_a === group.group_id || link.group_b === group.group_id)
      .flatMap(link => [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])]))];
    const viewKey = JSON.stringify([group.group_id, ids, visibleRawIds]);
    if (conceptViewKey !== viewKey) {
      conceptViewKey = viewKey;
      conceptPage = 0;
    }
    const priorityPending = ids.length && visibleRawIds.length
      && !orderedConceptsByView.has(viewKey) && !failedConceptViews.has(viewKey);
    const priority = orderedConceptsByView.get(viewKey);
    const orderedIds = priority?.ids || ids;
    conceptPage = Math.min(conceptPage, Math.max(0, Math.ceil(orderedIds.length / conceptPageSize) - 1));
    const start = conceptPage * conceptPageSize;
    const pageIds = priorityPending ? [] : orderedIds.slice(start, start + conceptPageSize);
    const missing = pageIds.filter(id => !conceptLabels.has(id) && !state.variableById?.has(id));
    const pageKey = JSON.stringify(pageIds);
    const loading = missing.length && !failedConceptPages.has(pageKey);
    elements.edgeInspector.className = "edge-inspector group-definition-inspector";
    elements.edgeInspector.hidden = false;
    elements.closeEvidencePane.hidden = false;
    elements.provenancePanel.hidden = true;
    replaceChildren(elements.edgeInspector,
      h("strong", { textContent: group.label || group.group_id }),
      h("div", { className: "small-note", textContent: "Group definition" }),
      h("p", { textContent: group.description || (state.publishedSchemaHydrating
        ? "Definition loading…" : "No definition available for this group.") }),
      h("div", { className: "group-concepts" },
        h("strong", { textContent: `Underlying concepts${count ? ` (${count})` : ""}` }),
        priority?.matchedCount ? h("div", { className: "small-note",
          textContent: "Concepts used by visible DAG links first" }) : null,
        pageIds.length ? h("ol", { start: start + 1 }, pageIds.map(id => {
          const knownLabel = conceptLabels.get(id)
            || state.variableById?.get(id)?.concept_label
            || state.variableById?.get(id)?.display_label;
          const label = knownLabel || (loading ? "Loading…" : id);
          const canExclude = Boolean(knownLabel && (resolvedConceptIds.has(id)
            || state.variableById?.get(id)?.concept_label || state.variableById?.get(id)?.display_label));
          return h("li", {}, h("span", { textContent: label }), canExclude ? h("button", {
            className: "group-concept-exclude", type: "button", dataset: { excludeConceptId: id },
            attrs: { "aria-label": `Exclude ${label} from ${group.label || group.group_id}` },
            title: `Exclude ${label}`,
            disabled: state.publishedSchemaHydrating || state.publishedSchemaLoadFailed,
            textContent: "×",
          }) : null);
        })) : h("div", { className: "small-note", role: "status", textContent: priorityPending
          ? "Finding concepts used in this view…"
          : state.publishedSchemaHydrating ? "Loading concepts…" : "No underlying concepts." }),
        failedConceptViews.has(viewKey) ? h("button", {
          className: "text-button", type: "button", dataset: { conceptPriorityRetry: "" },
          textContent: "Could not prioritize concepts. Retry",
        }) : null,
        failedConceptPages.has(pageKey) ? h("button", {
          className: "text-button", type: "button", dataset: { conceptRetry: "" },
          textContent: "Could not load concepts. Retry",
        }) : null,
        !priorityPending && ids.length > conceptPageSize ? h("div", { className: "group-concept-pagination" },
          h("button", { className: "toolbar-button", type: "button", dataset: { conceptPage: "previous" },
            disabled: conceptPage === 0, textContent: "Previous" }),
          h("span", { textContent: `${start + 1}–${Math.min(start + conceptPageSize, ids.length)} of ${ids.length}` }),
          h("button", { className: "toolbar-button", type: "button", dataset: { conceptPage: "next" },
            disabled: start + conceptPageSize >= ids.length, textContent: "Next" })) : null));
    elements.edgeInspector.querySelector("[data-concept-page='previous']")?.addEventListener("click", () => {
      conceptPage -= 1;
      renderGroupDefinition();
    });
    elements.edgeInspector.querySelector("[data-concept-page='next']")?.addEventListener("click", () => {
      conceptPage += 1;
      renderGroupDefinition();
    });
    elements.edgeInspector.querySelector("[data-concept-retry]")?.addEventListener("click", () => {
      failedConceptPages.delete(pageKey);
      renderGroupDefinition();
    });
    elements.edgeInspector.querySelector("[data-concept-priority-retry]")?.addEventListener("click", () => {
      failedConceptViews.delete(viewKey);
      renderGroupDefinition();
    });
    elements.edgeInspector.querySelectorAll("[data-exclude-concept-id]").forEach(button => {
      button.addEventListener("click", () => {
        const id = button.dataset.excludeConceptId;
        excludeConcept(group.group_id, id, conceptLabels.get(id)
          || state.variableById?.get(id)?.concept_label
          || state.variableById?.get(id)?.display_label || id);
      });
    });
    if (priorityPending && !pendingConceptViews.has(viewKey)) {
      const pending = Promise.resolve().then(async () => {
        const known = visibleRawIds.map(id => state.rawLinksById?.get(id) || rawEndpointsById.get(id)).filter(Boolean);
        const missingRawIds = visibleRawIds.filter(id => !state.rawLinksById?.has(id) && !rawEndpointsById.has(id));
        const endpoints = missingRawIds.length ? await loadVisibleLinkEndpoints(missingRawIds) : [];
        for (const row of endpoints) rawEndpointsById.set(row.raw_causal_link_id, row);
        const counts = new Map();
        const members = new Set(ids);
        for (const row of [...known, ...endpoints]) {
          for (const id of [row.source_variable_id, row.target_variable_id]) {
            if (members.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
          }
        }
        orderedConceptsByView.set(viewKey, { ids: [...ids].sort((a, b) =>
          (counts.get(b) || 0) - (counts.get(a) || 0)), matchedCount: counts.size });
      }).catch(error => {
        failedConceptViews.add(viewKey);
        console.warn("Could not prioritize concepts for the current view.", error);
      }).finally(() => {
        pendingConceptViews.delete(viewKey);
        if (state.selectedEvidenceGroupId === group.group_id && !state.selectedEdgeId) renderGroupDefinition();
      });
      pendingConceptViews.set(viewKey, pending);
    }
    if (loading && !pendingConceptPages.has(pageKey)) {
      // Start after the description has been put in the DOM. Concept retrieval
      // can initialize the evidence engine without delaying the inspector.
      const pending = Promise.resolve().then(() => loadConceptLabels(missing)).then(rows => {
        for (const row of rows) {
          const label = row.concept_label || row.display_label;
          if (label) resolvedConceptIds.add(row.variable_id);
          conceptLabels.set(row.variable_id, label || row.variable_id);
        }
        for (const id of missing) if (!conceptLabels.has(id)) conceptLabels.set(id, id);
      }).catch(error => {
        failedConceptPages.add(pageKey);
        console.warn("Could not load underlying concepts.", error);
      }).finally(() => {
        pendingConceptPages.delete(pageKey);
        if (state.selectedEvidenceGroupId === group.group_id && !state.selectedEdgeId) renderGroupDefinition();
      });
      pendingConceptPages.set(pageKey, pending);
    }
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
      const loadedConceptLabel = variableId => state.variableById.get(variableId)?.concept_label
        || state.variableById.get(variableId)?.display_label;
      const conceptCell = (concept, variableId) => {
        if (loadedConceptLabel(variableId)) return cell(concept, "provenance-concept");
        return h("td", { className: "provenance-concept" }, state.pendingEdgeEvidence
          ? h("span", { className: "concept-loading", role: "status" },
            h("span", { className: "inline-spinner", ariaHidden: "true" }),
            h("span", { textContent: "Loading…" }))
          : h("span", { textContent: "Concept unavailable" }));
      };
      const id = raw.raw_causal_link_id;
      const decision = state.project.finding_decisions?.[id];
      const excluded = decision?.display_status === "excluded";
      const reasonLabel = decision?.reason_code === "not_relevant_to_target_population"
        ? "Not relevant to target population" : decision?.reason_code === "other" ? "Other" : "";
      const canDecide = Boolean((raw.paper_title || raw.paper_id)
        && loadedConceptLabel(raw.source_variable_id) && loadedConceptLabel(raw.target_variable_id));
      const action = canDecide ? h("button", { className: excluded ? "text-button" : "finding-exclude-button",
        type: "button", textContent: excluded ? "Restore" : "×",
        title: excluded ? "Restore finding" : "Exclude finding",
        attrs: { "aria-label": `${excluded ? "Restore" : "Exclude"} finding ${id}` } }) : null;
      action?.addEventListener("click", () => {
        if (excluded) {
          const before = takeSnapshot();
          if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, null)) === false) return;
          addDecision("finding_restored", { raw_causal_link_id: id });
          addToUndoHistory("Restored finding", before, "finding-decision");
          renderAll();
          persistFindingDecision();
        } else {
          pendingFindingId = pendingFindingId === id ? null : id;
          renderProvenance();
        }
      });
      const row = h("tr", { className: excluded ? "finding-excluded" : "" }, h("td", {}, paper), conceptCell(source.concept, raw.source_variable_id),
        conceptCell(target.concept, raw.target_variable_id),
        cell(raw.causal_link_existence || ""), cell((raw.identification_strategy || "").replaceAll("_", " ")), cell(truncate(raw.target_population || "", 60)),
        h("td", {}, excluded ? h("span", { className: "finding-excluded-label",
          textContent: `Excluded${reasonLabel ? `: ${reasonLabel}` : ""} ` }) : null, action));
      if (pendingFindingId !== id || !canDecide) return row;
      const reason = h("select", { attrs: { "aria-label": "Finding exclusion reason" } },
        h("option", { value: "not_relevant_to_target_population", textContent: "Not relevant to target population" }),
        h("option", { value: "other", textContent: "Other" }));
      const detail = h("textarea", { className: "dag-textarea", rows: 2,
        placeholder: "Enter the reason (kept private)", attrs: { "aria-label": "Other exclusion reason" } });
      detail.hidden = true;
      reason.addEventListener("change", () => { detail.hidden = reason.value !== "other"; });
      const confirm = h("button", { className: "primary-button", type: "button", textContent: "Confirm exclusion" });
      confirm.addEventListener("click", () => {
        const reasonText = detail.value.trim();
        if (reason.value === "other" && !reasonText) { detail.focus(); return; }
        const before = takeSnapshot();
        const findingDecision = { display_status: "excluded", reason_code: reason.value,
          ...(reason.value === "other" ? { reason_text: reasonText } : {}), timestamp: nowIso() };
        if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, findingDecision)) === false) return;
        pendingFindingId = null;
        addDecision("finding_excluded", { raw_causal_link_id: id });
        addToUndoHistory("Excluded finding", before, "finding-decision");
        renderAll();
        persistFindingDecision();
      });
      const cancel = h("button", { className: "text-button", type: "button", textContent: "Cancel" });
      cancel.addEventListener("click", () => { pendingFindingId = null; renderProvenance(); });
      return [row, h("tr", {}, h("td", { colSpan: 7, className: "finding-reason-row" },
        reason, detail, confirm, cancel))];
    };
    const headings = ["Paper", "Source concept", "Target concept", "Existence", "Strategy", "Population", "Decision"];
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
