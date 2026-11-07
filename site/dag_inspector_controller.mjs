import { conceptWithUoaHint } from "./concept_text.mjs";
import * as inspector from "./dag_inspector.mjs";
import * as projectOps from "./dag_project.mjs";
import { h, replaceChildren, safeUrl } from "./dom_builder.mjs";
import { excludeButton, excludedConcepts, exclusionNote, restoreList } from "./concept_exclusion_ui.mjs";

export const STUDY_DESIGN_EDGE_ID = "__study_design_iv_to_dv__";
export const STUDY_INSTRUMENT_EDGE_ID = "__study_design_instrument_to_iv__";

export function createDagInspectorController({
  state, elements, truncate, nowIso, takeSnapshot,
  applyProjectOperation, addDecision, addToUndoHistory, rebuildLinkDecision,
  renderAll = () => {},
  persistFindingDecision = () => {},
  evidenceLoadFailed = () => false, retryEvidence = () => {},
  loadConceptLabels = async () => [],
  loadVisibleLinkEndpoints = async () => [],
  excludeConcept = () => {},
  restoreConcept = () => {},
}) {
  const selectedEdge = () => state.studyGraph?.links?.find(link => link.edge_id === state.selectedEdgeId)
    || state.project?.links?.find(link => state.selectedEdgeId === STUDY_DESIGN_EDGE_ID
      ? link.is_target_relation : link.edge_id === state.selectedEdgeId) || null;
  let pendingFindingId = null;
  let pendingFindingReason = { code: "not_relevant_to_target_population", text: "" };
  const clearPendingFinding = () => {
    pendingFindingId = null;
    pendingFindingReason = { code: "not_relevant_to_target_population", text: "" };
  };
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
  let conceptPageSize = 10;
  const provenancePageSize = 5;
  // Evidence pages per direction, reset whenever a different edge is selected.
  let provenancePagesEdgeId = null;
  const provenancePages = new Map();
  const diagnosticView = () => ({
    preferredEvidenceDirection: (state.task === "causes" || state.task === "consequences")
      ? state.visibleLinks?.find(link => link.edge_id === state.selectedEdgeId)?.direction_type : null,
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
      // Bound label hydration while using the space available in taller panels.
      // The pane may still be hidden here, so fall back to the area it opens in.
      const pane = elements.edgeInspector.parentElement;
      const wide = Boolean(pane?.closest(".dag-workspace"));
      const height = pane?.clientHeight || pane?.closest(".dag-workspace, .dag-left-panel")?.clientHeight || 0;
      const descriptionLines = Math.ceil((group.description || "").length / (wide ? 110 : 40));
      conceptPageSize = Math.max(10, Math.min(30, Math.floor((height - (wide ? 260 : 190) - descriptionLines * 19) / (wide ? 35 : 28))));
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
    // Same heading pattern as the evidence page: a title with a muted subtitle.
    replaceChildren(elements.edgeInspector,
      h("section", { className: "provenance-direction group-definition-section" },
        h("h3", {}, `${group.label || group.group_id} `,
          h("span", { className: "provenance-count", textContent: "Definition" })),
        h("p", { className: "group-definition-text", textContent: group.description || (state.publishedSchemaHydrating
          ? "Definition loading…" : "No definition available for this group.") })),
      h("section", { className: "provenance-direction group-concepts" },
        h("h3", {}, "Underlying concepts ",
          h("span", { className: "provenance-count", textContent: count ? `(${count} concept${count === 1 ? "" : "s"})` : "" })),
        ids.length ? exclusionNote() : null,
        restoreList({ items: excludedConcepts(state.project, group), groupLabel: group.label || group.group_id,
          disabled: state.publishedSchemaHydrating || state.publishedSchemaLoadFailed,
          onRestore: (id, label) => restoreConcept(group.group_id, id, label) }),
        priority?.matchedCount ? h("div", { className: "small-note",
          textContent: "Concepts used by visible DAG links first" }) : null,
        pageIds.length ? h("ol", {
          start: start + 1,
          className: priority?.matchedCount > 0 && priority.matchedCount === start && start < ids.length
            ? "group-concept-boundary-at-page-start" : "",
        }, pageIds.map((id, index) => {
          const knownLabel = conceptLabels.get(id)
            || state.variableById?.get(id)?.concept_label
            || state.variableById?.get(id)?.display_label;
          const label = knownLabel || (loading ? "Loading…" : failedConceptPages.has(pageKey) ? "Name unavailable" : id);
          const canExclude = Boolean(knownLabel && (resolvedConceptIds.has(id)
            || state.variableById?.get(id)?.concept_label || state.variableById?.get(id)?.display_label));
          return h("li", {
            className: priority?.matchedCount === start + index && index > 0
              ? "group-concept-boundary" : "",
          }, h("span", { textContent: label }), canExclude ? excludeButton({
            label, groupLabel: group.label || group.group_id, dataset: { excludeConceptId: id },
            disabled: state.publishedSchemaHydrating || state.publishedSchemaLoadFailed,
          }) : null);
        })) : h("div", { className: "small-note", role: "status", textContent: priorityPending
          ? "Finding concepts used in this view…"
          : state.publishedSchemaHydrating ? "Loading concepts…" : "No underlying concepts." }),
        failedConceptViews.has(viewKey) ? h("button", {
          className: "btn btn--ghost", type: "button", dataset: { conceptPriorityRetry: "" },
          textContent: "Could not prioritize concepts. Retry",
        }) : null,
        failedConceptPages.has(pageKey) && missing.length ? h("button", {
          className: "btn btn--ghost", type: "button", dataset: { conceptRetry: "" },
          textContent: "Could not load concepts. Retry",
        }) : null,
        !priorityPending && ids.length > conceptPageSize ? h("div", { className: "group-concept-pagination" },
          h("button", { className: "btn", type: "button", dataset: { conceptPage: "previous" },
            disabled: conceptPage === 0, textContent: "Previous" }),
          h("span", { textContent: `${start + 1}–${Math.min(start + conceptPageSize, ids.length)} of ${ids.length}` }),
          h("button", { className: "btn", type: "button", dataset: { conceptPage: "next" },
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
    const exploring = state.task === "causes" || state.task === "consequences";
    const sourcesLoading = edgeSourcesLoading(link);
    elements.edgeInspector.className = "edge-inspector edge-evidence";
    elements.edgeInspector.hidden = false;
    elements.closeEvidencePane.hidden = false;
    const provenance = inspector.provenanceModel(link, state.project, state.rawLinksById, state.variableById, diagnosticView());
    const rejectedCount = provenance.rows.filter(({ raw }) =>
      state.project.finding_decisions?.[raw.raw_causal_link_id]?.display_status === "excluded").length;
    const records = `${model.rawCount} evidence record${model.rawCount === 1 ? "" : "s"}${rejectedCount ? ` · ${rejectedCount} rejected` : ""}`;
    const meta = [link.is_target_relation ? "Target relationship" : null,
      sourcesLoading ? null : model.rawCount || rejectedCount ? records : "No evidence records"].filter(Boolean).join(" · ");
    replaceChildren(elements.edgeInspector,
      h("header", { className: "evidence-header" },
        h("h2", { className: "evidence-title", textContent: `${model.sourceLabel} ${model.arrow} ${model.targetLabel}` }),
        meta ? h("p", { className: "evidence-meta", textContent: meta }) : null,
        sourcesLoading ? loadingSources() : null),
      exploring ? endpointDefinitions(link, model) : null);
  }

  // Explore: a link's evidence is read alongside what each of its variables means.
  function endpointDefinitions(link, model) {
    const groups = [link.group_a, link.group_b].map(id => state.project?.groups.find(group => group.group_id === id)).filter(Boolean);
    groups.sort((a, b) => (a.label === model.sourceLabel ? -1 : 0) - (b.label === model.sourceLabel ? -1 : 0));
    return h("section", { className: "evidence-definitions", attrs: { "aria-label": "Variable definitions" } },
      groups.map(group => h("div", { className: "evidence-definition" },
        h("h3", {}, `${group.label || group.group_id} `, h("span", { className: "provenance-count", textContent: "Definition" })),
        h("p", { className: group.description ? "group-definition-text" : "group-definition-text is-empty",
          textContent: group.description || (state.publishedSchemaHydrating
            ? "Definition loading…" : "No definition has been written for this variable.") }))));
  }

  function renderProvenance(focusPage = null) {
    const link = selectedEdge();
    if (!link) { elements.provenancePanel.hidden = true; return; }
    elements.provenancePanel.hidden = false;
    if (edgeSourcesLoading(link)) {
      replaceChildren(elements.provenancePanel, loadingSources());
      return;
    }
    if (evidenceLoadFailed()) {
      replaceChildren(elements.provenancePanel, h("div", { role: "alert" },
        h("p", { textContent: "Evidence could not be loaded. Try again." }),
        h("button", { type: "button", className: "btn btn--sm", textContent: "Retry evidence loading",
          onclick: retryEvidence })));
      return;
    }
    const model = inspector.provenanceModel(
      link, state.project, state.rawLinksById, state.variableById, diagnosticView(),
    );
    if (!model.rawIds.length) {
      replaceChildren(elements.provenancePanel, h("div", { className: "small-note", textContent: "No evidence records for this link." }));
      return;
    }
    let findingFocusTarget = null;
    const uoaHint = { shown: false };
    const renderRow = ({ raw, source, target }) => {
      const doi = isDoi(raw.paper_id) ? raw.paper_id.trim() : null;
      const title = raw.paper_title || raw.paper_id || "";
      const paper = doi
        ? h("a", { href: safeUrl(`https://doi.org/${encodeURIComponent(doi)}`), target: "_blank", rel: "noopener", title: raw.paper_title || doi, textContent: title })
        : document.createTextNode(title);
      const cell = (text, className) => h("td", { className, textContent: text });
      const loadedConceptLabel = variableId => state.variableById.get(variableId)?.concept_label
        || state.variableById.get(variableId)?.display_label;
      const conceptCell = (concept, variableId) => {
        if (loadedConceptLabel(variableId)) return h("td", { className: "provenance-concept" }, ...conceptWithUoaHint(concept, uoaHint));
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
        ? "Not relevant to target population" : decision?.reason_code === "concept_miscategorized"
          ? "Concept miscategorized" : decision?.reason_code === "other" ? "Other" : "";
      const canDecide = Boolean((raw.paper_title || raw.paper_id)
        && loadedConceptLabel(raw.source_variable_id) && loadedConceptLabel(raw.target_variable_id));
      const action = canDecide ? h("button", { className: excluded
        ? "btn btn--ghost btn--sm finding-decision-button finding-decision-button--restore"
        : "btn btn--sm btn--icon finding-decision-button finding-decision-button--exclude",
        type: "button", textContent: excluded ? "Restore" : "×",
        title: excluded ? "Restore finding" : "Exclude finding",
        attrs: { "aria-label": `${excluded ? "Restore" : "Exclude"} finding ${id}` } }) : null;
      action?.addEventListener("click", () => {
        if (excluded) {
          const before = takeSnapshot();
          if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, null)) === false) return;
          addDecision("finding_restored", { raw_causal_link_id: id });
          addToUndoHistory("Restored finding", before, "finding-decision");
          rebuildLinkDecision();
          persistFindingDecision();
        } else {
          if (pendingFindingId === id) clearPendingFinding();
          else { clearPendingFinding(); pendingFindingId = id; }
          renderProvenance({ findingId: id, control: pendingFindingId ? "reason" : "action" });
        }
      });
      if (focusPage?.findingId === id && focusPage.control === "action") findingFocusTarget = action;
      const row = h("tr", { className: excluded ? "finding-excluded" : "" }, h("td", {}, paper), conceptCell(source.concept, raw.source_variable_id),
        conceptCell(target.concept, raw.target_variable_id),
        cell(raw.causal_link_existence || "present"), cell((raw.identification_strategy || "").replaceAll("_", " ")), cell(raw.target_population || ""),
        h("td", {}, excluded ? h("span", { className: "finding-excluded-label",
          textContent: `Excluded${reasonLabel ? `: ${reasonLabel}` : ""} ` }) : null, action));
      if (pendingFindingId !== id || !canDecide) return row;
      const reason = h("select", { className: "select-input", attrs: { "aria-label": "Finding exclusion reason" } },
        h("option", { value: "not_relevant_to_target_population", textContent: "Not relevant to target population" }),
        h("option", { value: "concept_miscategorized", textContent: "Concept miscategorized" }),
        h("option", { value: "other", textContent: "Other" }));
      if (focusPage?.findingId === id && focusPage.control === "reason") findingFocusTarget = reason;
      const detail = h("textarea", { className: "dag-textarea", rows: 2,
        placeholder: "Enter the reason (kept private)", attrs: { "aria-label": "Other exclusion reason", "aria-describedby": "finding-reason-error" } });
      const detailError = h("p", { id: "finding-reason-error", className: "small-note is-error", role: "alert", hidden: true,
        textContent: "Enter a reason for excluding this finding." });
      const clearDetailError = () => { detailError.hidden = true; detail.removeAttribute("aria-invalid"); };
      reason.value = pendingFindingReason.code;
      detail.value = pendingFindingReason.text;
      detail.hidden = reason.value !== "other";
      reason.addEventListener("change", () => {
        pendingFindingReason.code = reason.value;
        detail.hidden = reason.value !== "other";
        clearDetailError();
      });
      detail.addEventListener("input", () => { pendingFindingReason.text = detail.value; clearDetailError(); });
      const confirm = h("button", { className: "btn btn--primary btn--sm", type: "button", textContent: "Confirm exclusion" });
      confirm.addEventListener("click", () => {
        const reasonText = detail.value.trim();
        if (reason.value === "other" && !reasonText) {
          detailError.hidden = false;
          detail.setAttribute("aria-invalid", "true");
          detail.focus();
          return;
        }
        const before = takeSnapshot();
        const findingDecision = { display_status: "excluded", reason_code: reason.value,
          ...(reason.value === "other" ? { reason_text: reasonText } : {}), timestamp: nowIso() };
        if (applyProjectOperation(projectOps.setFindingDecision(state.project, id, findingDecision)) === false) return;
        clearPendingFinding();
        addDecision("finding_excluded", { raw_causal_link_id: id });
        addToUndoHistory("Excluded finding", before, "finding-decision");
        rebuildLinkDecision();
        persistFindingDecision();
      });
      const cancel = h("button", { className: "btn btn--ghost btn--sm", type: "button", textContent: "Cancel" });
      cancel.addEventListener("click", () => { clearPendingFinding(); renderProvenance({ findingId: id, control: "action" }); });
      return [row, h("tr", { className: "finding-reason-tr" }, h("td", { colSpan: 7, className: "finding-reason-row" },
        h("div", { className: "exclude-reason-row" },
          h("span", { className: "exclude-reason-label", textContent: "Why exclude this finding?" }),
          reason, detail, detailError,
          h("p", { className: "exclude-reason-hint", textContent: "The finding stops counting toward this link; you can restore it later." }),
          h("div", { className: "exclude-reason-actions" }, confirm, cancel))))];
    };
    const headings = ["Paper", "Source concept", "Target concept", "Claim", "Strategy", "Population", "Decision"];
    if (provenancePagesEdgeId !== link.edge_id) {
      provenancePagesEdgeId = link.edge_id;
      provenancePages.clear();
    }
    let pageFocusTarget = null;
    const renderSection = section => {
      const page = inspector.provenancePage(section.rows, provenancePages.get(section.direction) || 0, provenancePageSize);
      provenancePages.set(section.direction, page.page);
      const goTo = (next, control) => {
        provenancePages.set(section.direction, next);
        clearPendingFinding();
        renderProvenance({ direction: section.direction, control });
      };
      const directionLabel = `${section.sourceLabel} to ${section.targetLabel}`;
      const previous = h("button", { className: "btn", type: "button", disabled: page.page === 0,
        textContent: "Previous", attrs: { "aria-label": `Previous evidence for ${directionLabel}` },
        onclick: () => goTo(page.page - 1, "previous") });
      const next = h("button", { className: "btn", type: "button", disabled: page.page >= page.pageCount - 1,
        textContent: "Next", attrs: { "aria-label": `Next evidence for ${directionLabel}` },
        onclick: () => goTo(page.page + 1, "next") });
      if (focusPage?.direction === section.direction) {
        const preferred = focusPage.control === "previous" ? previous : next;
        pageFocusTarget = preferred.disabled ? (preferred === previous ? next : previous) : preferred;
      }
      const rejectedCount = section.rows.filter(({ raw }) =>
        state.project.finding_decisions?.[raw.raw_causal_link_id]?.display_status === "excluded").length;
      const records = `${section.rows.length} record${section.rows.length === 1 ? "" : "s"}${rejectedCount ? ` · ${rejectedCount} rejected` : ""}`;
      return h("section", { className: "provenance-direction evidence-section" },
        h("h3", { className: "evidence-section-title" }, `Evidence for ${section.sourceLabel} → ${section.targetLabel}`,
          h("span", { className: "evidence-section-count", textContent: records })),
        h("table", { className: "provenance-table provenance-table--edge" },
          h("thead", {}, h("tr", {}, headings.map(label => h("th", { textContent: label })))),
          h("tbody", {}, page.rows.length ? page.rows.map(renderRow)
            : h("tr", {}, h("td", { colSpan: headings.length, textContent: "No evidence records for this direction." })))),
        page.pageCount > 1 ? h("div", { className: "provenance-pagination" },
          previous,
          h("span", { textContent: `${page.start + 1}–${page.end} of ${page.total}` }),
          next) : null);
    };
    replaceChildren(elements.provenancePanel, model.sections.map(renderSection));
    (findingFocusTarget || pageFocusTarget)?.focus();
  }

  return { renderEdge, renderProvenance, renderGroupDefinition, selectedEdge };
}
