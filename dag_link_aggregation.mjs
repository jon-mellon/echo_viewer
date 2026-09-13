// Pure derived links. Ordering, target-pair direction and evidence IDs follow the viewer rules.
export const linkKey = (sourceId, targetId) => `${sourceId}->${targetId}`;
export const pairKey = (a, b) => [a, b].sort().join("__");
export const edgeKey = (a, b) => `${a}__${b}`;

export function aggregateGroupLinks({ project, linkLookup, rawLinksById }) {
  const groups = project.groups.filter(g => g.variable_ids?.length);
  const iv = project.groups.find(g => g.group_id === project.iv_group_id);
  const dv = project.groups.find(g => g.group_id === project.dv_group_id);
  const evidenceByEdge = indexGroupLinkEvidence(groups, iv, dv, linkLookup, project.manual_edges);
  return [...evidenceByEdge.values()].map(({ groupA, groupB, targetPair, aToB, bToA }) => {
    const manual = manualFlagsForPair(groupA.group_id, groupB.group_id, project.manual_edges);
    const edgeId = edgeKey(groupA.group_id, groupB.group_id);
    const decision = project.link_decisions[edgeId] || null;
    return {
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
      a_to_b_paper_table_keys: paperTableKeys(aToB, rawLinksById),
      b_to_a_paper_table_keys: paperTableKeys(bToA, rawLinksById),
      display_status: decision?.display_status || "active_by_default",
      user_decision: decision,
    };
  }).sort((a, b) => a.edge_id.localeCompare(b.edge_id));
}

// Index only group pairs that have evidence. The previous implementation scanned
// every group pair and every cross-product of their members, even though causal
// mappings are sparse. Rank tuples retain rawLinksBetween's exact evidence order.
function indexGroupLinkEvidence(groups, iv, dv, linkLookup, manualEdges) {
  const groupById = new Map(groups.map(group => [group.group_id, group]));
  const owners = new Map();
  const positions = new Map();
  for (const group of groups) {
    positions.set(group.group_id, new Map(group.variable_ids.map((id, index) => [id, index])));
    for (const variableId of group.variable_ids) {
      if (!owners.has(variableId)) owners.set(variableId, []);
      owners.get(variableId).push(group);
    }
  }

  const indexed = new Map();
  const ensure = (first, second) => {
    const targetPair = Boolean(iv && dv && pairKey(first.group_id, second.group_id) === pairKey(iv.group_id, dv.group_id));
    const [groupA, groupB] = targetPair
      ? [iv, dv]
      : [first, second].sort((a, b) => a.group_id.localeCompare(b.group_id));
    const edgeId = edgeKey(groupA.group_id, groupB.group_id);
    if (!indexed.has(edgeId)) indexed.set(edgeId, {
      groupA, groupB, targetPair, aRanks: new Map(), bRanks: new Map(),
    });
    return indexed.get(edgeId);
  };

  if (iv && dv && groupById.has(iv.group_id) && groupById.has(dv.group_id)) ensure(iv, dv);
  for (const edge of manualEdges || []) {
    if (edge.deleted) continue;
    const source = groupById.get(edge.source_group_id);
    const target = groupById.get(edge.target_group_id);
    if (source && target && source !== target) ensure(source, target);
  }

  for (const [key, rawIds] of linkLookup) {
    const separator = key.indexOf("->");
    if (separator < 0) continue;
    const sourceId = key.slice(0, separator);
    const targetId = key.slice(separator + 2);
    const sourceGroups = owners.get(sourceId) || [];
    const targetGroups = owners.get(targetId) || [];
    for (const sourceGroup of sourceGroups) for (const targetGroup of targetGroups) {
      if (sourceGroup === targetGroup) continue;
      const item = ensure(sourceGroup, targetGroup);
      const forward = sourceGroup.group_id === item.groupA.group_id;
      const ranks = forward ? item.aRanks : item.bRanks;
      const sourcePosition = positions.get(sourceGroup.group_id).get(sourceId);
      const targetPosition = positions.get(targetGroup.group_id).get(targetId);
      for (let rawPosition = 0; rawPosition < rawIds.length; rawPosition += 1) {
        const rawId = rawIds[rawPosition];
        const rank = [sourcePosition, targetPosition, rawPosition];
        const prior = ranks.get(rawId);
        if (!prior || compareRank(rank, prior) < 0) ranks.set(rawId, rank);
      }
    }
  }

  return new Map([...indexed].map(([edgeId, item]) => [edgeId, {
    groupA: item.groupA,
    groupB: item.groupB,
    targetPair: item.targetPair,
    aToB: [...item.aRanks].sort((a, b) => compareRank(a[1], b[1])).map(([id]) => id),
    bToA: [...item.bRanks].sort((a, b) => compareRank(a[1], b[1])).map(([id]) => id),
  }]));
}

function compareRank(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
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

function manualFlagsForPair(groupAId, groupBId, manualEdges) {
  const out = { aToB: false, bToA: false, edgeIds: [] };
  for (const edge of manualEdges) {
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

export function paperTableKeys(rawLinkIds, rawLinksById) {
  const seen = new Set();
  for (const id of rawLinkIds) {
    const link = rawLinksById.get(id);
    if (!link) continue;
    seen.add(`${link.paper_id || "unknown"}::${link.within_table_occurrence_id || "unknown"}`);
  }
  return [...seen].sort();
}

export function rawLinksBetween(sourceIds, targetIds, linkLookup) {
  const targets = new Set(targetIds);
  const ids = [];
  for (const sourceId of sourceIds) {
    for (const targetId of targets) {
      const found = linkLookup.get(linkKey(sourceId, targetId));
      if (found) ids.push(...found);
    }
  }
  return [...new Set(ids)];
}
