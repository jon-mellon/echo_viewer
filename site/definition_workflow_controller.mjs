import * as projectOps from "./dag_project.mjs";
import * as searchModel from "./dag_search.mjs";
import { h, replaceChildren } from "./dom_builder.mjs";

export function createDefinitionWorkflowController({ state, elements: els, activeGroup, clusterRep,
  invalidateMapCaches, renderAll, setMapMode, fitMap, groupById, persistProjectLocally,
  visibleVariables, searchVariables, clusterDisplayVariable, expandToClusterMembers, nowIso,
  applyProjectOperation, takeSnapshot, addToUndoHistory, clean, truncate, resizeMap }) {
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

  function renderDefinition() {
    const draft = state.definitionDraft;
    const wasSpatial = document.body.classList.contains("defining-variable");
    const isSpatial = Boolean(draft && draft.step !== "sources");
    document.body.classList.toggle("defining-variable", isSpatial);
    // The map is display:none in the normal DAG2 layout, so its initial canvas
    // backing store is 1x1. Resize only after the browser has laid out the
    // temporary spatial workspace, including when a saved draft is resumed.
    if (isSpatial && !wasSpatial) requestAnimationFrame(() => {
      resizeMap();
      fitMap(draft.eligible_variable_ids);
    });
    els.definitionBlock.hidden = !draft;
    if (!draft) return;
    els.definitionTitle.textContent = draft.mode === "edit" ? "Edit split"
      : `Define new ${draft.role.toUpperCase()}`;
    els.definitionSourcesStep.hidden = draft.step !== "sources";
    els.definitionPartitionStep.hidden = draft.step !== "partition";
    els.definitionReviewStep.hidden = draft.step !== "review";
    els.definitionBack.hidden = draft.mode === "edit";
    if (draft.step === "sources") {
      const query = normalized(els.definitionSourceSearch.value);
      const selected = new Set(draft.source_group_ids);
      const groups = (state.project.groups || []).map((group, index) =>
        searchModel.anchorGroupSearchMatch(group, query, index, state.variableById))
        .filter(item => item.group.variable_ids?.length && item.matches).slice(0, 60);
      replaceChildren(els.definitionSourceList, groups.map(({ group, variableMatch }) =>
        h("div", { className: "definition-source-row" }, h("label", {},
          h("span", { className: "definition-source-main" }, h("strong", { textContent: group.label || group.group_id }),
            h("span", { textContent: `${new Set(group.variable_ids.map(clusterRep)).size} canonical` })),
          variableMatch ? h("span", { className: "setup-group-variable-match", textContent: `Matched: ${truncate(variableMatch, 72)}` }) : null),
        h("input", { type: "checkbox", dataset: { sourceId: group.group_id }, checked: selected.has(group.group_id) }))));
      els.definitionSourceList.querySelectorAll("input[data-source-id]").forEach(input => input.addEventListener("change", () => {
        const ids = new Set(draft.source_group_ids);
        if (input.checked) ids.add(input.dataset.sourceId); else ids.delete(input.dataset.sourceId);
        draft.source_group_ids = [...ids];
        renderDefinition(); persistProjectLocally();
      }));
      const count = definitionSources().reduce((sum, group) =>
        sum + new Set(group.variable_ids.map(clusterRep)).size, 0);
      els.definitionContinue.disabled = !selected.size;
      els.definitionContinue.textContent = selected.size
        ? `Continue with ${selected.size} categories (${count} variables)` : "Choose categories to continue";
    } else if (draft.step === "partition") {
      const residualText = definitionSources().map(source =>
        `${source.label}: ${definitionResidualIds(source).length} leftover`).join(" · ");
      els.definitionCounts.textContent = `${draft.new_variable_ids.length} in new variable · ${residualText}`;
      els.definitionReview.disabled = !definitionCanReview();
      const selectedIds = new Set(draft.new_variable_ids);
      const matches = searchVariables(els.definitionVariableSearch.value, visibleVariables().length)
        .filter(variable => !selectedIds.has(clusterRep(variable.variable_id)))
        .slice(0, 30);
      replaceChildren(els.definitionVariableResults, matches.map(variable => {
        const id = clusterRep(variable.variable_id);
        return h("button", { className: "result-button", type: "button", dataset: { variableId: id } },
          h("strong", { textContent: variable.display_label || variable.concept_label || id }),
          h("span", { textContent: truncate(variable.raw_variable_text || variable.concept_label, 90) }),
          h("span", { textContent: "In leftover — click to add" }));
      }));
      els.definitionVariableResults.querySelectorAll("button[data-variable-id]").forEach(button =>
        button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.variableId)));
      replaceChildren(els.definitionSelectedVariables, draft.new_variable_ids.length
        ? draft.new_variable_ids.map(id => {
          const variable = clusterDisplayVariable(id) || state.variableById.get(id);
          return h("button", { className: "definition-selected-variable", type: "button", dataset: { selectedVariableId: id }, title: "Remove from new group" },
            h("span", { textContent: variable?.display_label || variable?.concept_label || id }), h("b", { textContent: "×" }));
        })
        : h("div", { className: "small-note", textContent: "No variables picked yet. Click a point, search result, or draw around variables." }));
      els.definitionSelectedVariables.querySelectorAll("button[data-selected-variable-id]").forEach(button =>
        button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.selectedVariableId, false)));
      const neighbors = definitionNeighbors();
      els.definitionAddNeighbors.disabled = !neighbors.length;
      replaceChildren(els.definitionNeighborResults, neighbors.map(neighbor => {
        const variable = clusterDisplayVariable(neighbor.variable_id) || state.variableById.get(neighbor.variable_id);
        return h("button", { className: "result-button", type: "button", dataset: { neighborId: neighbor.variable_id } },
          h("strong", { textContent: variable?.display_label || variable?.concept_label || neighbor.variable_id }),
          h("span", { textContent: `LLM rank ${neighbor.llm_rank || ""}; cosine ${Number(neighbor.cosine_similarity || 0).toFixed(3)}` }));
      }));
      els.definitionNeighborResults.querySelectorAll("button[data-neighbor-id]").forEach(button =>
        button.addEventListener("click", () => toggleDefinitionVariable(button.dataset.neighborId, true)));
    } else {
      els.definitionNewLabel.value = draft.new_label || "";
      replaceChildren(els.definitionReviewVariables, draft.new_variable_ids.map(id => {
        const variable = clusterDisplayVariable(id) || state.variableById.get(id);
        return h("div", { className: "definition-review-variable", textContent: variable?.display_label || variable?.concept_label || id });
      }));
      replaceChildren(els.definitionResidualLabels, definitionSources().map(source => {
        const inputId = `residual_${source.group_id}`;
        return h("div", { className: "definition-residual-row" },
          h("label", { className: "dag-label", htmlFor: inputId, textContent: `Leftover from ${source.label || source.group_id} (${definitionResidualIds(source).length})` }),
          h("input", { id: inputId, className: "search-input", dataset: { residualId: source.group_id }, value: draft.residual_labels[source.group_id] || "" }));
      }));
      els.definitionResidualLabels.querySelectorAll("input[data-residual-id]").forEach(input =>
        input.addEventListener("input", () => { draft.residual_labels[input.dataset.residualId] = input.value; persistProjectLocally(); }));
      const affected = draft.mode === "edit" ? [] : affectedDefinitionManualEdges();
      replaceChildren(els.definitionManualReview, affected.length ? [h("h3", { textContent: "Review affected manual records" }),
        affected.map(edge => h("div", { className: "definition-manual-row" },
          h("div", { textContent: `${groupById(edge.source_group_id)?.label || edge.source_group_id} → ${groupById(edge.target_group_id)?.label || edge.target_group_id}` }),
          h("select", { className: "select-input", dataset: { manualId: edge.edge_id } },
            h("option", { value: "keep", textContent: "Keep with leftover" }), h("option", { value: "move", textContent: "Move to new variable" }),
            h("option", { value: "remove", textContent: "Remove" }))))] : []);
      els.definitionManualReview.querySelectorAll("select[data-manual-id]").forEach(select => {
        select.value = draft.manual_edge_dispositions[select.dataset.manualId] || "keep";
        select.addEventListener("change", () => { draft.manual_edge_dispositions[select.dataset.manualId] = select.value; persistProjectLocally(); });
      });
      els.definitionSave.textContent = draft.mode === "edit" ? "Update split"
        : `Save and use as ${draft.role.toUpperCase()}`;
    }
  }

  function saveDefinition() {
    const draft = state.definitionDraft;
    if (!draft) return;
    draft.new_label = clean(els.definitionNewLabel.value);
    for (const input of els.definitionResidualLabels.querySelectorAll("input[data-residual-id]")) {
      draft.residual_labels[input.dataset.residualId] = clean(input.value);
    }
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
      els.definitionValidation.textContent = error?.message || String(error);
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

  return { startDefinition, startEditSplit, cancelDefinition, definitionSources, continueDefinition,
    definitionResidualIds, toggleDefinitionVariable, affectedDefinitionManualEdges,
    definitionCanReview, definitionNeighbors, renderDefinition, saveDefinition, installDefinitionHandlers };
}
