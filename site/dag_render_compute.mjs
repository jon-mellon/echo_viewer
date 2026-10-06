"use strict";

import { computeDagLayout, dagNodeBoxes } from "./dag_layout.mjs";
import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";

function renderBounds(layout, routes) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const box of layout.boxes.values()) {
    left = Math.min(left, box.x);
    right = Math.max(right, box.x + box.w);
    top = Math.min(top, box.y);
    bottom = Math.max(bottom, box.y + box.h);
  }
  for (const route of routes) for (const point of route.points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return { width: right - left, height: bottom - top };
}

function routeDag(input, layout) {
  const corridor = studyArrowCorridor({
    ivId: input.ivId, dvId: input.dvId,
    positions: layout.positions, boxes: layout.boxes,
    fontSize: layout.params.fontSize,
  });
  return routeEdges(input.links, { positions: layout.positions, boxes: layout.boxes, corridor });
}

// Shared pure calculation for both the browser worker and its synchronous fallback.
export function computeDagRender(input, onPhase = () => {}) {
  const layoutStart = performance.now();
  const layout = computeDagLayout({ ...input, centroids: new Map(input.centroids) });
  onPhase("layout", performance.now() - layoutStart);
  const routeStart = performance.now();
  let routes = routeDag(input, layout);
  // fit() scales both axes equally. Spread the node centers along the short
  // dimension so the routed drawing matches the canvas aspect ratio.
  if (layout.positions.size > 2 && input.width > 0 && input.height > 0) {
    const bounds = renderBounds(layout, routes);
    const currentAspect = bounds.width / bounds.height;
    const targetAspect = input.width / input.height;
    if (Number.isFinite(currentAspect) && currentAspect > 0 &&
        (currentAspect < targetAspect / 1.12 || currentAspect > targetAspect * 1.12)) {
      const axis = currentAspect < targetAspect ? "x" : "y";
      // Keep this a small finishing adjustment; large stretches create empty
      // lanes inside the graph and make related nodes feel far apart.
      const factor = Math.min(1.25, axis === "x" ? targetAspect / currentAspect : currentAspect / targetAspect);
      const centers = [...layout.positions.values()].map(point => point[axis]);
      const center = (Math.min(...centers) + Math.max(...centers)) / 2;
      layout.positions = new Map([...layout.positions].map(([id, point]) =>
        [id, { ...point, [axis]: center + (point[axis] - center) * factor }]));
      layout.boxes = dagNodeBoxes(input.groups, layout);
      routes = routeDag(input, layout);
    }
  }
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
