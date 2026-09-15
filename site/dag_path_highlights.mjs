import { expandBox, pointInsideBox, simplifyRoute } from "./dag_routing_geometry.mjs";
import { pairKey, pathPairKeys } from "./edge_keys.mjs";
export { pathPairKeys } from "./edge_keys.mjs";

const EDGE_PALETTE = {
  iv: { color: "#d32f2f", shadow: "rgba(211,47,47,0.34)" },
  dv: { color: "#1976d2", shadow: "rgba(25,118,210,0.34)" },
  shared: { color: "#d18b08", shadow: "rgba(209,139,8,0.38)" },
};

export function addPathDirectionTargets(targetsByPair, path = []) {
  for (let index = 0; index < path.length - 1; index += 1) {
    const from = path[index];
    const to = path[index + 1];
    const key = pairKey(from, to);
    if (!targetsByPair.has(key)) targetsByPair.set(key, new Set());
    targetsByPair.get(key).add(to);
  }
  return targetsByPair;
}

export function highlightedSegmentArrows(edge, link, relevantTargets) {
  if (link?.direction_type !== "BIDIRECTIONAL" || !relevantTargets?.size) return edge.arrows;
  const pointsToA = relevantTargets.has(link.group_a);
  const pointsToB = relevantTargets.has(link.group_b);
  return {
    to: {
      enabled: (pointsToA && edge.to === link.group_a) || (pointsToB && edge.to === link.group_b),
      scaleFactor: 0.82,
    },
    from: {
      enabled: (pointsToA && edge.from === link.group_a) || (pointsToB && edge.from === link.group_b),
      scaleFactor: 0.82,
    },
  };
}

export function buildPathHighlightModel({
  paths,
  visibleLinks = [],
  edges = [],
  nodes = [],
  edgeSegments = new Map(),
  studyDesignEdgeId,
  groupId,
  ivId,
  dvId,
  showConfoundersOnly = false,
  confounderGroupIds = new Set(),
}) {
  const ivPairKeys = pathPairKeys(paths.toIv);
  const dvPairKeys = pathPairKeys(paths.toDv);
  const directionTargetsByPair = new Map();
  addPathDirectionTargets(directionTargetsByPair, paths.toIv);
  addPathDirectionTargets(directionTargetsByPair, paths.toDv);
  const ivNodeIds = new Set(paths.toIv);
  const dvNodeIds = new Set(paths.toDv);
  const highlightedNodeIds = new Set([...ivNodeIds, ...dvNodeIds]);
  const logicalEdgeRole = new Map();
  for (const link of visibleLinks) {
    const key = pairKey(link.group_a, link.group_b);
    const toIv = ivPairKeys.has(key);
    const toDv = dvPairKeys.has(key);
    if (toIv || toDv) logicalEdgeRole.set(link.edge_id, toIv && toDv ? "shared" : toIv ? "iv" : "dv");
  }

  const visibleLinkById = new Map(visibleLinks.map((link) => [link.edge_id, link]));
  const edgeUpdates = [];
  const laneSegments = [];
  for (const edge of edges) {
    if (edge.id === studyDesignEdgeId) continue;
    const logicalEdgeId = edgeSegments.get(edge.id) || edge.id;
    const role = logicalEdgeRole.get(logicalEdgeId);
    if (!role) {
      edgeUpdates.push({
        id: edge.id,
        color: { ...(edge.color || {}), opacity: 0.07 },
        width: 0.55,
        shadow: false,
      });
      continue;
    }
    const palette = EDGE_PALETTE[role];
    const link = visibleLinkById.get(logicalEdgeId);
    const relevantTargets = directionTargetsByPair.get(link ? pairKey(link.group_a, link.group_b) : "");
    const arrows = highlightedSegmentArrows(edge, link, relevantTargets);
    laneSegments.push({ logicalEdgeId, from: edge.from, to: edge.to, role, color: palette.color, arrows });
    edgeUpdates.push({
      id: edge.id,
      color: { color: palette.color, highlight: palette.color, hover: palette.color,
        inherit: false, opacity: 0.08 },
      width: 0.7,
      dashes: false,
      arrows: {
        to: { ...(arrows?.to || {}), enabled: false },
        from: { ...(arrows?.from || {}), enabled: false },
      },
      shadow: false,
      title: `${edge.title || ""}\n${role === "iv" ? "Path to IV" : role === "dv" ? "Path to DV" : "Shared segment of IV and DV paths"}`.trim(),
    });
  }

  const nodeUpdates = [];
  for (const node of nodes) {
    if (String(node.id).startsWith("__route__")) continue;
    if (!highlightedNodeIds.has(node.id)) {
      nodeUpdates.push({ id: node.id, opacity: 0.16 });
      continue;
    }
    const toIv = ivNodeIds.has(node.id);
    const toDv = dvNodeIds.has(node.id);
    const isShared = toIv && toDv;
    const isIntermediateConfounder = showConfoundersOnly
      && node.id !== groupId && node.id !== ivId && node.id !== dvId
      && confounderGroupIds.has(node.id);
    const transientBackground = isIntermediateConfounder ? "#e85d75" : node.color?.background;
    const palette = isShared ? EDGE_PALETTE.shared : toIv ? EDGE_PALETTE.iv : EDGE_PALETTE.dv;
    nodeUpdates.push({
      id: node.id,
      opacity: 1,
      color: {
        ...(node.color || {}),
        background: transientBackground,
        border: palette.color,
        highlight: { ...(node.color?.highlight || {}), background: transientBackground, border: palette.color },
        hover: { ...(node.color?.hover || {}), background: transientBackground, border: palette.color },
      },
      borderWidth: node.id === groupId ? 5 : 4,
      shadow: { enabled: true, color: palette.shadow, size: 15, x: 0, y: 1 },
    });
  }
  return { edgeUpdates, nodeUpdates, laneSegments };
}

