"use strict";

import { computeDagRender } from "./dag_render_compute.mjs";

self.addEventListener("message", (event) => {
  const { requestId, input } = event.data;
  const { layout, routes } = computeDagRender(input);
  self.postMessage({
    requestId,
    layout: {
      ...layout,
      positions: [...layout.positions],
      boxes: [...layout.boxes],
    },
    routes,
  });
});
