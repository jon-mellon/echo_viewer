import { rawLinksBetween } from "./dag_link_aggregation.mjs";

// Project data operations. Callers supply timestamps/IDs and duplicate-cluster
// members; no operation reads UI state, storage, the clock or the network.
// Unchanged records are shared. Treat all returned data as read-only until the
// UI adapter applies it; copying entire projects per variable would be wasteful.

import * as visibility from "./variable_visibility.mjs";

export function withoutGroupReviewStatus(group) {
  const { status, ...definition } = group;
  return definition;
}

export function createProject({ projectId, groupingSetId }) {
  return {
    project_id: projectId, active_grouping_set_id: groupingSetId,
    iv_group_id: 'g_iv', dv_group_id: 'g_dv', groups: [], links: [],
    candidate_queue: [], decisions: [], filters: {}, grouping_imports: [],
    grouping_exports: [], carve_outs: [], link_decisions: {}, manual_edges: [],
    rejected_variables: [], publication: null,
  };
}

export function updateGroup(project, groupId, changes) {
  return { ...project, groups: project.groups.map(group => group.group_id === groupId ? { ...group, ...changes } : group) };
}

export function upsertGroup(project, group, timestamp) {
  return project.groups.some(g => g.group_id === group.group_id)
    ? updateGroup(project, group.group_id, { ...group, updated_at: timestamp })
    : { ...project, groups: [...project.groups, group] };
}

export function promoteAnchor(project, side, groupId, timestamp) {
  if (!['iv', 'dv'].includes(side)) return project;
  const key = `${side}_group_id`;
  const opposite = side === 'dv' ? project.iv_group_id : project.dv_group_id;
  if (groupId === opposite || !project.groups.some(g => g.group_id === groupId)) return project;
  return { ...project, [key]: groupId, groups: project.groups.map(group => {
    if (group.group_id === groupId) return { ...group, type: side, updated_at: timestamp };
    if (group.group_id === project[key]) return { ...group, type: null };
    return group;
  }) };
}

export function addMembers(project, groupId, memberIds, timestamp) {
  if (!project.groups.some(group => group.group_id === groupId)) return project;
  const members = new Set(memberIds);
  return { ...project, groups: project.groups.map(group => ({ ...group,
    variable_ids: group.group_id === groupId
      ? [...group.variable_ids, ...[...members].filter(id => !group.variable_ids.includes(id))]
      : (group.variable_ids || []).filter(id => !members.has(id)),
    updated_at: timestamp,
  })) };
}

export function removeMembers(project, groupId, memberIds, timestamp) {
  const drop = new Set(memberIds);
  const group = project.groups.find(g => g.group_id === groupId);
  if (!group) return project;
  return updateGroup(project, groupId, {
    variable_ids: group.variable_ids.filter(id => !drop.has(id)), updated_at: timestamp,
  });
}

export function protectedSeedIds(group, seeds) {
  if ((group.type === 'iv' || group.type === 'dv') && seeds[group.type]?.size) return new Set(seeds[group.type]);
  if (Array.isArray(group.seed_variable_ids) && group.seed_variable_ids.length) return new Set(group.seed_variable_ids);
  return new Set(group.variable_ids.slice(0, 1));
}

export function membershipConflicts(groups, group) {
  const members = new Set(group.variable_ids);
  return groups.filter(other => other.group_id !== group.group_id).flatMap(other =>
    other.variable_ids.filter(id => members.has(id)).map(variableId => ({ groupId: other.group_id, variableId })));
}

export function removeMembersEverywhere(project, memberIds) {
  const drop = new Set(memberIds);
  const previousGroupIds = [];
  const groups = project.groups.map(group => {
    const variable_ids = (group.variable_ids || []).filter(id => !drop.has(id));
    if (variable_ids.length !== (group.variable_ids?.length || 0)) previousGroupIds.push(group.group_id);
    return { ...group, variable_ids };
  });
  return { project: { ...project, groups }, previousGroupIds };
}

