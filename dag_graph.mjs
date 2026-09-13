/**
 * Pure graph transformations used by the DAG viewer.
 *
 * A graph is `{ nodeIds: Set<string>, links: Array<object>, metadata: object }`.
 * Every transformation returns a new graph and never mutates its input. Links
 * retain their source order so shortest-path tie breaking remains stable.
 */

export function createGraph(nodeIds = [], links = [], metadata = {}) {
  return {
    nodeIds: new Set(nodeIds),
    links: [...links],
    metadata: { ...metadata },
  };
}

export function filterGraphNodes(graph, retainedNodeIds) {
  const retained = new Set(retainedNodeIds);
  const nodeIds = new Set([...graph.nodeIds].filter((nodeId) => retained.has(nodeId)));
  const links = graph.links.filter(
    (link) => nodeIds.has(link.group_a) && nodeIds.has(link.group_b),
  );
  return createGraph(nodeIds, links, graph.metadata);
}

export function filterGraphLinks(graph, predicate) {
  return createGraph(graph.nodeIds, graph.links.filter(predicate), graph.metadata);
}

export function connectedComponentGraph(graph, startId) {
  if (!graph.nodeIds.has(startId)) return createGraph([], [], graph.metadata);
  const adjacency = new Map([...graph.nodeIds].map((nodeId) => [nodeId, new Set()]));
  for (const link of graph.links) {
    if (!adjacency.has(link.group_a) || !adjacency.has(link.group_b)) continue;
    adjacency.get(link.group_a).add(link.group_b);
    adjacency.get(link.group_b).add(link.group_a);
  }
  const componentIds = new Set();
  const stack = [startId];
  while (stack.length) {
    const nodeId = stack.pop();
    if (componentIds.has(nodeId)) continue;
    componentIds.add(nodeId);
    for (const adjacentId of adjacency.get(nodeId) || []) stack.push(adjacentId);
  }
  return filterGraphNodes(graph, componentIds);
}

export function filterGraphByLinkPairs(graph, retainedPairKeys) {
  const pairs = new Set(retainedPairKeys);
  return filterGraphLinks(graph, (link) => pairs.has(pairKey(link.group_a, link.group_b)));
}

export function confounderPathNodeRole(metadata, nodeId, { ivId, dvId }) {
  if (nodeId === ivId) return "iv";
  if (nodeId === dvId) return "dv";
  if (metadata.confounderIds?.has(nodeId)) return "confounder";
  if (metadata.pathIds?.has(nodeId)) return "mediator";
  return "other";
}

export function highlightedBidirectionalArrowDirections(segmentFrom, segmentTo, relevantTargets) {
  const targets = new Set(relevantTargets || []);
  return {
    to: !String(segmentTo).startsWith("__route__") && targets.has(segmentTo),
    from: !String(segmentFrom).startsWith("__route__") && targets.has(segmentFrom),
  };
}

