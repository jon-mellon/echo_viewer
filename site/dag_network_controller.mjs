import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";
import { computeDagRender } from "./dag_render_compute.mjs";
import { routesToVisData } from "./dag_vis_routing.mjs";
import { attachDagInteractions } from "./dag_interactions.mjs";
import * as dagDisplay from "./dag_display.mjs";
import * as workflow from "./dag_workflow.mjs";
import * as dagPathHighlights from "./dag_path_highlights.mjs";
import { STUDY_DESIGN_EDGE_ID } from "./dag_inspector_controller.mjs";

export function createDagNetworkController({
  state, elements: els, visApi, clusterRep, groupColor, dagGroups, groupById,
  drawMap, setMapMode, renderAll, selectEdge,
}) {
// ─── DAG visApi.js rendering ─────────────────────────────────────────────────────

let _visNetwork = null;
let _visNodes = null;
let _visEdges = null;
let _dagLayoutSignature = "";
let _dagEdgeSegments = new Map();
let _dagHoverBaseline = null;
let _dagHoveredConfounderId = null;
let _dagPathLaneSegments = [];
let _dagEdgeHoverBaseline = null;
let _dagHoveredLogicalEdgeId = null;

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function visNetworkOptions(p = {}) {
  const { fontSize=14, vMargin=8, hMargin=13, edgeWidth=1.25 } = p;
  return {
    interaction: {
      selectConnectedEdges: false,
      hover: true,
      tooltipDelay: 250,
      navigationButtons: false,
      keyboard: false,
    },
    layout: {
      improvedLayout: false,
      randomSeed: 20260614,
    },
    physics: { enabled: false },
    nodes: {
      font: {
        color: "#ffffff",
        size: fontSize,
        face: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        vadjust: -1,
      },
      borderWidth: 1.2,
      borderWidthSelected: 3,
      margin: { top: vMargin, right: hMargin, bottom: vMargin, left: hMargin },
      widthConstraint: { minimum: 92, maximum: p.nodeMaxWidth || 190 },
      shapeProperties: { borderRadius: 12 },
    },
    edges: {
      smooth: { type: "cubicBezier", forceDirection: "horizontal", roundness: 0.32 },
      width: edgeWidth,
      selectionWidth: 3.5,
      arrows: { to: { enabled: true, scaleFactor: Math.max(0.45, 0.7 * (fontSize / 14)) } },
      color: { color: "#7ba096", highlight: "#b83b5e", hover: "#805214", inherit: false, opacity: 0.48 },
    },
  };
}

function groupMapCentroid(group) {
  const points = (group.variable_ids || [])
    .map((id) => state.variableById.get(clusterRep(id)))
    .filter(Boolean)
    .map((variable) => ({ x: Number(variable.map_x || 0), y: Number(variable.map_y || 0) }));
  if (!points.length) return { x: 0, y: 0 };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function dagStudyArrowCorridor({ ivId, dvId, positions, boxes, fontSize = 12 }) {
  return studyArrowCorridor({ ivId, dvId, positions, boxes, fontSize });
}


function visNodeData(group, layoutPoint, layoutParams = {}) {
  return dagDisplay.visNodeData(group, layoutPoint, layoutParams, {
    showCollidersOnly: state.showCollidersOnly, showConfoundersOnly: state.showConfoundersOnly,
    colliderGroupIds: state.colliderGroupIds, colliderPathGroupIds: state.colliderPathGroupIds,
    confounderGroupIds: state.confounderGroupIds, confounderPathGroupIds: state.confounderPathGroupIds,
    ivId: state.project?.iv_group_id, dvId: state.project?.dv_group_id,
    activeGroupId: state.activeGroupId, groupColor: groupColor(group),
  });
}

function edgeVisualData(link) {
  return dagDisplay.edgeVisualData(link, state.selectedEdgeId);
}

function routedDagData(groups, links, layout) {
  const boxes = layout.boxes;
  const corridor = dagStudyArrowCorridor({
    ivId: state.project?.iv_group_id,
    dvId: state.project?.dv_group_id,
    positions: layout.positions,
    boxes,
    fontSize: layout.params.fontSize,
  });
  const routes = routeEdges(links, {
    positions: layout.positions,
    boxes,
    corridor,
  });
  return routedDagDataFromRoutes(groups, routes, layout);
}

function routedDagDataFromRoutes(groups, routes, layout) {
  const nodeData = groups.map((group) => visNodeData(group, layout.positions.get(group.group_id), layout.params));
  const routed = routesToVisData(routes, {
    edgeStyle: (link) => ({
      arrows: {
        to: { enabled: true, scaleFactor: 0.7 },
        from: link.direction_type === "BIDIRECTIONAL" ? { enabled: true, scaleFactor: 0.7 } : undefined,
      },
      ...edgeVisualData(link),
      smooth: { enabled: false },
    }),
    edgeTitle: edgeHoverText,
  });
  return { ...routed, nodeData: [...nodeData, ...routed.nodeData] };
}

function studyDesignEdgeData(groups) {
  const groupIds = new Set(groups.map((group) => group.group_id));
  const ivId = state.project?.iv_group_id;
  const dvId = state.project?.dv_group_id;
  if (!groupIds.has(ivId) || !groupIds.has(dvId) || ivId === dvId) return null;
  const evidence = state.project?.links?.find((link) => link.is_target_relation);
  const evidenceCount = evidence
    ? new Set([...(evidence.a_to_b_raw_link_ids || []), ...(evidence.b_to_a_raw_link_ids || [])]).size
    : 0;
  return {
    id: STUDY_DESIGN_EDGE_ID,
    from: ivId,
    to: dvId,
    arrows: { to: { enabled: true, scaleFactor: 1.15 } },
    color: {
      color: "#168a52",
      highlight: "#168a52",
      hover: "#168a52",
      inherit: false,
      opacity: 1,
    },
    width: 5.5,
    selectionWidth: 0,
    chosen: true,
    smooth: { enabled: false },
    shadow: { enabled: true, color: "rgba(22,138,82,0.32)", size: 8, x: 0, y: 1 },
    title: `Selected study relationship: IV → DV (not an evidence link). ${evidenceCount} evidence record(s) attached.`,
  };
}

function dagVisibleGroups() {
  const groups = dagGroups();
  return groups.filter((group) => state.componentGroupIds.has(group.group_id));
}

function drawConfounderPathLanes(context) {
  if (!_dagPathLaneSegments.length || !_visNetwork) return;
  const scale = Math.max(0.01, _visNetwork.getScale());
  const positions = _visNetwork.getPositions();
  const boxes = (_visNodes?.getIds() || []).filter(id => !String(id).startsWith("__route__")).map(id => {
    const b = _visNetwork.getBoundingBox(id);
    return { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top };
  });
  dagPathHighlights.drawPathLanes(context, {
    segments: _dagPathLaneSegments,
    positions,
    boxes,
    scale,
    ivId: state.project?.iv_group_id,
    dvId: state.project?.dv_group_id,
  });
}

function clearConfounderPathHover() {
  _dagPathLaneSegments = [];
  _dagHoveredConfounderId = null;
  if (!_dagHoverBaseline || !_visNodes || !_visEdges) {
    _visNetwork?.redraw();
    return;
  }
  _visNodes.update(_dagHoverBaseline.nodes);
  _visEdges.update(_dagHoverBaseline.edges);
  _dagHoverBaseline = null;
  _visNetwork?.redraw();
}

function clearLogicalDagEdgeHover() {
  if (!_dagEdgeHoverBaseline || !_visEdges) return;
  _visEdges.update(_dagEdgeHoverBaseline);
  _dagEdgeHoverBaseline = null;
  _dagHoveredLogicalEdgeId = null;
}

function highlightLogicalDagEdge(segmentId) {
  const logicalEdgeId = _dagEdgeSegments.get(segmentId) || segmentId;
  if (logicalEdgeId === STUDY_DESIGN_EDGE_ID) return;
  if (!logicalEdgeId || _dagHoveredLogicalEdgeId === logicalEdgeId || !_visEdges) return;
  clearLogicalDagEdgeHover();

  const segmentIds = _visEdges.getIds().filter(
    (edgeId) => (_dagEdgeSegments.get(edgeId) || edgeId) === logicalEdgeId
  );
  if (!segmentIds.length) return;
  _dagEdgeHoverBaseline = _visEdges.get(segmentIds).map((edge) => ({
    ...edge,
    shadow: edge.shadow || false,
  }));
  _dagHoveredLogicalEdgeId = logicalEdgeId;

  for (const edge of _dagEdgeHoverBaseline) {
    const hoverColor = "#9a5a0a";
    _visEdges.update({
      id: edge.id,
      color: {
        color: hoverColor,
        highlight: hoverColor,
        hover: hoverColor,
        inherit: false,
        opacity: 1,
      },
      width: Math.max(3.4, Number(edge.width || 1) + 2.2),
      shadow: { enabled: true, color: "rgba(154,90,10,0.32)", size: 7, x: 0, y: 0 },
    });
  }
}

function highlightConfounderPaths(groupId) {
  if (_dagHoveredConfounderId === groupId) return;
  clearConfounderPathHover();
  const candidateIds = state.showCollidersOnly
    ? state.colliderGroupIds
    : state.confounderGroupIds;
  if ((!state.showConfoundersOnly && !state.showCollidersOnly) || !candidateIds.has(groupId)) return;
  const rawPaths = state.showCollidersOnly
    ? state.colliderPathsByGroup.get(groupId)
    : state.confounderPathsByGroup.get(groupId);
  const paths = state.showCollidersOnly && rawPaths
    ? { toIv: rawPaths.fromIv, toDv: rawPaths.fromDv }
    : rawPaths;
  if (!paths || !_visNodes || !_visEdges) return;

  _dagHoverBaseline = {
    nodes: _visNodes.get().map((node) => ({ ...node, opacity: node.opacity ?? 1 })),
    edges: _visEdges.get().map((edge) => ({ ...edge, shadow: edge.shadow || false })),
  };
  _dagHoveredConfounderId = groupId;

  const model = dagPathHighlights.buildPathHighlightModel({
    paths,
    visibleLinks: state.visibleLinks,
    edges: _visEdges.get(),
    nodes: _visNodes.get(),
    edgeSegments: _dagEdgeSegments,
    studyDesignEdgeId: STUDY_DESIGN_EDGE_ID,
    groupId,
    ivId: state.project?.iv_group_id,
    dvId: state.project?.dv_group_id,
    showConfoundersOnly: state.showConfoundersOnly,
    confounderGroupIds: state.confounderGroupIds,
  });
  _dagPathLaneSegments = model.laneSegments;
  _visEdges.update(model.edgeUpdates);
  _visNodes.update(model.nodeUpdates);
  _visNetwork?.redraw();
}

let _dagRenderWorker = null;
let _dagRenderRequest = 0;

function renderDag() {
  clearLogicalDagEdgeHover();
  clearConfounderPathHover();
  const groups = dagVisibleGroups();
  els.dagLayoutSelect.value = state.dagLayoutMode;

  // Layout and obstacle-aware routing are pure but CPU intensive. Keep them off
  // the UI thread so the map and controls can paint immediately during startup.
  const input = {
    groups,
    links: state.visibleLinks.filter((link) => !link.is_target_relation),
    centroids: groups.map(group => [group.group_id, groupMapCentroid(group)]),
    ivId: state.project?.iv_group_id,
    dvId: state.project?.dv_group_id,
    mode: state.dagLayoutMode,
    width: els.dagNetwork.clientWidth || 630,
    height: els.dagNetwork.clientHeight || 700,
    viewSignature: state.showConfoundersOnly
      ? `confounders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
      : state.showCollidersOnly
        ? `colliders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
        : state.filterDagByCausalRelevance ? "causal" : "all",
  };
  const requestId = ++_dagRenderRequest;
  _dagRenderWorker?.terminate();

  if (typeof Worker === "undefined") {
    const { layout, routes } = computeDagRender(input);
    applyDagRender(groups, layout, routes);
    return;
  }
  const worker = new Worker(new URL("./dag_layout_worker.mjs", import.meta.url), { type: "module" });
  _dagRenderWorker = worker;
  worker.addEventListener("message", (event) => {
    if (event.data.requestId !== _dagRenderRequest) return;
    const layout = {
      ...event.data.layout,
      positions: new Map(event.data.layout.positions),
      boxes: new Map(event.data.layout.boxes),
    };
    worker.terminate();
    if (_dagRenderWorker === worker) _dagRenderWorker = null;
    applyDagRender(groups, layout, event.data.routes);
  });
  worker.addEventListener("error", () => {
    if (requestId !== _dagRenderRequest) return;
    worker.terminate();
    if (_dagRenderWorker === worker) _dagRenderWorker = null;
    const { layout, routes } = computeDagRender(input);
    applyDagRender(groups, layout, routes);
  }, { once: true });
  worker.postMessage({ requestId, input });
}

function applyDagRender(groups, layout, routes) {
  const { nodeData, edgeData, edgeSegments } = routedDagDataFromRoutes(groups, routes, layout);
  const designEdge = studyDesignEdgeData(groups);
  if (designEdge) edgeData.push(designEdge);
  _dagEdgeSegments = edgeSegments;

  if (!_visNetwork) {
    _visNodes = new visApi.DataSet(nodeData);
    _visEdges = new visApi.DataSet(edgeData);
    _visNetwork = new visApi.Network(
      els.dagNetwork,
      { nodes: _visNodes, edges: _visEdges },
      visNetworkOptions(layout.params)
    );
    _dagLayoutSignature = layout.signature;
    attachDagNetworkHandlers(_visNetwork);
    setTimeout(() => _visNetwork?.fit({ animation: false, padding: 34 }), 80);
  } else {
    // Update the existing network in place. Destroying/recreating the network
    // synchronously here is unsafe when renderDag() is called from inside a visApi.js
    // event handler (e.g. selectEdge): vis continues its own click dispatch after
    // the handler returns and crashes on the freed network ("getItemsOnPoint" of
    // undefined). In-place DataSet updates avoid that and are cheaper.
    const prevNodeIds = new Set(_visNodes.getIds());
    const nextNodeIds = new Set(nodeData.map((n) => n.id));
    const nodeSetChanged =
      prevNodeIds.size !== nextNodeIds.size ||
      [...nextNodeIds].some((id) => !prevNodeIds.has(id));

    _visNodes.update(nodeData);
    const dropNodes = [...prevNodeIds].filter((id) => !nextNodeIds.has(id));
    if (dropNodes.length) _visNodes.remove(dropNodes);

    const nextEdgeIds = new Set(edgeData.map((e) => e.id));
    _visEdges.update(edgeData);
    const dropEdges = _visEdges.getIds().filter((id) => !nextEdgeIds.has(id));
    if (dropEdges.length) _visEdges.remove(dropEdges);

    _visNetwork.setOptions(visNetworkOptions(layout.params));
    // Only refit when the node set changed; refitting on every edge selection
    // would yank the viewport around as the user inspects edges.
    const layoutChanged = layout.signature !== _dagLayoutSignature;
    _dagLayoutSignature = layout.signature;
    if (nodeSetChanged || layoutChanged) {
      setTimeout(() => _visNetwork?.fit({ animation: false, padding: 34 }), 120);
    }
  }
}

function minimumDagScale() {
  const ids = _visNodes?.getIds() || [];
  if (!ids.length || !_visNetwork) return 0.1;
  const boxes = ids.map(id => _visNetwork.getBoundingBox(id));
  const width = Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left));
  const height = Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top));
  return 0.8 * Math.min(Math.max(1, els.dagNetwork.clientWidth - 68) / Math.max(1, width),
    Math.max(1, els.dagNetwork.clientHeight - 68) / Math.max(1, height), 1);
}

