import { CLAIM_STATUSES, diagnosticKey, scopedDecisions } from "./confounder_status.mjs";

export const effectKey = ({ sourceId, targetId }) => JSON.stringify([sourceId, targetId]);

export function directedEffects(links, { includeExcluded = false } = {}) {
  return (links || []).flatMap(link => {
    if (!includeExcluded && link.display_status === "excluded") return [];
    const effects = [];
    if (["A_TO_B", "BIDIRECTIONAL"].includes(link.direction_type)) effects.push({ sourceId: link.group_a, targetId: link.group_b });
    if (["B_TO_A", "BIDIRECTIONAL"].includes(link.direction_type)) effects.push({ sourceId: link.group_b, targetId: link.group_a });
    return effects;
  });
}

export function activeStudyDecisions(project, omitKey = null) {
  return ["confounders", "exclusion"].flatMap(kind => scopedDecisions(project, kind)
    .filter(row => row.key !== omitKey).map(row => ({ ...row, kind })));
}

/** Baseline groups and evidence links remain immutable. Decisions compose by provenance. */
export function effectiveStudyGraph(project, { omitKey = null } = {}) {
  const decisions = activeStudyDecisions(project, omitKey);
  const anchors = new Set([project.iv_group_id, project.dv_group_id, project.instrument_group_id]);
  const removed = new Set(decisions.filter(row => row.status === "removed_other" && !anchors.has(row.groupId)).map(row => row.groupId));
  const groups = (project.groups || []).filter(group => !removed.has(group.group_id));
  const ids = new Set(groups.map(group => group.group_id));
  const claims = decisions.filter(row => CLAIM_STATUSES.has(row.status) && ids.has(row.groupId));
  const rejected = new Set(claims.flatMap(row => (row.rejected_effects || []).map(effectKey)));
  const links = (project.links || []).flatMap(link => {
    if (!ids.has(link.group_a) || !ids.has(link.group_b)) return [];
    const effects = directedEffects([link], { includeExcluded: true }).filter(effect => !rejected.has(effectKey(effect)));
    if (!effects.length) return [];
    const direction = effects.length === 2 ? "BIDIRECTIONAL" : effects[0].sourceId === link.group_a ? "A_TO_B" : "B_TO_A";
    return [direction === link.direction_type ? link : { ...link, direction_type: direction }];
  });
  const present = new Set(directedEffects(links).map(effectKey));
  for (const row of claims) for (const effect of row.asserted_effects || []) {
    const key = effectKey(effect);
    if (!ids.has(effect.sourceId) || !ids.has(effect.targetId) || effect.sourceId === effect.targetId || present.has(key)) continue;
    present.add(key);
    links.push({ edge_id: `__claim__${key}`, group_a: effect.sourceId, group_b: effect.targetId,
      direction_type: "A_TO_B", display_status: "active", is_user_claim: true, claim_key: row.key,
      a_to_b_raw_link_ids: [], b_to_a_raw_link_ids: [],
      a_to_b_paper_table_keys: [], b_to_a_paper_table_keys: [] });
  }
  return { groups, links, removed, claims };
}

function adjacency(effects, blocked, reverse = false) {
  const graph = new Map();
  for (const effect of effects) {
    if (effect.sourceId === blocked || effect.targetId === blocked) continue;
    const from = reverse ? effect.targetId : effect.sourceId;
    const to = reverse ? effect.sourceId : effect.targetId;
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  }
  return graph;
}

function reachable(graph, start) {
  const seen = new Set([start]), queue = [start];
  for (let index = 0; index < queue.length; index++) for (const next of graph.get(queue[index]) || []) {
    if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}

/** A cycle-safe witness; a via-X claim rejects every route that avoids X. */
export function bypassPath(effects, source, target, x) {
  if (source === x || target === x) return null;
  const graph = adjacency(effects, x), parents = new Map([[source, null]]), queue = [source];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    if (from === target) {
      const path = []; let current = target;
      while (current !== null) { path.unshift(current); current = parents.get(current); }
      return path;
    }
    for (const next of graph.get(from) || []) if (!parents.has(next)) { parents.set(next, from); queue.push(next); }
  }
  return null;
}

