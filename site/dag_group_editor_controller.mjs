import * as projectOps from "./dag_project.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";
import * as groupEditorModel from "./dag_group_editor.mjs";
import * as searchModel from "./dag_search.mjs";
import * as workflow from "./dag_workflow.mjs";

export function createDagGroupEditorController({
  state, elements: els, applyProjectOperation, groupById, takeSnapshot,
  expandToClusterMembers, nowIso, clean, setMapMode, fitNeighborhood, fitMap,
  addToUndoHistory, renderAll, addDecision, setWorkflowMode, groupedVariableIds,
  searchVariables, clusterMemberIds, rejectedVariableIdSet, uoaMatches,
  fitSearchContext, applyActiveGroupingSet, rebuildProject, createDensityCandidateGroup,
  escapeHtml, truncate,
}) {
function beginTargetGroup(side) {
  const isDv = side === "dv";
  const groupId = `g_${side}_${Date.now()}`;
  const input = isDv ? els.dvInput : els.ivInput;
  const before = takeSnapshot();
  const seeds = [...state.seeds[side]];
  const seedMembers = expandToClusterMembers(seeds);

  const group = ensureGroup({
    group_id: groupId,
    label: clean(input.value) || seedLabel(side) || (isDv ? "Dependent variable" : "Independent variable"),
    variable_ids: seedMembers,
    seed_variable_ids: seedMembers.slice(),
    excluded_nearby_variable_ids: [],
    boundary_geometry: { polygons: [] },
    notes: "",
    type: null,
    source_grouping_set_id: "",
    source_group_id: "",
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  resolveGroupMembershipConflicts(group);
  Object.assign(state, workflow.transition(state, { type: "open-editor", groupId, side }));
  setMapMode("select");
  fitNeighborhood(seeds);
  addToUndoHistory("Create target group", before);
  renderAll();
}

function promoteGroupToAnchor(side, groupId) {
  const next = projectOps.promoteAnchor(state.project, side, groupId, nowIso());
  if (next === state.project) return false;
  applyProjectOperation(next);
  return true;
}

function assignGroupAsAnchor(side, sourceGroupId) {
  const source = groupById(sourceGroupId);
  if (!source || !source.variable_ids?.length) return;
  const currentGroupId = side === "dv" ? state.project.dv_group_id : state.project.iv_group_id;
  if (sourceGroupId === currentGroupId) {
    Object.assign(state, workflow.transition(state, { type: "anchor-selected", side, groupId: sourceGroupId, alreadyCurrent: true }));
    setMapMode("select");
    fitMap(source.variable_ids);
    renderAll();
    return;
  }
  const before = takeSnapshot();
  const variableIds = (source.variable_ids || []).slice();
  const label = clean(source.label) || (side === "dv" ? "Dependent variable" : "Independent variable");
  if (!promoteGroupToAnchor(side, sourceGroupId)) return;
  Object.assign(state, workflow.transition(state, { type: "anchor-selected", side, groupId: sourceGroupId }));
  setMapMode("select");
  addDecision(`group_promoted_to_${side}`, { source_group_id: sourceGroupId, target_group_id: sourceGroupId });
  addToUndoHistory(`Use "${label}" as ${side.toUpperCase()}`, before);
  fitMap(variableIds);
  renderAll();
}

function seedLabel(side) {
  const first = [...state.seeds[side]][0];
  const v = state.variableById.get(first);
  return v?.concept_label || v?.display_label || "";
}

function ensureGroup(group) {
  applyProjectOperation(projectOps.upsertGroup(state.project, group, nowIso()));
  return groupById(group.group_id);
}

function activeGroup() {
  if (!state.activeGroupId) return null;
  return state.project.groups.find((g) => g.group_id === state.activeGroupId) || null;
}

function createCustomGroup() {
  const before = takeSnapshot();
  const groupId = `g_custom_${Date.now()}`;
  ensureGroup({
    group_id: groupId,
    label: "New group",
    variable_ids: [],
    excluded_nearby_variable_ids: [],
    boundary_geometry: { polygons: [] },
    notes: "",
    type: null,
    source_grouping_set_id: "",
    source_group_id: "",
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  Object.assign(state, workflow.transition(state, { type: "open-editor", groupId }));
  setMapMode("select");
  addToUndoHistory("Create group", before);
  if (state.workflowMode === "setup") setWorkflowMode("group_review");
  renderAll();
  setTimeout(() => { els.groupLabelInput?.focus(); els.groupLabelInput?.select(); }, 60);
}

function closeGroupEditor() {
  Object.assign(state, workflow.transition(state, { type: "close-editor" }));
  setMapMode("select");
  renderAll();
}

// ─── Group editor (right panel) ───────────────────────────────────────────────

function renderGroupEditor() {
  const group = activeGroup();
  if (!group) return;

  const model = groupEditorModel.buildGroupEditorModel(group, {
    variables: state.variableById, workflowMode: state.workflowMode, phase: state.phase,
  });
  els.groupEditorTitle.textContent = model.title;
  els.useGroupAsAnchor.hidden = !model.choosingAnchor;
  els.useGroupAsAnchor.textContent = model.anchorButtonLabel;
  els.groupEditorHint.textContent = model.hint;
  if (els.editSplit) {
    els.editSplit.hidden = !projectOps.editableSplitContext(state.project, group);
  }
  els.groupLabelInput.value = model.label;
  els.groupNotesInput.value = model.notes;
  // Reset the in-editor add-search when a different group is opened.
  if (els.groupSeedInput.dataset.groupId !== group.group_id) {
    els.groupSeedInput.value = "";
    els.groupSeedInput.dataset.groupId = group.group_id;
  }

  replaceChildren(els.includedVariables, model.members.map(({ variableId, title, label }) =>
    h("span", { className: "chip", title }, truncate(label, 42),
      h("button", { type: "button", dataset: { variableId }, textContent: "×" })),
  ));
  els.includedVariables.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const before = takeSnapshot();
      removeVariableFromGroup(group, btn.dataset.variableId);
      addToUndoHistory(`Removed variable from "${group.label}"`, before);
      renderAll();
    });
  });

  renderGroupSeedSearch();
  renderNeighborSuggestions(group);
}

// In-editor search to add any variable (its whole duplicate cluster) to the open group.
// Available for every group — including IV/DV, which is how "Change IV/DV" lets a user
// swap the anchor variable without restarting Setup.
function renderGroupSeedSearch() {
  if (!els.groupSeedInput) return;
  const group = activeGroup();
  const query = els.groupSeedInput.value.trim();
  const blockedIds = groupedVariableIds();
  const matches = group && query
    ? searchVariables(query, 18)
      .filter((v) => !clusterMemberIds(v.variable_id).some((id) => blockedIds.has(id)))
      .slice(0, 12)
    : [];
  replaceChildren(els.groupSeedResults, matches.map(v => h("button", {
    className: "result-button", type: "button", dataset: { variableId: v.variable_id },
  }, h("strong", { textContent: v.display_label || v.concept_label }),
  h("span", { textContent: truncate(v.raw_variable_text || v.concept_label, 100) }),
  h("span", { textContent: v.paper_id || "unknown paper" }))));
  els.groupSeedResults.querySelectorAll(".result-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = activeGroup();
      if (!g) return;
      const before = takeSnapshot();
      const had = new Set(g.variable_ids);
      addVariableToGroup(g, btn.dataset.variableId);
      state.selectedVariableId = btn.dataset.variableId;
      if (g.variable_ids.some((id) => !had.has(id))) {
        addToUndoHistory(`Added variable to "${g.label}"`, before);
      }
      els.groupSeedInput.value = "";
      renderAll();
      fitNeighborhood([btn.dataset.variableId]);
    });
  });
}

