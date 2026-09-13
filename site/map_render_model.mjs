// Pure inputs for the canvas and HTML map renderers. This module deliberately
// does not know about DOM nodes, canvas contexts, or the viewer's mutable state.

export const DEFAULT_VARIABLE_COLOR = "#76847b";

export function variableVisualStatus(variableId, groups, activeGroupId) {
  const group = (groups || []).find((candidate) => candidate.variable_ids?.includes(variableId));
  if (!group) return "unassigned";
  if (group.group_id === activeGroupId) return "active";
  if (group.type === "iv") return "iv";
  if (group.type === "dv") return "dv";
  return "assigned";
}

export function variableColor(status, groupColors, fallback = DEFAULT_VARIABLE_COLOR) {
  return groupColors?.[status] || fallback;
}

export function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function colorDistance(a, b) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const dr = ca.r - cb.r;
  const dg = ca.g - cb.g;
  const db = ca.b - cb.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function computePaletteAssignment(groups, variables, palette) {
  const eligible = (groups || []).filter(
    (group) => group.type !== "iv" && group.type !== "dv" && group.variable_ids?.length,
  );
  const worldById = new Map((variables || []).map((variable) => [
    variable.variable_id,
    { x: variable.map_x, y: variable.map_y },
  ]));
  const radii = eligible.map((group) => {
    const points = group.variable_ids.map((id) => worldById.get(id)).filter(Boolean);
    if (!points.length) return 0;
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return Math.max(...points.map((point) => Math.hypot(point.x - cx, point.y - cy)), 0.001);
  });

  const adjacency = Array.from({ length: eligible.length }, () => new Array(eligible.length).fill(false));
  for (let i = 0; i < eligible.length; i += 1) {
    const pointsI = eligible[i].variable_ids.map((id) => worldById.get(id)).filter(Boolean);
    for (let j = i + 1; j < eligible.length; j += 1) {
      const pointsJ = eligible[j].variable_ids.map((id) => worldById.get(id)).filter(Boolean);
      const threshold = (radii[i] + radii[j]) * 1.4;
      let minDistance = Infinity;
      outer: for (const pointI of pointsI) {
        for (const pointJ of pointsJ) {
          const distance = Math.hypot(pointI.x - pointJ.x, pointI.y - pointJ.y);
          if (distance < minDistance) {
            minDistance = distance;
            if (minDistance < threshold * 0.3) break outer;
          }
        }
      }
      if (minDistance < threshold) adjacency[i][j] = adjacency[j][i] = true;
    }
  }

  const order = Array.from({ length: eligible.length }, (_, index) => index)
    .sort((a, b) => adjacency[b].filter(Boolean).length - adjacency[a].filter(Boolean).length);
  const colors = new Array(eligible.length).fill(-1);
  for (const index of order) {
    const neighborColors = adjacency[index]
      .map((isAdjacent, neighbor) => (isAdjacent ? colors[neighbor] : -1))
      .filter((color) => color >= 0);
    let bestIndex = -1;
    let bestScore = -1;
    for (let candidate = 0; candidate < palette.length; candidate += 1) {
      if (neighborColors.includes(candidate)) continue;
      const score = neighborColors.length
        ? Math.min(...neighborColors.map((other) => colorDistance(palette[candidate], palette[other])))
        : Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    colors[index] = bestIndex >= 0 ? bestIndex : index % palette.length;
  }
  return new Map(eligible.map((group, index) => [group.group_id, colors[index]]));
}

export function groupColor(group, { activeGroupId, groupColors, palette, paletteAssignment }) {
  if (group.type === "iv") return groupColors.iv;
  if (group.type === "dv") return groupColors.dv;
  if (group.group_id === activeGroupId) return groupColors.active;
  const index = paletteAssignment?.get(group.group_id);
  if (index !== undefined) return palette[index];
  let hash = 5381;
  for (let i = 0; i < group.group_id.length; i += 1) {
    hash = ((hash << 5) + hash + group.group_id.charCodeAt(i)) & 0x7fffffff;
  }
  return palette[hash % palette.length];
}

export function labelPriority(item) {
  return (item.isHovered ? 64 : 0) + (item.isSelected ? 32 : 0) + (item.isSeed ? 16 : 0)
    + (item.isActive ? 8 : 0) + (item.isSearch ? 4 : 0) + (item.isVisibleContext ? 1 : 0);
}

export function mapLabelClasses(item) {
  return [item.isSeed ? "seed" : "", item.isActive ? "active" : "", item.isSearch ? "search" : "", item.isSelected ? "selected" : "", item.isHovered ? "hovered" : ""]
    .filter(Boolean).join(" ");
}

export function shouldShowVariableLabel(item, { isAssigned = false, fewVisible = false } = {}) {
  return !isAssigned || fewVisible || item.isHovered || item.isSelected || item.isActive;
}

export function estimateLabelSize(text, maxWidth, item) {
  const charWidth = item.isSeed || item.isActive || item.isSelected ? 7.6 : 7.1;
  const width = Math.min(maxWidth, Math.max(54, text.length * charWidth + 16));
  const lineCount = Math.max(1, Math.ceil((text.length * charWidth) / Math.max(54, width - 12)));
  return { w: width, h: Math.min(64, 8 + lineCount * 16) };
}

export function importantMapVariables({
  variables,
  variableById,
  groups,
  activeGroupId,
  focusedGroupId,
  seeds,
  searchMatches,
  selectedVariableId,
  selectedVariableIds,
  hoveredVariableId,
  visibleVarCount = 999,
  width,
  height,
  transform,
  isRejectedVariable,
  clusterRep,
  clusterMemberIds,
  worldToScreen,
  phase,
}) {
  const focusedGroup = focusedGroupId ? groups.find((group) => group.group_id === focusedGroupId) : null;
  const activeGroup = groups.find((group) => group.group_id === activeGroupId);
  const activeIds = new Set([...(activeGroup?.variable_ids || []), ...(focusedGroup?.variable_ids || [])]);
  const seedIds = new Set([...(seeds?.iv || []), ...(seeds?.dv || [])]);
  const searchIds = new Set([...(searchMatches?.iv || []).slice(0, 16), ...(searchMatches?.dv || []).slice(0, 16)]);
  const selectedIds = new Set(selectedVariableIds || []);
  const fewVisible = visibleVarCount <= 50;
  const manyVisible = visibleVarCount > 80;

  if (!manyVisible) {
    for (const seedId of seedIds) {
      const variable = variableById.get(seedId);
      for (const neighbor of variable?.similarity_neighbors?.slice(0, 16) || []) searchIds.add(neighbor.variable_id);
    }
  }

  const labelVisibleViewport = Boolean(activeGroup || focusedGroup
    || phase === "define_dv" || phase === "define_iv" || fewVisible);
  const visibleIds = new Set();
  if (labelVisibleViewport) {
    let count = 0;
    for (const variable of variables) {
      if (!variable.is_cluster_rep || isRejectedVariable(variable.variable_id)) continue;
      const screen = worldToScreen(variable.map_x, variable.map_y, transform);
      if (screen.x < -40 || screen.x > width + 40 || screen.y < -30 || screen.y > height + 30) continue;
      visibleIds.add(variable.variable_id);
      if (++count >= 120) break;
    }
  }
  const selectedRep = clusterRep(selectedVariableId || "");
  const hoveredRep = clusterRep(hoveredVariableId || "");
  const anyMember = (set, variable) => clusterMemberIds(variable.variable_id).some((id) => set.has(id));
  return variables.filter((variable) => variable.is_cluster_rep && !isRejectedVariable(variable.variable_id) && (
    anyMember(activeIds, variable) || anyMember(seedIds, variable) || anyMember(searchIds, variable)
    || visibleIds.has(variable.variable_id) || variable.variable_id === selectedRep
    || selectedIds.has(variable.variable_id) || variable.variable_id === hoveredRep
  )).map((variable) => ({
    variable,
    isActive: anyMember(activeIds, variable),
    isSeed: anyMember(seedIds, variable),
    isSearch: anyMember(searchIds, variable),
    isVisibleContext: visibleIds.has(variable.variable_id),
    isSelected: variable.variable_id === selectedRep || selectedIds.has(variable.variable_id),
    isHovered: variable.variable_id === hoveredRep,
  }));
}

export function buildMapPointModels({ variables, groups, activeGroupId, selectedVariableId, selectedVariableIds, hoveredVariableId, clusterRep, worldToScreen, transform, width, height, uoaFilterEnabled, selectedUoa, uoaMatches, variableColorForStatus }) {
  const points = [];
  for (const variable of variables) {
    const screen = worldToScreen(variable.map_x, variable.map_y, transform);
    if (screen.x < -24 || screen.x > width + 24 || screen.y < -24 || screen.y > height + 24) continue;
    const status = variableVisualStatus(variable.variable_id, groups, activeGroupId);
    const selected = clusterRep(selectedVariableId || "") === variable.variable_id || selectedVariableIds.has(variable.variable_id);
    const hovered = clusterRep(hoveredVariableId || "") === variable.variable_id;
    const uoaMatch = !uoaFilterEnabled || !selectedUoa || uoaMatches(variable.uoa, selectedUoa);
    const merged = variable.cluster_size > 1;
    const baseRadius = selected || hovered ? 5.8 : status === "unassigned" ? 3.2 : 4.4;
    const radius = merged ? baseRadius + Math.min(9, 1.6 * Math.sqrt(variable.cluster_size - 1)) : baseRadius;
    points.push({ variable, screen, status, color: variableColorForStatus(status), selected, hovered, uoaMatch, merged, radius });
  }
  return points;
}