/** Simple paths from source to target that avoid x, shortest first. Bounded, so dense or cyclic graphs stay quick. */
export function bypassPaths(effects, source, target, x, { limit = 20, maxEdges = 6, budget = 20000 } = {}) {
  if (source === x || target === x) return { paths: [], truncated: false };
  const graph = adjacency(effects, x), found = [];
  let steps = 0, truncated = false;
  // Deepen one edge at a time so the shortest paths are found before the budget runs out.
  for (let edges = 1; edges <= maxEdges && found.length <= limit && !truncated; edges++) {
    const walk = (node, path, seen) => {
      if (found.length > limit || ++steps > budget) { truncated = true; return; }
      if (path.length - 1 === edges) { if (node === target) found.push([...path]); return; }
      for (const next of graph.get(node) || []) {
        if (seen.has(next) || (next === target && path.length !== edges)) continue;
        seen.add(next); path.push(next);
        walk(next, path, seen);
        path.pop(); seen.delete(next);
      }
    };
    walk(source, [source], new Set([source]));
  }
  return { paths: found.slice(0, limit), truncated: truncated || found.length > limit };
}

export function graphClaimPreview(project, kind, groupId, status) {
  if (!CLAIM_STATUSES.has(status)) throw new Error("Choose a graph-claim disposition.");
  const key = diagnosticKey(project, kind, groupId);
  const graph = effectiveStudyGraph(project, { omitKey: key });
  const ids = new Set(graph.groups.map(group => group.group_id));
  const x = project.iv_group_id;
  const source = status === "instrument_only_via_x" ? project.instrument_group_id : groupId;
  const target = status === "instrument_only_via_x" ? groupId : project.dv_group_id;
  if (![x, source, target].every(id => ids.has(id)) || new Set([x, source, target]).size !== 3) {
    throw new Error("The study variables needed for this claim are not available.");
  }
  const effects = [...new Map(directedEffects(graph.links).map(effect => [effectKey(effect), effect])).values()];
  const forward = reachable(adjacency(effects, x), source);
  const backward = reachable(adjacency(effects, x, true), target);
  const candidates = effects.filter(effect => effect.sourceId !== x && effect.targetId !== x
    && effect.sourceId !== target && effect.targetId !== source
    && forward.has(effect.sourceId) && backward.has(effect.targetId));
  // Only a direct bypass has one unambiguous edge to reject.
  const suggested = candidates.filter(effect => effect.sourceId === source && effect.targetId === target);
  const assertedExists = effects.some(effect => effect.sourceId === source && effect.targetId === x);
  return { key, kind, groupId, status, source, target, x, effects, candidates, suggested, assertedExists,
    asserted: [{ sourceId: source, targetId: x }],
    scope: [project.iv_group_id, project.dv_group_id, ...(kind === "exclusion" ? [project.instrument_group_id] : [])] };
}

export function claimConflicts(project, preview, rejectedEffects) {
  const asserted = new Set(preview.asserted.map(effectKey));
  const rejected = new Set(rejectedEffects.map(effectKey));
  return activeStudyDecisions(project, preview.key).flatMap(row => {
    if (!CLAIM_STATUSES.has(row.status)) return [];
    return [...(row.rejected_effects || []).filter(effect => asserted.has(effectKey(effect))),
      ...(row.asserted_effects || []).filter(effect => rejected.has(effectKey(effect)))].map(effect => ({ ...effect, decisionKey: row.key, groupId: row.groupId }));
  });
}

export function confirmGraphClaim(project, preview, rejectedEffects) {
  const current = graphClaimPreview(project, preview.kind, preview.groupId, preview.status);
  if (JSON.stringify(current.scope) !== JSON.stringify(preview.scope)) throw new Error("The study changed. Reopen the claim preview.");
  const allowed = new Set(current.candidates.map(effectKey));
  const rejected = [...new Map(rejectedEffects.map(effect => [effectKey(effect), effect])).values()];
  if (rejected.some(effect => !allowed.has(effectKey(effect)))) throw new Error("The graph changed. Reopen the claim preview.");
  const removed = new Set(rejected.map(effectKey));
  const remaining = current.effects.filter(effect => !removed.has(effectKey(effect)));
  const path = bypassPath(remaining, current.source, current.target, current.x);
  if (path) throw new Error("A path still bypasses X. Select the direct effects to reject on that path.");
  return { status: preview.status, rejected_effects: rejected, asserted_effects: current.asserted };
}