function renderNeighborSuggestions(group) {
  const suggestions = groupNeighborSuggestions(group, 14);
  replaceChildren(els.neighborSuggestions, suggestions.map((item) => {
    const v = state.variableById.get(item.variable_id);
    return h("button", { className: "result-button", type: "button", dataset: { variableId: item.variable_id } },
      h("strong", { textContent: v?.display_label || item.variable_id }),
      h("span", { textContent: truncate(v?.raw_variable_text || v?.concept_label || "", 100) }),
      h("span", { textContent: `LLM rank ${item.llm_rank || ""}; cosine ${Number(item.cosine_similarity || 0).toFixed(3)}` }));
  }));
  els.neighborSuggestions.querySelectorAll(".result-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const before = takeSnapshot();
      addVariableToGroup(group, btn.dataset.variableId);
      addToUndoHistory(`Added variable to "${group.label}"`, before);
      renderAll();
    });
  });
}

function groupNeighborSuggestions(group, limit) {
  return searchModel.groupNeighborSuggestions(group, {
    variableById: state.variableById, blockedIds: groupedVariableIds(), clusterMemberIds,
    rejectedIds: rejectedVariableIdSet(), selectedUoa: state.selectedUoa,
    uoaFilterEnabled: state.uoaFilterEnabled, uoaMatches,
  }, limit);
}

function addVariableToGroup(group, variableId) {
  if (!variableId || !state.variableById.has(variableId)) return;
  applyProjectOperation(projectOps.addMembers(state.project, group.group_id, clusterMemberIds(variableId), nowIso()));
}

function addVariableSetToGroup(group, variableIds) {
  for (const variableId of variableIds || []) addVariableToGroup(group, variableId);
}

