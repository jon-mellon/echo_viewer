import * as groupListModel from "./dag_group_list.mjs";
import * as searchModel from "./dag_search.mjs";
import * as workflow from "./dag_workflow.mjs";

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
      select_uoa: "Choose the unit of analysis for your study. Variables will be filtered to match. You can change this at any time.",
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
        elements.uoaSearchBlock.hidden = true;
        elements.schemaChoice.hidden = true;
        return;
      }
      const iv = groupById(state.project?.iv_group_id), dv = groupById(state.project?.dv_group_id);
      const ivSet = Boolean(iv?.variable_ids?.length), dvSet = Boolean(dv?.variable_ids?.length);
      const changingIv = state.changingAnchorSide === "iv";
      const changingDv = state.changingAnchorSide === "dv";
      elements.currentStepTitle.textContent = !ivSet || changingIv
        ? "Select independent variable"
        : !dvSet || changingDv ? "Select dependent variable" : "Optional UOA filter";
      elements.dagStatusBadge.textContent = ivSet && dvSet ? "Ready" : ivSet ? "Select DV" : "Select IV";
      elements.dagStatusBadge.className = `status-pill${ivSet && dvSet ? " muted" : ""}`;
      elements.workflowHint.textContent = !ivSet || changingIv
        ? "Choose the independent-variable group from the default schema."
        : !dvSet || changingDv
          ? "Choose the dependent-variable group."
          : "The overall DAG is ready. Optionally limit groups and evidence to a unit of analysis.";
      elements.ivSearchBlock.hidden = ivSet && !changingIv;
      elements.dvSearchBlock.hidden = !ivSet || (dvSet && !changingDv) || changingIv;
      elements.uoaSearchBlock.hidden = !(ivSet && dvSet) || changingIv || changingDv;
      elements.schemaChoice.hidden = true;
      return;
    }
    if (state.workflowMode !== "setup") {
      elements.dagStatusBadge.textContent = state.workflowMode === "group_review" ? "Groups" : "Build";
      elements.dagStatusBadge.className = "status-pill muted";
      return;
    }
    const labels = { select_uoa: "UOA", select_dv: "Select DV", define_dv: "Define DV", select_iv: "Select IV",
      define_iv: "Define IV", schema_choice: "Schema", build: "Build map" };
    const titles = { select_uoa: "Select unit of analysis", select_dv: "Select dependent variable",
      define_dv: "Define dependent-variable group", select_iv: "Select independent variable",
      define_iv: "Define independent-variable group", schema_choice: "Load candidate grouping schema?", build: "Build causal map" };
    elements.currentStepTitle.textContent = titles[state.phase] || "Build causal map";
    elements.dagStatusBadge.textContent = labels[state.phase] || "Build";
    elements.dagStatusBadge.className = "status-pill";
    elements.workflowHint.textContent = hint();
    elements.uoaSearchBlock.hidden = state.phase !== "select_uoa";
    elements.dvSearchBlock.hidden = state.phase !== "select_dv";
    elements.ivSearchBlock.hidden = state.phase !== "select_iv";
    elements.schemaChoice.hidden = state.phase !== "schema_choice";
  }

  function renderSetupPicker(side) {
    const container = side === "dv" ? elements.dvGroupPicker : elements.ivGroupPicker;
    if (!container) return;
    if (state.definitionDraft || state.workflowMode !== "setup" || state.phase !== `select_${side}`) {
      container.hidden = true; container.innerHTML = ""; return;
    }
    const input = side === "dv" ? elements.dvInput : elements.ivInput;
    const label = side === "dv" ? elements.dvInputLabel : elements.ivInputLabel;
    const toggle = side === "dv" ? elements.dvDefineNew : elements.ivDefineNew;
    const isNew = state.anchorSearchMode[side] === "new";
    label.textContent = isNew ? "Search raw variables" : "Search existing groups";
    toggle.textContent = isNew ? "Back to existing groups" : "Define new group";
    input.placeholder = isNew ? (side === "dv" ? "Income, prejudice, labor-market outcome" : "Education, religiosity, parental status") : "Search group or constituent variable";
    if (isNew) { container.hidden = true; container.innerHTML = ""; return; }
    const searchProject = dagProjectView ? dagProjectView() : state.project;
    const groups = searchModel.searchAnchorGroups(searchProject, side, normalized(input.value), state.variableById);
    container.hidden = false;
    if (!groups.length) { container.innerHTML = `<div class="setup-group-picker-title">No matching existing groups</div>`; return; }
    container.innerHTML = `<div class="setup-group-picker-title">Existing groups</div><div class="setup-group-picker-list">${groups.map(({ group, variableMatch }) => `<div class="setup-group-picker-row"><div><strong>${escapeHtml(group.label || group.group_id)}</strong><span>${escapeHtml(String(group.variable_ids?.length || 0))} vars</span>${variableMatch ? `<span class="setup-group-variable-match">Matched variable: ${escapeHtml(truncate(variableMatch, 86))}</span>` : ""}</div><button class="action-button" type="button" data-side="${side}" data-group-id="${escapeHtml(group.group_id)}">Use as ${side.toUpperCase()}</button></div>`).join("")}<div class="setup-group-picker-row define-new-row"><div><strong>Define new variable…</strong><span>Chop one or more existing categories in the spatial viewer</span></div><button class="action-button" type="button" data-define-side="${side}">Define</button></div></div>`;
    container.querySelectorAll("button[data-group-id]").forEach(button =>
      button.addEventListener("click", () => assignGroupAsAnchor(button.dataset.side, button.dataset.groupId)));
    container.querySelector("button[data-define-side]")?.addEventListener("click", event =>
      startDefinition?.(event.currentTarget.dataset.defineSide));
  }

  function renderGroupList() {
    const model = groupListModel.buildGroupListModel(dagProjectView ? dagProjectView() : state.project, { candidateQueue: state.candidateQueue,
      sort: state.groupListSort, activeGroupId: state.activeGroupId, roleLabels });
    if (elements.groupListCount) elements.groupListCount.textContent = model.countText;
    elements.groupList.innerHTML = model.rows.map(item => `<div class="group-row ${item.isActive ? "group-row-active" : ""}" data-group-id="${escapeHtml(item.groupId)}"><div class="group-row-head"><strong>${escapeHtml(item.label)}</strong><span class="group-row-meta">${escapeHtml(item.variableCount)} vars</span></div>${item.roleLabels.length ? `<div class="role-list">${item.roleLabels.map(label => `<span class="role-pill">${escapeHtml(label)}</span>`).join("")}</div>` : ""}<div class="group-row-footer"><span class="group-role-label">${item.anchorLabel}</span><button class="action-button group-open-btn" type="button" data-action="open">Open</button></div></div>`).join("");
    elements.groupList.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      const group = groupById(button.closest(".group-row").dataset.groupId);
      if (!group) return;
      Object.assign(state, workflow.transition(state, { type: "open-editor", groupId: group.group_id }));
      setMapMode("select"); renderAll();
    }));
  }

  function renderGroupingControls() {
    elements.groupingSetSelect.innerHTML = (state.data.grouping_sets || []).map(set => `<option value="${escapeHtml(set.grouping_set_id)}">${escapeHtml(set.label || set.grouping_set_id)}</option>`).join("");
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