export function filterGraphByConfounders(graph, options) {
  const {
    ivId,
    dvId,
    maxPathLength = 1,
    excludeBottlenecked = false,
    traversableLink = () => true,
  } = options;
  const emptyMetadata = {
    confounderIds: new Set(),
    pathIds: new Set(),
    pathsByGroup: new Map(),
    linkPairKeys: new Set(),
    bottleneckedIds: new Set(),
  };
  if (!graph.nodeIds.has(ivId) || !graph.nodeIds.has(dvId)) {
    return createGraph([], [], emptyMetadata);
  }

  const outgoing = directedOutgoing(graph, traversableLink);

  function pathWithout(startId, targetId, blockedIds, maxDepth) {
    const seen = new Set([startId, ...blockedIds]);
    const parent = new Map();
    const queue = [{ nodeId: startId, depth: 0 }];
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const { nodeId: currentId, depth } = queue[queueIndex];
      queueIndex += 1;
      if (depth >= maxDepth) continue;
      for (const childId of outgoing.get(currentId) || []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        parent.set(childId, currentId);
        if (childId === targetId) {
          const path = [targetId];
          while (path[0] !== startId) path.unshift(parent.get(path[0]));
          return path;
        }
        queue.push({ nodeId: childId, depth: depth + 1 });
      }
    }
    return null;
  }

  function qualifyingWitnessPaths(startId, pathToIv, pathToDv) {
    const pathKey = (path) => path.join("->");
    const ivOptions = [pathToIv];
    const dvOptions = [pathToDv];
    const seenIv = new Set([pathKey(pathToIv)]);
    const seenDv = new Set([pathKey(pathToDv)]);

    for (const intermediateId of pathToIv.slice(1, -1)) {
      const alternative = pathWithout(startId, ivId, [dvId, intermediateId], maxPathLength);
      if (alternative && !seenIv.has(pathKey(alternative))) {
        seenIv.add(pathKey(alternative));
        ivOptions.push(alternative);
      }
    }
    for (const intermediateId of pathToDv.slice(1, -1)) {
      const alternative = pathWithout(startId, dvId, [ivId, intermediateId], maxPathLength);
      if (alternative && !seenDv.has(pathKey(alternative))) {
        seenDv.add(pathKey(alternative));
        dvOptions.push(alternative);
      }
    }

    for (const ivPath of ivOptions) {
      const dvPath = pathWithout(startId, dvId, [ivId, ...ivPath.slice(1, -1)], maxPathLength);
      if (dvPath) return { toIv: ivPath, toDv: dvPath };
    }
    for (const dvPath of dvOptions) {
      const ivPath = pathWithout(startId, ivId, [dvId, ...dvPath.slice(1, -1)], maxPathLength);
      if (ivPath) return { toIv: ivPath, toDv: dvPath };
    }
    return null;
  }

  const confounderIds = new Set();
  const pathIds = new Set([ivId, dvId]);
  const pathsByGroup = new Map();
  const linkPairKeys = new Set();
  const bottleneckedIds = new Set();
  for (const nodeId of graph.nodeIds) {
    if (nodeId === ivId || nodeId === dvId) continue;
    // Paths through the other anchor do not establish a common-ancestor role.
    const pathToIv = pathWithout(nodeId, ivId, [dvId], maxPathLength);
    const pathToDv = pathWithout(nodeId, dvId, [ivId], maxPathLength);
    if (!pathToIv || !pathToDv) continue;
    const qualifyingPaths = qualifyingWitnessPaths(nodeId, pathToIv, pathToDv);
    const isBottlenecked = !qualifyingPaths;
    if (isBottlenecked) bottleneckedIds.add(nodeId);
    if (excludeBottlenecked && isBottlenecked) continue;

    confounderIds.add(nodeId);
    const displayedPaths = excludeBottlenecked
      ? qualifyingPaths
      : { toIv: pathToIv, toDv: pathToDv };
    pathsByGroup.set(nodeId, displayedPaths);
    for (const pathNodeId of [...displayedPaths.toIv, ...displayedPaths.toDv]) {
      pathIds.add(pathNodeId);
    }
    for (const key of [...pathPairKeys(displayedPaths.toIv), ...pathPairKeys(displayedPaths.toDv)]) {
      linkPairKeys.add(key);
    }
  }

  const resultMetadata = {
    confounderIds,
    pathIds,
    pathsByGroup,
    linkPairKeys,
    bottleneckedIds,
  };
  return filterGraphNodes(createGraph(graph.nodeIds, graph.links, resultMetadata), pathIds);
}

export function filterGraphByColliders(graph, options) {
  const reversedGraph = createGraph(
    graph.nodeIds,
    graph.links.map((link) => ({
      ...link,
      direction_type: reverseDirection(link.direction_type),
    })),
    graph.metadata,
  );
  const reversedResult = filterGraphByConfounders(reversedGraph, {
    ...options,
  });
  const reversedMetadata = reversedResult.metadata;
  const pathsByGroup = new Map(
    [...reversedMetadata.pathsByGroup].map(([nodeId, paths]) => [nodeId, {
      fromIv: [...paths.toIv].reverse(),
      fromDv: [...paths.toDv].reverse(),
    }]),
  );
  const resultMetadata = {
    colliderIds: reversedMetadata.confounderIds,
    pathIds: reversedMetadata.pathIds,
    pathsByGroup,
    linkPairKeys: reversedMetadata.linkPairKeys,
    bottleneckedIds: reversedMetadata.bottleneckedIds,
  };
  return filterGraphNodes(
    createGraph(graph.nodeIds, graph.links, resultMetadata),
    resultMetadata.pathIds,
  );
}

function reverseDirection(direction) {
  if (direction === "A_TO_B") return "B_TO_A";
  if (direction === "B_TO_A") return "A_TO_B";
  return direction;
}

function directedOutgoing(graph, traversableLink) {
  const outgoing = new Map([...graph.nodeIds].map((nodeId) => [nodeId, new Set()]));
  for (const link of graph.links) {
    if (!traversableLink(link)) continue;
    const { group_a: groupA, group_b: groupB, direction_type: direction } = link;
    if (!outgoing.has(groupA) || !outgoing.has(groupB)) continue;
    if (direction === "A_TO_B" || direction === "BIDIRECTIONAL") outgoing.get(groupA).add(groupB);
    if (direction === "B_TO_A" || direction === "BIDIRECTIONAL") outgoing.get(groupB).add(groupA);
  }
  return outgoing;
}

function pathPairKeys(path) {
  const keys = new Set();
  for (let index = 0; index < path.length - 1; index += 1) {
    keys.add(pairKey(path[index], path[index + 1]));
  }
  return keys;
}

function pairKey(a, b) {
  return [a, b].sort().join("__");
}
