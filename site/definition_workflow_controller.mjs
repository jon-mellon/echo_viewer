import * as projectOps from "./dag_project.mjs";
import { createDefinitionWorkflowPresenter } from "./definition_workflow_presenter.mjs";
import { createDefinitionJevAssist } from "./definition_jev_assist.mjs";
import { listOwnPublishedSplits, loadPublishedSplitMembership } from "./published_split_browser.mjs";
import { eligiblePreviousSplits } from "./previous_split_candidates.mjs";

export function createDefinitionWorkflowController({ state, elements: els, activeGroup, clusterRep,
  invalidateVisibleCaches, renderAll, groupById, persistProjectLocally, getReturnUrl = () => location.href,
  visibleVariables, searchVariables, searchSourceGroups = groups => groups.map((group, index) => ({ group, index, variableMatch: "" })),
  clusterDisplayVariable, expandToClusterMembers, nowIso,
  applyProjectOperation, takeSnapshot, addToUndoHistory, clean, normalized, truncate,
  hydrateVariableDetails = async () => {},
  prewarmEvidence = async () => {}, commitSchema = async () => {},
  onCommitFailureRestored = () => {}, onInstrumentReady = () => {}, onFocusDefined = null, previousSplits = () => [] }) {
  let hydrationRevision = 0;
  const sourceHydrations = new Map();
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
      const ids = state.definitionDraft.source_group_ids;
      const rows = [...previousSplits()];
      if (!rows.length) {
        const published = await listOwnPublishedSplits();
        const loaded = await Promise.allSettled(published.filter(row => row.source_group_by_variable)
          .map(async row => ({ ...row, local_variable_ids: await loadPublishedSplitMembership(row) })));
        rows.push(...eligiblePreviousSplits(loaded.flatMap(result => result.status === "fulfilled" ? [result.value] : []), state.project?.groups));
      }
      const matching = rows.filter(row => ids.every(id => row.source_group_ids?.includes(id)));
      if (revision !== browseRevision || state.definitionDraft?.step !== "sources") return;
      browseState.rows = matching;
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
    if (!eligiblePreviousSplits([row], state.project?.groups).length) {
      browseState.error = "This saved variable no longer fits the current schema.";
      renderDefinition();
      return;
    }
    const available = new Set((state.project?.groups || []).filter(group => group.variable_ids?.length).map(group => group.group_id));
    if (!row.source_group_ids?.length || row.source_group_ids.some(id => !available.has(id))) {
      browseState.error = "This split's source variables are not available in the current schema.";
      renderDefinition();
      return;
    }
    draft.source_group_ids = [...row.source_group_ids];
    browseState.loading = true;
    browseState.error = "Loading the previous split…";
    renderDefinition();
    try {
      const ids = row.local_variable_ids || await loadPublishedSplitMembership(row);
      if (state.definitionDraft !== draft) return;
      const sources = definitionSources();
      const eligible = new Set(sources.flatMap(group => group.variable_ids));
      if (!ids.length || ids.some(id => !eligible.has(id))
        || sources.some(group => group.variable_ids.every(id => ids.includes(id)))) {
        throw new Error("This split does not fit the current source category assignments.");
      }
      await continueDefinition();
      if (state.definitionDraft !== draft) return;
      if (draft.step !== "describe") throw new Error("Could not load the current source variables.");
      // The published split supplies which concepts move and starts the name
      // and definition, which the next step lets the user rewrite.
      draft.new_label = row.name;
      draft.new_description = row.description;
      // Continue focused the empty name field. Keep its visible value in sync
      // when adopting a published split, since the presenter preserves focus.
      els.definitionNewLabel.value = row.name;
      els.definitionNewDescription.value = row.description;
      draft.new_variable_ids = [...new Set(ids.map(clusterRep))];
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      draft.published_split = { publication_id: row.publication_id, group_id: row.origin_group_id || row.group_id,
        split_id: row.origin_split_id || row.split_id };
      draft.step = "partition";
      state.selectedVariableIds = new Set(draft.new_variable_ids);
      persistProjectLocally();
      invalidateVisibleCaches();
      renderDraft();
      els.definitionSave.focus();
    } catch (error) {
      if (state.definitionDraft === draft) {
        browseState.error = `Could not use this split: ${error.message || error}`;
        browseState.loading = false;
        renderDefinition();
      }
    }
  }
  const renderDraft = () => {
    // Definition steps change the draft, not the project DAG.
    // The DAG is hidden until cancel/save, where a full render is performed.
    renderAll({ rebuild: false });
    jevAssist.render();
  };

  function startDefinition(role) {
    if (state.interfaceMode !== "dag2" || !["iv", "dv", "instrument", "candidate"].includes(role)) return;
    jevAssist.clearPreview();
    browseRevision += 1;
    browseState.rows = [];
    browseState.error = "";
    browseState.loading = false;
    // Start the query engine while the user chooses a source. The source load
    // still awaits this setup and reports any error through its normal path.
    void prewarmEvidence().catch(() => {});
    hydrationRevision += 1;
    sourceHydrations.clear();
    state.definitionDraft = {
      role, step: "sources", source_group_ids: [], source_snapshot: [],
      eligible_variable_ids: [], new_variable_ids: [], new_label: "", new_description: "",
      ai_description: "", residual_labels: {}, reviewed_variable_ids: [],
    };
    state.selectedVariableIds.clear();
    invalidateVisibleCaches();
    renderDraft();
    els.definitionSourceSearch.focus();
    void renderSavedRuns();
  }

  function browsePreviousForSource(role, sourceId) {
    startDefinition(role);
    if (state.definitionDraft) setSourceSelection(sourceId, true);
  }

  function reusePreviousSplit(role, row) {
    startDefinition(role);
    if (!state.definitionDraft) return;
    const available = new Set((state.project?.groups || []).filter(group => group.variable_ids?.length).map(group => group.group_id));
    if (!row.source_group_ids?.length || row.source_group_ids.some(id => !available.has(id))) {
      state.definitionDraft.source_group_ids = [...(row.source_group_ids || [])];
      browseState.error = "This split's source variables are not available in the current schema.";
      renderDefinition();
      return;
    }
    state.definitionDraft.source_group_ids = [...row.source_group_ids];
    void choosePublishedSplit(row);
  }

  async function startEditSplit(groupId = null) {
    const context = projectOps.editableSplitContext(state.project, groupId ? groupId : activeGroup());
    if (!context) return;
    jevAssist.clearPreview();
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
    invalidateVisibleCaches();
    renderDraft();
    try {
      await hydrateVariableDetails(eligible, { skipNeighbors: true });
    } catch (error) {
      if (revision === hydrationRevision && state.definitionDraft === draft) {
        draft.details_error = error?.message || String(error);
      }
    }
    if (revision !== hydrationRevision || state.definitionDraft !== draft) return;
    draft.details_loading = false;
    invalidateVisibleCaches();
    renderDraft();
  }

  function cancelDefinition() {
    browseRevision += 1;
    hydrationRevision += 1;
    jevAssist.clearPreview();
    state.definitionDraft = null;
    state.selectedVariableIds.clear();
    state.selectedVariableId = null;
    invalidateVisibleCaches();
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
        || hydrateVariableDetails(source.variable_ids, { skipNeighbors: true })));
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
    draft.step = "describe";
    invalidateVisibleCaches();
    renderDraft();
    els.definitionNewLabel.focus();
  }

  function definitionResidualIds(source) {
    const carved = new Set(state.definitionDraft?.new_variable_ids || []);
    return [...new Set(source.variable_ids.map(clusterRep))].filter(id => !carved.has(id));
  }

  function definitionCanReview() {
    const draft = state.definitionDraft;
    return Boolean(draft?.new_variable_ids?.length && definitionSources().every(source =>
      definitionResidualIds(source).length));
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
        const loading = hydrateVariableDetails(source.variable_ids, { skipNeighbors: true });
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
    if (draft.step === "describe" && step === "partition") {
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
    if (step === "sources" && draft.mode === "edit") return;
    if (step === "partition" && draft.mode !== "edit" && !draft.eligible_variable_ids.length) step = "sources";
    if (step === "sources") {
      state.selectedVariableIds.clear();
      delete draft.published_split;
    }
    draft.step = step;
    persistProjectLocally();
    invalidateVisibleCaches();
    renderDraft();
    if (step === "sources") void refreshBrowse();
    if (step === "describe") els.definitionNewLabel.focus();
  }

  function renderDefinition() {
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
        reusedFrom: draft.published_split || null,
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
      if (!fromManager) {
        state.activeGroupId = null;
        state.focusedGroupId = newGroupId;
      }
      if (draft.role === "candidate" && !forFocus && !fromManager) state.pendingVariablePanelGroupId = newGroupId;
      const initialAnchor = draft.mode !== "edit" && !state.changingAnchorSide;
      if (!forFocus && !fromManager) {
        state.phase = initialAnchor && draft.role === "iv" ? "select_dv"
          : initialAnchor && draft.role === "dv" ? "select_instrument" : "build";
        state.workflowMode = state.phase === "build" ? "group_review" : "setup";
      }
      state.changingAnchorSide = null;
      invalidateVisibleCaches();
      addToUndoHistory(draft.mode === "edit" ? `Updated split "${draft.new_label}"`
        : draft.role === "candidate" ? `Defined variable "${draft.new_label}"`
          : `Defined "${draft.new_label}" as ${draft.role.toUpperCase()}`, before);
      renderAll();
      if (forFocus) onFocusDefined(newGroupId);
      if (draft.role === "instrument") onInstrumentReady();
    } catch (error) {
      state.compiledDagRevision = (state.compiledDagRevision || 0) + 1;
      state.compiledDag = previousCompiledDag;
      state.compiledDagUpdating = false;
      state.project = previousProject;
      onCommitFailureRestored();
      invalidateVisibleCaches();
      renderDraft();
      showSaveError(error);
    }
  }

  function showSaveError(error) {
    presenter.showSaveError(error);
  }

  function installDefinitionHandlers() {
    jevAssist.install();
    els.definitionSourceSearch.addEventListener("input", renderDefinition);
    els.definitionContinue.addEventListener("click", continueDefinition);
    els.definitionDescribeNext.addEventListener("click", () => goToStep("partition"));
    els.definitionDescribeBack.addEventListener("click", () => goToStep("sources"));
    presenter.install();
    els.definitionBack.addEventListener("click", () => state.definitionDraft?.published_split ? cancelDefinition() : goToStep("describe"));
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
  // Group memberships fill in after startup, and a saved draft is compared against them, so wait for them first.
  async function whenGroupsHydrated() {
    const deadline = Date.now() + 60_000;
    while (state.publishedSchemaHydrating && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  }

  async function resumeJevDraft(draft, { adopt }) {
    await whenGroupsHydrated();
    if (!sourcesUnchanged(draft)) return;
    if (adopt) {
      state.definitionDraft = draft;
      state.selectedVariableIds = new Set(draft.new_variable_ids || []);
    }
    if (draft.step === "sources") { renderDraft(); return; }
    try { await hydrateVariableDetails(draft.eligible_variable_ids); }
    catch (error) { console.warn("Could not reload all split variable details.", error); }
    invalidateVisibleCaches();
    renderDraft();
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
    if (state.definitionDraft !== draft || draft?.step !== "sources") return;
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
    clusterDisplayVariable,
    onSourceSelection: setSourceSelection, onResidualLabel: setResidualLabel,
    onCancel: cancelDefinition,
    browseState, onChoosePublishedSplit: choosePublishedSplit,
  });

  const jevAssist = createDefinitionJevAssist({ elements: els,
    getDraft: () => state.definitionDraft,
    getVariable: id => clusterDisplayVariable(id) || state.variableById.get(id),
    persistDraft: persistProjectLocally, getReturnUrl,
    onConnectionChange: ready => { state.definitionAiReady = ready; if (state.project && state.definitionDraft) renderDraft(); },
    onApply: ids => {
      const draft = state.definitionDraft;
      if (!draft || draft.step !== "partition") return;
      draft.new_variable_ids = ids;
      draft.reviewed_variable_ids = [...draft.eligible_variable_ids];
      state.selectedVariableIds = new Set(ids);
      // The suggestions land in the included list, where they can be checked and saved.
      invalidateVisibleCaches();
      persistProjectLocally();
      renderDraft();
    },
  });

  return { startDefinition, browsePreviousForSource, reusePreviousSplit, startEditSplit, cancelDefinition, definitionSources, continueDefinition,
    definitionResidualIds,
    definitionCanReview, renderDefinition, saveDefinition, installDefinitionHandlers,
    resumeAfterOAuth };
}
