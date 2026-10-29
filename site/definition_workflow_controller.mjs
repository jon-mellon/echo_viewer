import * as projectOps from "./dag_project.mjs";
import { createDefinitionWorkflowPresenter } from "./definition_workflow_presenter.mjs";
import { nearbyMapNeighbors } from "./definition_neighbors.mjs";
import { createDefinitionJevAssist } from "./definition_jev_assist.mjs";
import { browsePublishedSplits, loadPublishedSplitMembership } from "./published_split_browser.mjs";

export function createDefinitionWorkflowController({ state, elements: els, activeGroup, clusterRep,
  invalidateMapCaches, renderAll, drawMap = () => {}, renderAssignmentCoverage = () => {}, setMapMode, fitMap, groupById, persistProjectLocally, getReturnUrl = () => location.href,
  visibleVariables, searchVariables, clusterDisplayVariable, expandToClusterMembers, nowIso,
  applyProjectOperation, takeSnapshot, addToUndoHistory, clean, normalized, truncate, resizeMap,
  hydrateVariableDetails = async () => {}, hydrateNeighbors = async () => {},
  prewarmEvidence = async () => {}, commitSchema = async () => {},
  onCommitFailureRestored = () => {}, onInstrumentReady = () => {} }) {
  let hydrationRevision = 0;
  const sourceHydrations = new Map();
  let lastBatch = null;
  let browseRevision = 0;
  const browseState = { rows: [], loading: false, error: "" };
  async function refreshBrowse() {
    const revision = ++browseRevision;
    browseState.rows = [];
    browseState.error = "";
    browseState.loading = Boolean(state.definitionDraft?.source_group_ids?.length);
    renderDefinition();
    if (!browseState.loading) return;
    try {
      const rows = await browsePublishedSplits(state.definitionDraft.source_group_ids);
      if (revision !== browseRevision || state.definitionMethod !== "browse") return;
      browseState.rows = rows;
    } catch (error) {
      if (revision !== browseRevision || state.definitionMethod !== "browse") return;
      browseState.error = `Could not browse splits: ${error.message || error}`;
    }
    browseState.loading = false;
    renderDefinition();
  }
  async function choosePublishedSplit(row) {
    if (!row || browseState.loading || state.definitionDraft?.step !== "sources") return;
    const draft = state.definitionDraft;
    browseState.loading = true;
    browseState.error = "Loading the published assignments…";
    renderDefinition();
    try {
      const ids = await loadPublishedSplitMembership(row);
      if (state.definitionDraft !== draft) return;
      const sources = definitionSources();
      const eligible = new Set(sources.flatMap(group => group.variable_ids));
      if (!ids.length || ids.some(id => !eligible.has(id))
        || sources.some(group => group.variable_ids.every(id => ids.includes(id)))) {
        throw new Error("This split does not fit the current source category assignments.");
      }
      state.definitionMethod = "manual";
      await continueDefinition();
      if (state.definitionDraft !== draft) return;
      if (draft.step !== "partition") {
        state.definitionMethod = "browse";
        throw new Error("Could not load the current source variables.");
      }
      draft.new_variable_ids = [...new Set(ids.map(clusterRep))];
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      draft.new_label = row.name;
      draft.new_description = row.description;
      // A published split keeps its name and description; each leftover keeps
      // its source category's name, so the split is used without a naming step.
      draft.published_split = { publication_id: row.publication_id, group_id: row.group_id };
      draft.residual_labels = Object.fromEntries(sources.map(group => [group.group_id, group.label || group.group_id]));
      state.selectedVariableIds = new Set(draft.new_variable_ids);
      persistProjectLocally();
      invalidateMapCaches();
      renderDraft({ redrawMap: true });
    } catch (error) {
      if (state.definitionDraft === draft) {
        browseState.error = `Could not use this split: ${error.message || error}`;
        browseState.loading = false;
        renderDefinition();
      }
    }
  }
  const renderDraft = ({ redrawMap = false } = {}) => {
    // Definition steps change selection and map contents, not the project DAG.
    // The DAG is hidden until cancel/save, where a full render is performed.
    renderAll({ rebuild: false });
    renderAssignmentCoverage();
    jevAssist.render();
    if (redrawMap) drawMap();
  };

  function startDefinition(role) {
    if (state.interfaceMode !== "dag2" || !["iv", "dv", "instrument", "candidate"].includes(role)) return;
    jevAssist.clearPreview();
    state.definitionMethod = null;
    browseRevision += 1;
    browseState.rows = [];
    browseState.error = "";
    browseState.loading = false;
    // Start the query engine while the user chooses a source. The source load
    // still awaits this setup and reports any error through its normal path.
    void prewarmEvidence().catch(() => {});
    hydrationRevision += 1;
    sourceHydrations.clear();
    lastBatch = null;
    state.definitionDraft = {
      role, step: "sources", source_group_ids: [], source_snapshot: [],
      eligible_variable_ids: [], new_variable_ids: [], new_label: "", new_description: "",
      residual_labels: {}, reviewed_variable_ids: [],
    };
    state.selectedVariableIds.clear();
    invalidateMapCaches();
    renderDraft();
    els.definitionChooseManual.focus();
  }

  async function startEditSplit(groupId = null) {
    lastBatch = null;
    const context = projectOps.editableSplitContext(state.project, groupId ? groupId : activeGroup());
    if (!context) return;
    jevAssist.clearPreview();
    state.definitionMethod = "manual";
    const { splitId, newGroup, residuals } = context;
    const eligible = [...new Set([...newGroup.variable_ids, ...residuals.flatMap(group => group.variable_ids)]
      .map(clusterRep))];
    const revision = ++hydrationRevision;
    const draft = state.definitionDraft = {
      mode: "edit", split_id: splitId, existing_new_group_id: newGroup.group_id,
      role: ["iv", "dv"].includes(newGroup.type) ? newGroup.type : null,
      step: "partition", source_group_ids: residuals.map(group => group.group_id),
      source_snapshot: [newGroup, ...residuals].map(group => ({ group_id: group.group_id,
        label: group.label, variable_ids: [...group.variable_ids], updated_at: group.updated_at || null })),
      eligible_variable_ids: eligible,
      new_variable_ids: [...new Set(newGroup.variable_ids.map(clusterRep))],
      reviewed_variable_ids: eligible,
      new_label: newGroup.label || "",
      new_description: newGroup.description || "",
      residual_labels: Object.fromEntries(residuals.map(group => [group.group_id, group.label || ""])),
      details_loading: true,
    };
    state.activeGroupId = null;
    state.selectedVariableIds = new Set(state.definitionDraft.new_variable_ids);
    invalidateMapCaches();
    setMapMode("select");
    renderDraft();
    fitMap(eligible);
    try {
      await hydrateVariableDetails(eligible, { skipNeighbors: true });
    } catch (error) {
      if (revision === hydrationRevision && state.definitionDraft === draft) {
        draft.details_error = error?.message || String(error);
      }
    }
    if (revision !== hydrationRevision || state.definitionDraft !== draft) return;
    draft.details_loading = false;
    invalidateMapCaches();
    renderDraft({ redrawMap: true });
    fitMap(eligible);
  }

  function cancelDefinition() {
    browseRevision += 1;
    hydrationRevision += 1;
    lastBatch = null;
    jevAssist.clearPreview();
    state.definitionDraft = null;
    state.definitionMethod = null;
    state.selectedVariableIds.clear();
    state.selectedVariableId = null;
    invalidateMapCaches();
    setMapMode("select");
    renderAll({ rebuild: false, refreshView: true });
  }

  function definitionSources() {
    const ids = new Set(state.definitionDraft?.source_group_ids || []);
    return (state.project?.groups || []).filter(group => ids.has(group.group_id));
  }

  async function continueDefinition() {
    const draft = state.definitionDraft;
    const sources = definitionSources();
    if (!draft || draft.details_loading || !state.definitionMethod || !sources.length) return;
    lastBatch = null;
    const revision = ++hydrationRevision;
    draft.source_snapshot = sources.map(group => ({ group_id: group.group_id, label: group.label,
      variable_ids: [...group.variable_ids], updated_at: group.updated_at || null }));
    draft.eligible_variable_ids = [...new Set(sources.flatMap(group =>
      group.variable_ids.map(clusterRep)))];
    draft.new_variable_ids = [];
    draft.reviewed_variable_ids = [];
    draft.residual_labels = Object.fromEntries(sources.map(group =>
      [group.group_id, `Other: ${group.label || group.group_id}`]));
    draft.details_loading = true;
    state.selectedVariableIds.clear();
    presenter.setContinueLoading();
    try {
      await Promise.all(sources.map(source => sourceHydrations.get(source.group_id)
        || hydrateVariableDetails(source.variable_ids)));
    } catch (error) {
      if (revision === hydrationRevision && state.definitionDraft === draft) {
        draft.details_loading = false;
        renderDefinition();
        presenter.showLoadError(error);
      }
      return;
    }
    if (revision !== hydrationRevision || state.definitionDraft !== draft) return;
    draft.details_loading = false;
    draft.step = "partition";
    invalidateMapCaches();
    setMapMode("select");
    renderDraft();
    fitMap(draft.eligible_variable_ids);
  }

  function definitionResidualIds(source) {
    const carved = new Set(state.definitionDraft?.new_variable_ids || []);
    return [...new Set(source.variable_ids.map(clusterRep))].filter(id => !carved.has(id));
  }

  function toggleDefinitionVariable(variableId, add = null) {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition" || state.definitionMethod !== "manual") return;
    const id = clusterRep(variableId);
    if (!draft.eligible_variable_ids.includes(id)) return;
    lastBatch = null;
    const selected = new Set(draft.new_variable_ids);
    const shouldAdd = add === null ? !selected.has(id) : add;
    if (shouldAdd) selected.add(id); else selected.delete(id);
    draft.new_variable_ids = [...selected];
    draft.reviewed_variable_ids = [...new Set([...(draft.reviewed_variable_ids || []), id])];
    state.selectedVariableIds = new Set(draft.new_variable_ids);
    state.selectedVariableId = id;
    invalidateMapCaches();
    renderDraft({ redrawMap: true });
  }

  function batchMoveDefinitionVariables(ids, add) {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition") return;
    const eligible = new Set(draft.eligible_variable_ids);
    const selected = new Set(draft.new_variable_ids);
    const reviewed = new Set(draft.reviewed_variable_ids || []);
    const changed = [...new Set(ids)].filter(id => eligible.has(id)
      && (selected.has(id) !== add || !reviewed.has(id)));
    if (!changed.length) return;
    lastBatch = new Map(changed.map(id => [id, { selected: selected.has(id), reviewed: reviewed.has(id) }]));
    for (const id of changed) {
      if (add) selected.add(id); else selected.delete(id);
      reviewed.add(id);
    }
    draft.new_variable_ids = [...selected];
    draft.reviewed_variable_ids = [...reviewed];
    state.selectedVariableIds = new Set(selected);
    invalidateMapCaches();
    renderDraft({ redrawMap: true });
  }

  function undoDefinitionBatch() {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition" || !lastBatch) return;
    const selected = new Set(draft.new_variable_ids);
    const reviewed = new Set(draft.reviewed_variable_ids || []);
    for (const [id, previous] of lastBatch) {
      if (previous.selected) selected.add(id); else selected.delete(id);
      if (previous.reviewed) reviewed.add(id); else reviewed.delete(id);
    }
    lastBatch = null;
    draft.new_variable_ids = [...selected];
    draft.reviewed_variable_ids = [...reviewed];
    state.selectedVariableIds = new Set(selected);
    invalidateMapCaches();
    renderDraft({ redrawMap: true });
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
    // Some source groups have no similarity links between their members. Keep
    // nearby suggestions useful by falling back to the displayed map layout.
    if (!best.size) return nearbyMapNeighbors(eligible, selected, state.variableById);
    return [...best.values()].sort((a, b) => Number(a.llm_rank || 99) - Number(b.llm_rank || 99)
      || Number(b.cosine_similarity || 0) - Number(a.cosine_similarity || 0)).slice(0, 12);
  }

  function setSourceSelection(sourceId, selected) {
    const ids = new Set(state.definitionDraft?.source_group_ids || []);
    if (selected) ids.add(sourceId); else ids.delete(sourceId);
    state.definitionDraft.source_group_ids = [...ids];
    persistProjectLocally();
    renderDefinition();
    if (state.definitionMethod === "browse") void refreshBrowse();
    if (selected && !sourceHydrations.has(sourceId)) {
      const source = groupById(sourceId);
      if (source?.variable_ids?.length) {
        const loading = hydrateVariableDetails(source.variable_ids);
        sourceHydrations.set(sourceId, loading);
        // Continue will await this same promise; handle cancellation separately.
        void loading.catch(() => sourceHydrations.delete(sourceId));
      }
    }
  }

  function setResidualLabel(groupId, label) {
    if (!state.definitionDraft) return;
    state.definitionDraft.residual_labels[groupId] = label;
    persistProjectLocally();
  }

  function renderDefinition() {
    const draft = state.definitionDraft;
    if (draft?.step === "partition" && !draft.details_loading && draft.new_variable_ids?.length
      && !(draft.mode === "edit" && draft.new_variable_ids.length > 40)) {
      void hydrateNeighbors(draft.new_variable_ids)
        .catch(error => console.warn("Could not load variable neighbor suggestions.", error));
    }
    presenter.render();
    jevAssist.render();
  }

  async function saveDefinition() {
    const draft = state.definitionDraft;
    if (!draft) return;
    draft.new_label = clean(draft.new_label);
    draft.new_description = clean(draft.new_description || "");
    if ([...draft.new_description].length < 20) {
      showSaveError(new Error("Group definition must be at least 20 characters. Please add more detail."));
      els.definitionNewDescription.setAttribute("aria-invalid", "true");
      els.definitionNewDescription.focus();
      return;
    }
    draft.residual_labels = Object.fromEntries(Object.entries(draft.residual_labels)
      .map(([groupId, label]) => [groupId, clean(label)]));
    const previousProject = structuredClone(state.project);
    const previousCompiledDag = state.compiledDag ? structuredClone(state.compiledDag) : null;
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
        newDescription: draft.new_description,
        residualLabels: draft.residual_labels,
        newVariableIds: expandToClusterMembers(draft.new_variable_ids), timestamp: nowIso(),
        role: draft.role,
        splitId: draft.split_id,
      });
      applyProjectOperation(next);
      await commitSchema();
      if (draft.role === "instrument") {
        state.showExclusionViolations = true;
        state.showExogeneity = false;
        state.showConfoundersOnly = false;
        state.showCollidersOnly = false;
      }
      state.definitionDraft = null;
      state.selectedVariableIds.clear();
      state.activeGroupId = null;
      state.focusedGroupId = newGroupId;
      if (draft.role === "candidate") state.pendingVariablePanelGroupId = newGroupId;
      const initialAnchor = draft.mode !== "edit" && !state.changingAnchorSide;
      state.phase = initialAnchor && draft.role === "iv" ? "select_dv"
        : initialAnchor && draft.role === "dv" ? "select_instrument" : "build";
      state.workflowMode = state.phase === "build" ? "group_review" : "setup";
      state.changingAnchorSide = null;
      invalidateMapCaches();
      addToUndoHistory(draft.mode === "edit" ? `Updated split "${draft.new_label}"`
        : draft.role === "candidate" ? `Defined variable "${draft.new_label}"`
          : `Defined "${draft.new_label}" as ${draft.role.toUpperCase()}`, before);
      setMapMode("select");
      renderAll();
      if (draft.role === "instrument") onInstrumentReady();
    } catch (error) {
      state.compiledDagRevision = (state.compiledDagRevision || 0) + 1;
      state.compiledDag = previousCompiledDag;
      state.compiledDagUpdating = false;
      state.project = previousProject;
      onCommitFailureRestored();
      invalidateMapCaches();
      renderDraft({ redrawMap: true });
      showSaveError(error);
    }
  }

  // Validation messages live on the review step, which a published split skips.
  function showSaveError(error) {
    const draft = state.definitionDraft;
    if (draft && draft.step !== "review") { draft.step = "review"; renderDraft(); }
    presenter.showValidationError(error);
  }

  function installDefinitionHandlers() {
    jevAssist.install();
    const chooseInitialMethod = method => {
      if (state.definitionDraft?.step !== "sources") return;
      browseRevision += 1;
      state.definitionMethod = method;
      renderDraft();
      if (method === "browse") void refreshBrowse();
      (method ? els.definitionSourceSearch : els.definitionChooseManual).focus();
    };
    els.definitionChooseJev.addEventListener("click", () => chooseInitialMethod("jev"));
    els.definitionChooseManual.addEventListener("click", () => chooseInitialMethod("manual"));
    els.definitionChooseBrowse.addEventListener("click", () => chooseInitialMethod("browse"));
    els.definitionChangeMethod.addEventListener("click", () => chooseInitialMethod(null));
    els.definitionAiChangeMethod.addEventListener("click", () => chooseInitialMethod(null));
    const chooseMethod = method => {
      if (state.definitionDraft?.step !== "partition" || state.definitionMethod === method) return;
      state.definitionMethod = method;
      delete state.definitionDraft.published_split;
      if (state.map) state.map._groupRegions = null;
      renderDraft({ redrawMap: true });
    };
    els.definitionMethodJev.addEventListener("click", () => chooseMethod("jev"));
    els.definitionMethodManual.addEventListener("click", () => chooseMethod("manual"));
    els.definitionCancel.addEventListener("click", cancelDefinition);
    els.definitionSourceSearch.addEventListener("input", renderDefinition);
    els.definitionContinue.addEventListener("click", continueDefinition);
    els.definitionVariableSearch.addEventListener("input", renderDefinition);
    els.definitionTermToNew.addEventListener("click", () => batchMoveDefinitionVariables(presenter.selectedTermIds(), true));
    els.definitionTermToLeftover.addEventListener("click", () => batchMoveDefinitionVariables(presenter.selectedTermIds(), false));
    els.definitionTermPrev.addEventListener("click", () => presenter.changeTermPage(-1));
    els.definitionTermNext.addEventListener("click", () => presenter.changeTermPage(1));
    els.definitionUndoBatch.addEventListener("click", undoDefinitionBatch);
    els.definitionAddNeighbors.addEventListener("click", () => {
      const selected = new Set(state.definitionDraft?.new_variable_ids || []);
      const added = definitionNeighbors().slice(0, 8).map(neighbor => neighbor.variable_id);
      for (const id of added) selected.add(id);
      state.definitionDraft.new_variable_ids = [...selected];
      state.definitionDraft.reviewed_variable_ids = [...new Set([
        ...(state.definitionDraft.reviewed_variable_ids || []), ...added,
      ])];
      state.selectedVariableIds = new Set(selected);
      invalidateMapCaches();
      renderDraft({ redrawMap: true });
    });
    els.definitionBack.addEventListener("click", () => {
      state.definitionDraft.step = "sources"; state.selectedVariableIds.clear();
      delete state.definitionDraft.published_split;
      invalidateMapCaches(); renderDraft();
    });
    els.definitionReview.addEventListener("click", () => {
      if (!definitionCanReview()) return;
      if (state.definitionDraft.published_split) { void saveDefinition(); return; }
      state.definitionDraft.step = "review"; renderDraft();
    });
    els.definitionReviewBack.addEventListener("click", () => {
      state.definitionDraft.new_label = clean(els.definitionNewLabel.value);
      state.definitionDraft.new_description = clean(els.definitionNewDescription.value);
      state.definitionDraft.step = "partition"; renderDraft({ redrawMap: true });
    });
    els.definitionNewLabel.addEventListener("input", () => {
      if (state.definitionDraft) state.definitionDraft.new_label = els.definitionNewLabel.value;
      persistProjectLocally();
    });
    els.definitionNewDescription.addEventListener("input", () => {
      if (state.definitionDraft) state.definitionDraft.new_description = els.definitionNewDescription.value;
      presenter.clearDescriptionValidation();
      persistProjectLocally();
    });
    els.definitionSave.addEventListener("click", saveDefinition);
  }

  async function resumeAfterOAuth() {
    const oauthDraft = jevAssist.takeResumeDraft();
    const checkpointDraft = !oauthDraft && !state.definitionDraft
      ? await jevAssist.latestResumeDraft().catch(error => {
        console.warn("Could not read saved Jev draft.", error);
        return null;
      }) : null;
    const draft = oauthDraft || state.definitionDraft || checkpointDraft;
    if (!draft || !["sources", "partition"].includes(draft.step) || !Array.isArray(draft.eligible_variable_ids)) return;
    // A source-step draft is resumed here only when it belongs to the OAuth
    // handoff. Startup may otherwise race with a newly opened manual draft.
    if (draft.step === "sources" && !oauthDraft) return;
    state.definitionMethod = "jev";
    if (!draft.source_snapshot?.every(snap => {
      const current = groupById(snap.group_id);
      return current && JSON.stringify(current.variable_ids) === JSON.stringify(snap.variable_ids);
    })) return;
    if (oauthDraft || checkpointDraft) {
      state.definitionDraft = draft;
      state.selectedVariableIds = new Set(draft.new_variable_ids || []);
    }
    if (draft.step === "sources") { renderDraft(); return; }
    try { await hydrateVariableDetails(draft.eligible_variable_ids); }
    catch (error) { console.warn("Could not reload all split variable details.", error); }
    invalidateMapCaches();
    setMapMode("select");
    renderDraft();
    fitMap(draft.eligible_variable_ids);
    try { await jevAssist.restoreForDraft({ force: true }); }
    catch (error) { console.warn("Could not restore saved Jev progress.", error); }
  }

  const presenter = createDefinitionWorkflowPresenter({
    state, elements: els, normalized, clusterRep, truncate, definitionSources,
    definitionResidualIds, definitionCanReview, searchVariables, visibleVariables,
    clusterDisplayVariable, definitionNeighbors,
    resizeMap, fitMap, onSourceSelection: setSourceSelection,
    onToggleVariable: toggleDefinitionVariable, onResidualLabel: setResidualLabel,
    canUndoBatch: () => Boolean(lastBatch),
    browseState, onChoosePublishedSplit: choosePublishedSplit,
  });

  const jevAssist = createDefinitionJevAssist({ elements: els,
    getDraft: () => state.definitionDraft,
    getVariable: id => clusterDisplayVariable(id) || state.variableById.get(id),
    persistDraft: persistProjectLocally, getReturnUrl,
    onConnectionChange: ready => { state.definitionAiReady = ready; if (state.project && state.definitionDraft) renderDraft(); },
    onPreviewChange: (ids, mode) => {
      state.definitionAiPreviewIds = ids ? new Set(ids) : null;
      presenter.setJevPreviewStatus(ids, mode);
      // The positions and visible variables are unchanged; only group regions move.
      if (state.map) state.map._groupRegions = null;
      drawMap();
    },
    onApply: (ids, description) => {
      const draft = state.definitionDraft;
      if (!draft || draft.step !== "partition") return;
      state.definitionMethod = "manual";
      lastBatch = null;
      draft.new_variable_ids = ids;
      draft.new_description = description;
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      state.selectedVariableIds = new Set(ids);
      invalidateMapCaches();
      persistProjectLocally();
      renderDraft({ redrawMap: true });
    },
  });

  return { startDefinition, startEditSplit, cancelDefinition, definitionSources, continueDefinition,
    definitionResidualIds, toggleDefinitionVariable,
    definitionCanReview, definitionNeighbors, renderDefinition, saveDefinition, installDefinitionHandlers,
    resumeAfterOAuth };
}
