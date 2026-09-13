// Frozen pre-extraction drawing routines for command compatibility tests.
function drawVoronoiBackground(ctx, width, height) {
  const cells = ensureGlobalVoronoiCells();
  if (!cells.size) return;
  ctx.save();
  ctx.strokeStyle = "rgba(70, 80, 75, 0.11)";
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (const poly of cells.values()) {
    const pts = poly.map((p) => worldToScreen(p.x, p.y));
    if (!pts.some((s) => s.x > -20 && s.x < width + 20 && s.y > -20 && s.y < height + 20)) continue;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.restore();
}

function drawGroupMemberHalos(ctx, group, active) {
  const stroke = active ? GROUP_COLORS.active : group.type === "iv" ? GROUP_COLORS.iv : group.type === "dv" ? GROUP_COLORS.dv : GROUP_COLORS.assigned;
  for (const variableId of group.variable_ids || []) {
    const v = state.variableById.get(variableId);
    if (!v) continue;
    const point = worldToScreen(v.map_x, v.map_y);
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, active ? 13 : 10, 0, Math.PI * 2);
    ctx.fillStyle = active ? "rgba(184, 59, 94, 0.10)" : "rgba(31, 122, 103, 0.075)";
    ctx.strokeStyle = stroke;
    ctx.lineWidth = active ? 1.7 : 1.1;
    ctx.setLineDash([]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawStoredGroupPolygons(ctx, group, active) {
  const polygons = group.boundary_geometry?.polygons || [];
  const drawable = polygons.filter((p) => Array.isArray(p.points) && p.points.length >= 3);
  if (!drawable.length) return false;
  for (const polygon of drawable) {
    const points = polygon.points.map((p) => worldToScreen(p.x, p.y));
    const removing = polygon.action === "remove";
    ctx.save();
    ctx.fillStyle = removing ? "rgba(184, 59, 94, 0.08)" : active ? "rgba(31, 122, 103, 0.11)" : "rgba(31, 122, 103, 0.06)";
    ctx.strokeStyle = removing ? GROUP_COLORS.active : group.type === "iv" ? GROUP_COLORS.iv : group.type === "dv" ? GROUP_COLORS.dv : GROUP_COLORS.assigned;
    ctx.lineWidth = active ? 2.2 : 1.3;
    ctx.setLineDash(removing ? [5, 4] : []);
    drawPolygonPath(ctx, points);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  return true;
}

function drawPolygonPath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.closePath();
}

function drawGroupRegion(ctx, group, region, active) {
  if (!region.territories?.length) return;
  const color = groupColor(group);
  const lw = active ? 2.2 : 1.5;
  const W = canvasWidth(), H = canvasHeight();

  // Append all territory subpaths to whatever path is currently open.
  const addPaths = () => {
    for (const poly of region.territories) {
      const p0 = worldToScreen(poly[0].x, poly[0].y);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = worldToScreen(poly[i].x, poly[i].y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
  };

  ctx.save();

  // 1. Fill: all territories as one path — adjacent cells share edges (not area)
  //    so the union fills as a single continuous shape with no visible seams.
  ctx.beginPath();
  addPaths();
  ctx.fillStyle = hexToRgba(color, active ? 0.16 : 0.09);
  ctx.fill();

  // 2. Stroke: draw only the outer boundary by clipping to outside-the-union.
  //    evenodd rule on (canvas rect ∪ territories) = everywhere outside territories.
  //    Stroke width is doubled so the inner half (inside union) is clipped away,
  //    leaving a correctly-sized stroke only at the outer edge.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  addPaths();
  ctx.clip('evenodd');
  ctx.beginPath();
  addPaths();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw * 2;
  ctx.setLineDash(active ? [6, 3] : []);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

function drawMapPoints(ctx, width, height) {
  const points = mapRenderModel.buildMapPointModels({
    variables: visibleClusterReps(),
    groups: state.project?.groups || [],
    activeGroupId: state.activeGroupId,
    selectedVariableId: state.selectedVariableId,
    selectedVariableIds: state.selectedVariableIds,
    hoveredVariableId: state.hoveredVariableId,
    clusterRep,
    worldToScreen: mapGeometry.worldToScreen,
    transform: state.map.transform,
    width,
    height,
    uoaFilterEnabled: state.uoaFilterEnabled,
    selectedUoa: state.selectedUoa,
    uoaMatches,
    variableColorForStatus: variableColor,
  });
  for (const { variable: v, screen, status, color, selected, hovered, uoaMatch, merged, radius } of points) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.globalAlpha = uoaMatch
      ? (status === "unassigned" ? 0.46 : 0.88)
      : 0.10;
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = uoaMatch ? 1 : 0.12;
    ctx.lineWidth = selected || hovered ? 2.2 : 0.9;
    ctx.strokeStyle = selected || hovered ? "#17201b" : "rgba(255,255,255,0.82)";
    ctx.stroke();
    if (merged && uoaMatch) {
      // Count badge so a merged node visibly represents N duplicate measures.
      const label = String(v.cluster_size);
      ctx.globalAlpha = 1;
      ctx.font = "700 9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#17201b";
      ctx.fillText(label, screen.x, screen.y + 0.5);
    }
    ctx.restore();
  }
}

function drawBrush(ctx) {
  const brush = state.map.brush;
  if (!brush?.points?.length) return;
  ctx.save();
  ctx.fillStyle = brush.action === "remove"
    ? "rgba(184, 59, 94, 0.10)"
    : brush.action === "select_vars"
      ? "rgba(49, 95, 157, 0.10)"
      : "rgba(31, 122, 103, 0.10)";
  ctx.strokeStyle = brush.action === "remove"
    ? GROUP_COLORS.active
    : brush.action === "select_vars"
      ? GROUP_COLORS.iv
      : GROUP_COLORS.assigned;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  if (brush.points.length >= 3) { drawPolygonPath(ctx, brush.points); ctx.fill(); ctx.stroke(); }
  else { ctx.beginPath(); ctx.arc(brush.points[0].x, brush.points[0].y, 4, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
