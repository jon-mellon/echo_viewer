import { isPresentLink } from "./dag_link_aggregation.mjs";

import {
  connectedComponentGraph,
  createGraph,
  filterGraphByColliders,
  filterGraphByConfounders,
  filterGraphByExclusionViolations,
  filterGraphByLinkPairs,
  filterGraphLinks,
  filterGraphNodes,
} from "./dag_graph.mjs";

/** Distinct papers with a present finding among these raw links. */
export function presentPaperIds(rawLinkIds, edgeSupportById, rawLinksById = edgeSupportById) {
  const papers = new Set();
  // A plain loop, and the claim is only checked for a paper not yet counted:
  // this runs over every finding in the dataset, so allocation per finding showed.
  for (const id of rawLinkIds || []) {
    const evidence = edgeSupportById.get(id) || rawLinksById.get(id);
    const paper = evidence?.paper_id;
    if (paper && !papers.has(paper) && isPresentLink(evidence)) papers.add(paper);
  }
  return papers;
}

/**
 * Papers behind one direction of a link. The aggregated DAG already carries
 * them per direction (distinct papers among its paper/table keys), so nothing
 * is counted. An edge that a local edit touched carries no keys, because they
 * cannot be kept in step with its findings; those are counted exactly from
 * per-finding support records, when given.
 */
export function directionalPaperCounter(edgeSupportById = null, rawLinksById = edgeSupportById) {
  return (link, forward) => {
    const keys = forward ? link.a_to_b_paper_table_keys : link.b_to_a_paper_table_keys;
    if (Array.isArray(keys)) return new Set(keys.map(key => String(key).split("::")[0])).size;
    if (!edgeSupportById) return 0;
    return presentPaperIds(forward ? link.a_to_b_raw_link_ids : link.b_to_a_raw_link_ids,
      edgeSupportById, rawLinksById).size;
  };
}

const forwardDirections = new Set(["A_TO_B", "BIDIRECTIONAL"]);
const backwardDirections = new Set(["B_TO_A", "BIDIRECTIONAL"]);

/**
 * The link with only the directions that at least `minimum` papers support, or
 * null when neither does. Each direction is judged on its own evidence, as
 * Explore and the Papers column count it: findings for b → a do not support a → b.
 */
function sparseFiltered(link, minimum, papersFor) {
  if (link.is_user_claim) return link;
  const forward = forwardDirections.has(link.direction_type) && papersFor(link, true) >= minimum;
  const backward = backwardDirections.has(link.direction_type) && papersFor(link, false) >= minimum;
  if (forward && backward) return link;
  if (forward) return link.direction_type === "A_TO_B" ? link : { ...link, direction_type: "A_TO_B" };
  if (backward) return link.direction_type === "B_TO_A" ? link : { ...link, direction_type: "B_TO_A" };
  return null;
}

export function excludedForConnectivity(link) {
  return link.display_status === "excluded" && !link.is_target_relation;
}

// Diagnostic results depend on the graph and path settings, not the selected
// view. Reuse them when switching views, while checking the graph contents so
// in-place project edits cannot leave stale results behind.
let diagnosticCache;