export function polylineLength(points) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
  }
  return length;
}

export function pointAlongPolyline(points, fraction) {
  const total = polylineLength(points);
  if (points.length < 2 || total < 1e-9) return { point: points[0] || { x: 0, y: 0 }, angle: 0 };
  let remaining = total * Math.max(0, Math.min(1, fraction));
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (remaining <= length || index === points.length - 2) {
      const ratio = length > 1e-9 ? Math.min(1, remaining / length) : 0;
      return { point: { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio },
        angle: Math.atan2(to.y - from.y, to.x - from.x) };
    }
    remaining -= length;
  }
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  return { point: last, angle: Math.atan2(last.y - previous.y, last.x - previous.x) };
}

export function separateHighlightRuns(points, occupied, scale, side) {
  const overlaps = (a, b, c, d) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const otherLength = Math.hypot(d.x - c.x, d.y - c.y);
    if (length < 1e-6 || otherLength < 1e-6) return false;
    if (Math.abs(dx * (d.y - c.y) - dy * (d.x - c.x)) / (length * otherLength) > 0.06) return false;
    const projection = point => ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
    const pc = projection(c), pd = projection(d);
    const lo = Math.max(0, Math.min(pc, pd));
    const hi = Math.min(length, Math.max(pc, pd));
    if (hi - lo <= 12 / scale) return false;
    const distanceAt = projected => {
      const t = (projected - pc) / (pd - pc);
      return Math.abs(dx * (c.y + t * (d.y - c.y) - a.y)
        - dy * (c.x + t * (d.x - c.x) - a.x)) / length;
    };
    return Math.min(distanceAt(lo), distanceAt(hi)) < 10 / scale;
  };
  const runs = points.slice(0, -1).map((a, index) => {
    const b = points[index + 1];
    let dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    if ((Math.abs(dx) >= Math.abs(dy) && dx < 0) || (Math.abs(dx) < Math.abs(dy) && dy < 0)) {
      dx *= -1; dy *= -1;
    }
    let from = a, to = b;
    for (let lane = 1; lane <= occupied.length + 1; lane += 1) {
      if (!occupied.some(([c, d]) => overlaps(from, to, c, d))) break;
      const offset = side * lane * 15 / scale;
      from = { x: a.x - dy / length * offset, y: a.y + dx / length * offset };
      to = { x: b.x - dy / length * offset, y: b.y + dx / length * offset };
    }
    return { from, to };
  });
  const result = [points[0], runs[0].from];
  for (let index = 1; index < runs.length; index += 1) {
    const a = runs[index - 1], b = runs[index];
    const ux = a.to.x - a.from.x, uy = a.to.y - a.from.y;
    const vx = b.to.x - b.from.x, vy = b.to.y - b.from.y;
    const cross = ux * vy - uy * vx;
    const t = Math.abs(cross) > 1e-6
      ? ((b.from.x - a.from.x) * vy - (b.from.y - a.from.y) * vx) / cross : NaN;
    const intersection = { x: a.from.x + t * ux, y: a.from.y + t * uy };
    if (Number.isFinite(t) && Math.hypot(intersection.x - points[index].x, intersection.y - points[index].y) < 60 / scale) {
      result.push(intersection);
    } else result.push(a.to, b.from);
  }
  result.push(runs[runs.length - 1].to, points[points.length - 1]);
  return simplifyRoute(result);
}

