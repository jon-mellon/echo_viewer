import { withoutGroupReviewStatus, replaceSchemaGroups, normalizeDuplicateAssignments } from "./dag_project.mjs";
import { missingAnchorWorkflow, restoreWorkflowMode } from "./dag_workflow.mjs";
import { PROJECT_FORMAT_VERSION } from "./app_contracts.mjs";
import { validateProjectPayload } from "./data_validation.mjs";
export { restoreWorkflowMode } from "./dag_workflow.mjs";

/** @typedef {import("./app_contracts.mjs").Project} Project */
/** @typedef {import("./app_contracts.mjs").SerializedProjectPayload} SerializedProjectPayload */
/** @typedef {import("./app_contracts.mjs").GroupingSchema} GroupingSchema */

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
/**
 * The sole conversion from the JSON-safe persistence envelope to live project state.
 * @param {unknown} payload
 * @param {Project} defaults
 * @param {string} currentLayoutSource
 */
export function restoreProjectPayload(payload, defaults, currentLayoutSource) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = /** @type {Record<string, unknown>} */ (payload);
  if (record.schema_version !== PROJECT_FORMAT_VERSION) return null;
  validateProjectPayload(payload);
  const serialized = /** @type {SerializedProjectPayload} */ (payload);
  const { candidate_queue: _derivedCandidateQueue, ...projectDefaults } =
    /** @type {Project & {candidate_queue?: unknown}} */ ({ ...defaults });
  const persistedProject = Object.fromEntries(
    Object.keys(projectDefaults)
      .filter(key => Object.hasOwn(serialized, key))
      .map(key => [key, serialized[key]]),
  );
  const selectedUoa = serialized.selectedUoa || null;
  const phase = serialized.phase || (selectedUoa ? "select_dv" : "select_uoa");
  return {
    project: {
      ...projectDefaults, ...persistedProject,
      groups: Array.isArray(serialized.groups) ? serialized.groups.map(withoutGroupReviewStatus) : [],
      decisions: Array.isArray(serialized.decisions) ? serialized.decisions : [],
      manual_edges: Array.isArray(serialized.manual_edges) ? serialized.manual_edges : [],
      rejected_variables: Array.isArray(serialized.rejected_variables) ? serialized.rejected_variables : [],
      restored_variable_ids: serialized.restored_variable_ids || [],
      link_decisions: serialized.link_decisions || {},
      carve_outs: Array.isArray(serialized.carve_outs) ? serialized.carve_outs : [],
    },
    selectedUoa,
    uoaFilterEnabled: serialized.uoaFilterEnabled !== false,
    phase,
    workflowMode: restoreWorkflowMode(serialized.workflowMode, phase),
    changingAnchorSide: ["iv", "dv"].includes(serialized.changingAnchorSide) ? serialized.changingAnchorSide : null,
    variableLayoutSource: String(serialized.variableLayoutSource ?? "").trim() || currentLayoutSource,
    dagLayoutMode: ["auto", "hierarchical", "organic"].includes(serialized.dagLayoutMode) ? serialized.dagLayoutMode : "auto",
    seeds: { iv: new Set(serialized.seeds?.iv || []), dv: new Set(serialized.seeds?.dv || []) },
    definitionDraft: serialized.definitionDraft || null,
    undoHistory: serialized.undoHistory || [],
    undoPointer: Number.isInteger(serialized.undoPointer) ? serialized.undoPointer : -1,
    actionLog: serialized.actionLog || [],
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