export function snapshotProject(project, phase) {
  return JSON.stringify({ groups: project.groups, link_decisions: project.link_decisions,
    manual_edges: project.manual_edges, rejected_variables: project.rejected_variables,
    restored_variable_ids: project.restored_variable_ids, decisions: project.decisions,
    iv_group_id: project.iv_group_id, dv_group_id: project.dv_group_id, phase });
}

export function restoreSnapshot(project, json) {
  const snap = JSON.parse(json);
  return { project: { ...project, groups: snap.groups.map(withoutGroupReviewStatus),
    link_decisions: snap.link_decisions, manual_edges: snap.manual_edges,
    rejected_variables: snap.rejected_variables || [],
    restored_variable_ids: snap.restored_variable_ids || [],
    decisions: snap.decisions || [],
    iv_group_id: snap.iv_group_id || project.iv_group_id,
    dv_group_id: snap.dv_group_id || project.dv_group_id }, phase: snap.phase };
}

export function replaceSchemaGroups(project, groupingSet, clusterOf, clusterMembers) {
  const schemaIds = new Set(groupingSet.groups.map(g => g.group_id));
  const anchors = {};
  for (const side of ['iv', 'dv']) {
    const previous = project.groups.find(group => group.group_id === project[`${side}_group_id`]);
    const id = previous?.source_group_id || project[`${side}_group_id`];
    anchors[`${side}_group_id`] = schemaIds.has(id) ? id : `g_${side}`;
  }
  return { ...project, ...anchors, active_grouping_set_id: groupingSet.grouping_set_id,
    groups: groupingSet.groups.map(group => ({ ...withoutGroupReviewStatus(group),
      variable_ids: [...(group.variable_ids || [])], seed_variable_ids: [...(group.variable_ids || [])],
      type: 'candidate', source_grouping_set_id: groupingSet.grouping_set_id, source_group_id: group.group_id })),
    rejected_variables: visibility.schemaRejections(project, groupingSet, clusterOf, clusterMembers), carve_outs: [] };
}

export function normalizeDuplicateAssignments(project, clusterOf, clusterMembers) {
  const clusterRep = id => clusterOf.get(id) || id;
  const clusterMemberIds = id => clusterMembers.get(clusterRep(id)) || [id];
  project = { ...project, groups: project.groups.map(group => ({ ...group })) };
  // A merged construct can belong to only one group. Preserve the first existing
  // owner, then expand that ownership to every underlying variable in the cluster.
  const ownerByRep = new Map();
  for (const group of project.groups || []) {
    for (const variableId of group.variable_ids || []) {
      const repId = clusterRep(variableId);
      if (!ownerByRep.has(repId)) ownerByRep.set(repId, group.group_id);
    }
  }
  for (const group of project.groups || []) {
    const ownedReps = [...ownerByRep.entries()]
      .filter(([, groupId]) => groupId === group.group_id)
      .map(([repId]) => repId);
    group.variable_ids = [...new Set(ownedReps.flatMap((repId) => clusterMemberIds(repId)))];
    if (Array.isArray(group.seed_variable_ids)) {
      group.seed_variable_ids = [...new Set(
        group.seed_variable_ids.flatMap((variableId) => clusterMemberIds(variableId))
      )];
    }
  }
  project.rejected_variables = (project.rejected_variables || []).map((entry) => {
    const repId = clusterRep(entry.variable_id);
    return {
      ...entry,
      variable_id: repId,
      member_variable_ids: clusterMemberIds(repId).slice(),
    };
  });
  return project;
}

