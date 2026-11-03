import * as projectOps from "./dag_project.mjs";
import { createDefinitionWorkflowPresenter } from "./definition_workflow_presenter.mjs";
import { nearbyMapNeighbors } from "./definition_neighbors.mjs";
import { createDefinitionJevAssist } from "./definition_jev_assist.mjs";
import { browsePublishedSplits, loadPublishedSplitMembership } from "./published_split_browser.mjs";

export function createDefinitionWorkflowController({ state, elements: els, activeGroup, clusterRep,
  invalidateMapCaches, renderAll, drawMap = () => {}, renderAssignmentCoverage = () => {}, setMapMode, fitMap, groupById, persistProjectLocally, getReturnUrl = () => location.href,
  visibleVariables, searchVariables, searchSourceGroups = groups => groups.map((group, index) => ({ group, index, variableMatch: "" })),
  clusterDisplayVariable, expandToClusterMembers, nowIso,
  applyProjectOperation, takeSnapshot, addToUndoHistory, clean, normalized, truncate, resizeMap,
  hydrateVariableDetails = async () => {}, hydrateNeighbors = async () => {},
  prewarmEvidence = async () => {}, commitSchema = async () => {},
  onCommitFailureRestored = () => {}, onInstrumentReady = () => {}, onFocusDefined = null }) {
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
      if (revision !== browseRevision || state.definitionDraft?.step !== "sources") return;
      browseState.rows = rows;
    } catch (error) {
      if (revision !== browseRevision || state.definitionDraft?.step !== "sources") return;
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
      if (draft.step !== "partition") throw new Error("Could not load the current source variables.");
      // The published split supplies which concepts move; the name and
      // definition stay the ones the user wrote in the first step.
      draft.new_variable_ids = [...new Set(ids.map(clusterRep))];
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      draft.published_split = { publication_id: row.publication_id, group_id: row.group_id };
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
    state.definitionMethod = "manual";
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
      role, step: "describe", source_group_ids: [], source_snapshot: [],
      eligible_variable_ids: [], new_variable_ids: [], new_label: "", new_description: "",
      ai_description: "", residual_labels: {}, reviewed_variable_ids: [],
    };
    state.selectedVariableIds.clear();
    invalidateMapCaches();
    renderDraft();
    els.definitionNewLabel.focus();
    void renderSavedRuns();
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
      ai_description: newGroup.description || "",
      ai_description_source: newGroup.description || "",
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
    if (!draft || draft.details_loading || !sources.length) return;
    state.definitionMethod ||= "manual";
    lastBatch = null;
    const revision = ++hydrationRevision;
    draft.source_snapshot = sources.map(group => ({ group_id: group.group_id, label: group.label,
      variable_ids: [...group.variable_ids], updated_at: group.updated_at || null }));
    draft.eligible_variable_ids = [...new Set(sources.flatMap(group =>
      group.variable_ids.map(clusterRep)))];
    draft.new_variable_ids = [];
    draft.reviewed_variable_ids = [];
    // What stays behind keeps its variable's name unless the user renames it.
    draft.residual_labels = Object.fromEntries(sources.map(group =>
      [group.group_id, group.label || group.group_id]));
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

  /**
   * Classify concepts as included ("in"), excluded ("out") or back to
   * unreviewed ("clear"). Every manual change goes through here, so the last
   * one can always be undone.
   */
  function classifyDefinitionVariables(ids, side) {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition") return;
    const eligible = new Set(draft.eligible_variable_ids);
    const selected = new Set(draft.new_variable_ids);
    const reviewed = new Set(draft.reviewed_variable_ids || []);
    const wantSelected = side === "in";
    const wantReviewed = side !== "clear";
    const changed = [...new Set(ids.map(clusterRep))].filter(id => eligible.has(id)
      && (selected.has(id) !== wantSelected || reviewed.has(id) !== wantReviewed));
    if (!changed.length) return;
    lastBatch = new Map(changed.map(id => [id, { selected: selected.has(id), reviewed: reviewed.has(id) }]));
    for (const id of changed) {
      if (wantSelected) selected.add(id); else selected.delete(id);
      if (wantReviewed) reviewed.add(id); else reviewed.delete(id);
    }
    draft.new_variable_ids = [...selected];
    draft.reviewed_variable_ids = [...reviewed];
    state.selectedVariableIds = new Set(selected);
    if (changed.length === 1) state.selectedVariableId = changed[0];
    persistProjectLocally();
    invalidateMapCaches();
    renderDraft({ redrawMap: true });
  }

  // The map toggles one point at a time; `add` forces a side.
  function toggleDefinitionVariable(variableId, add = null) {
    const draft = state.definitionDraft;
    if (!draft || draft.step !== "partition" || state.definitionMethod !== "manual") return;
    const id = clusterRep(variableId);
    const shouldAdd = add === null ? !draft.new_variable_ids.includes(id) : add;
    classifyDefinitionVariables([id], shouldAdd ? "in" : "out");
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
    persistProjectLocally();
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
    void refreshBrowse();
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

  /** Why the name and definition cannot be used yet, or "" when they can. */
  function describeError(draft = state.definitionDraft) {
    const label = clean(draft?.new_label);
    if (!label) return "Name the new variable.";
    const description = clean(draft?.new_description);
    if ([...description].length < 20) return "Write a definition of at least 20 characters.";
    const own = draft.existing_new_group_id;
    const taken = (state.project?.groups || []).some(group => group.group_id !== own
      && clean(group.label).toLowerCase() === label.toLowerCase());
    return taken ? `Another variable is already called “${label}”.` : "";
  }

  function goToStep(step) {
    const draft = state.definitionDraft;
    if (!draft) return;
    if (draft.step === "describe" && step !== "describe") {
      const error = describeError(draft);
      if (error) { presenter.showDescribeError(error); return; }
      draft.new_label = clean(draft.new_label);
      draft.new_description = clean(draft.new_description);
      // The AI sorts against the definition unless it was reworded for the AI.
      if (!draft.ai_description || draft.ai_description === draft.ai_description_source) {
        draft.ai_description = draft.new_description;
        draft.ai_description_source = draft.new_description;
      }
    }
    if (step === "sources" && draft.mode === "edit") step = "partition";
    if (step === "partition" && draft.step === "describe" && draft.mode !== "edit") step = "sources";
    if (step === "sources") {
      state.selectedVariableIds.clear();
      delete draft.published_split;
    }
    draft.step = step;
    persistProjectLocally();
    invalidateMapCaches();
    renderDraft({ redrawMap: step === "partition" });
    if (step === "sources") void refreshBrowse();
    if (step === "describe") els.definitionNewLabel.focus();
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
    const describeProblem = describeError(draft);
    if (describeProblem) {
      draft.step = "describe";
      renderDraft();
      presenter.showDescribeError(describeProblem);
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
      // In Causes and Consequences a new variable becomes the focus; it is not
      // an anchor and has no group panel to open.
      // Started from the Custom variables page: go back to it, showing the new row.
      const fromManager = Boolean(state.customVariablesOpen);
      const forFocus = !fromManager && Boolean(onFocusDefined) && draft.role === "candidate" && draft.mode !== "edit"
        && (state.task === "causes" || state.task === "consequences");
      if (fromManager) state.customVariablesHighlight = newGroupId;
      state.definitionDraft = null;
      state.selectedVariableIds.clear();
      state.activeGroupId = null;
      state.focusedGroupId = newGroupId;
      if (draft.role === "candidate" && !forFocus && !fromManager) state.pendingVariablePanelGroupId = newGroupId;
      const initialAnchor = draft.mode !== "edit" && !state.changingAnchorSide;
      if (!forFocus) {
        state.phase = initialAnchor && draft.role === "iv" ? "select_dv"
          : initialAnchor && draft.role === "dv" ? "select_instrument" : "build";
        state.workflowMode = state.phase === "build" ? "group_review" : "setup";
      }
      state.changingAnchorSide = null;
      invalidateMapCaches();
      addToUndoHistory(draft.mode === "edit" ? `Updated split "${draft.new_label}"`
        : draft.role === "candidate" ? `Defined variable "${draft.new_label}"`
          : `Defined "${draft.new_label}" as ${draft.role.toUpperCase()}`, before);
      setMapMode("select");
      renderAll();
      if (forFocus) onFocusDefined(newGroupId);
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

  function showSaveError(error) {
    presenter.showSaveError(error);
  }

  function installDefinitionHandlers() {
    jevAssist.install();
    const chooseMethod = method => {
      if (state.definitionDraft?.step !== "partition" || state.definitionMethod === method) return;
      state.definitionMethod = method;
      if (state.map) state.map._groupRegions = null;
      renderDraft({ redrawMap: true });
    };
    els.definitionMethodJev.addEventListener("click", () => chooseMethod("jev"));
    els.definitionMethodManual.addEventListener("click", () => chooseMethod("manual"));
    // Each step's footer has its own Cancel, beside Next (or Save).
    for (const button of document.querySelectorAll(".definition-cancel")) button.addEventListener("click", cancelDefinition);
    els.definitionSourceSearch.addEventListener("input", renderDefinition);
    els.definitionContinue.addEventListener("click", continueDefinition);
    els.definitionDescribeNext.addEventListener("click", () => goToStep("partition"));
    els.definitionSourcesBack.addEventListener("click", () => goToStep("describe"));
    presenter.install();
    els.definitionTermToNew.addEventListener("click", () => classifyDefinitionVariables(presenter.selectedTermIds(), "in"));
    els.definitionTermToLeftover.addEventListener("click", () => classifyDefinitionVariables(presenter.selectedTermIds(), "out"));
    els.definitionUndoBatch.addEventListener("click", undoDefinitionBatch);
    els.definitionAddNeighbors.addEventListener("click", () =>
      classifyDefinitionVariables(definitionNeighbors().slice(0, 8).map(neighbor => neighbor.variable_id), "in"));
    els.definitionBack.addEventListener("click", () =>
      goToStep(state.definitionDraft?.mode === "edit" ? "describe" : "sources"));
    els.definitionNewLabel.addEventListener("input", () => {
      if (state.definitionDraft) state.definitionDraft.new_label = els.definitionNewLabel.value;
      presenter.clearDescriptionValidation();
      persistProjectLocally();
    });
    const nextOnEnter = event => {
      if (event.key === "Enter" && !event.shiftKey && state.definitionDraft?.step === "describe") {
        event.preventDefault();
        goToStep("partition");
      }
    };
    els.definitionNewLabel.addEventListener("keydown", nextOnEnter);
    els.definitionNewDescription.addEventListener("input", () => {
      if (state.definitionDraft) state.definitionDraft.new_description = els.definitionNewDescription.value;
      presenter.clearDescriptionValidation();
      persistProjectLocally();
    });
    els.definitionSave.addEventListener("click", saveDefinition);
  }

  const sourcesUnchanged = draft => Boolean(draft.source_snapshot?.every(snap => {
    const current = groupById(snap.group_id);
    return current && JSON.stringify(current.variable_ids) === JSON.stringify(snap.variable_ids);
  }));

  // Saved runs are only offered from Define, never restored at startup, so a
  // preview appears only where its controls do. `adopt` makes the draft current.
  async function resumeJevDraft(draft, { adopt }) {
    if (!sourcesUnchanged(draft)) return;
    state.definitionMethod = "jev";
    if (adopt) {
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

  async function resumeAfterOAuth() {
    const draft = jevAssist.takeResumeDraft() || state.definitionDraft;
    if (!draft || !["sources", "partition"].includes(draft.step) || !Array.isArray(draft.eligible_variable_ids)) return;
    // A source-step draft is resumed here only when it belongs to the OAuth
    // handoff. Startup may otherwise race with a newly opened manual draft.
    if (draft.step === "sources" && draft === state.definitionDraft) return;
    await resumeJevDraft(draft, { adopt: draft !== state.definitionDraft });
  }

  /** Lists saved, unfinished AI splits under the method choice of a new definition. */
  async function renderSavedRuns() {
    const draft = state.definitionDraft;
    presenter.showSavedRuns([]);
    let saved = [];
    try { saved = await jevAssist.listSavedRuns(); }
    catch (error) { console.warn("Could not read saved Jev runs.", error); }
    if (state.definitionDraft !== draft || draft?.step !== "describe") return;
    // Group memberships may still be loading, which would look like a change.
    const loading = state.publishedSchemaHydrating;
    presenter.showSavedRuns(saved
      .filter(({ run }) => run.draft?.step === "partition" && Array.isArray(run.draft.eligible_variable_ids))
      .map(({ run, batchCount }) => {
        const usable = !loading && sourcesUnchanged(run.draft);
        const sources = (run.draft.source_snapshot || []).map(snap => snap.label || snap.group_id).join(", ");
        return {
          title: truncate(run.draft.ai_description || "Untitled split", 90),
          detail: `${sources || "Unknown sources"} · ${run.draft.eligible_variable_ids.length} variables · ${batchCount} batches saved · ${new Date(run.createdAt).toLocaleString()}`,
          note: usable ? "" : loading ? "Loading group memberships…" : "The source categories have changed since this was saved.",
          usable,
          onResume: () => {
            if (state.definitionDraft !== draft) return;
            // The saved run keeps its classifications; the role is whatever this definition is for.
            const resumed = structuredClone(run.draft);
            resumed.role = draft.role;
            void resumeJevDraft(resumed, { adopt: true });
          },
          onDiscard: async () => {
            await jevAssist.discardSavedRun(run.id).catch(error => console.warn("Could not remove Jev checkpoint.", error));
            if (state.definitionDraft === draft) void renderSavedRuns();
          },
        };
      }));
    if (loading) setTimeout(() => {
      if (state.definitionDraft === draft) void renderSavedRuns();
    }, 400);
  }

  const presenter = createDefinitionWorkflowPresenter({
    state, elements: els, normalized, clusterRep, truncate, definitionSources,
    definitionResidualIds, definitionCanReview, searchVariables, searchSourceGroups, visibleVariables,
    clusterDisplayVariable, definitionNeighbors,
    resizeMap, fitMap, onSourceSelection: setSourceSelection,
    onClassify: (id, side) => classifyDefinitionVariables([id], side), onResidualLabel: setResidualLabel,
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
    onApply: ids => {
      const draft = state.definitionDraft;
      if (!draft || draft.step !== "partition") return;
      state.definitionMethod = "manual";
      // Replacing every choice is one change, so Undo restores what was there.
      const before = new Set(draft.new_variable_ids);
      const beforeReviewed = new Set(draft.reviewed_variable_ids || []);
      lastBatch = new Map(draft.eligible_variable_ids.map(id => [id, { selected: before.has(id), reviewed: beforeReviewed.has(id) }]));
      draft.new_variable_ids = ids;
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      state.selectedVariableIds = new Set(ids);
      // The suggestions land in the manual list, where they can be checked and saved.
      invalidateMapCaches();
      persistProjectLocally();
      renderDraft({ redrawMap: true });
    },
  });

  return { startDefinition, startEditSplit, cancelDefinition, definitionSources, continueDefinition,
    definitionResidualIds, toggleDefinitionVariable, classifyDefinitionVariables,
    definitionCanReview, definitionNeighbors, renderDefinition, saveDefinition, installDefinitionHandlers,
    resumeAfterOAuth };
}
