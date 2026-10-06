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
  const compactOuterLanes = input.width / input.height > 1.45;
  return routeEdges(input.links, { positions: layout.positions, boxes: layout.boxes, corridor,
    config: { compactOuterLanes } });
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
    const targetAspect = input.width / input.height;
    let bestError = Infinity;
    let bestGeometry = null;
    for (let pass = 0; pass < 2; pass += 1) {
      const bounds = renderBounds(layout, routes);
      const currentAspect = bounds.width / bounds.height;
      if (!Number.isFinite(currentAspect) || currentAspect <= 0) break;
      const error = Math.abs(Math.log(currentAspect / targetAspect));
      if (error >= bestError) {
        layout.positions = bestGeometry.positions;
        layout.boxes = bestGeometry.boxes;
        routes = bestGeometry.routes;
        break;
      }
      bestError = error;
      bestGeometry = { positions: layout.positions, boxes: layout.boxes, routes };
      if (error <= Math.log(1.08)) break;
      const axis = currentAspect < targetAspect ? "x" : "y";
      // Keep this a small finishing adjustment; large stretches create empty
      // lanes inside the graph and make related nodes feel far apart.
      const factor = Math.min(pass === 0 ? 1.25 : 1.06,
        axis === "x" ? targetAspect / currentAspect : currentAspect / targetAspect);
      const centers = [...layout.positions.values()].map(point => point[axis]);
      const center = (Math.min(...centers) + Math.max(...centers)) / 2;
      layout.positions = new Map([...layout.positions].map(([id, point]) =>
        [id, { ...point, [axis]: center + (point[axis] - center) * factor }]));
      layout.boxes = dagNodeBoxes(input.groups, layout);
      routes = routeDag(input, layout);
    }
    const finalBounds = renderBounds(layout, routes);
    const finalError = Math.abs(Math.log((finalBounds.width / finalBounds.height) / targetAspect));
    if (bestGeometry && finalError > bestError) {
      layout.positions = bestGeometry.positions;
      layout.boxes = bestGeometry.boxes;
      routes = bestGeometry.routes;
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
