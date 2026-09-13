import { centroid, computeVoronoiCells, distance, worldToScreen } from "./map_geometry.mjs";
import { rawLinksBetween, pairKey } from "./dag_link_aggregation.mjs";

const ROLE_PRIORITY = [
  "possible_confounder",
  "possible_mediator",
  "possible_common_consequence_or_collider",
  "other_possible_cause_of_dv",
  "other_possible_cause_of_iv",
  "near_iv_dv_map_region",
];

function compareFiniteNumbers(left, right) {
  const tolerance = Number.EPSILON * Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE) * 128;
  return Math.abs(left - right) <= tolerance ? 0 : left < right ? -1 : 1;
}

export function groupCoherence(variableIds, similarityEdgeMap) {
  if (variableIds.length <= 1) return 1;
  const weights = [];
  for (let i = 0; i < variableIds.length; i += 1) {
    for (let j = i + 1; j < variableIds.length; j += 1) {
      const w = similarityEdgeMap.get(pairKey(variableIds[i], variableIds[j]));
      if (Number.isFinite(w)) weights.push(w);
    }
  }
  return weights.length ? weights.reduce((s, w) => s + w, 0) / weights.length : 0;
}

function candidateContext(project, { variables, similarityEdgeMap, linkLookup }) {
  const iv = project.groups.find(g => g.group_id === project.iv_group_id);
  const dv = project.groups.find(g => g.group_id === project.dv_group_id);
  const groupSites = project.groups
    .filter(group => group.variable_ids?.length)
    .map(group => ({ id: group.group_id, ...centroid(group.variable_ids, variables) }));
  const groupCells = computeVoronoiCells(groupSites);
  const targetOwners = new Set([iv, dv]
    .filter(Boolean)
    .map(group => groupCells.ownerById.get(group.group_id) ?? group.group_id));
  const nearTargetGroupIds = new Set();
  for (const group of project.groups) {
    const owner = groupCells.ownerById.get(group.group_id) ?? group.group_id;
    if (targetOwners.has(owner)) {
      nearTargetGroupIds.add(group.group_id);
      continue;
    }
    if ([...targetOwners].some(target => groupCells.adjacency.get(target)?.has(owner))) {
      nearTargetGroupIds.add(group.group_id);
    }
  }
  return {
    iv, dv,
    hasAnyMapping: (a, b) => rawLinksBetween(a, b, linkLookup).length > 0,
    groupCoherence: ids => groupCoherence(ids, similarityEdgeMap),
    groupProximity: (g, x, y) => Math.min(
      distance(centroid(g.variable_ids, variables), centroid(x.variable_ids, variables)),
      distance(centroid(g.variable_ids, variables), centroid(y.variable_ids, variables))),
    isNearTarget: group => nearTargetGroupIds.has(group.group_id),
  };
}

export function buildCandidateQueue(project, inputs) {
  const { iv, dv, hasAnyMapping, groupCoherence, groupProximity, isNearTarget } = candidateContext(project, inputs);
  if (!iv?.variable_ids?.length || !dv?.variable_ids?.length) {
    return [];
  }
  const queue = [];
  for (const group of project.groups) {
    if (!group.variable_ids?.length || [iv.group_id, dv.group_id].includes(group.group_id)) continue;
    const cToX = hasAnyMapping(group.variable_ids, iv.variable_ids);
    const cToY = hasAnyMapping(group.variable_ids, dv.variable_ids);
    const xToC = hasAnyMapping(iv.variable_ids, group.variable_ids);
    const yToC = hasAnyMapping(dv.variable_ids, group.variable_ids);
    const xConnected = cToX || xToC;
    const yConnected = cToY || yToC;
    const roles = [];
    const why = [];
    if (cToX && cToY) { roles.push("possible_confounder"); why.push(`${group.label} → IV group; ${group.label} → DV group`); }
    if (xToC && cToY) { roles.push("possible_mediator"); why.push(`IV group → ${group.label} → DV group`); }
    if (xToC && yToC) { roles.push("possible_common_consequence_or_collider"); why.push(`IV group → ${group.label} ← DV group`); }
    if (cToY && !xConnected) { roles.push("other_possible_cause_of_dv"); why.push(`${group.label} → DV group`); }
    if (cToX && !yConnected) { roles.push("other_possible_cause_of_iv"); why.push(`${group.label} → IV group`); }
    if (!roles.length && isNearTarget(group)) {
      roles.push("near_iv_dv_map_region");
      why.push("Shares a map-region boundary with the IV or DV group");
    }
    if (!roles.length) continue;
    const orderedRoles = roles.sort((a, b) => ROLE_PRIORITY.indexOf(a) - ROLE_PRIORITY.indexOf(b));
    queue.push({
      group_id: group.group_id,
      label: group.label,
      roles: orderedRoles,
      why,
      variable_count: group.variable_ids.length,
      similarity_coherence: Number(group.similarity_coherence || groupCoherence(group.variable_ids)),
      proximity: groupProximity(group, iv, dv),
    });
  }
  queue.sort((a, b) => {
    const r = ROLE_PRIORITY.indexOf(a.roles[0]) - ROLE_PRIORITY.indexOf(b.roles[0]);
    if (r) return r;
    const coherenceOrder = compareFiniteNumbers(
      Number(b.similarity_coherence || 0), Number(a.similarity_coherence || 0),
    );
    if (coherenceOrder) return coherenceOrder;
    const proximityOrder = compareFiniteNumbers(Number(a.proximity || 0), Number(b.proximity || 0));
    if (proximityOrder) return proximityOrder;
    return a.label.localeCompare(b.label) || a.group_id.localeCompare(b.group_id);
  });
  return queue.slice(0, 80);
}

