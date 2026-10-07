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
  let lastTouchAt = -Infinity;
  let tappedCandidateId = null;
  let touchStart = null;
  let previousTap = null;
  let handledTouchDoubleTapAt = -Infinity;
  const rememberTouch = event => {
    lastTouchAt = Date.now();
    const touch = event?.touches?.length === 1 ? event.touches[0] : null;
    touchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const isTouchGesture = event => {
    const source = event?.event?.srcEvent || event?.event;
    if (source?.pointerType) return source.pointerType === "touch";
    if (source?.type) return source.type.startsWith("touch");
    return Date.now() - lastTouchAt < 700;
  };
  const rememberTouchPointer = event => {
    if (event.pointerType === "touch") rememberTouch();
  };
  const clearTappedCandidate = () => {
    if (!tappedCandidateId) return;
    tappedCandidateId = null;
    actions.clearPathHover();
  };
  const onTouchEnd = event => {
    const touch = event.changedTouches?.[0];
    if (!touch || event.touches?.length || !touchStart) return;
    const x = touch.clientX, y = touch.clientY;
    const moved = Math.hypot(x - touchStart.x, y - touchStart.y);
    touchStart = null;
    if (moved > 12) { previousTap = null; return; }
    const rect = element.getBoundingClientRect();
    const id = network.getNodeAt?.({ x: x - rect.left, y: y - rect.top });
    const now = Date.now();
    if (id && actions.hasGroup(id) && previousTap?.id === id
      && now - previousTap.at <= 400
      && Math.hypot(x - previousTap.x, y - previousTap.y) <= 24) {
      event.preventDefault();
      previousTap = null;
      handledTouchDoubleTapAt = now;
      clearTappedCandidate();
      actions.focusGroup(id);
      return;
    }
    previousTap = id && actions.hasGroup(id) ? { id, x, y, at: now } : null;
  };
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
    // Ignore a late blur for an old edge after a newer hover has already won.
    blurEdge: event => actions.clearEdgeHover(event.edge),
    hoverNode(event) {
      if (tappedCandidateId && isTouchGesture(event)) return;
      clearTappedCandidate();
      if (actions.isDiagnosticCandidate(event.node)) {
        actions.clearEdgeHover();
        actions.highlightPaths(event.node);
      } else {
        actions.clearPathHover();
        actions.highlightNodeEdges(event.node);
      }
    },
    blurNode: () => {
      if (!tappedCandidateId) actions.clearPathHover();
      actions.clearEdgeHover();
    },
    selectNode(event) {
      const id = event.nodes[0];
      if (id && actions.hasGroup(id)) {
        if (isTouchGesture(event)) {
          clearTappedCandidate();
          if (actions.isDiagnosticCandidate(id)) {
            tappedCandidateId = id;
            actions.clearEdgeHover();
            actions.highlightPaths(id);
          } else {
            actions.highlightNodeEdges(id);
          }
        } else {
          actions.focusGroup(id);
        }
        // The graph selection is temporary for both mouse and touch actions.
        // Clear vis.js's otherwise persistent burgundy selection treatment.
        network.unselectAll();
      }
    },
    doubleClick(event) {
      if (isTouchGesture(event) && Date.now() - handledTouchDoubleTapAt < 400) return;
      // vis-network reports the current selection here, which we intentionally
      // clear after a single tap. Hit-test the second tap before treating it as
      // a double-click on empty space.
      const id = event.pointer?.DOM
        ? network.getNodeAt?.(event.pointer.DOM) || event.nodes?.[0]
        : event.nodes?.[0];
      if (id && actions.hasGroup(id)) {
        clearTappedCandidate();
        if (isTouchGesture(event)) actions.focusGroup(id);
        else actions.openGroup(id);
        return;
      }
      if (!event.nodes?.length && !event.edges?.length && event.pointer?.canvas) {
        actions.zoomToPoint(event.pointer.canvas);
      }
    },
    selectEdge(event) {
      clearTappedCandidate();
      const id = actions.logicalEdgeId(event.edges[0]);
      if (id) {
        actions.selectEdge(id);
        // A routed link consists of several vis edges. Its built-in selection
        // paints only the clicked segment over our logical-link styling.
        network.unselectAll();
      }
    },
  };
  const leave = () => {
    if (!tappedCandidateId) actions.clearPathHover();
    actions.clearEdgeHover();
  };
  const clearOnBackgroundTap = event => {
    if (!event.nodes?.length && !event.edges?.length) clearTappedCandidate();
  };
  handlers.click = clearOnBackgroundTap;
  for (const [name, handler] of Object.entries(handlers)) network.on(name, handler);
  element.addEventListener("touchstart", rememberTouch, { passive: true });
  element.addEventListener("touchend", onTouchEnd, { passive: false });
  element.addEventListener("pointerdown", rememberTouchPointer);
  element.addEventListener("mouseleave", leave);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) network.off(name, handler);
    element.removeEventListener("touchstart", rememberTouch);
    element.removeEventListener("touchend", onTouchEnd);
    element.removeEventListener("pointerdown", rememberTouchPointer);
    element.removeEventListener("mouseleave", leave);
  };
}
