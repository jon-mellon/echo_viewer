import * as groupListModel from "./dag_group_list.mjs";
import * as searchModel from "./dag_search.mjs";
import * as workflow from "./dag_workflow.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function dag2AnchorPickerIsActive(state, side, groupById) {
  const iv = groupById(state.project?.iv_group_id);
  const dv = groupById(state.project?.dv_group_id);
  const ivSet = Boolean(iv?.variable_ids?.length);
  const dvSet = Boolean(dv?.variable_ids?.length);
  const changingIv = state.changingAnchorSide === "iv";
  const changingDv = state.changingAnchorSide === "dv";
  return side === "iv"
    ? !ivSet || changingIv
    : ivSet && (!dvSet || changingDv) && !changingIv;
}

export function createDagSetupGroupController({
  state, elements, escapeHtml, normalized, truncate, groupById,
  assignGroupAsAnchor, setMapMode, renderAll, roleLabels, dagProjectView, startDefinition,
  canEditSplit = () => false,
}) {
  function renderMode() {
    if (state.interfaceMode === "dag2") {
      elements.setupSection.hidden = false;
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
    const ivSet = Boolean(iv?.variable_ids?.length), dvSet = Boolean(dv?.variable_ids?.length);
    const show = (state.interfaceMode === "dag2" || state.workflowMode !== "setup") && (ivSet || dvSet);
    elements.anchorBar.hidden = !show;
    if (!show) return;
    elements.anchorDvLabel.textContent = dvSet ? dv.label : "not set";
    elements.anchorIvLabel.textContent = ivSet ? iv.label : "not set";
    elements.anchorDvLabel.title = dvSet ? dv.label : "";
    elements.anchorIvLabel.title = ivSet ? iv.label : "";
    if (elements.editSplitIv) elements.editSplitIv.hidden = !ivSet || !canEditSplit(iv);
    if (elements.editSplitDv) elements.editSplitDv.hidden = !dvSet || !canEditSplit(dv);
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

  function hint() {
    const hints = {
      select_dv: "Search the existing groups for the outcome, or choose Define new group to build a new dependent-variable group from raw variables.",
      define_dv: "Use Draw + / Draw − to adjust the dependent-variable group boundary. Confirm when the group is substantively correct.",
      select_iv: "Search the existing groups for the independent variable, or choose Define new group to build a new group from raw variables.",
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
        elements.schemaChoice.hidden = true;
        return;
      }
      const iv = groupById(state.project?.iv_group_id), dv = groupById(state.project?.dv_group_id);
      const ivSet = Boolean(iv?.variable_ids?.length), dvSet = Boolean(dv?.variable_ids?.length);
      const changingIv = state.changingAnchorSide === "iv";
      const changingDv = state.changingAnchorSide === "dv";
      elements.currentStepTitle.textContent = !ivSet || changingIv
        ? "Select independent variable"
        : !dvSet || changingDv ? "Select dependent variable" : "Working causal map";
      elements.dagStatusBadge.textContent = ivSet && dvSet ? "Ready" : ivSet ? "Select DV" : "Select IV";
      elements.dagStatusBadge.className = `status-pill${ivSet && dvSet ? " muted" : ""}`;
      elements.workflowHint.textContent = !ivSet || changingIv
        ? "Choose the independent-variable group from the default schema."
        : !dvSet || changingDv
          ? "Choose the dependent-variable group."
          : "The overall DAG is ready.";
      elements.ivSearchBlock.hidden = ivSet && !changingIv;
      elements.dvSearchBlock.hidden = !ivSet || (dvSet && !changingDv) || changingIv;
      elements.schemaChoice.hidden = true;
      return;
    }
    if (state.workflowMode !== "setup") {
      elements.dagStatusBadge.textContent = state.workflowMode === "group_review" ? "Groups" : "Build";
      elements.dagStatusBadge.className = "status-pill muted";
      return;
    }
    const labels = { select_dv: "Select DV", define_dv: "Define DV", select_iv: "Select IV",
      define_iv: "Define IV", schema_choice: "Schema", build: "Build map" };
    const titles = { select_dv: "Select dependent variable",
      define_dv: "Define dependent-variable group", select_iv: "Select independent variable",
      define_iv: "Define independent-variable group", schema_choice: "Load candidate grouping schema?", build: "Build causal map" };
    elements.currentStepTitle.textContent = titles[state.phase] || "Build causal map";
    elements.dagStatusBadge.textContent = labels[state.phase] || "Build";
    elements.dagStatusBadge.className = "status-pill";
    elements.workflowHint.textContent = hint();
    elements.dvSearchBlock.hidden = state.phase !== "select_dv";
    elements.ivSearchBlock.hidden = state.phase !== "select_iv";
    elements.schemaChoice.hidden = state.phase !== "schema_choice";
  }

  function renderSetupPicker(side) {
    const container = side === "dv" ? elements.dvGroupPicker : elements.ivGroupPicker;
    if (!container) return;
    const pickerIsActive = state.interfaceMode === "dag2"
      ? dag2AnchorPickerIsActive(state, side, groupById)
      : state.workflowMode === "setup" && state.phase === `select_${side}`;
    if (state.definitionDraft || !pickerIsActive) {
      container.hidden = true; container.replaceChildren(); return;
    }
    const input = side === "dv" ? elements.dvInput : elements.ivInput;
    const label = side === "dv" ? elements.dvInputLabel : elements.ivInputLabel;
    const toggle = side === "dv" ? elements.dvDefineNew : elements.ivDefineNew;
    const isNew = state.anchorSearchMode[side] === "new";
    label.textContent = isNew ? "Search raw variables" : "Search existing groups";
    toggle.textContent = isNew ? "Back to existing groups" : "Define new group";
    input.placeholder = isNew ? (side === "dv" ? "Income, prejudice, labor-market outcome" : "Education, religiosity, parental status") : "Search group or constituent variable";
    if (isNew) { container.hidden = true; container.replaceChildren(); return; }
    const searchProject = dagProjectView ? dagProjectView() : state.project;
    const groups = searchModel.searchAnchorGroups(searchProject, side, normalized(input.value), state.variableById);
    container.hidden = false;
    if (!groups.length) {
      replaceChildren(container, h("div", { className: "setup-group-picker-title", textContent: "No matching existing groups" }));
      return;
    }
    const rows = groups.map(({ group, variableMatch }) => h("div", { className: "setup-group-picker-row" },
      h("div", {}, h("strong", { textContent: group.label || group.group_id }),
        h("span", { textContent: `${group.variable_ids?.length || 0} vars` }),
        variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched variable: ${truncate(variableMatch, 86)}` }) : null),
      h("button", { className: "action-button", type: "button", dataset: { side, groupId: group.group_id }, textContent: `Use as ${side.toUpperCase()}` })));
    rows.push(h("div", { className: "setup-group-picker-row define-new-row" },
      h("div", {}, h("strong", { textContent: "Define new variable…" }), h("span", { textContent: "Chop one or more existing categories in the spatial viewer" })),
      h("button", { className: "action-button", type: "button", dataset: { defineSide: side }, textContent: "Define" })));
    replaceChildren(container, h("div", { className: "setup-group-picker-title", textContent: "Existing groups" }),
      h("div", { className: "setup-group-picker-list" }, rows));
    container.querySelectorAll("button[data-group-id]").forEach(button =>
      button.addEventListener("click", () => assignGroupAsAnchor(button.dataset.side, button.dataset.groupId)));
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

  return { renderMode, renderAnchorBar, renderRightPanel, hint, renderStatus, renderSetupPicker,
    renderSetupPickers() { renderSetupPicker("dv"); renderSetupPicker("iv"); }, renderGroupList, renderGroupingControls };
}