export function createDensityCandidateGroup(project, inputs, { visibleVariables, transform, width, height, groupId, createdAt, updatedAt = createdAt }) {
  const { iv, dv, hasAnyMapping, groupCoherence } = candidateContext(project, inputs);
  if (!iv || !dv) return null;
  const isCausallyRelevantToTarget = ids => hasAnyMapping(ids, iv.variable_ids)
    || hasAnyMapping(iv.variable_ids, ids) || hasAnyMapping(ids, dv.variable_ids) || hasAnyMapping(dv.variable_ids, ids);
  const assignedIds = new Set(project.groups.filter(g => g.variable_ids?.length).flatMap((g) => g.variable_ids));
  const relevant = visibleVariables
    .filter((v) => !assignedIds.has(v.variable_id))
    .filter((v) => isCausallyRelevantToTarget([v.variable_id]));
  if (!relevant.length) return null;
  const visible = relevant.filter((v) => {
    const s = worldToScreen(v.map_x, v.map_y, transform);
    return s.x >= 0 && s.x <= width && s.y >= 0 && s.y <= height;
  });
  const pool = visible.length >= 4 ? visible : relevant;
  const members = densestNeighborhood(pool, 12).map(variable => variable.variable_id);
  const group = {
    group_id: groupId,
    label: "Causally relevant dense area",
    variable_ids: members,
    seed_variable_ids: members.slice(),
    excluded_nearby_variable_ids: [],
    boundary_geometry: { polygons: [] },
    notes: "Created after skipping imported grouping schema.",
    type: "candidate",
    created_at: createdAt,
    updated_at: updatedAt,
    source_grouping_set_id: "",
    source_group_id: "",
    similarity_coherence: groupCoherence(members),
  };
  return group;
}

/**
 * Return the fixed-size neighbourhood with the smallest k-nearest-neighbour
 * radius. This is a scale-free density estimator: multiplying every coordinate
 * by the same positive constant cannot change the selected variables.
 */
export function densestNeighborhood(variables, neighborhoodSize = 12) {
  if (!variables.length || neighborhoodSize <= 0) return [];
  const size = Math.min(variables.length, Math.max(1, Math.floor(neighborhoodSize)));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const variable of variables) {
    minX = Math.min(minX, variable.map_x); maxX = Math.max(maxX, variable.map_x);
    minY = Math.min(minY, variable.map_y); maxY = Math.max(maxY, variable.map_y);
  }
  const scale = Math.max(maxX - minX, maxY - minY) || 1;
  const normalized = variables.map(variable => ({
    variable,
    x: (variable.map_x - minX) / scale,
    y: (variable.map_y - minY) / scale,
  }));
  let best = null;
  for (const center of normalized) {
    const nearest = [];
    for (const neighbor of normalized) {
      const dx = neighbor.x - center.x;
      const dy = neighbor.y - center.y;
      const item = { variable: neighbor.variable, distanceSquared: dx * dx + dy * dy };
      let index = nearest.findIndex(candidate => compareFiniteNumbers(item.distanceSquared, candidate.distanceSquared) < 0
        || (compareFiniteNumbers(item.distanceSquared, candidate.distanceSquared) === 0
          && String(item.variable.variable_id).localeCompare(String(candidate.variable.variable_id)) < 0));
      if (index < 0) index = nearest.length;
      if (index < size) nearest.splice(index, 0, item);
      if (nearest.length > size) nearest.pop();
    }
    const radiusSquared = nearest[nearest.length - 1]?.distanceSquared ?? 0;
    const meanDistanceSquared = nearest.reduce((sum, item) => sum + item.distanceSquared, 0) / nearest.length;
    const candidate = { center: center.variable, nearest, radiusSquared, meanDistanceSquared };
    if (!best
      || compareFiniteNumbers(candidate.radiusSquared, best.radiusSquared) < 0
      || (compareFiniteNumbers(candidate.radiusSquared, best.radiusSquared) === 0
        && compareFiniteNumbers(candidate.meanDistanceSquared, best.meanDistanceSquared) < 0)
      || (compareFiniteNumbers(candidate.radiusSquared, best.radiusSquared) === 0
        && compareFiniteNumbers(candidate.meanDistanceSquared, best.meanDistanceSquared) === 0
        && String(candidate.center.variable_id).localeCompare(String(best.center.variable_id)) < 0)) {
      best = candidate;
    }
  }
  return best.nearest.map(item => item.variable);
}
