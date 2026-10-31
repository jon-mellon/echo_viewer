import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";
import { computeDagRender, reuseDagGeometry } from "./dag_render_compute.mjs";
import { routesToVisData } from "./dag_vis_routing.mjs";
import { attachDagInteractions } from "./dag_interactions.mjs";
import * as dagDisplay from "./dag_display.mjs";
import * as workflow from "./dag_workflow.mjs";
import * as dagPathHighlights from "./dag_path_highlights.mjs";
import { STUDY_DESIGN_EDGE_ID, STUDY_INSTRUMENT_EDGE_ID } from "./dag_inspector_controller.mjs";
import { studyDesignEdgeData } from "./dag_study_edges.mjs";
import { createDagTable, dagTableModel } from "./dag_table.mjs";

export function selectionUpdatesForSegments(edgeSegments, previousId, selectedId, links, visualData) {
  if (previousId === selectedId) return [];
  const changedIds = new Set([previousId, selectedId].filter(Boolean));
  const linksById = new Map(links.filter(link => changedIds.has(link.edge_id))
    .map(link => [link.edge_id, link]));
  const updates = [];
  for (const [segmentId, logicalId] of edgeSegments) {
    const link = linksById.get(logicalId);
    if (link) updates.push({ id: segmentId, ...visualData(link) });
  }
  return updates;
}

export function applyLogicalEdgeHover(edges, visEdges) {
  if (!edges.length) return;
  const hoverColor = "#9a5a0a";
  visEdges.update(edges.map(edge => ({
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
  })));
}

function visOptionSignature(params = {}) {
  return JSON.stringify([
    params.fontSize ?? 14, params.vMargin ?? 8, params.hMargin ?? 13,
    params.edgeWidth ?? 1.25, params.nodeMaxWidth || 190,
  ]);
}

// vis-network's fit() defaults to maxZoomLevel: 1, leaving small DAGs surrounded
// by empty canvas even when there is room to display them larger.
export const DAG_FIT_OPTIONS = { animation: false, maxZoomLevel: Number.MAX_VALUE };

export function isDagDisplayGroup(group) {
  return group?.type !== "other"
    && group?.group_id !== "other"
    && String(group?.label || "").trim().toLowerCase() !== "other";
}

export function isDagFullyVisible(network, boxes, viewport) {
  if (!network || !boxes.length || !viewport.clientWidth || !viewport.clientHeight) return false;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  const topLeft = network.canvasToDOM({ x: left, y: top });
  const bottomRight = network.canvasToDOM({ x: right, y: bottom });
  return topLeft.x >= -1 && topLeft.y >= -1 &&
    bottomRight.x <= viewport.clientWidth + 1 &&
    bottomRight.y <= viewport.clientHeight + 1;
}

