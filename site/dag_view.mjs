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

export function excludedForConnectivity(link) {
  return link.display_status === "excluded" && !link.is_target_relation;
}

export function deriveDagView({
  groups = [],
  links = [],
  ivId = null,
  dvId = null,
  instrumentId = null,
  maxPathLength = 1,
  excludeBottlenecked = false,
  filterByCausalRelevance = false,
  showConfoundersOnly = false,
  showCollidersOnly = false,
  showExclusionViolations = false,
  hideIrrelevantDiagnosticLinks = false,
} = {}) {
  const fullGraph = createGraph(groups.map((group) => group.group_id), links);
  const connectivityGraph = filterGraphLinks(fullGraph, (link) => !excludedForConnectivity(link));
  const traversableLink = (link) => !excludedForConnectivity(link);
  const diagnosticOptions = {
    ivId,
    dvId,
    maxPathLength,
    excludeBottlenecked,
    traversableLink,
  };
  const confounderGraph = filterGraphByConfounders(fullGraph, diagnosticOptions);
  const colliderGraph = filterGraphByColliders(fullGraph, diagnosticOptions);
  const exclusionGraph = filterGraphByExclusionViolations(fullGraph, {
    instrumentId, ivId, dvId, maxPathLength, traversableLink,
  });
  const componentGraph = connectedComponentGraph(connectivityGraph, ivId);
  const canFilterFromIv = filterByCausalRelevance && connectivityGraph.nodeIds.has(ivId);
  const anchorsReady = fullGraph.nodeIds.has(ivId) && fullGraph.nodeIds.has(dvId) && ivId !== dvId;

  let selectedGraph;
  if (showExclusionViolations && anchorsReady && instrumentId) selectedGraph = exclusionGraph;
  else if (showConfoundersOnly && anchorsReady) selectedGraph = confounderGraph;
  else if (showCollidersOnly && anchorsReady) selectedGraph = colliderGraph;
  else selectedGraph = canFilterFromIv ? componentGraph : fullGraph;

  const componentGroupIds = new Set(selectedGraph.nodeIds);
  let visibleGraph = filterGraphNodes(fullGraph, componentGroupIds);
  visibleGraph = filterGraphLinks(visibleGraph, (link) => {
    return link.display_status !== "excluded" || link.is_target_relation;
  });
  if (showExclusionViolations && instrumentId) {
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
    confounders: confounderGraph.metadata,
    colliders: colliderGraph.metadata,
    exclusionViolations: exclusionGraph.metadata,
  };
}