export function highlightedArrowMarker(points, atStart, boxes, scale) {
  const length = polylineLength(points);
  if (!length) return null;
  // Prefer generous clearance, but progressively relax it for short edges. A
  // fixed halo can cover the entire gap between nearby nodes and suppress the
  // arrow even though the highlighted link itself is visible.
  for (const padding of [12, 8, 4, 0]) {
    for (let distance = 10 / scale; distance < length; distance += 2 / scale) {
      const marker = pointAlongPolyline(points, atStart ? distance / length : 1 - distance / length);
      if (boxes.some(box => pointInsideBox(marker.point, expandBox(box, padding / scale)))) continue;
      return { point: marker.point, angle: marker.angle + (atStart ? Math.PI : 0) };
    }
  }
  return null;
}

function drawPathLaneArrow(context, point, angle, color, scale) {
  const length = 13 / scale;
  const halfWidth = 6.5 / scale;
  context.save();
  context.translate(point.x, point.y);
  context.rotate(angle);
  context.beginPath();
  context.moveTo(length / 2, 0);
  context.lineTo(-length / 2, -halfWidth);
  context.lineTo(-length / 2, halfWidth);
  context.closePath();
  context.fillStyle = color;
  context.fill();
  context.restore();
}

export function clipPathLanesAroundNodes(context, boxes, scale) {
  if (!boxes.length) return;
  const padding = 1.5 / scale;
  const expanded = boxes.map(box => expandBox(box, padding));
  const margin = 10000 / scale;
  const left = Math.min(...expanded.map(box => box.x)) - margin;
  const top = Math.min(...expanded.map(box => box.y)) - margin;
  const right = Math.max(...expanded.map(box => box.x + box.w)) + margin;
  const bottom = Math.max(...expanded.map(box => box.y + box.h)) + margin;
  context.beginPath();
  context.rect(left, top, right - left, bottom - top);
  for (const box of expanded) context.rect(box.x, box.y, box.w, box.h);
  context.clip("evenodd");
}

export function drawPathLanes(context, { segments = [], positions = {}, boxes = [], scale = 1, ivId, dvId }) {
  const occupied = [];
  const iv = positions[ivId], dv = positions[dvId];
  if (iv && dv) occupied.push([iv, dv]);
  const logicalEdges = new Map();
  for (const segment of segments) {
    if (!logicalEdges.has(segment.logicalEdgeId)) logicalEdges.set(segment.logicalEdgeId, []);
    logicalEdges.get(segment.logicalEdgeId).push(segment);
  }
  const rendered = [];
  for (const edgeSegments of logicalEdges.values()) {
    let segment = edgeSegments.find(item => !String(item.from).startsWith("__route__"));
    if (!segment) continue;
    const first = segment;
    const points = [positions[first.from]];
    const seen = new Set();
    while (segment && !seen.has(segment)) {
      seen.add(segment);
      points.push(positions[segment.to]);
      segment = edgeSegments.find(item => item.from === segment.to);
    }
    if (points.some(point => !point) || points.length < 2) continue;
    const routed = separateHighlightRuns(points, occupied, scale, first.role === "iv" ? -1 : 1);
    occupied.push(...routed.slice(0, -1).map((point, index) => [point, routed[index + 1]]));
    rendered.push({ points: routed, color: first.color,
      to: edgeSegments.some(item => item.arrows?.to?.enabled),
      from: edgeSegments.some(item => item.arrows?.from?.enabled) });
  }
  context.save();
  // Lanes paint above ordinary edges so no portion is washed out, while an
  // even-odd mask preserves nodes and their borders as opaque foreground.
  clipPathLanesAroundNodes(context, boxes, scale);
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const casing of [true, false]) {
    for (const edge of rendered) {
      context.beginPath();
      context.moveTo(edge.points[0].x, edge.points[0].y);
      for (const point of edge.points.slice(1)) context.lineTo(point.x, point.y);
      context.strokeStyle = casing ? "rgba(255,255,255,0.94)" : edge.color;
      context.lineWidth = (casing ? 8.5 : 4.4) / scale;
      context.stroke();
    }
  }
  for (const edge of rendered) {
    for (const atStart of [false, true]) {
      if (!(atStart ? edge.from : edge.to)) continue;
      const marker = highlightedArrowMarker(edge.points, atStart, boxes, scale);
      if (marker) drawPathLaneArrow(context, marker.point, marker.angle, edge.color, scale);
    }
  }
  context.restore();
  return rendered;
}
