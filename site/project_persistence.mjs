import { withoutGroupReviewStatus, replaceSchemaGroups, normalizeDuplicateAssignments } from "./dag_project.mjs";
import { missingAnchorWorkflow, restoreWorkflowMode } from "./dag_workflow.mjs";
import { PROJECT_FORMAT_VERSION } from "./app_contracts.mjs";
export { restoreWorkflowMode } from "./dag_workflow.mjs";

export function applyCurrentSchema(loaded, schema, clusterOf, clusterMembers) {
  if (!schema) return loaded;
  const project = replaceSchemaGroups(loaded.project, schema, clusterOf, clusterMembers);
  const schemaIds = new Set(schema.groups.map(group => group.group_id));
  const seeds = {};
  for (const side of ["iv", "dv"]) {
    const anchor = project.groups.find(group => group.group_id === project[side + "_group_id"]);
    seeds[side] = new Set(anchor?.variable_ids || []);
  }
  const missingAnchor = !schemaIds.has(project.iv_group_id) || !schemaIds.has(project.dv_group_id);
  return { ...loaded, project, seeds,
    ...(missingAnchor ? missingAnchorWorkflow(loaded.selectedUoa) : {}),
  };
}

// Shared preparation for file import and autosave restoration; no live-state writes.
export function prepareLoadedProject(payload, { defaults, currentLayoutSource, schema, clusterOf, clusterMembers }) {
  const restored = restoreProjectPayload(payload, defaults, currentLayoutSource);
  if (!restored) throw new Error(`Project must use ${PROJECT_FORMAT_VERSION}.`);
  const loaded = applyCurrentSchema(restored, schema, clusterOf, clusterMembers);
  return { ...loaded,
    project: normalizeDuplicateAssignments(loaded.project, clusterOf, clusterMembers),
  };
}

export function projectStorageKey(prefix, data, variableCount) {
  const releaseKey = data?.cache_compatibility?.record_signature || data?.generated_at || "unknown";
  const parts = [prefix, releaseKey, variableCount, data?.default_grouping_set_id || "none"];
  if (data?.publication_source?.publication_id) parts.push(data.publication_source.publication_id);
  return parts.join(":");
}


// Defaults are supplied by the caller so restoration does not generate IDs or time.
export function restoreProjectPayload(payload, defaults, currentLayoutSource) {
  if (payload?.schema_version !== PROJECT_FORMAT_VERSION) return null;
  const { candidate_queue: _derivedCandidateQueue, ...persistedPayload } = payload;
  const { candidate_queue: _defaultCandidateQueue, ...projectDefaults } = defaults;
  const selectedUoa = payload.selectedUoa || null;
  const phase = payload.phase || (selectedUoa ? "select_dv" : "select_uoa");
  return {
    project: {
      ...projectDefaults, ...persistedPayload,
      groups: Array.isArray(payload.groups) ? payload.groups.map(withoutGroupReviewStatus) : [],
      decisions: Array.isArray(payload.decisions) ? payload.decisions : [],
      manual_edges: Array.isArray(payload.manual_edges) ? payload.manual_edges : [],
      rejected_variables: Array.isArray(payload.rejected_variables) ? payload.rejected_variables : [],
      restored_variable_ids: Array.isArray(payload.restored_variable_ids) ? payload.restored_variable_ids : [],
      link_decisions: payload.link_decisions || {},
      carve_outs: Array.isArray(payload.carve_outs) ? payload.carve_outs : [],
    },
    selectedUoa,
    uoaFilterEnabled: payload.uoaFilterEnabled !== false,
    phase,
    workflowMode: restoreWorkflowMode(payload.workflowMode, phase),
    changingAnchorSide: ["iv", "dv"].includes(payload.changingAnchorSide) ? payload.changingAnchorSide : null,
    variableLayoutSource: String(payload.variableLayoutSource ?? "").trim() || currentLayoutSource,
    dagLayoutMode: ["auto", "hierarchical", "organic"].includes(payload.dagLayoutMode) ? payload.dagLayoutMode : "auto",
    seeds: { iv: new Set(payload.seeds?.iv || []), dv: new Set(payload.seeds?.dv || []) },
    definitionDraft: payload.definitionDraft || null,
    undoHistory: Array.isArray(payload.undoHistory) ? payload.undoHistory : [],
    undoPointer: Number.isInteger(payload.undoPointer) ? payload.undoPointer : -1,
    actionLog: Array.isArray(payload.actionLog) ? payload.actionLog : [],
  };
}

// Storage errors propagate to the UI adapter, which owns warning/reporting policy.
export function readProject(storage, key) {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}

export function writeProject(storage, key, payload) {
  storage.setItem(key, JSON.stringify(payload));
}