export function deriveDagView({
  groups = [],
  links = [],
  ivId = null,
  dvId = null,
  instrumentId = null,
  maxPathLength = 1,
  exclusionMaxPathLength = maxPathLength,
  excludeBottlenecked = false,
  excludeSparseEdges = false,
  minimumEdgePapers = 2,
  rawLinksById = new Map(),
  edgeSupportById = rawLinksById,
  filterByCausalRelevance = false,
  showConfoundersOnly = false,
  showCollidersOnly = false,
  showExclusionViolations = false,
  showExogeneity = false,
  hideIrrelevantDiagnosticLinks = false,
  showAllExclusionLinks = false,
} = {}) {
  const papersFor = excludeSparseEdges && directionalPaperCounter(edgeSupportById, rawLinksById);
  const retainedLinks = excludeSparseEdges
    ? links.map(link => sparseFiltered(link, minimumEdgePapers, papersFor)).filter(Boolean) : links;
  const fullGraph = createGraph(groups.map((group) => group.group_id), retainedLinks);
  const traversableLink = (link) => !excludedForConnectivity(link);
  const diagnosticOptions = {
    ivId,
    dvId,
    maxPathLength,
    excludeBottlenecked,
    traversableLink,
  };
  const cacheKey = !excludeSparseEdges && JSON.stringify([
    [...fullGraph.nodeIds], retainedLinks.map(link => [link.group_a, link.group_b,
      link.direction_type, link.display_status, Boolean(link.is_target_relation)]),
    ivId, dvId, instrumentId,
    maxPathLength, exclusionMaxPathLength, excludeBottlenecked,
  ]);
  let diagnostics = cacheKey && diagnosticCache?.key === cacheKey ? diagnosticCache.value : null;
  if (!diagnostics) {
    const confounderGraph = filterGraphByConfounders(fullGraph, diagnosticOptions);
    const colliderGraph = filterGraphByColliders(fullGraph, diagnosticOptions);
    const exclusionGraph = filterGraphByExclusionViolations(fullGraph, {
      instrumentId, ivId, dvId, maxPathLength: exclusionMaxPathLength, traversableLink,
    });
    const exogeneityGraph = filterGraphByConfounders(fullGraph, {
      ...diagnosticOptions, ivId: instrumentId,
    });
    if (instrumentId && fullGraph.nodeIds.has(instrumentId) && fullGraph.nodeIds.has(ivId)) {
      exogeneityGraph.nodeIds.add(ivId);
      exogeneityGraph.metadata.pathIds.add(ivId);
    }
    diagnostics = { confounderGraph, colliderGraph, exclusionGraph, exogeneityGraph };
    diagnosticCache = cacheKey ? { key: cacheKey, value: diagnostics } : null;
  }
  const { confounderGraph, colliderGraph, exclusionGraph, exogeneityGraph } = diagnostics;
  const canFilterFromIv = filterByCausalRelevance && fullGraph.nodeIds.has(ivId);
  const anchorsReady = fullGraph.nodeIds.has(ivId) && fullGraph.nodeIds.has(dvId) && ivId !== dvId;

  let selectedGraph;
  if (showExogeneity && anchorsReady && instrumentId) selectedGraph = exogeneityGraph;
  else if (showExclusionViolations && anchorsReady && instrumentId) selectedGraph = exclusionGraph;
  else if (showConfoundersOnly && anchorsReady) selectedGraph = confounderGraph;
  else if (showCollidersOnly && anchorsReady) selectedGraph = colliderGraph;
  else selectedGraph = canFilterFromIv
    ? connectedComponentGraph(filterGraphLinks(fullGraph, traversableLink), ivId)
    : fullGraph;

  const componentGroupIds = new Set(selectedGraph.nodeIds);
  let visibleGraph = filterGraphNodes(fullGraph, componentGroupIds);
  visibleGraph = filterGraphLinks(visibleGraph, (link) => {
    return link.display_status !== "excluded" || link.is_target_relation;
  });
  if (showExogeneity && instrumentId && hideIrrelevantDiagnosticLinks) {
    visibleGraph = filterGraphByLinkPairs(visibleGraph, exogeneityGraph.metadata.linkPairKeys);
  } else if (showExclusionViolations && instrumentId && !showAllExclusionLinks) {
    visibleGraph = filterGraphByLinkPairs(visibleGraph, exclusionGraph.metadata.linkPairKeys);
  } else if (anchorsReady && (showConfoundersOnly || showCollidersOnly) && hideIrrelevantDiagnosticLinks) {
    const retainedPairs = showCollidersOnly
      ? colliderGraph.metadata.linkPairKeys
      : confounderGraph.metadata.linkPairKeys;
    visibleGraph = filterGraphByLinkPairs(visibleGraph, retainedPairs);
  }

  return {
    filterByCausalRelevance: canFilterFromIv,
    componentGroupIds,
    visibleLinks: visibleGraph.links,
    confounders: structuredClone(confounderGraph.metadata),
    colliders: structuredClone(colliderGraph.metadata),
    exclusionViolations: structuredClone(exclusionGraph.metadata),
    exogeneity: structuredClone(exogeneityGraph.metadata),
  };
}
