"use strict";

import { computeDagLayout } from "./dag_layout.mjs";
import { routeEdges, studyArrowCorridor } from "./dag_router.mjs";

// Shared pure calculation for both the browser worker and its synchronous fallback.
export function computeDagRender(input) {
  const layout = computeDagLayout({ ...input, centroids: new Map(input.centroids) });
  const corridor = studyArrowCorridor({
    ivId: input.ivId,
    dvId: input.dvId,
    positions: layout.positions,
    boxes: layout.boxes,
    fontSize: layout.params.fontSize,
  });
  const routes = routeEdges(input.links, {
    positions: layout.positions,
    boxes: layout.boxes,
    corridor,
  });
  return { layout, routes };
}
