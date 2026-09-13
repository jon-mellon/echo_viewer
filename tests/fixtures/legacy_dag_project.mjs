// Frozen before the project/aggregation extraction. Change expectations explicitly
// when changing domain rules; do not update this oracle to conceal a regression.
export function legacyAggregate(input) {
  const state = { ...input, project: structuredClone(input.project) };
  const linkKey = (a, b) => `${a}->${b}`;
  const pairKey = (a, b) => [a, b].sort().join("__");
  const edgeKey = (a, b) => `${a}__${b}`;
function aggregateGroupLinks() {
  const groups = dagGroups();
  const linksByKey = new Map();
  const iv = groupById(state.project.iv_group_id);
  const dv = groupById(state.project.dv_group_id);
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const g1 = groups[i];
      const g2 = groups[j];
      const targetPair = iv && dv && pairKey(g1.group_id, g2.group_id) === pairKey(iv.group_id, dv.group_id);
      const groupA = targetPair ? iv : [g1, g2].sort((a, b) => a.group_id.localeCompare(b.group_id))[0];
      const groupB = targetPair ? dv : [g1, g2].sort((a, b) => a.group_id.localeCompare(b.group_id))[1];
      const aToB = rawLinksBetween(groupA.variable_ids, groupB.variable_ids);
      const bToA = rawLinksBetween(groupB.variable_ids, groupA.variable_ids);
      const manual = manualFlagsForPair(groupA.group_id, groupB.group_id);
      if (!targetPair && !aToB.length && !bToA.length && !manual.aToB && !manual.bToA) continue;
      const edgeId = edgeKey(groupA.group_id, groupB.group_id);
      const decision = state.project.link_decisions[edgeId] || null;
      const link = {
        edge_id: edgeId,
        group_a: groupA.group_id,
        group_b: groupB.group_id,
        is_target_relation: Boolean(targetPair),
        target_direction: targetPair ? "group_a_to_group_b" : "",
        edge_source: edgeSource(aToB.length || bToA.length, manual.aToB || manual.bToA),
        is_manual: Boolean(manual.aToB || manual.bToA),
        manual_edge_ids: manual.edgeIds,
        mapping_a_to_b_exists: aToB.length > 0,
        mapping_b_to_a_exists: bToA.length > 0,
        manual_a_to_b_exists: manual.aToB,
        manual_b_to_a_exists: manual.bToA,
        direction_type: directionType(aToB.length > 0 || manual.aToB, bToA.length > 0 || manual.bToA, targetPair),
        a_to_b_raw_link_ids: aToB,
        b_to_a_raw_link_ids: bToA,
        a_to_b_paper_table_keys: paperTableKeys(aToB),
        b_to_a_paper_table_keys: paperTableKeys(bToA),
        display_status: decision?.display_status || "active_by_default",
        user_decision: decision,
      };
      linksByKey.set(edgeId, link);
    }
  }
  state.project.links = [...linksByKey.values()].sort((a, b) => a.edge_id.localeCompare(b.edge_id));
}

function edgeSource(hasMapping, hasManual) {
  if (hasMapping && hasManual) return "mapping_and_manual";
  if (hasManual) return "user_manual";
  return "mapping_derived";
}

function directionType(aToB, bToA, targetPair) {
  const forward = aToB || targetPair;
  if (forward && bToA) return "BIDIRECTIONAL";
  if (forward) return "A_TO_B";
  if (bToA) return "B_TO_A";
  return "NO_MAPPING_LINK";
}

function manualFlagsForPair(groupAId, groupBId) {
  const out = { aToB: false, bToA: false, edgeIds: [] };
  for (const edge of state.project.manual_edges) {
    if (edge.deleted) continue;
    if (pairKey(edge.source_group_id, edge.target_group_id) !== pairKey(groupAId, groupBId)) continue;
    out.edgeIds.push(edge.edge_id);
    const sourceIsA = edge.source_group_id === groupAId;
    if (edge.direction === "bidirectional") { out.aToB = true; out.bToA = true; }
    else if (sourceIsA) out.aToB = true;
    else out.bToA = true;
  }
  return out;
}

function paperTableKeys(rawLinkIds) {
  const seen = new Set();
  for (const id of rawLinkIds) {
    const link = state.rawLinksById.get(id);
    if (!link) continue;
    seen.add(`${link.paper_id || "unknown"}::${link.within_table_occurrence_id || "unknown"}`);
  }
  return [...seen].sort();
}

function rawLinksBetween(sourceIds, targetIds) {
  const targets = new Set(targetIds);
  const ids = [];
  for (const sourceId of sourceIds) {
    for (const targetId of targets) {
      const found = state.linkLookup.get(linkKey(sourceId, targetId));
      if (found) ids.push(...found);
    }
  }
  return [...new Set(ids)];
}

function dagGroups() {
  return state.project.groups.filter((g) => g.variable_ids?.length);
}