export function importSchemaGroups(project, groupingSet, linkLookup, timestamp) {
  project = { ...project, groups: [...project.groups], carve_outs: [...project.carve_outs] };
  const groupById = id => project.groups.find(group => group.group_id === id);
  const dagGroups = () => project.groups.filter(group => group.variable_ids?.length);
  const hasAnyMapping = (source, target) => rawLinksBetween(source, target, linkLookup).length > 0;
  const iv = groupById(project.iv_group_id);
  const dv = groupById(project.dv_group_id);
  const anchorsReady = Boolean(iv?.variable_ids?.length && dv?.variable_ids?.length);

  const ivDvIds = anchorsReady ? new Set([...iv.variable_ids, ...dv.variable_ids]) : new Set();
  const assignedIds = new Set(dagGroups().flatMap((g) => g.variable_ids));
  const existingSourceIds = new Set(project.groups.map((g) => `${g.source_grouping_set_id || ""}::${g.source_group_id || ""}`));
  const loadedGroupIds = [];
  for (const sourceGroup of groupingSet.groups || []) {
    const sourceKey = `${groupingSet.grouping_set_id}::${sourceGroup.group_id}`;
    if (existingSourceIds.has(sourceKey)) continue;
    const removed = (sourceGroup.variable_ids || []).filter((id) => ivDvIds.has(id));
    const remaining = (sourceGroup.variable_ids || []).filter((id) => !assignedIds.has(id));
    if (!remaining.length) {
      if (anchorsReady && removed.length) recordCarveOut(project, groupingSet, sourceGroup, removed, iv, dv);
      continue;
    }
    if (anchorsReady && !(hasAnyMapping(remaining, iv.variable_ids) || hasAnyMapping(iv.variable_ids, remaining)
      || hasAnyMapping(remaining, dv.variable_ids) || hasAnyMapping(dv.variable_ids, remaining))) {
      if (removed.length) recordCarveOut(project, groupingSet, sourceGroup, removed, iv, dv);
      continue;
    }
    if (anchorsReady && removed.length) recordCarveOut(project, groupingSet, sourceGroup, removed, iv, dv);
    const importedGroupId = `schema_${sourceGroup.group_id}`;
    project.groups.push({
      group_id: importedGroupId,
      label: sourceGroup.label || "Imported group",
      variable_ids: remaining,
      seed_variable_ids: remaining.slice(),
      excluded_nearby_variable_ids: [],
      boundary_geometry: {},
      notes: sourceGroup.notes || "",
      type: "candidate",
      created_at: timestamp,
      updated_at: timestamp,
      source_grouping_set_id: groupingSet.grouping_set_id,
      source_group_id: sourceGroup.group_id,
      similarity_coherence: Number(sourceGroup.similarity_coherence || 0),
    });
    loadedGroupIds.push(importedGroupId);
  }
  return { project, loadedGroupIds, anchorsReady };
}

function recordCarveOut(project, groupingSet, sourceGroup, removed, iv, dv) {
  const key = `${groupingSet.grouping_set_id}::${sourceGroup.group_id}`;
  if (project.carve_outs.some((c) => `${c.source_grouping_set_id}::${c.source_group_id}` === key)) return;
  const removedToGroups = {};
  for (const variableId of removed) {
    removedToGroups[variableId] = dv.variable_ids.includes(variableId) ? dv.group_id : iv.group_id;
  }
  project.carve_outs.push({
    source_grouping_set_id: groupingSet.grouping_set_id,
    source_group_id: sourceGroup.group_id,
    removed_variable_ids: removed,
    removed_to_groups: removedToGroups,
  });
}

export function appendManualEdge(project, edge) {
  return { ...project, manual_edges: [...project.manual_edges, edge] };
}

export function deleteManualEdge(project, edgeId) {
  return { ...project, manual_edges: project.manual_edges.map(edge => edge.edge_id === edgeId ? { ...edge, deleted: true } : edge) };
}

export function setLinkDecision(project, edgeId, decision) {
  const link_decisions = { ...project.link_decisions };
  if (decision === null) delete link_decisions[edgeId];
  else link_decisions[edgeId] = decision;
  return { ...project, link_decisions };
}

