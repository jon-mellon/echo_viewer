// Pure interaction decisions for the variable map. Event listeners remain in
// dag_builder.js because they coordinate state, DOM, history, and rendering.

export function eventPoint(event, rect) {
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function brushAction({ mode, hasActiveGroup, seedSelectionPhase }) {
  const drawToSeed = !hasActiveGroup && mode === "draw_add" && seedSelectionPhase;
  if (!hasActiveGroup && !drawToSeed) return "select_vars";
  return mode === "draw_remove" ? "remove" : "add";
}

export function appendBrushPoint(points, point, minimumDistance = 3) {
  const previous = points?.[points.length - 1];
  if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < minimumDistance) {
    return points.slice();
  }
  return [...(points || []), { x: point.x, y: point.y }];
}

export function panTransform(dragStart, clientX, clientY) {
  return {
    tx: dragStart.tx + clientX - dragStart.x,
    ty: dragStart.ty + clientY - dragStart.y,
  };
}

export function constrainTransform(transform, worldBounds, viewport, minimumVisible = 32) {
  if (!worldBounds || !Number.isFinite(transform?.scale) || transform.scale <= 0) {
    return { ...transform };
  }
  const width = Math.max(0, Number(viewport?.width) || 0);
  const height = Math.max(0, Number(viewport?.height) || 0);
  const visibleX = Math.min(Math.max(0, minimumVisible), width / 2);
  const visibleY = Math.min(Math.max(0, minimumVisible), height / 2);
  const minTx = visibleX - worldBounds.maxX * transform.scale;
  const maxTx = width - visibleX - worldBounds.minX * transform.scale;
  const minTy = visibleY - worldBounds.maxY * transform.scale;
  const maxTy = height - visibleY - worldBounds.minY * transform.scale;
  const constrained = {
    ...transform,
    tx: Math.max(minTx, Math.min(maxTx, transform.tx)),
    ty: Math.max(minTy, Math.min(maxTy, transform.ty)),
  };
  const innerLeft = visibleX;
  const innerRight = width - visibleX;
  const innerTop = visibleY;
  const innerBottom = height - visibleY;
  let nearest = null;
  for (const point of worldBounds.points || []) {
    const x = point.x * transform.scale + constrained.tx;
    const y = point.y * transform.scale + constrained.ty;
    const targetX = Math.max(innerLeft, Math.min(innerRight, x));
    const targetY = Math.max(innerTop, Math.min(innerBottom, y));
    const distance = (targetX - x) ** 2 + (targetY - y) ** 2;
    if (!nearest || distance < nearest.distance) nearest = { x, y, targetX, targetY, distance };
  }
  if (nearest?.distance > 0) {
    constrained.tx += nearest.targetX - nearest.x;
    constrained.ty += nearest.targetY - nearest.y;
  }
  return constrained;
}

export function zoomTransform(transform, screenX, screenY, factor, bounds) {
  const oldScale = transform.scale;
  const newScale = Math.max(bounds.minScale, Math.min(bounds.maxScale, oldScale * factor));
  const applied = newScale / oldScale;
  return {
    scale: newScale,
    tx: screenX - (screenX - transform.tx) * applied,
    ty: screenY - (screenY - transform.ty) * applied,
  };
}

export function nearestVariable(variables, screenPoint, threshold, transform, worldToScreen) {
  let best = null;
  let bestDistance = threshold;
  for (const variable of variables || []) {
    const screen = worldToScreen(variable.map_x, variable.map_y, transform);
    const distance = Math.hypot(screen.x - screenPoint.x, screen.y - screenPoint.y);
    if (distance < bestDistance) {
      best = variable;
      bestDistance = distance;
    }
  }
  return best;
}

export function selectionAfterClick({ variableId, priorId, shiftKey }) {
  if (!variableId) return { comparisonVariableIds: [], selectedVariableIds: [] };
  if (shiftKey && priorId && priorId !== variableId) {
    return { comparisonVariableIds: [priorId, variableId], selectedVariableIds: [priorId, variableId] };
  }
  return { comparisonVariableIds: [], selectedVariableIds: [variableId] };
}

export function contextMenuPosition({ clientX, clientY, rect, menuWidth, menuHeight, offset = 10, padding = 8 }) {
  const x = clientX - rect.left + offset;
  const y = clientY - rect.top + offset;
  return {
    left: Math.max(padding, Math.min(x, rect.width - menuWidth - padding)),
    top: Math.max(padding, Math.min(y, rect.height - menuHeight - padding)),
  };
}
