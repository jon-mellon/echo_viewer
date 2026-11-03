// Group colors for the DAG: Ind var and Dep var keep fixed colors, and every other group gets a palette color that
// differs from the groups whose variables sit close to it (by their coordinates), falling back to a stable choice by
// group id until those coordinates are loaded.

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

function stablePaletteIndex(groupId, paletteLength) {
  if (!paletteLength) return -1;
  let hash = 5381;
  for (let i = 0; i < groupId.length; i += 1) {
    hash = ((hash << 5) + hash + groupId.charCodeAt(i)) & 0x7fffffff;
  }
  return hash % paletteLength;
}

export function computePaletteAssignment(groups, variables, palette) {
  const eligible = (groups || []).filter(
    (group) => group.type !== "iv" && group.type !== "dv" && group.variable_ids?.length,
  );
  const worldById = new Map((variables || []).map((variable) => [
    variable.variable_id,
    { x: variable.map_x, y: variable.map_y },
  ]));
  // Compiled publications hydrate memberships before they lazily load any R2
  // variable coordinates. Preserve the deterministic group-id fallback until
  // coordinates exist instead of assigning every group palette slot zero.
  if (!worldById.size) return new Map();
  const pointsByGroup = eligible.map((group) => group.variable_ids.map((id) => worldById.get(id)).filter(Boolean));
  const bounds = pointsByGroup.map((points) => points.reduce((box, point) => ({
    x0: Math.min(box.x0, point.x), x1: Math.max(box.x1, point.x),
    y0: Math.min(box.y0, point.y), y1: Math.max(box.y1, point.y),
  }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }));
  const radii = pointsByGroup.map((points) => {
    if (!points.length) return 0;
    const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    return Math.max(...points.map((point) => Math.hypot(point.x - cx, point.y - cy)), 0.001);
  });

  const adjacency = Array.from({ length: eligible.length }, () => new Array(eligible.length).fill(false));
  for (let i = 0; i < eligible.length; i += 1) {
    const pointsI = pointsByGroup[i];
    for (let j = i + 1; j < eligible.length; j += 1) {
      const pointsJ = pointsByGroup[j];
      const threshold = (radii[i] + radii[j]) * 1.4;
      // Bounding boxes can only be closer than their members, so a gap at
      // least the threshold rules the pair out without comparing points.
      const gapX = Math.max(0, bounds[i].x0 - bounds[j].x1, bounds[j].x0 - bounds[i].x1);
      const gapY = Math.max(0, bounds[i].y0 - bounds[j].y1, bounds[j].y0 - bounds[i].y1);
      if (!(Math.hypot(gapX, gapY) < threshold)) continue;
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
    // Published schemas can be edited before all member coordinates have been
    // hydrated. Those groups (and genuinely isolated groups) have no colored
    // neighbors. Giving every one of them candidate zero makes the entire DAG
    // turn green after any edit invalidates the palette cache. Use the same
    // stable group-id fallback as groupColor until spatial adjacency is known.
    if (!neighborColors.length) {
      colors[index] = stablePaletteIndex(eligible[index].group_id, palette.length);
      continue;
    }
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
  return palette[stablePaletteIndex(group.group_id, palette.length)];
}

export function createGroupPalette({ state, colors, palette }) {
  let signature = null;
  let shape = null;
  let assignment = new Map(); // group_id -> palette index

  function invalidate() {
    signature = null;
    shape = null;
    assignment = new Map();
  }

  // groupColor() runs once per DAG node, so the full membership signature is too costly to rebuild on every call.
  // When no group or membership array has been replaced, resized or renamed, the assignment still holds; otherwise
  // fall back to comparing the full signature.
  const groupShape = groups => groups.map(g => [g, g.group_id, g.variable_ids, g.variable_ids.length]);
  const sameShape = (previous, groups) => previous?.length === groups.length && previous.every(([group, id, ids, length], index) =>
    group === groups[index] && id === group.group_id && ids === group.variable_ids && length === ids.length);

  // Replaced groups usually keep most membership arrays, or copy them unchanged.
  // Key each array once so the fallback signature is cheap to rebuild and compare.
  const membershipKeys = new WeakMap();
  function membershipKey(ids) {
    const cached = membershipKeys.get(ids);
    if (cached?.length === ids.length) return cached.key;
    const key = ids.join(",");
    membershipKeys.set(ids, { length: ids.length, key });
    return key;
  }
  const groupSignature = groups => groups.map(g => [g.group_id, membershipKey(g.variable_ids)]);
  const sameSignature = (a, b) => a?.length === b.length && a.every(([id, key], index) => id === b[index][0] && key === b[index][1]);

  function refresh() {
    const groups = state.project?.groups || [];
    if (sameShape(shape, groups)) return;
    shape = groupShape(groups);
    const next = groupSignature(groups);
    if (sameSignature(signature, next)) return;
    signature = next;
    assignment = computePaletteAssignment(groups, state.variables, palette);
  }

  function color(group) {
    if (group.group_id === "__definition_new__") return colors.active;
    refresh();
    return groupColor(group, { activeGroupId: state.activeGroupId, groupColors: colors, palette, paletteAssignment: assignment });
  }

  return { groupColor: color, invalidate };
}