export function splitCategories(project, {
  sourceGroupIds, newGroupId, newLabel, residualLabels = {}, newVariableIds,
  timestamp, role, manualEdgeDispositions = {}, splitId = null,
}) {
  splitId ||= `split_${newGroupId}`;
  const sourceIds = [...new Set(sourceGroupIds || [])];
  if (!sourceIds.length) throw new Error("Choose at least one source category.");
  if (!newGroupId || project.groups.some(group => group.group_id === newGroupId)) {
    throw new Error("The new category must have a unique ID.");
  }
  if (!String(newLabel || "").trim()) throw new Error("Name the new variable.");
  const sourceGroups = sourceIds.map(id => project.groups.find(group => group.group_id === id));
  if (sourceGroups.some(group => !group?.variable_ids?.length)) {
    throw new Error("Every source category must exist and contain variables.");
  }
  const eligible = new Set(sourceGroups.flatMap(group => group.variable_ids));
  const sourceGroupByVariable = Object.fromEntries(sourceGroups.flatMap(group =>
    group.variable_ids.map(variableId => [variableId, group.group_id])));
  const carved = new Set(newVariableIds || []);
  if (!carved.size || [...carved].some(id => !eligible.has(id))) {
    throw new Error("The new variable must contain only variables from the selected sources.");
  }
  const nextGroups = project.groups.map(group => {
    if (!sourceIds.includes(group.group_id)) return group;
    const variable_ids = group.variable_ids.filter(id => !carved.has(id));
    if (!variable_ids.length) throw new Error(`The leftover for ${group.label || group.group_id} cannot be empty.`);
    const label = String(residualLabels[group.group_id] || "").trim();
    if (!label) throw new Error(`Name the leftover for ${group.label || group.group_id}.`);
    const type = ["iv", "dv"].includes(role) && group.type === role ? null : group.type;
    return { ...group, label, variable_ids, type, updated_at: timestamp,
      provenance: { operation: "split_categories", split_id: splitId, prior_label: group.label || "",
        source_group_ids: [group.group_id], source_group_ids_retained_as_residuals: true,
        edited_at: timestamp } };
  });
  const normalizedLabels = nextGroups.map(group => String(group.label || "").trim().toLowerCase()).filter(Boolean);
  if (new Set(normalizedLabels).size !== normalizedLabels.length) throw new Error("Category names must be unique.");
  const labels = new Set(normalizedLabels);
  const normalizedNewLabel = String(newLabel).trim().toLowerCase();
  if (labels.has(normalizedNewLabel)) throw new Error("Category names must be unique.");
  const newGroup = {
    group_id: newGroupId, label: String(newLabel).trim(), variable_ids: [...carved],
    seed_variable_ids: [...carved], excluded_nearby_variable_ids: [], boundary_geometry: {},
    notes: "", type: role || "candidate", source: "user_split",
    created_at: timestamp, updated_at: timestamp,
    provenance: { operation: "split_categories", split_id: splitId, source_group_ids: sourceIds,
      source_group_by_variable: sourceGroupByVariable,
      source_group_ids_retained_as_residuals: true, edited_at: timestamp },
  };
  let manual_edges = (project.manual_edges || []).map(edge => {
    const disposition = manualEdgeDispositions[edge.edge_id];
    if (!disposition) return edge;
    if (disposition === "remove") return { ...edge, deleted: true };
    if (disposition === "move") return { ...edge,
      source_group_id: sourceIds.includes(edge.source_group_id) ? newGroupId : edge.source_group_id,
      target_group_id: sourceIds.includes(edge.target_group_id) ? newGroupId : edge.target_group_id };
    return edge;
  });
  const next = { ...project, groups: [...nextGroups, newGroup], manual_edges,
    ...(["iv", "dv"].includes(role) ? { [`${role}_group_id`]: newGroupId } : {}),
    decisions: [...(project.decisions || []), {
      decision_id: `decision_${(project.decisions || []).length + 1}`,
      type: "split_categories", timestamp,
      payload: { source_group_ids: sourceIds, new_group_id: newGroupId,
        retained_residual_group_ids: sourceIds, selected_role: role || null },
    }],
  };
  const owners = new Map();
  for (const group of next.groups) for (const id of group.variable_ids || []) {
    if (owners.has(id)) throw new Error(`Variable ${id} belongs to more than one category.`);
    owners.set(id, group.group_id);
  }
  return next;
}

