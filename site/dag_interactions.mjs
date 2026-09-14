export function constrainViewPosition(position, scale, contentBounds, viewport, minimumVisible = 32) {
  if (!contentBounds || !Number.isFinite(scale) || scale <= 0) return { ...position };
  const width = Math.max(0, Number(viewport?.width) || 0);
  const height = Math.max(0, Number(viewport?.height) || 0);
  const visibleX = Math.min(Math.max(0, minimumVisible), width / 2) / scale;
  const visibleY = Math.min(Math.max(0, minimumVisible), height / 2) / scale;
  const halfWidth = width / (2 * scale);
  const halfHeight = height / (2 * scale);
  const constrained = {
    x: Math.max(
      contentBounds.left - halfWidth + visibleX,
      Math.min(contentBounds.right + halfWidth - visibleX, position.x),
    ),
    y: Math.max(
      contentBounds.top - halfHeight + visibleY,
      Math.min(contentBounds.bottom + halfHeight - visibleY, position.y),
    ),
  };
  let nearest = null;
  for (const box of contentBounds.boxes || []) {
    const x = ((box.left + box.right) / 2 - constrained.x) * scale + width / 2;
    const y = ((box.top + box.bottom) / 2 - constrained.y) * scale + height / 2;
    const targetX = Math.max(visibleX * scale, Math.min(width - visibleX * scale, x));
    const targetY = Math.max(visibleY * scale, Math.min(height - visibleY * scale, y));
    const distance = (targetX - x) ** 2 + (targetY - y) ** 2;
    if (!nearest || distance < nearest.distance) nearest = { box, x, y, targetX, targetY, distance };
  }
  if (nearest?.distance > 0) {
    constrained.x -= (nearest.targetX - nearest.x) / scale;
    constrained.y -= (nearest.targetY - nearest.y) / scale;
  }
  return constrained;
}

// Network event ownership; callbacks read current viewer state at event time.
export function attachDagInteractions(network, element, actions) {
  let constrainingViewport = false;
  const constrainViewport = () => {
    if (constrainingViewport) return;
    const scale = Math.max(actions.minimumScale(), network.getScale());
    const position = constrainViewPosition(
      network.getViewPosition(),
      scale,
      actions.contentBounds(),
      { width: element.clientWidth, height: element.clientHeight },
    );
    const current = network.getViewPosition();
    if (scale === network.getScale() &&
        Math.abs(position.x - current.x) < 0.01 &&
        Math.abs(position.y - current.y) < 0.01) return;
    constrainingViewport = true;
    network.moveTo({ position, scale, animation: false });
    constrainingViewport = false;
  };
  const handlers = {
    zoom: constrainViewport,
    dragging: constrainViewport,
    dragEnd: constrainViewport,
    beforeDrawing: context => actions.drawPathLanes(context),
    hoverEdge: event => actions.highlightEdge(event.edge),
    blurEdge: () => actions.clearEdgeHover(),
    hoverNode(event) {
      if (actions.isDiagnosticCandidate(event.node)) actions.highlightPaths(event.node);
      else actions.clearPathHover();
    },
    blurNode: () => actions.clearPathHover(),
    selectNode(event) {
      const id = event.nodes[0];
      if (id && actions.hasGroup(id)) actions.focusGroup(id);
    },
    doubleClick(event) {
      const id = event.nodes?.[0];
      if (id && actions.hasGroup(id)) {
        actions.openGroup(id);
        return;
      }
      if (!event.nodes?.length && !event.edges?.length && event.pointer?.canvas) {
        actions.zoomToPoint(event.pointer.canvas);
      }
    },
    selectEdge(event) {
      const id = actions.logicalEdgeId(event.edges[0]);
      if (id) actions.selectEdge(id);
    },
  };
  const leave = () => { actions.clearEdgeHover(); actions.clearPathHover(); };
  for (const [name, handler] of Object.entries(handlers)) network.on(name, handler);
  element.addEventListener("mouseleave", leave);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) network.off(name, handler);
    element.removeEventListener("mouseleave", leave);
  };
}