export function createDagNetworkController({
  state, elements: els, visApi, clusterRep, groupColor, dagGroups, groupById,
  drawMap, setMapMode, renderAll, selectEdge, selectGroup, onViewportChange = () => {},
}) {
  // The causes and consequences views draw a neighborhood of one variable, not
  // a study design, so there are no IV, DV or instrument anchors to pin or style.
  const exploring = () => state.task === "causes" || state.task === "consequences";
  const studyAnchors = () => exploring() ? { ivId: null, dvId: null, instrumentId: null }
    : { ivId: state.project?.iv_group_id, dvId: state.project?.dv_group_id, instrumentId: state.project?.instrument_group_id };
  const exploreFocusId = () => exploring() ? state.explore?.[state.task]?.focusId || null : null;
// ─── DAG visApi.js rendering ─────────────────────────────────────────────────────

let _visNetwork = null;
let _visNodes = null;
let _visEdges = null;
let _dagLayoutSignature = "";
let _visOptionSignature = "";
const DAG_INSTALL_SLICE = 1000;
let _dagGeometry = null;
let _dagBoundsCache = null;
let _dagEdgeSegments = new Map();
let _renderedSelectedEdgeId = null;
let _dagNodeDataById = new Map();
let _dagHoverBaseline = null;
let _dagHoveredConfounderId = null;
let _dagPathLaneSegments = [];
let _dagEdgeHoverBaseline = null;
let _dagHoveredLogicalEdgeIds = new Set();

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function visNetworkOptions(p = {}) {
  const { fontSize=14, vMargin=8, hMargin=13, edgeWidth=1.25 } = p;
  return {
    interaction: {
      selectConnectedEdges: false,
      hoverConnectedEdges: false,
      hover: true,
      tooltipDelay: 0,
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
  return dagDisplay.groupMapCentroid(group, state.variableById, clusterRep);
}

function dagStudyArrowCorridor({ ivId, dvId, positions, boxes, fontSize = 12 }) {
  return studyArrowCorridor({ ivId, dvId, positions, boxes, fontSize });
}


function visNodeData(group, layoutPoint, layoutParams = {}) {
  const focusId = exploreFocusId();
  // The focus is drawn like an anchor (the outcome when exploring causes, the
  // exposure when exploring consequences); everything else is a plain node.
  if (exploring()) group = { ...group, type: group.group_id === focusId ? (state.task === "causes" ? "dv" : "iv") : "candidate" };
  return dagDisplay.visNodeData(group, layoutPoint, layoutParams, {
    focusId,
    showCollidersOnly: state.showCollidersOnly, showConfoundersOnly: state.showConfoundersOnly,
    showExclusionViolations: state.showExclusionViolations,
    showExogeneity: state.showExogeneity,
    exclusionViolationIds: state.exclusionViolationIds,
    exogeneityGroupIds: state.exogeneityGroupIds,
    exogeneityPathGroupIds: state.exogeneityPathGroupIds,
    instrumentId: studyAnchors().instrumentId,
    colliderGroupIds: state.colliderGroupIds, colliderPathGroupIds: state.colliderPathGroupIds,
    confounderGroupIds: state.confounderGroupIds, confounderPathGroupIds: state.confounderPathGroupIds,
    ivId: studyAnchors().ivId, dvId: studyAnchors().dvId,
    activeGroupId: state.activeGroupId, groupColor: groupColor(group),
  });
}

function edgeVisualData(link) {
  return dagDisplay.edgeVisualData(link, state.selectedEdgeId);
}

// The table is another view of the same nodes and links the graph draws; it
// is rebuilt from them on every render while shown, and the graph is rebuilt
// from them when it is shown again.
let _dagTable = null;
const tableShown = () => state.dagDisplay === "table";

function openVariable(id) {
  Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: id }));
  drawMap();
  selectGroup(id);
}

function openEvidence(edgeId) {
  state.selectedEdgeId = edgeId;
  selectEdge();
}

function tableRole(group) {
  const id = group.group_id;
  const anchors = studyAnchors();
  if (id === exploreFocusId()) return "Focus";
  if (id === anchors.ivId) return "Ind var";
  if (id === anchors.dvId) return "Dep var";
  if (id === anchors.instrumentId) return "Instrument";
  if (state.showExogeneity && state.exogeneityGroupIds?.has(id)) return "Common cause of instrument and Dep var";
  if (state.showExclusionViolations && state.exclusionViolationIds?.has(id)) return "Exclusion restriction violation";
  if (state.showCollidersOnly && state.colliderGroupIds?.has(id)) return "Collider";
  if (state.showConfoundersOnly && state.confounderGroupIds?.has(id)) return "Confounder";
  return "";
}

function renderDagTable(groups, links) {
  _dagTable ||= createDagTable({ container: els.dagTable, onOpenVariable: openVariable, onOpenEvidence: openEvidence });
  const studyLinks = studyDesignEdgeData(groups, state.project).map(edge => ({
    edgeId: edge.id, sourceId: edge.from, targetId: edge.to,
    note: edge.id === STUDY_DESIGN_EDGE_ID ? "Study relationship" : "Study instrument",
  }));
  _dagTable.update(dagTableModel({ groups, links, roleFor: tableRole, studyLinks }));
  _dagTable.select({ edgeId: state.selectedEdgeId, groupId: state.selectedEvidenceGroupId });
}