export function editableSplitContext(project, groupOrId) {
  const group = typeof groupOrId === "string"
    ? project.groups.find(candidate => candidate.group_id === groupOrId)
    : groupOrId;
  const splitId = group?.provenance?.split_id;
  if (!splitId) return null;
  const resultGroups = (project.groups || []).filter(candidate =>
    candidate.provenance?.operation === "split_categories"
    && candidate.provenance?.split_id === splitId);
  const newGroup = resultGroups.find(candidate => candidate.source === "user_split");
  const sourceIds = newGroup?.provenance?.source_group_ids || [];
  const sourceOwners = newGroup?.provenance?.source_group_by_variable;
  if (!newGroup || !sourceIds.length || !sourceOwners) return null;
  const residuals = sourceIds.map(id => resultGroups.find(candidate => candidate.group_id === id));
  if (residuals.some(candidate => !candidate)) return null;
  const eligibleIds = [newGroup, ...residuals].flatMap(candidate => candidate.variable_ids || []);
  if (eligibleIds.some(id => !sourceIds.includes(sourceOwners[id]))) return null;
  return { splitId, newGroup, residuals };
}

export function updateSplitCategories(project, {
  sourceGroupIds, newGroupId, newLabel, residualLabels = {}, newVariableIds,
  timestamp, role, splitId,
}) {
  const sourceIds = [...new Set(sourceGroupIds || [])];
  const context = editableSplitContext(project, newGroupId);
  if (!context || context.splitId !== splitId
    || sourceIds.length !== context.residuals.length
    || sourceIds.some(id => !context.residuals.some(group => group.group_id === id))) {
    throw new Error("All categories produced by this split must still exist before it can be edited.");
  }
  const { newGroup, residuals } = context;
  const resultIds = new Set([newGroupId, ...sourceIds]);
  const eligible = new Set([newGroup, ...residuals].flatMap(group => group.variable_ids || []));
  const carved = new Set(newVariableIds || []);
  if (!carved.size || [...carved].some(id => !eligible.has(id))) {
    throw new Error("The new variable must contain only variables from this split.");
  }
  const ownerByVariable = new Map(Object.entries(newGroup.provenance?.source_group_by_variable || {}));
  for (const residual of residuals) {
    for (const id of residual.variable_ids || []) ownerByVariable.set(id, residual.group_id);
  }
  if ([...eligible].some(id => !ownerByVariable.has(id))) {
    throw new Error("This split predates editable split provenance and cannot be safely reconstructed.");
  }
  const nextGroups = project.groups.map(group => {
    if (!resultIds.has(group.group_id)) return group;
    if (group.group_id === newGroupId) return { ...group,
      label: String(newLabel || "").trim(), variable_ids: [...carved],
      seed_variable_ids: [...carved], type: role || group.type, updated_at: timestamp };
    const variable_ids = [...eligible].filter(id => !carved.has(id) && ownerByVariable.get(id) === group.group_id);
    if (!variable_ids.length) throw new Error(`The leftover for ${group.label || group.group_id} cannot be empty.`);
    const label = String(residualLabels[group.group_id] || "").trim();
    if (!label) throw new Error(`Name the leftover for ${group.label || group.group_id}.`);
    return { ...group, label, variable_ids, updated_at: timestamp };
  });
  const labels = nextGroups.map(group => String(group.label || "").trim().toLowerCase()).filter(Boolean);
  if (!String(newLabel || "").trim()) throw new Error("Name the new variable.");
  if (new Set(labels).size !== labels.length) throw new Error("Category names must be unique.");
  return { ...project, groups: nextGroups,
    decisions: [...(project.decisions || []), {
      decision_id: `decision_${(project.decisions || []).length + 1}`,
      type: "split_categories_updated", timestamp,
      payload: { split_id: splitId, source_group_ids: sourceIds, new_group_id: newGroupId },
    }],
  };
}
