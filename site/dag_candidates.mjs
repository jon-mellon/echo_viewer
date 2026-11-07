import { pairKey } from "./dag_link_aggregation.mjs";

const ROLE_PRIORITY = [
  "possible_confounder",
  "possible_mediator",
  "possible_common_consequence_or_collider",
  "other_possible_cause_of_dv",
  "other_possible_cause_of_iv",
];

export function centroid(variableIds, variableById) {
  const points = variableIds.map(id => variableById.get(id)).filter(Boolean);
  if (!points.length) return { x: 0, y: 0 };
  return { x: points.reduce((sum, v) => sum + v.map_x, 0) / points.length,
    y: points.reduce((sum, v) => sum + v.map_y, 0) / points.length };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function compareFiniteNumbers(left, right) {
  const tolerance = Number.EPSILON * Math.max(Math.abs(left), Math.abs(right), Number.MIN_VALUE) * 128;
  return Math.abs(left - right) <= tolerance ? 0 : left < right ? -1 : 1;
}

export function groupCoherence(variableIds, similarityEdgeMap) {
  if (variableIds.length <= 1) return 1;
  // Compiled publications omit raw similarity edges. Avoid generating every
  // variable pair when there cannot be a matching weight.
  if (!similarityEdgeMap.size) return 0;
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
  const outgoing = new Map();
  for (const [key, links] of linkLookup) {
    if (!links.length) continue;
    const separator = key.indexOf("->");
    if (separator < 0) continue;
    const source = key.slice(0, separator), target = key.slice(separator + 2);
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    outgoing.get(source).add(target);
  }
  const iv = project.groups.find(g => g.group_id === project.iv_group_id);
  const dv = project.groups.find(g => g.group_id === project.dv_group_id);
  // All proximity comparisons within this calculation use the same group
  // memberships and variable positions. Compute each centroid only once.
  const centroids = new Map();
  const groupCentroid = group => {
    if (!centroids.has(group)) centroids.set(group, centroid(group.variable_ids, variables));
    return centroids.get(group);
  };
  return {
    iv, dv,
    hasAnyMapping: (a, b) => {
      const targets = new Set(b);
      return a.some(source => [...(outgoing.get(source) || [])].some(target => targets.has(target)));
    },
    groupCoherence: ids => groupCoherence(ids, similarityEdgeMap),
    groupProximity: (g, x, y) => Math.min(
      distance(groupCentroid(g), groupCentroid(x)),
      distance(groupCentroid(g), groupCentroid(y))),
  };
}

export function buildCandidateQueue(project, inputs) {
  const { iv, dv, hasAnyMapping, groupCoherence, groupProximity } = candidateContext(project, inputs);
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
    if (cToX && cToY) { roles.push("possible_confounder"); why.push(`${group.label} → cause; ${group.label} → outcome`); }
    if (xToC && cToY) { roles.push("possible_mediator"); why.push(`Cause → ${group.label} → outcome`); }
    if (xToC && yToC) { roles.push("possible_common_consequence_or_collider"); why.push(`Cause → ${group.label} ← outcome`); }
    if (cToY && !xConnected) { roles.push("other_possible_cause_of_dv"); why.push(`${group.label} → outcome`); }
    if (cToX && !yConnected) { roles.push("other_possible_cause_of_iv"); why.push(`${group.label} → cause`); }
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