function showDagDisplay() {
  const table = tableShown();
  els.dagTable.hidden = !table;
  els.dagNetwork.hidden = table;
  for (const [button, active] of [[els.dagViewGraph, !table], [els.dagViewTable, table]]) {
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function setDagDisplay(mode) {
  const next = mode === "table" ? "table" : "graph";
  if (state.dagDisplay === next) return;
  state.dagDisplay = next;
  showDagDisplay();
  onViewportChange(false);
  await renderDag();
  if (next === "graph") _visNetwork?.redraw();
}

function refreshEdgeSelection({ redraw = true } = {}) {
  _dagTable?.select({ edgeId: state.selectedEdgeId, groupId: state.selectedEvidenceGroupId });
  if (!_visEdges) return;
  // Selecting an edge only changes its presentation. Recomputing and reapplying
  // the full layout here can make vis.js move nodes while it is still completing
  // the click event, especially for routed edges with synthetic bend nodes.
  clearLogicalDagEdgeHover();
  const updates = selectionUpdatesForSegments(_dagEdgeSegments, _renderedSelectedEdgeId,
    state.selectedEdgeId, (exploring() ? state.visibleLinks : state.project?.links) || [], edgeVisualData);
  _renderedSelectedEdgeId = state.selectedEdgeId;
  if (updates.length) _visEdges.update(updates);
  // DataSet updates already request a frame from vis. A synchronous redraw here
  // duplicates that paint inside the selection event.
}

function routedDagData(groups, links, layout) {
  const boxes = layout.boxes;
  const corridor = dagStudyArrowCorridor({
    ivId: studyAnchors().instrumentId || studyAnchors().ivId,
    dvId: studyAnchors().dvId,
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

function dagVisibleGroups() {
  const groups = dagGroups();
  return groups.filter((group) => state.componentGroupIds.has(group.group_id)
    && isDagDisplayGroup(group));
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
    ivId: studyAnchors().ivId,
    dvId: studyAnchors().dvId,
    instrumentId: studyAnchors().instrumentId,
  });
}

function clearConfounderPathHover({ redraw = true } = {}) {
  const hadLanes = _dagPathLaneSegments.length > 0;
  _dagPathLaneSegments = [];
  _dagHoveredConfounderId = null;
  if (!_dagHoverBaseline || !_visNodes || !_visEdges) {
    if (redraw && hadLanes) _visNetwork?.redraw();
    return;
  }
  _visNodes.update(_dagHoverBaseline.nodes);
  _visEdges.update(_dagHoverBaseline.edges);
  _dagHoverBaseline = null;
  if (redraw) _visNetwork?.redraw();
}

function clearLogicalDagEdgeHover(segmentId = null) {
  const logicalEdgeId = segmentId == null ? null : (_dagEdgeSegments.get(segmentId) || segmentId);
  if (logicalEdgeId && !_dagHoveredLogicalEdgeIds.has(logicalEdgeId)) return;
  if (!_dagEdgeHoverBaseline || !_visEdges) return;
  _visEdges.update(_dagEdgeHoverBaseline);
  _dagEdgeHoverBaseline = null;
  _dagHoveredLogicalEdgeIds = new Set();
}

function highlightLogicalDagEdges(logicalEdgeIds) {
  const nextIds = new Set([...logicalEdgeIds].filter(Boolean));
  const unchanged = nextIds.size === _dagHoveredLogicalEdgeIds.size
    && [...nextIds].every(id => _dagHoveredLogicalEdgeIds.has(id));
  if (unchanged || !_visEdges) return;
  clearLogicalDagEdgeHover();
  nextIds.delete(STUDY_DESIGN_EDGE_ID);
  nextIds.delete(STUDY_INSTRUMENT_EDGE_ID);
  if (!nextIds.size) return;

  const segmentIds = _visEdges.getIds().filter(
    (edgeId) => nextIds.has(_dagEdgeSegments.get(edgeId) || edgeId)
  );
  if (!segmentIds.length) return;
  _dagEdgeHoverBaseline = _visEdges.get(segmentIds).map((edge) => ({
    ...edge,
    shadow: edge.shadow || false,
  }));
  _dagHoveredLogicalEdgeIds = nextIds;

  applyLogicalEdgeHover(_dagEdgeHoverBaseline, _visEdges);
}

function highlightLogicalDagEdge(segmentId) {
  highlightLogicalDagEdges([_dagEdgeSegments.get(segmentId) || segmentId]);
}

function highlightConnectedDagEdges(nodeId) {
  if (!_visNetwork) return;
  const logicalIds = _visNetwork.getConnectedEdges(nodeId)
    .map(edgeId => _dagEdgeSegments.get(edgeId) || edgeId);
  highlightLogicalDagEdges(logicalIds);
}

function highlightConfounderPaths(groupId) {
  if (_dagHoveredConfounderId === groupId) return;
  clearConfounderPathHover();
  const candidateIds = state.showExogeneity ? state.exogeneityGroupIds
    : state.showExclusionViolations ? state.exclusionViolationIds
    : state.showCollidersOnly ? state.colliderGroupIds : state.confounderGroupIds;
  if ((!state.showConfoundersOnly && !state.showCollidersOnly && !state.showExclusionViolations && !state.showExogeneity)
    || !candidateIds.has(groupId)) return;
  const rawPaths = state.showExogeneity ? state.exogeneityPathsByGroup.get(groupId)
    : state.showExclusionViolations
    ? state.exclusionPathsByGroup.get(groupId)
    : state.showCollidersOnly
    ? state.colliderPathsByGroup.get(groupId)
    : state.confounderPathsByGroup.get(groupId);
  const paths = state.showExclusionViolations && rawPaths
    ? { toIv: [], toDv: rawPaths }
    : state.showCollidersOnly && rawPaths
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
    instrumentDesignEdgeId: STUDY_INSTRUMENT_EDGE_ID,
    groupId,
    ivId: state.showExogeneity ? studyAnchors().instrumentId : studyAnchors().ivId,
    dvId: studyAnchors().dvId,
    showConfoundersOnly: state.showConfoundersOnly,
    showExogeneity: state.showExogeneity,
    showExclusionViolations: state.showExclusionViolations,
    confounderGroupIds: state.showExogeneity ? state.exogeneityGroupIds : state.confounderGroupIds,
  });
  _dagPathLaneSegments = model.laneSegments;
  _visEdges.update(model.edgeUpdates);
  _visNodes.update(model.nodeUpdates);
  _visNetwork?.redraw();
}

let _dagRenderWorker = null;
let _dagRenderRequest = 0;
let _dagApplyingRequest = null;
let _dagRenderedPromise = Promise.resolve();
const _dagGeometryCache = new Map();

function rememberGeometry(key, geometry) {
  _dagGeometryCache.delete(key);
  _dagGeometryCache.set(key, geometry);
  if (_dagGeometryCache.size > 8) _dagGeometryCache.delete(_dagGeometryCache.keys().next().value);
}

async function renderDag({ reuseGeometry = false, allowRemovedGroups = false } = {}) {
  // Data loading and filtering continue during setup, but there is no graph to
  // lay out until both study variables have been chosen.
  const hasAnchor = id => {
    const group = state.project?.groups?.find(item => item.group_id === id);
    return Boolean(group?.variable_ids?.length
      || (state.publishedSchemaHydrating && Number(group?.member_count) > 0));
  };
  if (state.interfaceMode === "dag2" && !exploring()
    && (!hasAnchor(state.project?.iv_group_id) || !hasAnchor(state.project?.dv_group_id)
      || (state.phase === "select_instrument" && !state.changingAnchorSide))) return;
  let resolveRendered;
  _dagRenderedPromise = new Promise(resolve => { resolveRendered = resolve; });
  clearLogicalDagEdgeHover();
  clearConfounderPathHover({ redraw: false });
  const groups = dagVisibleGroups();

  // A worker render can take long enough for the previous diagnostic graph to
  // remain on screen after its nodes cease to qualify. Hide that stale graph
  // until the new node set has been applied.
  const nextGroupIds = new Set(groups.map(group => group.group_id));
  const displayedGroupIds = _visNodes?.getIds().filter(id => !String(id).startsWith("__route__")) || [];
  if (_visNetwork && (displayedGroupIds.length !== nextGroupIds.size
    || displayedGroupIds.some(id => !nextGroupIds.has(id)))) {
    els.dagNetwork.style.visibility = "hidden";
  }

  const links = state.visibleLinks.filter((link) => !link.is_target_relation
    && nextGroupIds.has(link.group_a) && nextGroupIds.has(link.group_b));
  if (els.dagTable.hidden === tableShown()) showDagDisplay();
  if (tableShown()) {
    // No layout: the graph is rebuilt from the same groups and links when it is shown again.
    renderDagTable(groups, links);
    resolveRendered();
    return;
  }
  if (reuseGeometry && !_dagRenderWorker && _dagApplyingRequest === null && _visNetwork) {
    const reused = reuseDagGeometry(_dagGeometry, groups, links, { allowRemovedGroups });
    if (reused) {
      applyReusedDagRender(groups, reused.layout, reused.routes);
      resolveRendered();
      return;
    }
  }

  // Layout and obstacle-aware routing are pure but CPU intensive. Keep them off
  // the UI thread so the map and controls can paint immediately during startup.
  const input = {
    groups: groups.map(({ group_id, label }) => ({ group_id, label })),
    links: links.map(({ edge_id, group_a, group_b, direction_type }) =>
      ({ edge_id, group_a, group_b, direction_type })),
    centroids: groups.map(group => [group.group_id, groupMapCentroid(group)]),
    ivId: studyAnchors().ivId,
    dvId: studyAnchors().dvId,
    instrumentId: studyAnchors().instrumentId,
    focus: exploring() ? state.exploreLayout || null : null,
    mode: state.dagLayoutMode,
    width: els.dagNetwork.clientWidth || 630,
    height: els.dagNetwork.clientHeight || 700,
    viewSignature: exploring() ? `explore:${state.task}:${exploreFocusId()}`
      : state.showConfoundersOnly
      ? `confounders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
      : state.showExogeneity
        ? `exogeneity:${state.project?.instrument_group_id}:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
      : state.showExclusionViolations
        ? `exclusion:${state.project?.instrument_group_id}:${state.exclusionMaxPathLength}:all-links:${state.showAllExclusionLinks}`
      : state.showCollidersOnly
        ? `colliders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
        : "all",
  };
  // Filter names do not affect geometry; the actual nodes, topology, anchors,
  // centroids and viewport do. Cache those inputs without large memberships or
  // evidence arrays, and always rebind routes to the current evidence objects.
  const geometryKey = JSON.stringify({ ...input, viewSignature: undefined });
  const cached = _dagGeometryCache.get(geometryKey);
  if (cached) {
    const requestId = ++_dagRenderRequest;
    _dagRenderWorker?.terminate();
    _dagRenderWorker = null;
    rememberGeometry(geometryKey, cached);
    _dagGeometry = cached;
    const reused = reuseDagGeometry(cached, groups, links);
    // Applying cached geometry can be substantial, and this branch runs in
    // the filter's input handler. Let that handler finish before updating vis.
    _dagApplyingRequest = requestId;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (_dagApplyingRequest === requestId) _dagApplyingRequest = null;
    if (requestId !== _dagRenderRequest) {
      resolveRendered();
      return;
    }
    await applyDagRender(groups, reused.layout, reused.routes);
    resolveRendered();
    return;
  }
  async function acceptGeometry(layout, routes) {
    const linksById = new Map(links.map(link => [link.edge_id, link]));
    const currentRoutes = routes.map(route => ({ ...route, link: linksById.get(route.link.edge_id) }));
    _dagGeometry = { groupIds: groups.map(group => group.group_id), layout, routes: currentRoutes };
    rememberGeometry(geometryKey, _dagGeometry);
    await applyDagRender(groups, layout, currentRoutes);
  }
  const requestId = ++_dagRenderRequest;
  _dagRenderWorker?.terminate();

  if (typeof Worker === "undefined") {
    const { layout, routes } = computeDagRender(input);
    await acceptGeometry(layout, routes);
    resolveRendered();
    return;
  }
  const worker = new Worker(new URL("./dag_layout_worker.mjs", import.meta.url), { type: "module" });
  _dagRenderWorker = worker;
  worker.addEventListener("message", async (event) => {
    if (event.data.requestId !== _dagRenderRequest) return;
    const timingEnd = performance.now();
    for (const [phase, duration] of Object.entries(event.data.timings || {})) {
      performance.measure(`echo:dag:${phase}`, { start: timingEnd - duration, end: timingEnd });
    }
    const layout = {
      ...event.data.layout,
      positions: new Map(event.data.layout.positions),
      boxes: new Map(event.data.layout.boxes),
    };
    worker.terminate();
    if (_dagRenderWorker === worker) _dagRenderWorker = null;
    await acceptGeometry(layout, event.data.routes);
    resolveRendered();
  });
  worker.addEventListener("error", async () => {
    if (requestId !== _dagRenderRequest) return;
    worker.terminate();
    if (_dagRenderWorker === worker) _dagRenderWorker = null;
    const { layout, routes } = computeDagRender(input);
    await acceptGeometry(layout, routes);
    resolveRendered();
  }, { once: true });
  worker.postMessage({ requestId, input });
}

async function applyDagRender(groups, layout, routes) {
  const requestId = _dagRenderRequest;
  const { nodeData, edgeData, edgeSegments } = routedDagDataFromRoutes(groups, routes, layout);
  const largeUpdate = nodeData.length + edgeData.length > 300;
  if (largeUpdate) {
    // Route conversion and network installation are separate large stages.
    // Give input a turn between them, and discard a superseded installation.
    _dagApplyingRequest = requestId;
    await new Promise(resolve => setTimeout(resolve, 0));
    if (_dagApplyingRequest === requestId) _dagApplyingRequest = null;
    if (requestId !== _dagRenderRequest) return;
  }
  _dagBoundsCache = null;
  const previousNodeData = _dagNodeDataById;
  _dagNodeDataById = new Map(nodeData.map(node => [node.id, node]));
  edgeData.push(...studyDesignEdgeData(groups, state.project));
  _dagEdgeSegments = edgeSegments;
  _renderedSelectedEdgeId = state.selectedEdgeId;

  if (!_visNetwork) {
    _visNodes = new visApi.DataSet(nodeData);
    _visEdges = new visApi.DataSet(edgeData);
    _visNetwork = new visApi.Network(
      els.dagNetwork,
      { nodes: _visNodes, edges: _visEdges },
      visNetworkOptions(layout.params)
    );
    _dagLayoutSignature = layout.signature;
    _visOptionSignature = visOptionSignature(layout.params);
    attachDagNetworkHandlers(_visNetwork);
    setTimeout(() => _visNetwork?.fit(DAG_FIT_OPTIONS), 80);
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

    const maximumNodes = Math.max(prevNodeIds.size, nodeData.length);
    // A large count change guarantees that most nodes are added or removed.
    // Avoid serializing every route bend merely to rediscover that fact.
    const replaceMostNodes = nodeSetChanged && maximumNodes > 500
      && Math.abs(prevNodeIds.size - nodeData.length) > maximumNodes / 2;
    const changedNodes = replaceMostNodes ? [] : nodeData.filter(node =>
      JSON.stringify(node) !== JSON.stringify(previousNodeData.get(node.id)));
    const dropNodes = [...prevNodeIds].filter((id) => !nextNodeIds.has(id));
    if (replaceMostNodes || (nodeSetChanged && maximumNodes > 500
      && changedNodes.length + dropNodes.length > maximumNodes / 2)) {
      // A large filter transition replaces most route bends. Bind the complete
      // data once rather than repeatedly rebuilding adjacency as nodes and edges
      // are updated and removed. Preserve the Network instance and its handlers.
      // Install it in slices with a turn for input between them: one bind of thousands of route bends and edges is a
      // single task of a second or more on a phone.
      els.dagNetwork.style.visibility = "hidden";
      _visNodes = new visApi.DataSet();
      _visEdges = new visApi.DataSet();
      _visNetwork.setData({ nodes: _visNodes, edges: _visEdges });
      _dagApplyingRequest = requestId;
      for (const [dataSet, rows] of [[_visNodes, nodeData], [_visEdges, edgeData]]) {
        for (let at = 0; at < rows.length; at += DAG_INSTALL_SLICE) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (requestId !== _dagRenderRequest) {
            if (_dagApplyingRequest === requestId) _dagApplyingRequest = null;
            // The network holds a partial install: forget what it holds so the next render rewrites all of it.
            _dagNodeDataById = new Map();
            return;
          }
          dataSet.add(rows.slice(at, at + DAG_INSTALL_SLICE));
        }
      }
      if (_dagApplyingRequest === requestId) _dagApplyingRequest = null;
    } else {
      if (changedNodes.length) _visNodes.update(changedNodes);
      if (dropNodes.length) _visNodes.remove(dropNodes);
      if (largeUpdate) {
        // Updating route nodes and installing their edges can each be costly.
        // Keep the partial network hidden and let the browser handle input
        // before adding edges; a newer render supersedes this one.
        els.dagNetwork.style.visibility = "hidden";
        _dagApplyingRequest = requestId;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (_dagApplyingRequest === requestId) _dagApplyingRequest = null;
        if (requestId !== _dagRenderRequest) return;
      }
      const nextEdgeIds = new Set(edgeData.map((e) => e.id));
      _visEdges.update(edgeData);
      const dropEdges = _visEdges.getIds().filter((id) => !nextEdgeIds.has(id));
      if (dropEdges.length) _visEdges.remove(dropEdges);
    }

    const optionSignature = visOptionSignature(layout.params);
    if (optionSignature !== _visOptionSignature) {
      _visNetwork.setOptions(visNetworkOptions(layout.params));
      _visOptionSignature = optionSignature;
    }
    // Only refit when the node set changed; refitting on every edge selection
    // would yank the viewport around as the user inspects edges.
    const layoutChanged = layout.signature !== _dagLayoutSignature;
    _dagLayoutSignature = layout.signature;
    if (nodeSetChanged || layoutChanged) {
      setTimeout(() => _visNetwork?.fit(DAG_FIT_OPTIONS), 120);
    }
  }
  els.dagNetwork.style.visibility = "";
}

function applyReusedDagRender(groups, layout, routes) {
  _dagBoundsCache = null;
  const wanted = new Set(routes.map(route => route.link.edge_id));
  const removed = [..._dagEdgeSegments].filter(([, logicalId]) => !wanted.has(logicalId));
  const currentEdgeIds = new Set(_visEdges.getIds());
  const removeEdgeIds = removed.map(([id]) => id).filter(id => currentEdgeIds.has(id));
  if (removeEdgeIds.length) _visEdges.remove(removeEdgeIds);
  const removedLogicalIds = new Set(removed.map(([, logicalId]) => logicalId));
  const removeNodeIds = _dagGeometry.routes.filter(route => removedLogicalIds.has(route.link.edge_id))
    .flatMap(route => route.points.slice(1, -1).map((_, index) =>
      `__route__${route.link.edge_id}__${index}`));
  if (removeNodeIds.length) _visNodes.remove(removeNodeIds);
  for (const id of removeNodeIds) _dagNodeDataById.delete(id);
  for (const [id] of removed) _dagEdgeSegments.delete(id);

  // A group that stopped qualifying is hidden; one that qualifies again returns at its old position.
  const wantedGroupIds = new Set(groups.map(group => group.group_id));
  const goneGroupIds = (_visNodes.getIds() || []).filter(id => !String(id).startsWith("__route__") && !wantedGroupIds.has(id));
  if (goneGroupIds.length) {
    _visNodes.remove(goneGroupIds);
    for (const id of goneGroupIds) _dagNodeDataById.delete(id);
  }
  const shownGroupIds = new Set(_visNodes.getIds());
  const returning = groups.filter(group => !shownGroupIds.has(group.group_id))
    .map(group => visNodeData(group, layout.positions.get(group.group_id), layout.params));
  if (returning.length) {
    _visNodes.add(returning);
    for (const node of returning) _dagNodeDataById.set(node.id, node);
  }

  const rendered = new Set(_dagEdgeSegments.values());
  const additions = routes.filter(route => !rendered.has(route.link.edge_id));
  if (additions.length) {
    const added = routedDagDataFromRoutes([], additions, layout);
    if (added.nodeData.length) {
      _visNodes.add(added.nodeData);
      for (const node of added.nodeData) _dagNodeDataById.set(node.id, node);
    }
    if (added.edgeData.length) _visEdges.add(added.edgeData);
    for (const [id, logicalId] of added.edgeSegments) _dagEdgeSegments.set(id, logicalId);
  }

  const changedNodes = [];
  for (const group of groups) {
    const node = visNodeData(group, layout.positions.get(group.group_id), layout.params);
    if (JSON.stringify(node) !== JSON.stringify(_dagNodeDataById.get(group.group_id))) {
      changedNodes.push(node);
      _dagNodeDataById.set(group.group_id, node);
    }
  }
  if (changedNodes.length) _visNodes.update(changedNodes);
  _renderedSelectedEdgeId = state.selectedEdgeId;
  els.dagNetwork.style.visibility = "";
  // DataSet additions/removals/updates schedule their own coalesced paint.
}

function dagBounds() {
  if (_dagBoundsCache) return _dagBoundsCache;
  const ids = _visNodes?.getIds() || [];
  if (!ids.length || !_visNetwork) return null;
  const all = ids.map(id => {
    // Invisible routing points have fixed coordinates; their empty text labels
    // need not be measured by vis merely to establish graph bounds.
    const point = String(id).startsWith("__route__") ? _dagNodeDataById.get(id) : null;
    return { id, box: point ? { left: point.x - 0.1, right: point.x + 0.1,
      top: point.y - 0.1, bottom: point.y + 0.1 } : _visNetwork.getBoundingBox(id) };
  }).filter(({ box }) => [box.left, box.right, box.top, box.bottom].every(Number.isFinite));
  const boxes = all.map(item => item.box);
  const groupBoxes = all.filter(item => Boolean(groupById(item.id))).map(item => item.box);
  const contentBounds = groupBoxes.length ? {
    left: Math.min(...groupBoxes.map(box => box.left)),
    right: Math.max(...groupBoxes.map(box => box.right)),
    top: Math.min(...groupBoxes.map(box => box.top)),
    bottom: Math.max(...groupBoxes.map(box => box.bottom)),
    boxes: groupBoxes,
  } : null;
  _dagBoundsCache = { boxes, contentBounds };
  return _dagBoundsCache;
}

function minimumDagScale() {
  const boxes = dagBounds()?.boxes;
  if (!boxes?.length) return 0.1;
  const width = Math.max(...boxes.map(b => b.right)) - Math.min(...boxes.map(b => b.left));
  const height = Math.max(...boxes.map(b => b.bottom)) - Math.min(...boxes.map(b => b.top));
  return 0.8 * Math.min(Math.max(1, els.dagNetwork.clientWidth - 68) / Math.max(1, width),
    Math.max(1, els.dagNetwork.clientHeight - 68) / Math.max(1, height), 1);
}

function fitDag() {
  const boxes = dagBounds()?.boxes;
  const width = els.dagNetwork.clientWidth, height = els.dagNetwork.clientHeight;
  if (!_visNetwork || !boxes?.length || !width || !height) return;
  const left = Math.min(...boxes.map(box => box.left));
  const right = Math.max(...boxes.map(box => box.right));
  const top = Math.min(...boxes.map(box => box.top));
  const bottom = Math.max(...boxes.map(box => box.bottom));
  const padding = 16;
  const scale = Math.min(Math.max(1, width - 2 * padding) / Math.max(1, right - left),
    Math.max(1, height - 2 * padding) / Math.max(1, bottom - top));
  _visNetwork.moveTo({ position: { x: (left + right) / 2, y: (top + bottom) / 2 }, scale, animation: false });
}

let detachDagInteractions = null;

function attachDagNetworkHandlers(network) {
  detachDagInteractions?.();
  detachDagInteractions = attachDagInteractions(network, els.dagNetwork, {
    onViewportChange,
    minimumScale: minimumDagScale,
    contentBounds: () => dagBounds()?.contentBounds || null,
    drawPathLanes: drawConfounderPathLanes,
    highlightEdge: highlightLogicalDagEdge,
    highlightNodeEdges: highlightConnectedDagEdges,
    clearEdgeHover: clearLogicalDagEdgeHover,
    clearPathHover: clearConfounderPathHover,
    highlightPaths: highlightConfounderPaths,
    isDiagnosticCandidate(id) {
      const ids = state.showExogeneity ? state.exogeneityGroupIds
        : state.showExclusionViolations ? state.exclusionViolationIds
        : state.showCollidersOnly ? state.colliderGroupIds : state.confounderGroupIds;
      return (state.showConfoundersOnly || state.showCollidersOnly || state.showExclusionViolations || state.showExogeneity) && ids.has(id);
    },
    hasGroup: id => Boolean(groupById(id)),
    logicalEdgeId: id => _dagEdgeSegments.get(id) || id,
    focusGroup(id) {
      Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: id }));
      drawMap();
      selectGroup(id);
    },
    openGroup(id) {
      if (state.interfaceMode === "dag2") {
        Object.assign(state, workflow.transition(state, { type: "focus-group", groupId: id }));
        return;
      }
      Object.assign(state, workflow.transition(state, { type: "review-group", groupId: id }));
      setMapMode("select");
      renderAll({ rebuild: false, refreshView: true });
    },
    zoomToPoint(position) {
      network.moveTo({ position, scale: network.getScale() * 1.3 });
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
    refreshEdgeSelection, setDagDisplay,
    dagDisplay: () => state.dagDisplay,
    highlightConfounderPaths, clearConfounderPathHover, clearLogicalDagEdgeHover,
    highlightConnectedDagEdges,
    whenRendered: () => _dagRenderedPromise,
    renderedEdgeIds: () => [...new Set((_visEdges?.getIds() || []).map(id => _dagEdgeSegments.get(id) || id))],
    isEdgeRendered: edgeId => Boolean(_visEdges?.getIds().some(id => (_dagEdgeSegments.get(id) || id) === edgeId)),
    getNetwork: () => _visNetwork, getNodes: () => _visNodes, getEdges: () => _visEdges,
    isFullyVisible: () => isDagFullyVisible(_visNetwork, dagBounds()?.boxes || [], els.dagNetwork),
    getPathLaneSegments: () => _dagPathLaneSegments,
    zoomIn: () => _visNetwork?.moveTo({ scale: _visNetwork.getScale() * 1.3 }),
    zoomOut: () => _visNetwork?.moveTo({ scale: Math.max(minimumDagScale(), _visNetwork.getScale() / 1.3) }),
    fit: fitDag,
    redraw: () => _visNetwork?.redraw(),
  };
}
