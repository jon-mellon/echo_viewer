import * as projectOps from "./dag_project.mjs";
import { groupingSchemaUrl } from "./dag_data_config.mjs";
import { buildPermalink, CUSTOM_SCHEMA_INSTRUCTIONS, schemaMatchesProject } from "./dag_permalink.mjs";
import { writeGroupingSchemaFolder } from "./grouping_schema_writer.mjs";
import { makeZip } from "./dag_export_zip.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";

export function createGroupingSetController({ state, elements, publicationController, exportController,
  rejectedVariableEntries, rejectedVariableIdSet, applyProjectOperation, normalizeProjectDuplicateAssignments,
  groupById, nowIso }) {
  function active() {
    return (state.data.grouping_sets || []).find(set => set.grouping_set_id === state.project.active_grouping_set_id)
      || (state.data.grouping_sets || [])[0];
  }

  async function copyPermalink() {
    if (state.interfaceMode === "dag2") return publicationController.share();
    const schema = active();
    if (!schemaMatchesProject(schema, state.project)) return window.alert(CUSTOM_SCHEMA_INSTRUCTIONS);
    const dataVersion = state.data?.snapshot?.snapshot_id;
    if (!dataVersion) return window.alert("This dataset has no immutable snapshot ID, so an exact permalink cannot be created.");
    const url = buildPermalink({ location: window.location, schemaUrl: groupingSchemaUrl(), dataVersion, state });
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
    else window.prompt("Copy this permalink:", url);
  }

  function workingSchema() {
    const source = active() || {};
    const owners = new Map();
    const groups = state.project.groups.filter(group => group.variable_ids?.length).map(group => {
      const variable_ids = [...new Set(group.variable_ids.map(id => state.clusterOf.get(id) || id))].sort();
      for (const id of variable_ids) {
        const owner = owners.get(id);
        if (owner && owner !== group.group_id) throw new Error(`Canonical variable ${id} belongs to both ${owner} and ${group.group_id}.`);
        owners.set(id, group.group_id);
      }
      return {
        group_id: group.group_id, label: group.label || "", notes: group.notes || "",
        source: group.source || "project_export",
        ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
        variable_ids,
      };
    });
    const rejected_variables = rejectedVariableEntries().map(entry => ({
      variable_id: entry.variable_id,
      member_variable_ids: [...new Set(entry.member_variable_ids || [])].sort(),
      label: entry.label || "", reason: entry.reason || "low_quality", flagged_at: "",
      previous_group_ids: [...new Set(entry.previous_group_ids || [])].sort(),
    }));
    return {
      schema_version: GROUPING_FORMAT_VERSION,
      grouping_set_id: source.grouping_set_id || state.project.active_grouping_set_id,
      label: source.label || "Published working schema",
      description: source.description || "Published working grouping schema.",
      cache_compatibility: structuredClone(source.cache_compatibility || state.data.cache_compatibility || {}),
      built_against: structuredClone(source.built_against || source.cache_compatibility || state.data.cache_compatibility || {}),
      membership_unit: GROUPING_MEMBERSHIP_UNIT,
      ...(source.migration_provenance ? { migration_provenance: structuredClone(source.migration_provenance) } : {}),
      groups, rejected_variables, hidden_variable_ids: [...rejectedVariableIdSet()].sort(),
    };
  }

  function applyActive() {
    const groupingSet = active();
    if (!groupingSet) return [];
    if (state.interfaceMode === "dag2") {
      applyProjectOperation(projectOps.replaceSchemaGroups(state.project, groupingSet, state.clusterOf, state.clusterMembers));
      normalizeProjectDuplicateAssignments();
      const iv = groupById(state.project.iv_group_id);
      const dv = groupById(state.project.dv_group_id);
      const anchorsReady = Boolean(iv?.variable_ids?.length && dv?.variable_ids?.length);
      state.phase = anchorsReady ? "build" : "select_iv";
      state.workflowMode = anchorsReady ? "group_review" : "setup";
      state.changingAnchorSide = null;
      if (!anchorsReady) { state.selectedUoa = null; state.uoaFilterEnabled = false; }
      return groupingSet.groups.map(group => group.group_id);
    }
    const result = projectOps.importSchemaGroups(state.project, groupingSet, state.linkLookup, nowIso());
    applyProjectOperation(result.project);
    if (!result.anchorsReady) state.filterDagByCausalRelevance = false;
    return result.loadedGroupIds;
  }

  async function exportFolder() {
    const button = elements.exportGroupingFolder;
    button.disabled = true;
    const originalLabel = button.textContent;
    button.textContent = "Building ZIP…";
    try {
      const timestamp = nowIso();
      const schema = workingSchema();
      const folder = await writeGroupingSchemaFolder(schema);
      const archive = makeZip([...folder].map(([name, data]) => ({ name, data })));
      state.project.grouping_exports.push({ grouping_set_id: schema.grouping_set_id,
        exported_at: timestamp, format: `${GROUPING_FORMAT_VERSION}-folder` });
      exportController.downloadBlob(new Blob([archive], { type: "application/zip" }), "grouping_schema.zip");
    } catch (error) {
      console.error("Could not export grouping schema folder", error);
      window.alert(error?.message || "Could not export the grouping schema folder.");
    } finally {
      button.textContent = originalLabel;
      button.disabled = false;
    }
  }

  return { active, copyPermalink, workingSchema, applyActive, exportFolder };
}
