import * as groupListModel from "./dag_group_list.mjs";
import * as searchModel from "./dag_search.mjs";
import * as workflow from "./dag_workflow.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function dag2AnchorPickerIsActive(state, side, groupById) {
  const iv = groupById(state.project?.iv_group_id);
  const dv = groupById(state.project?.dv_group_id);
  const ivSet = anchorHasMembers(state, iv);
  const dvSet = anchorHasMembers(state, dv);
  const changingIv = state.changingAnchorSide === "iv";
  const changingDv = state.changingAnchorSide === "dv";
  if (side === "instrument") return ivSet && dvSet
    && state.changingAnchorSide === "instrument";
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
  assignGroupAsAnchor, assignGroupAsInstrument, setMapMode, renderAll,
  roleLabels, dagProjectView, startDefinition,
  canEditSplit = () => false, searchAnchorGroups = searchModel.searchAnchorGroups,
}) {
  function renderMode() {
    if (state.interfaceMode === "dag2") {
      const iv = groupById(state.project?.iv_group_id);
      const dv = groupById(state.project?.dv_group_id);
      elements.setupSection.hidden = anchorHasMembers(state, iv) && anchorHasMembers(state, dv)
        && !state.changingAnchorSide && !state.definitionDraft;
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

  function renderVariablePanel() {
    if (!elements.variablePanel) return;
    const project = state.project;
    const iv = groupById(state.project?.iv_group_id);
    const dv = groupById(state.project?.dv_group_id);
    const show = state.interfaceMode === "dag2" && anchorHasMembers(state, iv)
      && anchorHasMembers(state, dv) && !state.definitionDraft;
    elements.variablePanel.hidden = !show;
    if (!show) return;
    const groups = (project?.groups || []).slice()
      .sort((a, b) => (a.label || a.group_id).localeCompare(b.label || b.group_id));
    elements.variablePanelCount.textContent = String(groups.length);
    const openIds = new Set([...elements.variablePanelList.querySelectorAll("details[open]")]
      .map(detail => detail.dataset.groupId));
    const scrollTop = elements.variablePanelList.scrollTop;
    replaceChildren(elements.variablePanelList, groups.map(group =>
      h("details", { className: "variable-panel-item", dataset: { groupId: group.group_id }, open: openIds.has(group.group_id) },
        h("summary", {}, h("span", { textContent: group.label || group.group_id }),
          group.group_id === project.iv_group_id ? h("span", { className: "variable-panel-role", textContent: "IV" }) : null,
          group.group_id === project.dv_group_id ? h("span", { className: "variable-panel-role", textContent: "DV" }) : null,
          group.group_id === project.instrument_group_id ? h("span", { className: "variable-panel-role", textContent: "Instrument" }) : null),
        h("p", { textContent: group.description || "No definition available." }))));
    elements.variablePanelList.scrollTop = scrollTop;
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
          : `Define new ${state.definitionDraft.role.toUpperCase()}`;
        elements.dagStatusBadge.textContent = state.definitionDraft.step === "sources" ? "Sources"
          : state.definitionDraft.step === "partition" ? "Construct" : "Review";
        elements.dagStatusBadge.className = "status-pill";
        elements.workflowHint.textContent = state.definitionDraft.step === "sources"
          ? "Choose the existing categories whose canonical variables should be available."
          : "Only canonical variables from the selected categories are available in the spatial view.";
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
      const changingInstrument = state.changingAnchorSide === "instrument" && ivSet && dvSet;
      elements.currentStepTitle.textContent = !ivSet || changingIv
        ? "Select independent variable"
        : !dvSet || changingDv ? "Select dependent variable"
          : changingInstrument ? "Select instrument (optional)" : "Working causal map";
      elements.dagStatusBadge.textContent = changingInstrument ? "Instrument"
        : ivSet && dvSet ? "Ready" : ivSet ? "Select DV" : "Select IV";
      elements.dagStatusBadge.className = `status-pill${ivSet && dvSet && !changingInstrument ? " muted" : ""}`;
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
      elements.dagStatusBadge.className = "status-pill muted";
      return;
    }
    const labels = { select_dv: "Select DV", define_dv: "Define DV", select_iv: "Select IV",
      select_instrument: "Instrument",
      define_iv: "Define IV", schema_choice: "Schema", build: "Build map" };
    const titles = { select_dv: "Select dependent variable",
      select_instrument: "Select instrument (optional)",
      define_dv: "Define dependent-variable group", select_iv: "Select independent variable",
      define_iv: "Define independent-variable group", schema_choice: "Load candidate grouping schema?", build: "Build causal map" };
    elements.currentStepTitle.textContent = titles[state.phase] || "Build causal map";
    elements.dagStatusBadge.textContent = labels[state.phase] || "Build";
    elements.dagStatusBadge.className = "status-pill";
    elements.workflowHint.textContent = hint();
    elements.dvSearchBlock.hidden = state.phase !== "select_dv";
    elements.ivSearchBlock.hidden = state.phase !== "select_iv";
    elements.instrumentSearchBlock.hidden = state.phase !== "select_instrument";
    elements.schemaChoice.hidden = state.phase !== "schema_choice";
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
      h("div", {}, h("strong", { textContent: "Define a group" }), h("span", { textContent: "Chop one or more existing categories in the spatial viewer" })),
      h("button", { className: "action-button", type: "button", dataset: { defineSide: side }, textContent: "Define" }));
    const noneRow = side === "instrument" ? h("div", { className: "setup-group-picker-row" },
      h("div", {}, h("strong", { textContent: "None" }),
        h("span", { textContent: "Work without an instrument" })),
      h("button", { className: "action-button", type: "button",
        dataset: { selectNone: "true" }, textContent: "Use None" })) : null;
    const rows = groups.map(({ group, variableMatch }) => h("div", { className: "setup-group-picker-row" },
      h("div", {}, h("strong", { textContent: group.label || group.group_id }),
        h("span", { textContent: `${group.variable_ids?.length || 0} vars` }),
        variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched variable: ${truncate(variableMatch, 86)}` }) : null,
        group.description ? h("details", { className: "setup-group-definition" },
          h("summary", { textContent: "Definition" }),
          h("p", { textContent: group.description })) : null),
      h("button", { className: "action-button", type: "button", dataset: { side, groupId: group.group_id },
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
    replaceChildren(container, h("div", { className: "setup-group-picker-title", textContent: title }),
      h("div", { className: "setup-group-picker-list" }, noneRow, defineRow, ...rows));
    container.querySelectorAll("button[data-group-id]").forEach(button =>
      button.addEventListener("click", () => button.dataset.side === "instrument"
        ? assignGroupAsInstrument(button.dataset.groupId)
        : assignGroupAsAnchor(button.dataset.side, button.dataset.groupId)));
    container.querySelector("button[data-select-none]")?.addEventListener("click", () => assignGroupAsInstrument(null));
    container.querySelector("button[data-define-side]")?.addEventListener("click", event =>
      startDefinition?.(event.currentTarget.dataset.defineSide));
  }

  function renderGroupList() {
    const model = groupListModel.buildGroupListModel(dagProjectView ? dagProjectView() : state.project, { candidateQueue: state.candidateQueue,
      sort: state.groupListSort, activeGroupId: state.activeGroupId, roleLabels });
    if (elements.groupListCount) elements.groupListCount.textContent = model.countText;
    replaceChildren(elements.groupList, model.rows.map(item => h("div", {
      className: `group-row${item.isActive ? " group-row-active" : ""}`, dataset: { groupId: item.groupId },
    }, h("div", { className: "group-row-head" }, h("strong", { textContent: item.label }),
      h("span", { className: "group-row-meta", textContent: `${item.variableCount} vars` })),
    item.roleLabels.length ? h("div", { className: "role-list" }, item.roleLabels.map(label => h("span", { className: "role-pill", textContent: label }))) : null,
    h("div", { className: "group-row-footer" }, h("span", { className: "group-role-label", textContent: item.anchorLabel }),
      h("button", { className: "action-button group-open-btn", type: "button", dataset: { action: "open" },
        disabled: state.publishedSchemaLoadFailed || (state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId)),
        title: state.publishedSchemaLoadFailed ? "This published schema could not be verified"
          : state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId)
            ? "This group's memberships are still loading" : "",
        textContent: state.publishedSchemaLoadFailed ? "Unavailable"
          : state.publishedSchemaHydrating && !state.publishedMembershipReadyGroups.has(item.groupId) ? "Loading…" : "Open" })))));
    elements.groupList.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      const group = groupById(button.closest(".group-row").dataset.groupId);
      if (!group) return;
      Object.assign(state, workflow.transition(state, { type: "open-editor", groupId: group.group_id }));
      setMapMode("select"); renderAll();
    }));
  }

  function renderGroupingControls() {
    replaceChildren(elements.groupingSetSelect, (state.data.grouping_sets || []).map(set =>
      h("option", { value: set.grouping_set_id, textContent: set.label || set.grouping_set_id })));
    elements.groupingSetSelect.value = state.project.active_grouping_set_id;
    const active = (state.data.grouping_sets || []).find(set => set.grouping_set_id === state.project.active_grouping_set_id) || (state.data.grouping_sets || [])[0];
    elements.groupingSummary.textContent = active
      ? state.interfaceMode === "dag2"
        ? `${active.groups?.length || 0} groups loaded. Import a compatible JSON schema to replace this view.`
        : `${active.groups?.length || 0} groups available; import to view all groups, or load the groups relevant to an IV/DV setup.`
      : "No schema loaded. Import a schema or create groups manually.";
  }

  return { renderMode, renderAnchorBar, renderRightPanel, renderVariablePanel, hint, renderStatus, renderSetupPicker,
    renderSetupPickers() { renderSetupPicker("dv"); renderSetupPicker("iv"); renderSetupPicker("instrument"); },
    renderGroupList, renderGroupingControls };
}