function groupById(groupId) {
  return state.project.groups.find((g) => g.group_id === groupId) || null;
}
  aggregateGroupLinks();
  return state.project.links;
}
export function legacyGroupOperation(project, operation, args, timestamp, clusterOf = new Map(), clusterMembers = new Map(), linkLookup = new Map()) {
  const state = { project: structuredClone(project), linkLookup };
  const nowIso = () => timestamp;
  const clusterRep = id => clusterOf.get(id) || id;
  const clusterMemberIds = id => clusterMembers.get(clusterRep(id)) || [id];
  const linkKey = (a, b) => `${a}->${b}`;
  const activeGroupingSet = () => args[0];
  const hasAnyMapping = (a, b) => rawLinksBetween(a, b).length > 0;
function dagGroups() {
  return state.project.groups.filter((g) => g.variable_ids?.length);
}

function groupById(groupId) {
  return state.project.groups.find((g) => g.group_id === groupId) || null;
}

function promoteGroupToAnchor(side, groupId) {
  if (!['iv', 'dv'].includes(side)) return false;
  const anchorKey = side === "dv" ? "dv_group_id" : "iv_group_id";
  const oppositeId = side === "dv" ? state.project.iv_group_id : state.project.dv_group_id;
  const replacement = groupById(groupId);
  if (!replacement || groupId === oppositeId) return false;
  const previous = groupById(state.project[anchorKey]);
  if (previous && previous.group_id !== groupId) previous.type = null;
  replacement.type = side;
  replacement.updated_at = nowIso();
  state.project[anchorKey] = groupId;
  return true;
}

function normalizeProjectDuplicateAssignments() {
  if (!state.project) return;
  // A merged construct can belong to only one group. Preserve the first existing
  // owner, then expand that ownership to every underlying variable in the cluster.
  const ownerByRep = new Map();
  for (const group of state.project.groups || []) {
    for (const variableId of group.variable_ids || []) {
      const repId = clusterRep(variableId);
      if (!ownerByRep.has(repId)) ownerByRep.set(repId, group.group_id);
    }
  }
  for (const group of state.project.groups || []) {
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
  state.project.rejected_variables = (state.project.rejected_variables || []).map((entry) => {
    const repId = clusterRep(entry.variable_id);
    return {
      ...entry,
      variable_id: repId,
      member_variable_ids: clusterMemberIds(repId).slice(),
    };
  });
}

function applyActiveGroupingSet() {
  const groupingSet = activeGroupingSet();
  if (!groupingSet) return [];
  const iv = groupById(state.project.iv_group_id);
  const dv = groupById(state.project.dv_group_id);
  const anchorsReady = Boolean(iv?.variable_ids?.length && dv?.variable_ids?.length);
  if (!anchorsReady) state.filterDagByCausalRelevance = false;
  const ivDvIds = anchorsReady ? new Set([...iv.variable_ids, ...dv.variable_ids]) : new Set();
  const assignedIds = new Set(dagGroups().flatMap((g) => g.variable_ids));
  const existingSourceIds = new Set(state.project.groups.map((g) => `${g.source_grouping_set_id || ""}::${g.source_group_id || ""}`));
  const loadedGroupIds = [];
  for (const sourceGroup of groupingSet.groups || []) {
    const sourceKey = `${groupingSet.grouping_set_id}::${sourceGroup.group_id}`;
    if (existingSourceIds.has(sourceKey)) continue;
    const removed = (sourceGroup.variable_ids || []).filter((id) => ivDvIds.has(id));
    const remaining = (sourceGroup.variable_ids || []).filter((id) => !assignedIds.has(id));
    if (!remaining.length) {
      if (anchorsReady && removed.length) recordCarveOut(groupingSet, sourceGroup, removed, iv, dv);
      continue;
    }
    if (anchorsReady && !isCausallyRelevantToTarget(remaining)) {
      if (removed.length) recordCarveOut(groupingSet, sourceGroup, removed, iv, dv);
      continue;
    }
    if (anchorsReady && removed.length) recordCarveOut(groupingSet, sourceGroup, removed, iv, dv);
    const importedGroupId = `schema_${sourceGroup.group_id}`;
    state.project.groups.push({
      group_id: importedGroupId,
      label: sourceGroup.label || "Imported group",
      variable_ids: remaining,
      seed_variable_ids: remaining.slice(),
      excluded_nearby_variable_ids: [],
      boundary_geometry: {},
      notes: sourceGroup.notes || "",
      type: "candidate",
      created_at: nowIso(),
      updated_at: nowIso(),
      source_grouping_set_id: groupingSet.grouping_set_id,
      source_group_id: sourceGroup.group_id,
      similarity_coherence: Number(sourceGroup.similarity_coherence || 0),
    });
    loadedGroupIds.push(importedGroupId);
  }
  return loadedGroupIds;
}

function recordCarveOut(groupingSet, sourceGroup, removed, iv, dv) {
  const key = `${groupingSet.grouping_set_id}::${sourceGroup.group_id}`;
  if (state.project.carve_outs.some((c) => `${c.source_grouping_set_id}::${c.source_group_id}` === key)) return;
  const removedToGroups = {};
  for (const variableId of removed) {
    removedToGroups[variableId] = dv.variable_ids.includes(variableId) ? dv.group_id : iv.group_id;
  }
  state.project.carve_outs.push({
    source_grouping_set_id: groupingSet.grouping_set_id,
    source_group_id: sourceGroup.group_id,
    removed_variable_ids: removed,
    removed_to_groups: removedToGroups,
  });
}

function isCausallyRelevantToTarget(variableIds) {
  const iv = groupById(state.project.iv_group_id);
  const dv = groupById(state.project.dv_group_id);
  if (!iv || !dv) return false;
  return hasAnyMapping(variableIds, iv.variable_ids)
    || hasAnyMapping(iv.variable_ids, variableIds)
    || hasAnyMapping(variableIds, dv.variable_ids)
    || hasAnyMapping(dv.variable_ids, variableIds);
}

function rawLinksBetween(sourceIds, targetIds) {
  const targets = new Set(targetIds);
  const ids = [];
  for (const sourceId of sourceIds) {
    for (const targetId of targets) {
      const found = state.linkLookup.get(linkKey(sourceId, targetId));
      if (found) ids.push(...found);
    }
  }
  return [...new Set(ids)];
}
  const operations = { promoteGroupToAnchor, normalizeProjectDuplicateAssignments, applyActiveGroupingSet };
  const result = operations[operation](...args);
  return { project: state.project, result };
}

