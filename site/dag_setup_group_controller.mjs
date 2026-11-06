import { isDagDisplayGroup } from "./dag_network_controller.mjs";
import * as groupListModel from "./dag_group_list.mjs";
import * as searchModel from "./dag_search.mjs";
import * as workflow from "./dag_workflow.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";
import { attachListKeyboardNav, resultCountText } from "./list_keyboard_nav.mjs";
import { createVariableButton, customVariableActions } from "./custom_variable_actions.mjs";

export function dag2AnchorPickerIsActive(state, side, groupById) {
  const iv = groupById(state.project?.iv_group_id);
  const dv = groupById(state.project?.dv_group_id);
  const ivSet = anchorHasMembers(state, iv);
  const dvSet = anchorHasMembers(state, dv);
  const changingIv = state.changingAnchorSide === "iv";
  const changingDv = state.changingAnchorSide === "dv";
  if (side === "instrument") return ivSet && dvSet
    && (state.changingAnchorSide === "instrument" || state.phase === "select_instrument");
  return side === "iv"
    ? !ivSet || changingIv
    : ivSet && (!dvSet || changingDv) && !changingIv;
}

function anchorHasMembers(state, group) {
  return Boolean(group?.variable_ids?.length
    || (state.publishedSchemaHydrating && Number(group?.member_count) > 0));
}

