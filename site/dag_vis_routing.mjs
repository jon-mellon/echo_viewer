"use strict";

export function routeNodeData(id, point) {
  return {
    id, x: point.x, y: point.y, fixed: { x: true, y: true }, physics: false,
    // An empty text node anchors the routed segments without painting a
    // transparent circle for every bend on every canvas frame.
    label: "", shape: "text", size: 0.1, borderWidth: 0,
    margin: 0, widthConstraint: { minimum: 0.2, maximum: 0.2 }, heightConstraint: { minimum: 0.2 },
    color: "rgba(0,0,0,0)",
    font: { size: 1, color: "rgba(0,0,0,0)" }, chosen: false,
  };
}

// vis shortens an arrow's line only when the segment is longer than the head, so a final
// segment shorter than this leaves the head floating off the node with the line drawn through it.
const MIN_APPROACH = 24;

// The router ends a route on the target's side, on the line through its centre, but vis aims the
// last segment at the centre itself. When the previous bend sits off that line the arrowhead
// lands slanted, so the side point stays as a bend and the final segment runs straight in.
// A straight final segment is then lengthened to MIN_APPROACH by sliding the bends that share
// its axis outward, which keeps every segment orthogonal.
function approachPoints(points, target, box) {
  let bends = points.slice(1, -1);
  const entry = points[points.length - 1];
  if (!target || bends.length === 0) return bends;
  const prev = bends[bends.length - 1];
  const cross = (entry.x - prev.x) * (target.y - entry.y) - (entry.y - prev.y) * (target.x - entry.x);
  if (Math.abs(cross) >= 1e-6 && Math.hypot(entry.x - prev.x, entry.y - prev.y) >= 1) bends = [...bends, entry];
  if (!box) return bends;
  const last = bends[bends.length - 1];
  const vertical = Math.abs(last.x - target.x) < 0.5;
  if (!vertical && Math.abs(last.y - target.y) >= 0.5) return bends;
  const axis = vertical ? "y" : "x";
  const half = (vertical ? box.h : box.w) / 2;
  const offset = last[axis] - target[axis];
  const deficit = MIN_APPROACH + half - Math.abs(offset);
  if (deficit <= 0) return bends;
  const shift = Math.sign(offset || 1) * deficit;
  const value = last[axis];
  const moved = bends.slice();
  for (let i = moved.length - 1; i >= 0 && Math.abs(moved[i][axis] - value) < 0.5; i -= 1) {
    moved[i] = { ...moved[i], [axis]: moved[i][axis] + shift };
  }
  return moved;
}

export function routesToVisData(routes, { edgeStyle, edgeTitle, positions = null, boxes = null }) {
  const nodeData = [];
  const edgeData = [];
  const edgeSegments = new Map();
  for (const { link, sourceId, targetId, points } of routes) {
    const style = edgeStyle(link);
    const title = edgeTitle(link);
    if (points.length <= 2) {
      edgeSegments.set(link.edge_id, link.edge_id);
      edgeData.push({ id: link.edge_id, from: sourceId, to: targetId, ...style, title });
      continue;
    }
    const bendIds = approachPoints(points, positions?.get(targetId), boxes?.get(targetId)).map((point, index) => {
      const id = `__route__${link.edge_id}__${index}`;
      nodeData.push(routeNodeData(id, point));
      return id;
    });
    const ids = [sourceId, ...bendIds, targetId];
    for (let index = 0; index < ids.length - 1; index += 1) {
      const segmentId = `${link.edge_id}::seg${index}`;
      edgeSegments.set(segmentId, link.edge_id);
      edgeData.push({
        id: segmentId, from: ids[index], to: ids[index + 1],
        ...style, title,
        arrows: { to: index === ids.length - 2 ? { enabled: true, scaleFactor: 0.7 } : { enabled: false },
          from: link.direction_type === "BIDIRECTIONAL" && index === 0 ? { enabled: true, scaleFactor: 0.7 } : undefined },
      });
    }
  }
  return { nodeData, edgeData, edgeSegments };
}
