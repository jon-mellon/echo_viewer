import * as exportData from "./dag_exports.mjs";
import * as history from "./project_history.mjs";
import * as persistence from "./project_persistence.mjs";
import * as projectOps from "./dag_project.mjs";
import * as workflow from "./dag_workflow.mjs";

// Owns project lifecycle and the sole in-place mutation adapter used by the UI.
export function createDagProjectController({
  state, storage, storagePrefix, nowIso, invalidateMapCaches,
  renderAll, renderUndoRedo, renderActionHistory, warn = console.warn,
}) {
  function createProject() {
    return projectOps.createProject({
      projectId: `dag_project_${Date.now()}`,
      groupingSetId: state.data.default_grouping_set_id,
    });
  }

  function currentSchema() {
    return (state.data?.grouping_sets || [])
      .find(candidate => candidate.grouping_set_id === state.data.default_grouping_set_id);
  }

  function applyOperation(next) {
    const existing = new Map(state.project.groups.map(group => [group.group_id, group]));
    const groups = next.groups.map(group => {
      const current = existing.get(group.group_id);
      if (!current || current === group) return group;
      for (const key of Object.keys(current)) if (!(key in group)) delete current[key];
      Object.assign(current, group);
      return current;
    });
    Object.assign(state.project, next, { groups });
    if (state.map) state.map._groupRegions = null;
  }

  function initialize() {
    state.project = createProject();
  }

  function loadCurrentSchema() {
    if (!state.project) return;
    Object.assign(state, persistence.applyCurrentSchema({
      project: state.project, seeds: state.seeds, phase: state.phase,
      workflowMode: state.workflowMode, selectedUoa: state.selectedUoa,
    }, currentSchema(), state.clusterOf, state.clusterMembers));
    invalidateMapCaches();
  }

  function applyLoaded(payload) {
    Object.assign(state, persistence.prepareLoadedProject(payload, {
      defaults: createProject(), currentLayoutSource: state.variableLayoutSource,
      schema: state.interfaceMode === "dag2" ? null : currentSchema(),
      clusterOf: state.clusterOf, clusterMembers: state.clusterMembers,
    }));
    Object.assign(state, workflow.transition(state, { type: "clear-editor" }));
    invalidateMapCaches();
  }

  function storageKey() {
    return persistence.projectStorageKey(storagePrefix, state.data,
      state.projectStorageVariableCount ?? state.variables.length);
  }

  function payload() {
    return exportData.buildProjectPayload({
      project: state.project, selectedUoa: state.selectedUoa,
      uoaFilterEnabled: state.uoaFilterEnabled, phase: state.phase,
      workflowMode: state.workflowMode, changingAnchorSide: state.changingAnchorSide,
      variableLayoutSource: state.variableLayoutSource, dagLayoutMode: state.dagLayoutMode,
      seeds: state.seeds, definitionDraft: state.definitionDraft,
      undoHistory: state.undoHistory, undoPointer: state.undoPointer, actionLog: state.actionLog,
    }, nowIso());
  }

  function save() {
    if (!state.project || !state.data) return;
    try {
      persistence.writeProject(storage, storageKey(), payload());
    } catch (error) {
      warn("Could not autosave DAG project", error);
    }
  }

  function restore() {
    try {
      const saved = persistence.readProject(storage, storageKey());
      applyLoaded(saved);
      return true;
    } catch (error) {
      warn("Could not restore autosaved DAG project", error);
      return false;
    }
  }

  const snapshot = () => projectOps.snapshotProject(state.project, state.phase);

  function applySnapshot(serialized) {
    const restored = projectOps.restoreSnapshot(state.project, serialized);
    state.project = restored.project;
    state.phase = restored.phase;
    invalidateMapCaches();
  }

  function record(description, before) {
    const after = snapshot();
    if (before === after) return;
    Object.assign(state, history.recordHistory(state, description, before, after, nowIso()));
    renderUndoRedo();
    if (state.showActionHistory) renderActionHistory();
  }

  function step(direction) {
    const next = history.historyStep(state, direction);
    if (!next) return;
    state.undoPointer = next.undoPointer;
    applySnapshot(next.snapshot);
    renderAll();
  }

  function addDecision(type, decisionPayload) {
    state.project.decisions.push({
      decision_id: `decision_${state.project.decisions.length + 1}`,
      type,
      timestamp: nowIso(),
      payload: decisionPayload,
    });
  }

  return {
    createProject, currentSchema, applyOperation, initialize, loadCurrentSchema,
    applyLoaded, storageKey, payload, save, restore, snapshot, applySnapshot, record,
    undo: () => step("undo"), redo: () => step("redo"), addDecision,
  };
}
