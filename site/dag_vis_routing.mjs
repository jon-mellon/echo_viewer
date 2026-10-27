"use strict";

export function routeNodeData(id, point) {
  return {
    id, x: point.x, y: point.y, fixed: { x: true, y: true }, physics: false,
    // An empty text node anchors the routed segments without painting a
    // transparent circle for every bend on every canvas frame.
    label: "", shape: "text", size: 0.1, borderWidth: 0,
    color: { background: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)",
      highlight: { background: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)" },
      hover: { background: "rgba(0,0,0,0)", border: "rgba(0,0,0,0)" } },
    font: { size: 0, color: "rgba(0,0,0,0)" }, chosen: false,
  };
}

export function routesToVisData(routes, { edgeStyle, edgeTitle }) {
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
    const bendIds = points.slice(1, -1).map((point, index) => {
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