export function createDagSetupGroupController({
  state, elements, escapeHtml, normalized, truncate, groupById,
  assignGroupAsAnchor, assignGroupAsInstrument, renderAll,
  roleLabels, dagProjectView, startDefinition, startEditSplit,
  canEditSplit = () => false, searchAnchorGroups = searchModel.searchAnchorGroups,
  beginEditor = () => {},
  loadConceptLabels = async () => [], loadVisibleLinkEndpoints = async () => [],
  excludeConcept = () => {},
  // Causes and consequences reuse the anchor bar and picker for their one variable.
  exploreFocus = () => ({ active: false }), searchFocusGroups = () => [], onChooseFocus = () => {},
  // Identify's Cause, Outcome and Instrument fields share the Explore picker list.
  identifyPicking = () => null, onChooseIdentify = () => {}, onCancelIdentify = () => {},
  canChangeCustom = () => true, deleteCustom = async () => {},
  previousSplits = () => [], loadPreviousSplits = () => {}, reusePreviousSplit = () => {}, browsePreviousForSource = () => {},
}) {
  const variablePageSize = 10;
  let variablePage = 0;
  const expandedVariableIds = new Set();
  const conceptPageSize = 10;
  const conceptPages = new Map();
  const conceptLabels = new Map();
  const resolvedConceptIds = new Set();
  const pendingConceptPages = new Map();
  const failedConceptPages = new Set();
  const orderedConceptsByView = new Map();
  const rawEndpointsById = new Map();
  const pendingConceptViews = new Map();
  const failedConceptViews = new Set();
  const conceptHosts = new Map();
  function renderMode() {
    if (state.interfaceMode === "dag2") {
      const iv = groupById(state.project?.iv_group_id);
      const dv = groupById(state.project?.dv_group_id);
      // Every task opens on its map and side panel; only the legacy flow takes the whole page.
      document.body.classList.toggle("initial-setup", !state.task
        && (!(anchorHasMembers(state, iv) && anchorHasMembers(state, dv)) || state.phase === "select_instrument" && !state.changingAnchorSide));
      elements.setupSection.hidden = anchorHasMembers(state, iv) && anchorHasMembers(state, dv)
        && state.phase !== "select_instrument" && !state.changingAnchorSide && !state.definitionDraft;
      elements.groupListPanel.hidden = true;
      elements.groupingPanel.hidden = false;
      return;
    }
    elements.modeSwitcher.querySelectorAll(".mode-tab").forEach(tab =>
      tab.classList.toggle("active", tab.dataset.mode === state.workflowMode));
    elements.setupSection.hidden = state.workflowMode !== "setup";
    elements.groupListPanel.hidden = state.workflowMode === "setup";
    elements.groupingPanel.hidden = false;
  }

  function renderAnchorBar() {
    if (!elements.anchorBar) return;
    const focus = exploreFocus();
    const anchorRows = [elements.anchorDvLabel, elements.anchorIvLabel].map(node => node.closest(".anchor-row"));
    if (elements.exploreFocusSelector) elements.exploreFocusSelector.hidden = !focus.active;
    if (focus.active) {
      // The variable is shown by the search box in the Explore panel, and undo
      // and redo live in the top bar, so the anchor bar has nothing to show.
      elements.anchorBar.hidden = true;
      elements.exploreFocusSelector.hidden = true;
      for (const row of anchorRows) row.hidden = true;
      elements.exploreFocusName.textContent = focus.label || "";
      elements.exploreFocusSelector.title = focus.label ? `Change the selected variable (${focus.label})` : "";
      if (elements.editSplitIv) elements.editSplitIv.hidden = true;
      if (elements.editSplitDv) elements.editSplitDv.hidden = true;
      if (elements.instrumentRow) elements.instrumentRow.hidden = true;
      return;
    }
    if (state.task === "identify") {
      // The Cause, Outcome and Instrument fields in the side panel replace the anchor bar.
      elements.anchorBar.hidden = true;
      return;
    }
    for (const row of anchorRows) row.hidden = false;
    const iv = groupById(state.project?.iv_group_id), dv = groupById(state.project?.dv_group_id);
    const ivSet = anchorHasMembers(state, iv), dvSet = anchorHasMembers(state, dv);
    const show = (state.interfaceMode === "dag2" || state.workflowMode !== "setup") && (ivSet || dvSet);
    elements.anchorBar.hidden = !show;
    if (!show) return;
    elements.anchorDvLabel.textContent = dvSet ? dv.label : "not set";
    elements.anchorIvLabel.textContent = ivSet ? iv.label : "not set";
    elements.anchorDvLabel.title = dvSet ? dv.label : "";
    elements.anchorIvLabel.title = ivSet ? iv.label : "";
    if (elements.editSplitIv) elements.editSplitIv.hidden = !ivSet || !canEditSplit(iv);
    if (elements.editSplitDv) elements.editSplitDv.hidden = !dvSet || !canEditSplit(dv);
    if (elements.instrumentRow) {
      elements.instrumentRow.hidden = !ivSet || !dvSet;
      const instrument = groupById(state.project.instrument_group_id);
      elements.anchorInstrumentLabel.textContent = instrument?.label || "None";
      elements.anchorInstrumentLabel.title = instrument?.label || "No instrument selected";
    }
  }

  function renderRightPanel() {
    if (state.interfaceMode === "dag2") {
      elements.groupEditorSection.classList.remove("active");
      elements.dagWorkspaceSection.hidden = Boolean(state.definitionDraft && state.definitionDraft.step !== "sources");
      return;
    }
    const editing = Boolean(state.activeGroupId);
    elements.groupEditorSection.classList.toggle("active", editing);
    elements.dagWorkspaceSection.hidden = editing;
  }

  function renderVariableConcepts(group) {
    const host = conceptHosts.get(group.group_id);
    if (!host) return;
    const ids = group.variable_ids || [];
    const visibleRawIds = [...new Set((state.visibleLinks || [])
      .filter(link => link.group_a === group.group_id || link.group_b === group.group_id)
      .flatMap(link => [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])]))];
    const viewKey = JSON.stringify([group.group_id, ids, visibleRawIds]);
    const saved = conceptPages.get(group.group_id);
    const page = saved?.viewKey === viewKey ? saved.page : 0;
    const priorityPending = ids.length && visibleRawIds.length
      && !orderedConceptsByView.has(viewKey) && !failedConceptViews.has(viewKey);
    const priority = orderedConceptsByView.get(viewKey);
    const orderedIds = priority?.ids || ids;
    const currentPage = Math.min(page, Math.max(0, Math.ceil(orderedIds.length / conceptPageSize) - 1));
    conceptPages.set(group.group_id, { viewKey, page: currentPage });
    const start = currentPage * conceptPageSize;
    const pageIds = priorityPending ? [] : orderedIds.slice(start, start + conceptPageSize);
    const missing = pageIds.filter(id => !conceptLabels.has(id) && !state.variableById?.has(id));
    const pageKey = JSON.stringify([group.group_id, pageIds]);
    const loading = missing.length && !failedConceptPages.has(pageKey);
    const count = ids.length || (state.publishedSchemaHydrating ? Number(group.member_count) || 0 : 0);

    replaceChildren(host,
      h("strong", { textContent: `Underlying concepts${count ? ` (${count})` : ""}` }),
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
        const button = canExclude ? h("button", {
          className: "group-concept-exclude", type: "button",
          attrs: { "aria-label": `Exclude ${label} from ${group.label || group.group_id}` },
          title: `Exclude ${label}`,
          disabled: state.publishedSchemaHydrating || state.publishedSchemaLoadFailed,
          textContent: "×",
        }) : null;
        button?.addEventListener("click", () => excludeConcept(group.group_id, id, label));
        return h("li", {
          className: priority?.matchedCount === start + index && index > 0
            ? "group-concept-boundary" : "",
        }, h("span", { textContent: label }), button);
      })) : h("div", { className: "small-note", role: "status", textContent: priorityPending
        ? "Finding concepts used in this view…"
        : state.publishedSchemaHydrating ? "Loading concepts…" : "No underlying concepts." }),
      failedConceptViews.has(viewKey) ? h("button", {
        className: "btn btn--ghost", type: "button", textContent: "Could not prioritize concepts. Retry",
        onclick: () => { failedConceptViews.delete(viewKey); renderVariableConcepts(group); },
      }) : null,
      failedConceptPages.has(pageKey) && missing.length ? h("button", {
        className: "btn btn--ghost", type: "button", textContent: "Could not load concepts. Retry",
        onclick: () => { failedConceptPages.delete(pageKey); renderVariableConcepts(group); },
      }) : null,
      !priorityPending && ids.length > conceptPageSize ? h("div", { className: "group-concept-pagination" },
        h("button", { className: "btn", type: "button", disabled: currentPage === 0,
          textContent: "Previous", onclick: () => {
            conceptPages.set(group.group_id, { viewKey, page: currentPage - 1 });
            renderVariableConcepts(group);
          } }),
        h("span", { textContent: `${start + 1}–${Math.min(start + conceptPageSize, ids.length)} of ${ids.length}` }),
        h("button", { className: "btn", type: "button",
          disabled: start + conceptPageSize >= ids.length, textContent: "Next", onclick: () => {
            conceptPages.set(group.group_id, { viewKey, page: currentPage + 1 });
            renderVariableConcepts(group);
          } })) : null);

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
        console.warn("Could not prioritize concepts for the Variables list.", error);
      }).finally(() => {
        pendingConceptViews.delete(viewKey);
        const current = state.project?.groups.find(item => item.group_id === group.group_id);
        if (current && conceptHosts.has(group.group_id)) renderVariableConcepts(current);
      });
      pendingConceptViews.set(viewKey, pending);
    }
    if (loading && !pendingConceptPages.has(pageKey)) {
      const pending = Promise.resolve().then(() => loadConceptLabels(missing)).then(rows => {
        for (const row of rows) {
          const label = row.concept_label || row.display_label;
          if (label) resolvedConceptIds.add(row.variable_id);
          conceptLabels.set(row.variable_id, label || row.variable_id);
        }
        for (const id of missing) if (!conceptLabels.has(id)) conceptLabels.set(id, id);
      }).catch(error => {
        failedConceptPages.add(pageKey);
        console.warn("Could not load concepts in the Variables list.", error);
      }).finally(() => {
        pendingConceptPages.delete(pageKey);
        const current = state.project?.groups.find(item => item.group_id === group.group_id);
        if (current && conceptHosts.has(group.group_id)) renderVariableConcepts(current);
      });
      pendingConceptPages.set(pageKey, pending);
    }
  }

  function renderVariablePanel() {
    if (!elements.variablePanel) return;
    const project = state.project;
    const iv = groupById(state.project?.iv_group_id);
    const dv = groupById(state.project?.dv_group_id);
    const show = state.interfaceMode === "dag2" && anchorHasMembers(state, iv)
      && anchorHasMembers(state, dv) && !state.definitionDraft;
    elements.variablePanel.hidden = !show;
    if (!show) return;
    const groups = (project?.groups || []).filter(group =>
      (state.componentGroupIds?.has(group.group_id) || canEditSplit(group)) && isDagDisplayGroup(group))
      .sort((a, b) => (a.label || a.group_id).localeCompare(b.label || b.group_id));
    elements.variablePanelCount.textContent = String(groups.length);
    for (const detail of elements.variablePanelList.querySelectorAll("details[data-group-id]")) {
      if (detail.open) expandedVariableIds.add(detail.dataset.groupId);
      else expandedVariableIds.delete(detail.dataset.groupId);
    }
    variablePage = Math.min(variablePage, Math.max(0, Math.ceil(groups.length / variablePageSize) - 1));
    if (state.pendingVariablePanelGroupId) {
      const index = groups.findIndex(group => group.group_id === state.pendingVariablePanelGroupId);
      if (index >= 0) variablePage = Math.floor(index / variablePageSize);
      state.pendingVariablePanelGroupId = null;
    }
    const start = variablePage * variablePageSize;
    const scrollTop = elements.variablePanelList.scrollTop;
    conceptHosts.clear();
    replaceChildren(elements.variablePanelList, groups.slice(start, start + variablePageSize).map(group => {
      const concepts = h("div", { className: "group-concepts variable-panel-concepts" });
      conceptHosts.set(group.group_id, concepts);
      const editButton = canEditSplit(group) ? h("button", { className: "btn btn--ghost variable-panel-edit", type: "button",
        textContent: "Edit split", title: `Edit the split containing ${group.label || group.group_id}` }) : null;
      editButton?.addEventListener("click", () => startEditSplit?.(group.group_id));
      const detail = h("details", { className: "variable-panel-item", dataset: { groupId: group.group_id }, open: expandedVariableIds.has(group.group_id) },
        h("summary", {}, h("span", { textContent: group.label || group.group_id }),
          group.group_id === project.iv_group_id ? h("span", { className: "variable-panel-role", textContent: "Ind var" }) : null,
          group.group_id === project.dv_group_id ? h("span", { className: "variable-panel-role", textContent: "Dep var" }) : null,
          group.group_id === project.instrument_group_id ? h("span", { className: "variable-panel-role", textContent: "Instrument" }) : null),
        h("p", { textContent: group.description || "No definition available." }), editButton, concepts);
      detail.addEventListener("toggle", () => {
        if (detail.open) {
          expandedVariableIds.add(group.group_id);
          renderVariableConcepts(group);
        } else expandedVariableIds.delete(group.group_id);
      });
      return detail;
    }));
    for (const group of groups.slice(start, start + variablePageSize)) {
      if (expandedVariableIds.has(group.group_id)) renderVariableConcepts(group);
    }
    elements.variablePanelList.scrollTop = scrollTop;
    elements.variablePanelPagination.hidden = groups.length <= variablePageSize;
    if (groups.length > variablePageSize) {
      const previous = h("button", { className: "btn", type: "button", disabled: variablePage === 0,
        textContent: "Previous" });
      const next = h("button", { className: "btn", type: "button",
        disabled: start + variablePageSize >= groups.length, textContent: "Next" });
      previous.addEventListener("click", () => { variablePage -= 1; renderVariablePanel(); elements.variablePanelList.scrollTop = 0; });
      next.addEventListener("click", () => { variablePage += 1; renderVariablePanel(); elements.variablePanelList.scrollTop = 0; });
      replaceChildren(elements.variablePanelPagination, previous,
        h("span", { textContent: `${start + 1}–${Math.min(start + variablePageSize, groups.length)} of ${groups.length}` }), next);
    } else elements.variablePanelPagination.replaceChildren();
  }

  function hint() {
    const hints = {
      select_dv: "Search the existing groups for the outcome, or choose Define new group to build a new dependent-variable group from raw variables.",
      define_dv: "Use Draw + / Draw − to adjust the dependent-variable group boundary. Confirm when the group is substantively correct.",
      select_iv: "Search the existing groups for the independent variable, or choose Define new group to build a new group from raw variables.",
      select_instrument: "Choose an optional instrument from an existing group, define a new group, or select None.",
      define_iv: "Adjust the independent-variable group boundary. Confirm when satisfied.",
      schema_choice: "Choose whether to load the default grouping schema. Loaded groups participate in the DAG immediately.",
    };
    return hints[state.phase] || "Edit groups here. Close the group editor to inspect causal edges in the graph panel.";
  }

  function renderStatus() {
    if (state.interfaceMode === "dag2") {
      if (state.definitionDraft) {
        elements.currentStepTitle.textContent = state.definitionDraft.mode === "edit" ? "Edit split"
          : state.definitionDraft.role === "candidate" ? "Define new variable"
            : `Define new ${state.definitionDraft.role.toUpperCase()}`;
        elements.dagStatusBadge.textContent = state.definitionDraft.step === "sources" ? "Sources"
          : state.definitionDraft.step === "partition" ? "Construct" : "Review";
        elements.dagStatusBadge.className = "badge";
        elements.workflowHint.textContent = state.definitionDraft.step === "sources"
          ? "Choose the existing categories whose canonical variables should be available."
          : "Use the Variables tab to tap points or draw around them. Return to Setup to search, review, and save.";
        elements.ivSearchBlock.hidden = true;
        elements.dvSearchBlock.hidden = true;
        elements.instrumentSearchBlock.hidden = true;
        elements.schemaChoice.hidden = true;
        return;
      }
      const iv = groupById(state.project?.iv_group_id), dv = groupById(state.project?.dv_group_id);
      const ivSet = anchorHasMembers(state, iv), dvSet = anchorHasMembers(state, dv);
      const changingIv = state.changingAnchorSide === "iv";
      const changingDv = state.changingAnchorSide === "dv";
      const changingInstrument = (state.changingAnchorSide === "instrument" || state.phase === "select_instrument") && ivSet && dvSet;
      elements.currentStepTitle.textContent = !ivSet || changingIv
        ? "Select independent variable"
        : !dvSet || changingDv ? "Select dependent variable"
          : changingInstrument ? "Select instrument (optional)" : "Setup complete";
      elements.dagStatusBadge.textContent = changingInstrument ? "Instrument"
        : ivSet && dvSet ? "Ready" : ivSet ? "Select Dep var" : "Select Ind var";
      elements.dagStatusBadge.className = `badge${ivSet && dvSet && !changingInstrument ? " muted" : ""}`;
      elements.workflowHint.textContent = !ivSet || changingIv
        ? "Choose the independent-variable group from the default schema."
        : !dvSet || changingDv
          ? "Choose the dependent-variable group."
          : changingInstrument ? "Choose an instrument, define a new group, or select None."
            : "The overall DAG is ready.";
      elements.ivSearchBlock.hidden = ivSet && !changingIv;
      elements.dvSearchBlock.hidden = !ivSet || (dvSet && !changingDv) || changingIv;
      elements.instrumentSearchBlock.hidden = !changingInstrument;
      elements.schemaChoice.hidden = true;
      return;
    }
    if (state.workflowMode !== "setup") {
      elements.dagStatusBadge.textContent = state.workflowMode === "group_review" ? "Groups" : "Build";
      elements.dagStatusBadge.className = "badge muted";
      return;
    }
    const labels = { select_dv: "Select Dep var", define_dv: "Define Dep var", select_iv: "Select Ind var",
      select_instrument: "Instrument",
      define_iv: "Define Ind var", schema_choice: "Schema", build: "Build map" };
    const titles = { select_dv: "Select dependent variable",
      select_instrument: "Select instrument (optional)",
      define_dv: "Define dependent-variable group", select_iv: "Select independent variable",
      define_iv: "Define independent-variable group", schema_choice: "Load candidate grouping schema?", build: "Build causal map" };
    elements.currentStepTitle.textContent = titles[state.phase] || "Build causal map";
    elements.dagStatusBadge.textContent = labels[state.phase] || "Build";
    elements.dagStatusBadge.className = "badge";
    elements.workflowHint.textContent = hint();
    elements.dvSearchBlock.hidden = state.phase !== "select_dv";
    elements.ivSearchBlock.hidden = state.phase !== "select_iv";
    elements.instrumentSearchBlock.hidden = state.phase !== "select_instrument";
    elements.schemaChoice.hidden = state.phase !== "schema_choice";
  }

  /** One persistent live region per picker (so a changed count is announced) and one set of arrow-key handlers. */
  const pickerNav = new WeakMap();
  function pickerA11y(container, input, nav) {
    let entry = pickerNav.get(container);
    if (!entry) {
      entry = { input, inputs: new WeakSet(), status: h("p", { className: "sr-only picker-result-status", attrs: { role: "status", "aria-live": "polite" } }) };
      entry.handler = attachListKeyboardNav(container, { getInput: () => entry.input, ...nav });
      pickerNav.set(container, entry);
    }
    entry.input = input;
    if (input && !entry.inputs.has(input)) { entry.inputs.add(input); input.addEventListener("keydown", entry.handler); }
    return entry.status;
  }

  function renderSetupPicker(side) {
    const container = side === "dv" ? elements.dvGroupPicker
      : side === "instrument" ? elements.instrumentGroupPicker : elements.ivGroupPicker;
    if (!container) return;
    const pickerIsActive = state.interfaceMode === "dag2"
      ? dag2AnchorPickerIsActive(state, side, groupById)
      : state.workflowMode === "setup" && state.phase === `select_${side}`;
    if (state.definitionDraft || !pickerIsActive) {
      container.hidden = true; container.replaceChildren(); return;
    }
    const input = side === "dv" ? elements.dvInput
      : side === "instrument" ? elements.instrumentInput : elements.ivInput;
    const label = side === "dv" ? elements.dvInputLabel : elements.ivInputLabel;
    const toggle = side === "dv" ? elements.dvDefineNew : elements.ivDefineNew;
    const isNew = side !== "instrument" && state.anchorSearchMode[side] === "new";
    if (side !== "instrument") {
      label.textContent = isNew ? "Search raw variables" : "Search existing groups";
      toggle.textContent = isNew ? "Back to existing groups" : "Define new group";
    }
    input.placeholder = isNew ? (side === "dv" ? "Income, prejudice, labor-market outcome" : "Education, religiosity, parental status") : "Search group or constituent variable";
    if (isNew) { container.hidden = true; container.replaceChildren(); return; }
    const searchProject = dagProjectView ? dagProjectView() : state.project;
    const query = normalized(input.value);
    const groups = searchAnchorGroups(searchProject, side, query, state.variableById, Infinity);
    container.hidden = false;
    const defineRow = h("div", { className: "setup-group-picker-row define-new-row" },
      h("div", {}, h("strong", { textContent: "Create a variable" }), h("span", { textContent: "Make a new one from concepts in existing variables" })),
      h("button", { className: "btn btn--sm", type: "button", dataset: { defineSide: side }, textContent: "Create" }));
    const noneRow = side === "instrument" ? h("div", { className: "setup-group-picker-row instrument-none-row" },
      h("div", {}, h("strong", { textContent: "None" }),
        h("span", { textContent: "Work without an instrument" })),
      h("button", { className: "btn btn--primary", type: "button",
        dataset: { selectNone: "true" }, textContent: "Use None" })) : null;
    const rows = groups.map(({ group, variableMatch }) => h("div", { className: "setup-group-picker-row" },
      h("div", {}, h("strong", { textContent: group.label || group.group_id }),
        h("span", { textContent: `${group.variable_ids?.length || 0} vars` }),
        variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched variable: ${truncate(variableMatch, 86)}` }) : null,
        group.description ? h("details", { className: "setup-group-definition" },
          h("summary", { textContent: "Definition" }),
          h("p", { textContent: group.description })) : null),
      h("button", { className: "btn btn--sm", type: "button", dataset: { side, groupId: group.group_id },
        textContent: side === "instrument" ? "Use as instrument" : `Use as ${side.toUpperCase()}` })));
    const emptyTitle = query && state.variableSearchStatus === "loading"
      ? "Loading variable search…"
      : query && state.publishedSchemaHydrating
        ? "Loading group memberships…"
        : query && state.variableSearchStatus === "error"
          ? "Variable search unavailable"
          : "No matching existing groups";
    const title = !groups.length ? emptyTitle
      : query && state.variableSearchStatus === "loading"
        ? "Existing groups · variable search loading…"
        : query && state.variableSearchStatus === "error"
          ? "Existing groups · variable search unavailable"
          : "Existing groups";
    const resultStatus = pickerA11y(container, input,
      { rowSelector: "button[data-group-id], button[data-select-none]", itemSelector: ".setup-group-picker-row", detailSelector: "summary" });
    resultStatus.textContent = `${resultCountText(groups.length, "group")}. Use the arrow keys to move through them.`;
    replaceChildren(container, resultStatus, noneRow, h("div", { className: "setup-group-picker-title", textContent: title }),
      h("div", { className: "setup-group-picker-list" }, defineRow, ...rows));
    container.querySelectorAll("button[data-group-id]").forEach(button =>
      button.addEventListener("click", () => button.dataset.side === "instrument"
        ? assignGroupAsInstrument(button.dataset.groupId)
        : assignGroupAsAnchor(button.dataset.side, button.dataset.groupId)));
    container.querySelector("button[data-select-none]")?.addEventListener("click", () => assignGroupAsInstrument(null));
    container.querySelector("button[data-define-side]")?.addEventListener("click", event =>
      startDefinition?.(event.currentTarget.dataset.defineSide));
  }

  function renderFocusPicker() {
    const container = elements.focusGroupPicker;
    if (!container) return;
    const focus = exploreFocus();
    const picking = Boolean(focus.active && focus.picking);
    // The search box stays at the top of the panel. Once a variable is chosen it
    // shows that variable; searching swaps the results list for matching
    // groups, drawn in the same row style, until one is picked or Escape.
    const chosen = Boolean(focus.active && focus.groupId);
    elements.focusSearchBlock.hidden = !focus.active;
    elements.focusSearchBlock.classList.toggle("has-focus", chosen);
    elements.focusSearchBlock.classList.toggle("is-selected", chosen && !picking);
    if (elements.focusInputLabel) elements.focusInputLabel.textContent = "Variable";
    elements.focusInput.placeholder = chosen && picking ? `Search to replace ${focus.label}`
      : "Search group or constituent variable";
    if (chosen && !picking && document.activeElement !== elements.focusInput) elements.focusInput.value = focus.label;
    if (!picking) { container.hidden = true; container.replaceChildren(); elements.focusPickerCancel.hidden = true; return; }
    const newPicker = container.hidden;
    elements.focusPickerCancel.hidden = !focus.groupId;
    const noun = state.task === "causes" ? "causes" : "consequences";
    renderPickerList(container, { query: normalized(elements.focusInput.value), input: elements.focusInput,
      pick: { title: "Choose variable", action: `See ${noun}` },
      onChoose: onChooseFocus, onCreate: () => startDefinition?.("candidate") });
    if (newPicker) container.scrollTop = 0;
  }

  /** The Custom and Built-in variable lists a search field opens, in the Explore row style. */
  function renderPickerList(container, { query, input, onChoose, onCreate, exclude = new Set(), pick = null, onCancel = null }) {
    const expandedDefinitions = new Set([...container.querySelectorAll("details.picker-variable-info[open]")]
      .map(detail => detail.dataset.groupId));
    loadPreviousSplits();
    const groups = searchFocusGroups(query).filter(({ group }) => !exclude.has(group.group_id));
    const previous = previousSplits(pick?.role || "candidate").filter(item => !groups.some(({ group }) => group.group_id === item.group_id)
      && (!query || normalized(`${item.name} ${item.description || ""} ${(item.source_labels || []).join(" ")}`).includes(query)));
    container.hidden = false;
    const row = ({ group, variableMatch }) => {
      const label = group.label || group.group_id;
      const count = group.variable_ids?.length || Number(group.member_count) || 0;
      const custom = group.source === "user_split";
      return h("li", { className: "explore-row picker-variable-row" },
        h("button", { type: "button", className: "explore-row-open", dataset: { groupId: group.group_id },
          title: group.description || "", attrs: { "aria-label": pick ? `${pick.action}: ${label}, ${count} variables` : `${label}, ${count} variables` } },
        h("span", { className: "explore-row-text" },
          h("span", { className: "explore-row-label", textContent: label }),
          variableMatch ? h("span", { className: "explore-row-path", textContent: `matches ${truncate(variableMatch, 70)}` }) : null),
        h("span", { className: "explore-row-papers", textContent: String(count) })),
        h("details", { className: "picker-variable-info", dataset: { groupId: group.group_id },
          open: expandedDefinitions.has(group.group_id) },
          h("summary", { title: `Definition of ${label}`, attrs: { "aria-label": `Definition of ${label}` } }, "ⓘ"),
          h("p", { textContent: group.description || "No definition available." })),
        custom ? customVariableActions({ group, canChange: canChangeCustom,
          onEdit: id => startEditSplit?.(id), onDelete: deleteCustom }) : null);
    };
    // Under "Primary variable": Custom variables, then Built-in variables. The
    // search box above filters both.
    const status = query && state.variableSearchStatus === "loading" ? "Variable search is loading; matching names only for now."
      : query && state.publishedSchemaHydrating ? "Loading group memberships…"
        : query && state.variableSearchStatus === "error" ? "Variable search is unavailable; matching names only." : "";
    const clearButton = () => h("button", { className: "btn btn--sm", type: "button", dataset: { clearFocusSearch: "true" }, textContent: "Clear search" });
    // A quiet label over each list: the variables are what is being chosen, so they outrank their headings.
    const section = (title, items) => items.length ? h("section", { className: "picker-section" },
      h("h3", { className: "picker-label" }, title, h("span", { className: "picker-count", textContent: ` · ${items.length}` })),
      h("ol", { className: "explore-list" }, items.map(row))) : null;
    const custom = groups.filter(({ group }) => group.source === "user_split");
    const builtIn = groups.filter(({ group }) => group.source !== "user_split");
    const resultStatus = pickerA11y(container, input,
      { rowSelector: "button.explore-row-open", itemSelector: ".picker-variable-row", detailSelector: "details.picker-variable-info > summary, .picker-saved-info" });
    const matches = groups.length + previous.length;
    resultStatus.textContent = status ? `${resultCountText(matches)}. ${status}` : `${resultCountText(matches)}. Use the arrow keys to move through them.`;
    replaceChildren(container, resultStatus,
      pick ? h("div", { className: "identify-picker-head" },
        h("h2", { textContent: pick.title }),
        onCancel ? h("button", { className: "btn btn--ghost btn--sm", type: "button", textContent: "Cancel", onclick: onCancel }) : null) : null,
      status ? h("p", { className: "explore-subsection-empty", role: "status", textContent: status }) : null,
      // The one secondary action, above the lists instead of inside an empty section's heading.
      createVariableButton(onCreate, { label: "Create a new variable", className: "btn picker-create" }),
      section("Your variables", custom),
      previous.length ? h("section", { className: "picker-section" },
        h("h3", { className: "picker-label" }, "Saved in other schemas", h("span", { className: "picker-count", textContent: ` · ${previous.length}` })),
        h("ol", { className: "explore-list" }, previous.map(item => h("li", { className: "explore-row picker-variable-row" },
          h("button", { type: "button", className: "explore-row-open saved-variable-row", title: `Choose ${item.name}`,
            attrs: { "aria-label": `Choose ${item.name}` }, onclick: () => reusePreviousSplit(pick?.role || "candidate", item, { addDirectly: true }) },
            h("span", { className: "explore-row-text" }, h("span", { className: "explore-row-label", textContent: item.name }),
              h("span", { className: "explore-row-path", textContent: `From: ${(item.source_labels || []).join(", ")}` })), h("span", { className: "saved-variable-action", textContent: "Choose" })),
          h("button", { type: "button", className: "btn btn--icon btn--ghost picker-saved-info",
            title: `Review ${item.name}`, attrs: { "aria-label": `Review definition of ${item.name}` },
            onclick: () => reusePreviousSplit(pick?.role || "candidate", item) }, "ⓘ"))))) : null,
      section(custom.length || previous.length ? "All other variables" : "Variables", builtIn),
      query && !groups.length ? h("div", { className: "explore-subsection-empty" }, clearButton()) : null);
    container.querySelectorAll("button[data-group-id]").forEach(button =>
      button.addEventListener("click", () => onChoose(button.dataset.groupId)));
    container.querySelector("button[data-clear-focus-search]")?.addEventListener("click", () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  }

  /** Identify: the list under the Cause, Outcome and Instrument fields while one is being searched. */
  function renderIdentifyPicker() {
    const container = document.getElementById("identifyGroupPicker");
    if (!container) return;
    const side = identifyPicking();
    if (!side || state.definitionDraft) { container.hidden = true; container.replaceChildren(); container.dataset.pickerSide = ""; return; }
    const newPicker = container.hidden || container.dataset.pickerSide !== side;
    const input = document.getElementById(`identify-${side}-input`);
    input?.closest(".identify-field")?.append(container);
    // A variable can play one role at a time, so the other roles' variables are left out.
    const exclude = new Set(["iv", "dv", "instrument"].filter(other => other !== side)
      .map(other => state.project?.[`${other}_group_id`]).filter(Boolean));
    const role = { iv: "cause", dv: "outcome", instrument: "instrument" }[side];
    renderPickerList(container, { query: normalized(input?.value || ""), input, exclude,
      pick: { title: `Choose ${role}`, action: `Use as ${role}`, role: side },
      onCancel: onCancelIdentify,
      onChoose: groupId => onChooseIdentify(side, groupId), onCreate: () => startDefinition?.(side) });
    container.dataset.pickerSide = side;
    if (newPicker) container.scrollTop = 0;
  }

  function renderGroupList() {
    // DAG2 always hides the legacy group list; avoid rebuilding its DOM on
    // every diagnostic filter change. A mode change renders it again.
    if (state.interfaceMode === "dag2") return;
    const model = groupListModel.buildGroupListModel(dagProjectView ? dagProjectView() : state.project, { candidateQueue: state.candidateQueue,
      sort: state.groupListSort, activeGroupId: state.activeGroupId, roleLabels });
    if (elements.groupListCount) elements.groupListCount.textContent = model.countText;
    replaceChildren(elements.groupList, model.rows.map(item => h("div", {
      className: `group-row${item.isActive ? " group-row-active" : ""}`, dataset: { groupId: item.groupId },
    }, h("div", { className: "group-row-head" }, h("strong", { textContent: item.label }),
      h("span", { className: "group-row-meta", textContent: `${item.variableCount} vars` })),
    item.roleLabels.length ? h("div", { className: "role-list" }, item.roleLabels.map(label => h("span", { className: "badge badge--info", textContent: label }))) : null,
    h("div", { className: "group-row-footer" }, h("span", { className: "group-role-label", textContent: item.anchorLabel }),
      h("button", { className: "btn btn--sm group-open-btn", type: "button", dataset: { action: "open" },
        disabled: state.publishedSchemaLoadFailed || (state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId)),
        title: state.publishedSchemaLoadFailed ? "This published schema could not be verified"
          : state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId)
            ? "This group's memberships are still loading" : "",
        textContent: state.publishedSchemaLoadFailed ? "Unavailable"
          : state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId) ? "Loading…" : "Open" })))));
    elements.groupList.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      const group = groupById(button.closest(".group-row").dataset.groupId);
      if (!group) return;
      beginEditor();
      Object.assign(state, workflow.transition(state, { type: "open-editor", groupId: group.group_id }));
      renderAll({ rebuild: false, refreshView: true });
    }));
  }

  function renderGroupingControls() {
    // A human-readable label is the primary name; the identifier is only a fallback.
    const setName = set => set.label || set.grouping_set_id;
    replaceChildren(elements.groupingSetSelect, (state.data.grouping_sets || []).map(set =>
      h("option", { value: set.grouping_set_id, textContent: setName(set), title: setName(set) })));
    elements.groupingSetSelect.value = state.project.active_grouping_set_id;
    const active = (state.data.grouping_sets || []).find(set => set.grouping_set_id === state.project.active_grouping_set_id) || (state.data.grouping_sets || [])[0];
    // The closed select truncates long names; its tooltip carries the full one.
    elements.groupingSetSelect.title = active ? setName(active) : "";
    const count = active?.groups?.length || 0;
    elements.groupingSummary.textContent = active
      ? `${count} variable ${count === 1 ? "group" : "groups"}`
      : "No schema loaded";
  }

  return { renderMode, renderAnchorBar, renderRightPanel, renderVariablePanel, hint, renderStatus, renderSetupPicker,
    renderSetupPickers() { renderSetupPicker("dv"); renderSetupPicker("iv"); renderSetupPicker("instrument"); renderFocusPicker(); renderIdentifyPicker(); },
    renderFocusPicker, renderIdentifyPicker,
    renderGroupList, renderGroupingControls };
}
