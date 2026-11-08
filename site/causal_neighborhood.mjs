// Pure traversal for the causes and consequences views. Group links carry
// evidence in each direction; a hop counts when that direction is supported by
// at least `minPapers` distinct papers and the link is traversable by the same
// rule the identification diagrams use.
import { directionalPaperCounter, excludedForConnectivity } from "./dag_view.mjs";

export { directionalPaperCounter };

export const MAX_NEIGHBORHOOD_DEPTH = 4;

/** Links whose paper keys an edit dropped; only these need per-finding records. */
export function linksNeedingExactCounts(links = []) {
  return links.filter(link => !Array.isArray(link.a_to_b_paper_table_keys) || !Array.isArray(link.b_to_a_paper_table_keys));
}

/** Directed hops `from → to` with their paper support. */
export function directedHops(links = [], minPapers = 1, papersFor = directionalPaperCounter()) {
  const hops = [];
  for (const link of links) {
    if (excludedForConnectivity(link) || link.group_a === link.group_b) continue;
    const direction = link.direction_type;
    if (direction === "A_TO_B" || direction === "BIDIRECTIONAL") {
      const papers = papersFor(link, true);
      if (papers >= minPapers) hops.push({ from: link.group_a, to: link.group_b, papers, edgeId: link.edge_id });
    }
    if (direction === "B_TO_A" || direction === "BIDIRECTIONAL") {
      const papers = papersFor(link, false);
      if (papers >= minPapers) hops.push({ from: link.group_b, to: link.group_a, papers, edgeId: link.edge_id });
    }
  }
  return hops;
}

/**
 * Variables that cause (`causes`) or are caused by (`consequences`) the focus
 * within `depth` directed hops. Each result keeps its shortest distance and,
 * among the shortest paths, the one whose weakest hop has the most papers.
 * `path` runs in causal order, ending (causes) or starting (consequences) at
 * the focus; `pathEdgeIds` names the link behind each hop in the same order,
 * and `edgeId` is the link joining the variable to its neighbour toward the
 * focus, which is the evidence for why it belongs in the list.
 * `isNode` lets callers leave out groups that are not drawn (such as "other").
 * `isPassable` lets callers keep a variable in the results without following
 * routes through it, as when the user excludes it from the map.
 */
export function causalNeighborhood({ links = [], focusId, direction = "causes", depth = 1, minPapers = 2,
  papersFor = directionalPaperCounter(), isNode = () => true, isPassable = () => true } = {}) {
  if (!focusId) return [];
  const limit = Math.max(1, Math.min(MAX_NEIGHBORHOOD_DEPTH, Math.trunc(depth) || 1));
  const towardFocus = new Map();
  for (const hop of directedHops(links, Math.max(1, Math.trunc(minPapers) || 1), papersFor)) {
    if (!isNode(hop.from) || !isNode(hop.to)) continue;
    // Causes walk backwards from the focus; consequences walk forwards.
    const [near, far] = direction === "causes" ? [hop.to, hop.from] : [hop.from, hop.to];
    if (!towardFocus.has(near)) towardFocus.set(near, []);
    towardFocus.get(near).push({ node: far, papers: hop.papers, edgeId: hop.edgeId });
  }
  const distance = new Map([[focusId, 0]]);
  const best = new Map([[focusId, { strength: Infinity, next: null, papers: Infinity }]]);
  let frontier = [focusId];
  for (let level = 1; level <= limit && frontier.length; level++) {
    const reached = new Map();
    for (const near of frontier) {
      const nearStrength = best.get(near).strength;
      for (const { node, papers, edgeId } of towardFocus.get(near) || []) {
        if (distance.has(node) && distance.get(node) < level) continue;
        const strength = Math.min(nearStrength, papers);
        const current = reached.get(node);
        if (!current || strength > current.strength
          || (strength === current.strength && String(near) < String(current.next))) {
          reached.set(node, { strength, next: near, papers, edgeId });
        }
      }
    }
    for (const [node, entry] of reached) {
      distance.set(node, level);
      best.set(node, entry);
    }
    frontier = [...reached.keys()].filter(isPassable);
  }
  const results = [];
  for (const [node, level] of distance) {
    if (node === focusId) continue;
    const chain = [node], edgeIds = [];
    for (let cursor = node; cursor !== focusId;) {
      edgeIds.push(best.get(cursor).edgeId);
      cursor = best.get(cursor).next;
      chain.push(cursor);
    }
    const causal = direction === "causes";
    results.push({ groupId: node, distance: level, papers: best.get(node).papers,
      weakestPapers: best.get(node).strength, edgeId: edgeIds[0],
      path: causal ? chain : chain.reverse(), pathEdgeIds: causal ? edgeIds : edgeIds.reverse() });
  }
  return results.sort((a, b) => a.distance - b.distance || b.weakestPapers - a.weakestPapers
    || b.papers - a.papers || String(a.groupId).localeCompare(String(b.groupId)));
}

