"use strict";

import { computeDagLayout, dagNodeBoxes } from "./dag_layout.mjs";
import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";

function nodeBounds(layout) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const box of layout.boxes.values()) {
    left = Math.min(left, box.x);
    right = Math.max(right, box.x + box.w);
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.h);
  }
  return { width: right - left, height: bottom - top };
}

function routeDag(input, layout) {
  const corridor = studyArrowCorridor({
    ivId: input.ivId, dvId: input.dvId,
    positions: layout.positions, boxes: layout.boxes,
    fontSize: layout.params.fontSize,
  });
  const compactOuterLanes = input.width / input.height > 1.45;
  return routeEdges(input.links, { positions: layout.positions, boxes: layout.boxes, corridor,
    config: { compactOuterLanes } });
}

// Shared pure calculation for both the browser worker and its synchronous fallback.
export function computeDagRender(input, onPhase = () => {}) {
  const layoutStart = performance.now();
  const layout = computeDagLayout({ ...input, centroids: new Map(input.centroids) });
  onPhase("layout", performance.now() - layoutStart);
  // Set the node aspect before routing. The router can then work against the
  // final node geometry once, even when the canvas is unusually wide or tall.
  if (layout.positions.size > 2 && input.width > 0 && input.height > 0) {
    const canvasAspect = input.width / input.height;
    // Exterior routes add more vertical than horizontal extent on wide DAGs.
    // Reserve that allowance while positioning nodes, before the sole route pass.
    const targetAspect = canvasAspect > 1.45 ? canvasAspect * 1.2 : canvasAspect;
    const bounds = nodeBounds(layout);
    const currentAspect = bounds.width / bounds.height;
    if (Number.isFinite(currentAspect) && currentAspect > 0 &&
        Math.abs(Math.log(currentAspect / targetAspect)) > Math.log(1.08)) {
      const axis = currentAspect < targetAspect ? "x" : "y";
      const factor = Math.min(1.5,
        axis === "x" ? targetAspect / currentAspect : currentAspect / targetAspect);
      const centers = [...layout.positions.values()].map(point => point[axis]);
      const center = (Math.min(...centers) + Math.max(...centers)) / 2;
      layout.positions = new Map([...layout.positions].map(([id, point]) =>
        [id, { ...point, [axis]: center + (point[axis] - center) * factor }]));
      layout.boxes = dagNodeBoxes(input.groups, layout);
    }
  }
  const routeStart = performance.now();
  const routes = routeDag(input, layout);
  onPhase("routing", performance.now() - routeStart);
  return { layout, routes };
}

// A link decision only changes which already routed edges are shown. Keep the
// existing node positions and route segments so Exclude/Restore does not recompute
// the entire graph. An added edge or changed group set needs a full render.
export function reuseDagGeometry(geometry, groups, links) {
  if (!geometry || geometry.groupIds.length !== groups.length
      || groups.some(group => !geometry.groupIds.includes(group.group_id))) return null;
  const routesById = new Map(geometry.routes.map(route => [route.link.edge_id, route]));
  const routes = [];
  for (const link of links) {
    const route = routesById.get(link.edge_id);
    if (!route) return null;
    routes.push({ ...route, link });
  }
  return { layout: geometry.layout, routes };
}
