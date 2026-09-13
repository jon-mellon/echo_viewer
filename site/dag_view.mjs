import {
  connectedComponentGraph,
  createGraph,
  filterGraphByColliders,
  filterGraphByConfounders,
  filterGraphByLinkPairs,
  filterGraphLinks,
  filterGraphNodes,
} from "./dag_graph.mjs";

export function excludedForConnectivity(link) {
  return link.display_status === "excluded" && !link.is_manual && !link.is_target_relation;
}

export function deriveDagView({
  groups = [],
  links = [],
  ivId = null,
  dvId = null,
  maxPathLength = 1,
  excludeBottlenecked = false,
  filterByCausalRelevance = false,
  showConfoundersOnly = false,
  showCollidersOnly = false,
  hideIrrelevantDiagnosticLinks = false,
} = {}) {
  const fullGraph = createGraph(groups.map((group) => group.group_id), links);
  const connectivityGraph = filterGraphLinks(fullGraph, (link) => !excludedForConnectivity(link));
  const traversableLink = (link) => !excludedForConnectivity(link) && link.display_status !== "hidden";
  const diagnosticOptions = {
    ivId,
    dvId,
    maxPathLength,
    excludeBottlenecked,
    traversableLink,
  };
  const confounderGraph = filterGraphByConfounders(fullGraph, diagnosticOptions);
  const colliderGraph = filterGraphByColliders(fullGraph, diagnosticOptions);
  const componentGraph = connectedComponentGraph(connectivityGraph, ivId);
  const canFilterFromIv = filterByCausalRelevance && connectivityGraph.nodeIds.has(ivId);

  let selectedGraph;
  if (showConfoundersOnly) selectedGraph = confounderGraph;
  else if (showCollidersOnly) selectedGraph = colliderGraph;
  else selectedGraph = canFilterFromIv ? componentGraph : fullGraph;

  const componentGroupIds = new Set(selectedGraph.nodeIds);
  let visibleGraph = filterGraphNodes(fullGraph, componentGroupIds);
  visibleGraph = filterGraphLinks(visibleGraph, (link) => {
    if (link.display_status === "hidden") return false;
    return link.display_status !== "excluded" || link.is_manual || link.is_target_relation;
  });
  if ((showConfoundersOnly || showCollidersOnly) && hideIrrelevantDiagnosticLinks) {
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
  };
}
