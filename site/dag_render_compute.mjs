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
