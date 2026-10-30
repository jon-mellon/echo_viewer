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
  return new Set((rawLinkIds || []).flatMap(id => {
    const evidence = edgeSupportById.get(id) || rawLinksById.get(id);
    return evidence?.paper_id && isPresentLink(evidence) ? [evidence.paper_id] : [];
  }));
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
  const retainedLinks = excludeSparseEdges ? links.filter(link => presentPaperIds(
    [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])], edgeSupportById, rawLinksById,
  ).size >= minimumEdgePapers) : links;
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
