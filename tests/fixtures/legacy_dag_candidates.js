// Frozen pre-extraction candidate algorithms.
const ROLE_PRIORITY = [
  "possible_confounder",
  "possible_mediator",
  "possible_common_consequence_or_collider",
  "other_possible_cause_of_dv",
  "other_possible_cause_of_iv",
  "near_iv_dv_map_region",
];

function createDensityCandidateGroup() {
  const assignedIds = new Set(dagGroups().flatMap((g) => g.variable_ids));
  const relevant = visibleVariables()
    .filter((v) => !assignedIds.has(v.variable_id))
    .filter((v) => isCausallyRelevantToTarget([v.variable_id]));
  if (!relevant.length) return null;
  const visible = relevant.filter((v) => {
    const s = worldToScreen(v.map_x, v.map_y);
    return s.x >= 0 && s.x <= canvasWidth() && s.y >= 0 && s.y <= canvasHeight();
  });
  const pool = visible.length >= 4 ? visible : relevant;
  let best = pool[0];
  let bestScore = -1;
  for (const v of pool) {
    const score = pool.reduce((sum, other) => {
      if (other.variable_id === v.variable_id) return sum;
      return sum + (Math.hypot(other.map_x - v.map_x, other.map_y - v.map_y) <= 0.09 ? 1 : 0);
    }, 0);
    if (score > bestScore) { best = v; bestScore = score; }
  }
  const members = pool
    .map((v) => ({ v, dist: Math.hypot(v.map_x - best.map_x, v.map_y - best.map_y) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 12)
    .map((item) => item.v.variable_id);
  const group = {
    group_id: `density_${Date.now()}`,
    label: "Causally relevant dense area",
    variable_ids: members,
    seed_variable_ids: members.slice(),
    excluded_nearby_variable_ids: [],
    boundary_geometry: { polygons: [] },
    notes: "Created after skipping imported grouping schema.",
    type: "candidate",
    created_at: nowIso(),
    updated_at: nowIso(),
    source_grouping_set_id: "",
    source_group_id: "",
    similarity_coherence: groupCoherence(members),
  };
  ensureGroup(group);
  addDecision("density_candidate_created", { group_id: group.group_id, variable_ids: members });
  return group;
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

function buildCandidateQueue() {
  const iv = groupById(state.project.iv_group_id);
  const dv = groupById(state.project.dv_group_id);
  if (!iv?.variable_ids?.length || !dv?.variable_ids?.length) {
    state.candidateQueue = [];
    state.project.candidate_queue = [];
    return;
  }
  const queue = [];
  for (const group of state.project.groups) {
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
    if (!roles.length && nearTargetMapRegion(group, iv, dv)) { roles.push("near_iv_dv_map_region"); why.push("Close to IV/DV in similarity map"); }
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
    const c = Number(b.similarity_coherence || 0) - Number(a.similarity_coherence || 0);
    if (Math.abs(c) > 1e-9) return c;
    const p = Number(a.proximity || 0) - Number(b.proximity || 0);
    if (Math.abs(p) > 1e-9) return p;
    return a.label.localeCompare(b.label) || a.group_id.localeCompare(b.group_id);
  });
  state.candidateQueue = queue.slice(0, 80);
  state.project.candidate_queue = state.candidateQueue;
}

function groupCoherence(variableIds) {
  if (variableIds.length <= 1) return 1;
  const weights = [];
  for (let i = 0; i < variableIds.length; i += 1) {
    for (let j = i + 1; j < variableIds.length; j += 1) {
      const w = state.similarityEdgeMap.get(pairKey(variableIds[i], variableIds[j]));
      if (Number.isFinite(w)) weights.push(w);
    }
  }
  return weights.length ? weights.reduce((s, w) => s + w, 0) / weights.length : 0;
}

function nearTargetMapRegion(group, iv, dv) { return groupProximity(group, iv, dv) < 900; }

function groupProximity(group, iv, dv) {
  const c = groupCentroid(group.variable_ids);
  const x = groupCentroid(iv.variable_ids);
  const y = groupCentroid(dv.variable_ids);
  return Math.min(distance(c, x), distance(c, y));
}
