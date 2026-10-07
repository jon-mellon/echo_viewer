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
  exclusionMaxPathLength = maxPathLength,
  excludeBottlenecked = false,
  filterByCausalRelevance = false,
  showConfoundersOnly = false,
  showCollidersOnly = false,
  showExclusionViolations = false,
  showExogeneity = false,
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
    instrumentId, ivId, dvId, maxPathLength: exclusionMaxPathLength, traversableLink,
  });
  const exogeneityGraph = filterGraphByConfounders(fullGraph, {
    ...diagnosticOptions, ivId: instrumentId,
  });
  if (instrumentId && fullGraph.nodeIds.has(instrumentId) && fullGraph.nodeIds.has(ivId)) {
    exogeneityGraph.nodeIds.add(ivId);
    exogeneityGraph.metadata.pathIds.add(ivId);
  }
  const componentGraph = connectedComponentGraph(connectivityGraph, ivId);
  const canFilterFromIv = filterByCausalRelevance && connectivityGraph.nodeIds.has(ivId);
  const anchorsReady = fullGraph.nodeIds.has(ivId) && fullGraph.nodeIds.has(dvId) && ivId !== dvId;

  let selectedGraph;
  if (showExogeneity && anchorsReady && instrumentId) selectedGraph = exogeneityGraph;
  else if (showExclusionViolations && anchorsReady && instrumentId) selectedGraph = exclusionGraph;
  else if (showConfoundersOnly && anchorsReady) selectedGraph = confounderGraph;
  else if (showCollidersOnly && anchorsReady) selectedGraph = colliderGraph;
  else selectedGraph = canFilterFromIv ? componentGraph : fullGraph;

  const componentGroupIds = new Set(selectedGraph.nodeIds);
  let visibleGraph = filterGraphNodes(fullGraph, componentGroupIds);
  visibleGraph = filterGraphLinks(visibleGraph, (link) => {
    return link.display_status !== "excluded" || link.is_target_relation;
  });
  if (showExogeneity && instrumentId && hideIrrelevantDiagnosticLinks) {
    visibleGraph = filterGraphByLinkPairs(visibleGraph, exogeneityGraph.metadata.linkPairKeys);
  } else if (showExclusionViolations && instrumentId) {
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
    exogeneity: exogeneityGraph.metadata,
  };
}