/**
 * Checks a claim that `confounderId` affects `outcomeId` only via `mediatorId`
 * against the graph, up to distance 2. Returns the other routes already in the
 * data that contradict it: a direct `confounder → outcome` link, and every
 * `confounder → z → outcome` path where z is neither the claimed mediator, the
 * confounder nor the outcome. `claimHolds` is false when any are found; it only
 * speaks for these short routes, since longer ones are not searched.
 * `isNode` and `minPapers` work as in `causalNeighborhood`.
 */
export function checkOnlyViaClaim({ links = [], confounderId, mediatorId, outcomeId, minPapers = 1,
  papersFor = directionalPaperCounter(), isNode = () => true } = {}) {
  const hops = directedHops(links, Math.max(1, Math.trunc(minPapers) || 1), papersFor)
    .filter(hop => isNode(hop.from) && isNode(hop.to));
  const strongest = (from, to) => hops.filter(hop => hop.from === from && hop.to === to)
    .reduce((best, hop) => (!best || hop.papers > best.papers ? hop : best), null);
  const toOutcome = new Map();
  for (const hop of hops) if (hop.to === outcomeId) toOutcome.set(hop.from, hop);
  const direct = toOutcome.get(confounderId) || null;
  const viaOthers = [];
  for (const first of hops) {
    if (first.from !== confounderId) continue;
    const z = first.to;
    if (z === mediatorId || z === outcomeId || z === confounderId) continue;
    const second = toOutcome.get(z);
    if (!second) continue;
    const firstBest = strongest(confounderId, z);
    viaOthers.push({ viaId: z, path: [confounderId, z, outcomeId], pathEdgeIds: [firstBest.edgeId, second.edgeId],
      weakestPapers: Math.min(firstBest.papers, second.papers) });
  }
  const unique = [...new Map(viaOthers.map(route => [route.viaId, route])).values()]
    .sort((a, b) => b.weakestPapers - a.weakestPapers || String(a.viaId).localeCompare(String(b.viaId)));
  return { claimHolds: !direct && !unique.length, direct, otherPaths: unique };
}

/**
 * Checks a claim that `confounderId` is not needed in the adjustment set by
 * looking for open backdoor routes through it: a directed arm to the IV and a
 * directed arm to the outcome, each at most `maxArmLength` links, that share no
 * group except the confounder, contain no group in `controlledIds` and do not
 * pass through the IV or the outcome (iv ← … ← k → … → dv). Arms are searched
 * only up to that length, so `claimHolds` speaks for those routes alone.
 * Each route lists the arms (confounder first), the link behind each hop and
 * a display string; routes come shortest first and at most `maxRoutes` are
 * returned, with `totalRoutes` giving the full count.
 */
export function checkAdjustmentClaim({ links = [], confounderId, ivId, dvId, controlledIds = [], maxArmLength = 3,
  maxRoutes = 5, minPapers = 1, papersFor = directionalPaperCounter(), isNode = () => true } = {}) {
  const none = { claimHolds: true, openRoutes: [], totalRoutes: 0 };
  if (!confounderId || !ivId || !dvId || [ivId, dvId].includes(confounderId)) return none;
  const out = new Map();
  for (const hop of directedHops(links, Math.max(1, Math.trunc(minPapers) || 1), papersFor)) {
    if (!isNode(hop.from) || !isNode(hop.to)) continue;
    if (!out.has(hop.from)) out.set(hop.from, new Map());
    const known = out.get(hop.from).get(hop.to);
    if (!known || hop.papers > known.papers) out.get(hop.from).set(hop.to, hop);
  }
  const blocked = new Set(controlledIds);
  const arms = (target, other) => {
    const found = [];
    const walk = (path, edgeIds) => {
      const last = path.at(-1);
      if (last === target) { found.push({ path: [...path], edgeIds: [...edgeIds] }); return; }
      if (path.length > maxArmLength) return;
      for (const [next, hop] of out.get(last) || []) {
        if (path.includes(next) || next === other || blocked.has(next)) continue;
        walk([...path, next], [...edgeIds, hop.edgeId]);
      }
    };
    walk([confounderId], []);
    return found;
  };
  const toIv = arms(ivId, dvId), toDv = arms(dvId, ivId);
  const routes = [];
  for (const x of toIv) {
    const used = new Set(x.path.slice(1));
    for (const y of toDv) {
      if (y.path.slice(1).some(id => used.has(id))) continue;
      routes.push({ ivArm: x.path, dvArm: y.path, ivArmEdgeIds: x.edgeIds, dvArmEdgeIds: y.edgeIds,
        display: `${[...x.path].reverse().join(" ← ")} → ${y.path.slice(1).join(" → ")}` });
    }
  }
  routes.sort((a, b) => a.ivArm.length + a.dvArm.length - b.ivArm.length - b.dvArm.length
    || a.display.localeCompare(b.display));
  return { claimHolds: !routes.length, openRoutes: routes.slice(0, maxRoutes), totalRoutes: routes.length };
}
