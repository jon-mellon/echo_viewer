import * as mapGeometry from "./map_geometry.mjs";
import * as mapInteractions from "./map_interactions.mjs";

// Owns map mode and viewport lifecycle. Drawing primitives remain independently
// testable; the caller supplies the final frame renderer.
export function createDagMapViewController({
  state, elements, activeGroup, visibleVariables, isRejectedVariable, drawMap,
}) {
  let drawFrame = null;
  let settledTimer = null;
  const canvasWidth = () => state.map.canvas.width / state.map.dpr;
  const canvasHeight = () => state.map.canvas.height / state.map.dpr;
  const isDrawMode = (mode = state.map.mode) => mode === "draw_add" || mode === "draw_remove";
  const isSeedSelectionPhase = () => state.phase === "select_dv" || state.phase === "select_iv";

  function renderModeControls() {
    if (state.map.mode === "draw_remove" && !activeGroup()) state.map.mode = "select";
    elements.dagMapCanvas.classList.toggle("brush-mode", isDrawMode());
    elements.dagSelectMode.disabled = false;
    elements.dagBrushMode.disabled = false;
    elements.dagEraseMode.disabled = !activeGroup();
    for (const [element, mode] of [[elements.dagSelectMode, "select"], [elements.dagBrushMode, "draw_add"], [elements.dagEraseMode, "draw_remove"]]) {
      const active = state.map.mode === mode;
      element.classList.toggle("active", active);
      element.setAttribute("aria-pressed", active ? "true" : "false");
    }
    elements.dagBrushMode.title = activeGroup()
      ? "Draw a boundary to add visible variables to the active group"
      : isSeedSelectionPhase()
        ? "Draw a boundary to pick the enclosed variables as the seed set"
        : "Draw a boundary to select visible variables for bulk actions";
    elements.dagEraseMode.title = activeGroup()
      ? "Draw a boundary to remove visible variables from the active group"
      : "Open a group first to use erase mode";
  }

  function setMode(mode) {
    state.map.mode = mode === "draw_remove" && !activeGroup() ? "select" : mode;
    renderModeControls();
  }

  function visibleBounds() {
    const variables = visibleVariables();
    if (!variables.length) return null;
    const xs = variables.map(variable => variable.map_x), ys = variables.map(variable => variable.map_y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
      points: variables.map(variable => ({ x: variable.map_x, y: variable.map_y })) };
  }

  function constrain(transform) {
    return mapInteractions.constrainTransform(transform, visibleBounds(),
      { width: canvasWidth(), height: canvasHeight() });
  }

  function resize() {
    const canvas = state.map.canvas, rect = canvas.getBoundingClientRect();
    state.map.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * state.map.dpr));
    canvas.height = Math.max(1, Math.round(rect.height * state.map.dpr));
    state.map.ctx.setTransform(state.map.dpr, 0, 0, state.map.dpr, 0, 0);
    Object.assign(state.map.transform, constrain(state.map.transform));
    drawMap();
  }

  function worldSpan() {
    if (state.map._worldSpan == null) {
      const variables = visibleVariables();
      if (!variables.length) return 1;
      const xs = variables.map(v => v.map_x), ys = variables.map(v => v.map_y);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      state.map._worldSpan = span > 0 ? span : 1;
    }
    return state.map._worldSpan;
  }

  function fit(variableIds = null) {
    const variables = variableIds?.length
      ? variableIds.map(id => state.variableById.get(id)).filter(v => v && !isRejectedVariable(v.variable_id))
      : visibleVariables();
    if (!variables.length || !state.map.canvas) return;
    const xs = variables.map(v => v.map_x), ys = variables.map(v => v.map_y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const width = Math.max(1, canvasWidth()), height = Math.max(1, canvasHeight());
    const minSpan = worldSpan() * 0.03;
    const padding = variableIds?.length ? 150 : 54;
    const scale = Math.min(Math.max(1, width - padding * 2) / Math.max(maxX - minX, minSpan),
      Math.max(1, height - padding * 2) / Math.max(maxY - minY, minSpan));
    Object.assign(state.map.transform, { scale, tx: width / 2 - ((minX + maxX) / 2) * scale,
      ty: height / 2 - ((minY + maxY) / 2) * scale });
    state.map.fitScale = scale;
    drawMap();
  }

  function fitNeighborhood(variableIds, neighborLimit = 48) {
    const ids = new Set(variableIds || []);
    for (const variableId of variableIds || []) {
      for (const neighbor of state.variableById.get(variableId)?.similarity_neighbors || []) {
        if (ids.size >= (variableIds?.length || 0) + neighborLimit) break;
        if (state.variableById.has(neighbor.variable_id)) ids.add(neighbor.variable_id);
      }
    }
    fit([...ids]);
  }

  function schedule(includeLabels = false) {
    if (drawFrame !== null) return;
    drawFrame = requestAnimationFrame(() => { drawFrame = null; drawMap({ includeLabels }); });
  }

  function scheduleSettled(delayMs = 100) {
    if (settledTimer !== null) clearTimeout(settledTimer);
    settledTimer = setTimeout(() => { settledTimer = null; drawMap(); }, delayMs);
  }

  function beginDraw(includeLabels) {
    if (drawFrame !== null) { cancelAnimationFrame(drawFrame); drawFrame = null; }
    if (includeLabels && settledTimer !== null) { clearTimeout(settledTimer); settledTimer = null; }
  }

  function zoom(screenX, screenY, factor, interactive = false) {
    const base = state.map.fitScale || 1, variables = visibleVariables();
    const xs = variables.map(v => v.map_x), ys = variables.map(v => v.map_y), minSpan = worldSpan() * 0.03;
    const wholeFit = variables.length ? Math.min(
      Math.max(1, canvasWidth() - 108) / Math.max(minSpan, Math.max(...xs) - Math.min(...xs)),
      Math.max(1, canvasHeight() - 108) / Math.max(minSpan, Math.max(...ys) - Math.min(...ys))) : base;
    Object.assign(state.map.transform, constrain(mapInteractions.zoomTransform(
      state.map.transform, screenX, screenY, factor, { minScale: wholeFit * 0.8, maxScale: base * 32 })));
    if (interactive) { schedule(false); scheduleSettled(); } else drawMap();
  }

  return {
    setMode, isDrawMode, isSeedSelectionPhase, renderModeControls, resize,
    canvasWidth, canvasHeight, visibleBounds, constrain, worldSpan, fit, fitNeighborhood, zoom,
    worldToScreen: (x, y) => mapGeometry.worldToScreen(x, y, state.map.transform),
    screenToWorld: (x, y) => mapGeometry.screenToWorld(x, y, state.map.transform),
    schedule, scheduleSettled, beginDraw,
  };
}