let detachDagInteractions = null;

function attachDagNetworkHandlers(network) {
  detachDagInteractions?.();
  detachDagInteractions = attachDagInteractions(network, els.dagNetwork, {
    minimumScale: minimumDagScale,
    contentBounds() {
      const ids = (_visNodes?.getIds() || []).filter(id => Boolean(groupById(id)));
      if (!ids.length) return null;
      const boxes = ids.map(id => network.getBoundingBox(id));
      return {
        left: Math.min(...boxes.map(box => box.left)),
        right: Math.max(...boxes.map(box => box.right)),
        top: Math.min(...boxes.map(box => box.top)),
        bottom: Math.max(...boxes.map(box => box.bottom)),
        boxes,
      };
    },
    drawPathLanes: drawConfounderPathLanes,
    highlightEdge: highlightLogicalDagEdge,
    clearEdgeHover: clearLogicalDagEdgeHover,
    clearPathHover: clearConfounderPathHover,
    highlightPaths: highlightConfounderPaths,
    isDiagnosticCandidate(id) {
      const ids = state.showCollidersOnly ? state.colliderGroupIds : state.confounderGroupIds;
      return (state.showConfoundersOnly || state.showCollidersOnly) && ids.has(id);
    },
    hasGroup: id => Boolean(groupById(id)),
    logicalEdgeId: id => _dagEdgeSegments.get(id) || id,
    focusGroup(id) {
      Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: id }));
      drawMap();
    },
    openGroup(id) {
      if (state.interfaceMode === "dag2") {
        Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: id }));
        return;
      }
      Object.assign(state, workflow.transition(state, { type: "review-group", groupId: id }));
      setMapMode("select");
      renderAll();
    },
    selectEdge(id) {
      state.selectedEdgeId = id;
      selectEdge();
    },
  });
}

function edgeHoverText(link) {
  return dagDisplay.edgeHoverText(link, state.project.groups);
}


  return {
    clampNumber, visNetworkOptions, dagStudyArrowCorridor, routedDagData,
    routedDagDataFromRoutes, dagVisibleGroups, renderDag, minimumDagScale,
    highlightConfounderPaths, clearConfounderPathHover, clearLogicalDagEdgeHover,
    getNetwork: () => _visNetwork, getNodes: () => _visNodes, getEdges: () => _visEdges,
    getPathLaneSegments: () => _dagPathLaneSegments,
    zoomIn: () => _visNetwork?.moveTo({ scale: _visNetwork.getScale() * 1.3 }),
    zoomOut: () => _visNetwork?.moveTo({ scale: Math.max(minimumDagScale(), _visNetwork.getScale() / 1.3) }),
    fit: (padding = 20) => _visNetwork?.fit({ animation: false, padding }),
    redraw: () => _visNetwork?.redraw(),
  };
}
