"use strict";

import { computeDagLayout } from "./dag_layout.mjs";
import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";

// Shared pure calculation for both the browser worker and its synchronous fallback.
export function computeDagRender(input, onPhase = () => {}) {
  const layoutStart = performance.now();
  const layout = computeDagLayout({ ...input, centroids: new Map(input.centroids) });
  onPhase("layout", performance.now() - layoutStart);
  const corridor = studyArrowCorridor({
    ivId: input.ivId,
    dvId: input.dvId,
    positions: layout.positions,
    boxes: layout.boxes,
    fontSize: layout.params.fontSize,
  });
  const routeStart = performance.now();
  const routes = routeEdges(input.links, {
    positions: layout.positions,
    boxes: layout.boxes,
    corridor,
  });
  onPhase("routing", performance.now() - routeStart);
  return { layout, routes };
}

// A link decision only changes which already routed edges are shown. Keep the
// existing node positions and route segments so Hide/Restore does not recompute
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