function removeVariableFromGroup(group, variableId) {
  applyProjectOperation(projectOps.removeMembers(state.project, group.group_id, clusterMemberIds(variableId), nowIso()));
}

function addTopNeighborsToActiveGroup() {
  const group = activeGroup();
  if (!group) return;
  const before = takeSnapshot();
  for (const neighbor of groupNeighborSuggestions(group, 8)) addVariableToGroup(group, neighbor.variable_id);
  addToUndoHistory(`Added neighbors to "${group.label}"`, before);
  renderAll();
}

function groupSeedIds(group) {
  return projectOps.protectedSeedIds(group, state.seeds);
}

function removeTopNeighborsFromActiveGroup() {
  const group = activeGroup();
  if (!group) return;
  const before = takeSnapshot();
  const protectedSeeds = groupSeedIds(group);
  applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, {
    variable_ids: group.variable_ids.filter(id => protectedSeeds.has(id)), updated_at: nowIso(),
  }));
  addToUndoHistory(`Removed non-seed variables from "${group.label}"`, before);
  renderAll();
}

function clearActiveGroupVariables() {
  const group = activeGroup();
  if (!group) return;
  const before = takeSnapshot();
  applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, { variable_ids: [], updated_at: nowIso() }));
  addToUndoHistory(`Cleared all variables from "${group.label}"`, before);
  renderAll();
}

function selectActiveAnchor() {
  if (state.workflowMode !== "setup" || !["define_iv", "define_dv"].includes(state.phase)) return;
  const side = state.phase === "define_dv" ? "dv" : "iv";
  const group = activeGroup();
  if (!group) return;
  if (!group.variable_ids.length) {
    window.alert("A group must contain at least one variable.");
    return;
  }
  const before = takeSnapshot();
  if (!promoteGroupToAnchor(side, group.group_id)) return;
  applyProjectOperation(projectOps.updateGroup(state.project, group.group_id, {
    label: clean(els.groupLabelInput.value) || group.label || "Unnamed group",
    notes: els.groupNotesInput.value, updated_at: nowIso(),
  }));

  Object.assign(state, workflow.transition(state, {
    type: "anchor-selected", side, groupId: group.group_id, fromEditor: true,
  }));
  setMapMode("select");
  if (state.phase === "select_iv") {
    els.ivInput.focus();
    if (state.searchMatches.iv.length) fitSearchContext("iv");
  }
  addDecision("anchor_selected", { group_id: group.group_id, variable_ids: group.variable_ids.slice() });
  addToUndoHistory(`Use "${group.label}" as ${group.type.toUpperCase()}`, before);
  renderAll();
}

function resolveGroupMembershipConflicts(group) {
  const conflicts = projectOps.membershipConflicts(state.project.groups, group);
  if (!conflicts.length) return;
  const move = window.confirm(`${conflicts.length} variable(s) are already in other groups. Move them into "${group.label}"? Cancel keeps existing assignments.`);
  for (const { groupId, variableId } of conflicts) {
    removeVariableFromGroup(move ? groupById(groupId) : group, variableId);
  }
}

function finishSchemaChoice(loadSchema) {
  Object.assign(state, workflow.transition(state, { type: "finish-schema" }));
  if (loadSchema) {
    state.filterDagByCausalRelevance = true;
    state.showConfoundersOnly = false;
    state.showCollidersOnly = false;
    state.confounderMaxPathLength = 1;
    state.excludeBottleneckedConfounders = true;
    state.hideIrrelevantConfounderLinks = true;
    applyActiveGroupingSet();
    rebuildProject();
    const firstCandidate = state.candidateQueue[0];
    if (firstCandidate) {
      Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: firstCandidate.group_id }));
      fitMap(groupById(firstCandidate.group_id)?.variable_ids || []);
    }
  } else {
    const group = createDensityCandidateGroup();
    if (group) {
      Object.assign(state, workflow.transition(state, { type: "open-editor", groupId: group.group_id }));
      setMapMode("select");
      fitMap(group.variable_ids);
    }
  }
  renderAll();
}

// ─── Grouping set management ──────────────────────────────────────────────────


  return {
    beginTargetGroup, promoteGroupToAnchor, assignGroupAsAnchor, seedLabel,
    ensureGroup, activeGroup, createCustomGroup, closeGroupEditor, renderGroupEditor,
    renderGroupSeedSearch, renderNeighborSuggestions, groupNeighborSuggestions,
    addVariableToGroup, addVariableSetToGroup, removeVariableFromGroup,
    addTopNeighborsToActiveGroup, groupSeedIds, removeTopNeighborsFromActiveGroup,
    clearActiveGroupVariables, selectActiveAnchor, resolveGroupMembershipConflicts,
    finishSchemaChoice,
  };
}
