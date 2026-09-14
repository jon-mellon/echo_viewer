import * as projectOps from "./dag_project.mjs";
import { createDefinitionWorkflowPresenter } from "./definition_workflow_presenter.mjs";

export function createDefinitionWorkflowController({ state, elements: els, activeGroup, clusterRep,
  invalidateMapCaches, renderAll, setMapMode, fitMap, groupById, persistProjectLocally,
  visibleVariables, searchVariables, clusterDisplayVariable, expandToClusterMembers, nowIso,
  applyProjectOperation, takeSnapshot, addToUndoHistory, clean, normalized, truncate, resizeMap }) {
  function startDefinition(role) {
    if (state.interfaceMode !== "dag2" || !["iv", "dv"].includes(role)) return;
    state.definitionDraft = {
      role, step: "sources", source_group_ids: [], source_snapshot: [],
      eligible_variable_ids: [], new_variable_ids: [], new_label: "",
      residual_labels: {}, manual_edge_dispositions: {},
    };
    state.selectedVariableIds.clear();
    invalidateMapCaches();
    renderAll();
    els.definitionSourceSearch.focus();
  }

  function startEditSplit(groupId = null) {
    const context = projectOps.editableSplitContext(state.project, groupId ? groupId : activeGroup());
    if (!context) return;
    const { splitId, newGroup, residuals } = context;
    const eligible = [...new Set([...newGroup.variable_ids, ...residuals.flatMap(group => group.variable_ids)]
      .map(clusterRep))];
    state.definitionDraft = {
      mode: "edit", split_id: splitId, existing_new_group_id: newGroup.group_id,
      role: ["iv", "dv"].includes(newGroup.type) ? newGroup.type : null,
      step: "partition", source_group_ids: residuals.map(group => group.group_id),
      source_snapshot: [newGroup, ...residuals].map(group => ({ group_id: group.group_id,
        label: group.label, variable_ids: [...group.variable_ids], updated_at: group.updated_at || null })),
      eligible_variable_ids: eligible,
      new_variable_ids: [...new Set(newGroup.variable_ids.map(clusterRep))],
      new_label: newGroup.label || "",
      residual_labels: Object.fromEntries(residuals.map(group => [group.group_id, group.label || ""])),
      manual_edge_dispositions: {},
    };
    state.activeGroupId = null;
    state.selectedVariableIds = new Set(state.definitionDraft.new_variable_ids);
    invalidateMapCaches();
    setMapMode("select");
    renderAll();
    fitMap(eligible);
  }

  function cancelDefinition() {
    state.definitionDraft = null;
    state.selectedVariableIds.clear();
    state.selectedVariableId = null;
    invalidateMapCaches();
    setMapMode("select");
    renderAll();
  }

  function definitionSources() {
    const ids = new Set(state.definitionDraft?.source_group_ids || []);
    return (state.project?.groups || []).filter(group => ids.has(group.group_id));
  }

  function continueDefinition() {
    const draft = state.definitionDraft;
    const sources = definitionSources();
    if (!draft || !sources.length) return;
    draft.source_snapshot = sources.map(group => ({ group_id: group.group_id, label: group.label,
      variable_ids: [...group.variable_ids], updated_at: group.updated_at || null }));
    draft.eligible_variable_ids = [...new Set(sources.flatMap(group =>
      group.variable_ids.map(clusterRep)))];
    draft.new_variable_ids = [];
    draft.residual_labels = Object.fromEntries(sources.map(group =>
      [group.group_id, `Other: ${group.label || group.group_id}`]));
    draft.manual_edge_dispositions = Object.fromEntries(affectedDefinitionManualEdges()
      .map(edge => [edge.edge_id, "keep"]));
    draft.step = "partition";
    state.selectedVariableIds.clear();
    invalidateMapCaches();
    setMapMode("select");
    renderAll();
    fitMap(draft.eligible_variable_ids);
  }

  function definitionResidualIds(source) {
    const carved = new Set(state.definitionDraft?.new_variable_ids || []);
    return [...new Set(source.variable_ids.map(clusterRep))].filter(id => !carved.has(id));
  }

  function toggleDefinitionVariable(variableId, add = null) {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition") return;
    const id = clusterRep(variableId);
    if (!draft.eligible_variable_ids.includes(id)) return;
    const selected = new Set(draft.new_variable_ids);
    const shouldAdd = add === null ? !selected.has(id) : add;
    if (shouldAdd) selected.add(id); else selected.delete(id);
    draft.new_variable_ids = [...selected];
    state.selectedVariableIds = new Set(draft.new_variable_ids);
    state.selectedVariableId = id;
    invalidateMapCaches();
    renderAll();
  }

  function affectedDefinitionManualEdges() {
    const sources = new Set(state.definitionDraft?.source_group_ids || []);
    return (state.project?.manual_edges || []).filter(edge => !edge.deleted
      && (sources.has(edge.source_group_id) || sources.has(edge.target_group_id)));
  }

  function definitionCanReview() {
    const draft = state.definitionDraft;
    return Boolean(draft?.new_variable_ids?.length && definitionSources().every(source =>
      definitionResidualIds(source).length));
  }

  function definitionNeighbors() {
    const draft = state.definitionDraft;
    if (!draft?.new_variable_ids?.length) return [];
    const eligible = new Set(draft.eligible_variable_ids);
    const selected = new Set(draft.new_variable_ids);
    const best = new Map();
    for (const id of draft.new_variable_ids) {
      for (const neighbor of state.variableById.get(id)?.similarity_neighbors || []) {
        const rep = clusterRep(neighbor.variable_id);
        if (!eligible.has(rep) || selected.has(rep)) continue;
        const current = best.get(rep);
        if (!current || Number(neighbor.llm_rank || 99) < Number(current.llm_rank || 99)
            || Number(neighbor.cosine_similarity || 0) > Number(current.cosine_similarity || 0)) {
          best.set(rep, { ...neighbor, variable_id: rep });
        }
      }
    }
    return [...best.values()].sort((a, b) => Number(a.llm_rank || 99) - Number(b.llm_rank || 99)
      || Number(b.cosine_similarity || 0) - Number(a.cosine_similarity || 0)).slice(0, 12);
  }

  function setSourceSelection(sourceId, selected) {
    const ids = new Set(state.definitionDraft?.source_group_ids || []);
    if (selected) ids.add(sourceId); else ids.delete(sourceId);
    state.definitionDraft.source_group_ids = [...ids];
    persistProjectLocally();
    renderDefinition();
  }

  function setResidualLabel(groupId, label) {
    if (!state.definitionDraft) return;
    state.definitionDraft.residual_labels[groupId] = label;
    persistProjectLocally();
  }

  function setManualDisposition(edgeId, disposition) {
    if (!state.definitionDraft) return;
    state.definitionDraft.manual_edge_dispositions[edgeId] = disposition;
    persistProjectLocally();
  }

  function renderDefinition() { return presenter.render(); }

  function saveDefinition() {
    const draft = state.definitionDraft;
    if (!draft) return;
    draft.new_label = clean(draft.new_label);
    draft.residual_labels = Object.fromEntries(Object.entries(draft.residual_labels)
      .map(([groupId, label]) => [groupId, clean(label)]));
    try {
      for (const snap of draft.source_snapshot) {
        const current = groupById(snap.group_id);
        if (!current || JSON.stringify(current.variable_ids) !== JSON.stringify(snap.variable_ids)) {
          throw new Error(`Source category ${snap.label} changed while this definition was open.`);
        }
      }
      const before = takeSnapshot();
      const newGroupId = draft.existing_new_group_id || `g_split_${Date.now()}`;
      const operation = draft.mode === "edit" ? projectOps.updateSplitCategories : projectOps.splitCategories;
      const next = operation(state.project, {
        sourceGroupIds: draft.source_group_ids, newGroupId, newLabel: draft.new_label,
        residualLabels: draft.residual_labels,
        newVariableIds: expandToClusterMembers(draft.new_variable_ids), timestamp: nowIso(),
        role: draft.role, manualEdgeDispositions: draft.manual_edge_dispositions,
        splitId: draft.split_id,
      });
      applyProjectOperation(next);
      state.definitionDraft = null;
      state.selectedVariableIds.clear();
      state.activeGroupId = null;
      state.focusedGroupId = newGroupId;
      state.phase = "build";
      state.workflowMode = "group_review";
      state.changingAnchorSide = null;
      invalidateMapCaches();
      addToUndoHistory(draft.mode === "edit" ? `Updated split "${draft.new_label}"`
        : `Defined "${draft.new_label}" as ${draft.role.toUpperCase()}`, before);
      setMapMode("select");
      renderAll();
    } catch (error) {
      presenter.showValidationError(error);
    }
  }

  function installDefinitionHandlers() {
    els.definitionCancel.addEventListener("click", cancelDefinition);
    els.definitionSourceSearch.addEventListener("input", renderDefinition);
    els.definitionContinue.addEventListener("click", continueDefinition);
    els.definitionVariableSearch.addEventListener("input", renderDefinition);
    els.definitionAddNeighbors.addEventListener("click", () => {
      const selected = new Set(state.definitionDraft?.new_variable_ids || []);
      for (const neighbor of definitionNeighbors().slice(0, 8)) selected.add(neighbor.variable_id);
      state.definitionDraft.new_variable_ids = [...selected];
      state.selectedVariableIds = new Set(selected);
      invalidateMapCaches();
      renderAll();
    });
    els.definitionBack.addEventListener("click", () => {
      state.definitionDraft.step = "sources"; state.selectedVariableIds.clear();
      invalidateMapCaches(); renderAll();
    });
    els.definitionReview.addEventListener("click", () => {
      if (!definitionCanReview()) return;
      state.definitionDraft.step = "review"; renderAll();
    });
    els.definitionReviewBack.addEventListener("click", () => {
      state.definitionDraft.new_label = clean(els.definitionNewLabel.value);
      state.definitionDraft.step = "partition"; renderAll();
    });
    els.definitionNewLabel.addEventListener("input", () => {
      if (state.definitionDraft) state.definitionDraft.new_label = els.definitionNewLabel.value;
      persistProjectLocally();
    });
    els.definitionSave.addEventListener("click", saveDefinition);
  }

  const presenter = createDefinitionWorkflowPresenter({
    state, elements: els, normalized, clusterRep, truncate, definitionSources,
    definitionResidualIds, definitionCanReview, searchVariables, visibleVariables,
    clusterDisplayVariable, definitionNeighbors, affectedDefinitionManualEdges,
    groupById, resizeMap, fitMap, onSourceSelection: setSourceSelection,
    onToggleVariable: toggleDefinitionVariable, onResidualLabel: setResidualLabel,
    onManualDisposition: setManualDisposition,
  });

  return { startDefinition, startEditSplit, cancelDefinition, definitionSources, continueDefinition,
    definitionResidualIds, toggleDefinitionVariable, affectedDefinitionManualEdges,
    definitionCanReview, definitionNeighbors, renderDefinition, saveDefinition, installDefinitionHandlers };
}
