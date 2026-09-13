// Frozen pre-extraction layout oracle. Do not update when changing layout heuristics.
export function legacyLayout({ groups, links, centroids, ivId, dvId, mode, width, height }) {
  const state = { dagLayoutMode: mode, project: { iv_group_id: ivId, dv_group_id: dvId } };
  const groupMapCentroid = group => centroids.get(group.group_id) || { x: 0, y: 0 };
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function layoutDirectedEdges(groups, links) {
  const ids = new Set(groups.map((group) => group.group_id));
  const edges = [];
  for (const link of links || []) {
    if (!ids.has(link.group_a) || !ids.has(link.group_b)) continue;
    if (link.direction_type === "BIDIRECTIONAL") {
      edges.push({ from: link.group_a, to: link.group_b, link, weak: true });
      edges.push({ from: link.group_b, to: link.group_a, link, weak: true });
    } else if (link.direction_type === "B_TO_A") {
      edges.push({ from: link.group_b, to: link.group_a, link, weak: false });
    } else {
      edges.push({ from: link.group_a, to: link.group_b, link, weak: false });
    }
  }
  return edges;
}

function normalizedValue(value, min, max) {
  if (!Number.isFinite(value) || max <= min) return 0.5;
  return clampNumber((value - min) / (max - min), 0, 1);
}

function softCausalRanks(groups, edges) {
  const ids = groups.map((group) => group.group_id);
  const ranks = new Map(ids.map((id) => [id, 0]));
  const degreeBias = new Map(ids.map((id) => [id, 0]));
  for (const edge of edges) {
    const weight = edge.weak ? 0.25 : 1;
    degreeBias.set(edge.from, (degreeBias.get(edge.from) || 0) - 0.08 * weight);
    degreeBias.set(edge.to, (degreeBias.get(edge.to) || 0) + 0.08 * weight);
  }
  for (let iter = 0; iter < 120; iter += 1) {
    for (const edge of edges) {
      const weight = edge.weak ? 0.18 : 1;
      const fromRank = ranks.get(edge.from) || 0;
      const toRank = ranks.get(edge.to) || 0;
      const error = (fromRank + 1) - toRank;
      const step = clampNumber(error * 0.018 * weight, -0.035, 0.035);
      ranks.set(edge.from, fromRank - step);
      ranks.set(edge.to, toRank + step);
    }
    const mean = ids.reduce((sum, id) => sum + (ranks.get(id) || 0), 0) / Math.max(1, ids.length);
    for (const id of ids) {
      ranks.set(id, ((ranks.get(id) || 0) - mean) * 0.985 + (degreeBias.get(id) || 0));
    }
  }
  const values = ids.map((id) => ranks.get(id) || 0);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  return new Map(ids.map((id) => [id, normalizedValue(ranks.get(id) || 0, min, max)]));
}

function assignDagColumns(groups, scores, columnCount) {
  const ordered = groups
    .slice()
    .sort((a, b) => (scores.get(a.group_id) || 0) - (scores.get(b.group_id) || 0)
      || (a.label || "").localeCompare(b.label || ""));
  const columns = Array.from({ length: columnCount }, () => []);
  for (let index = 0; index < ordered.length; index += 1) {
    const column = Math.min(columnCount - 1, Math.floor((index * columnCount) / Math.max(1, ordered.length)));
    columns[column].push(ordered[index]);
  }
  return columns;
}

function moveGroupBetweenColumns(groupId, fromColumn, toColumn, columns) {
  if (fromColumn === toColumn) return false;
  const source = columns[fromColumn];
  const index = source.findIndex((group) => group.group_id === groupId);
  if (index < 0) return false;
  const [group] = source.splice(index, 1);
  columns[toColumn].push(group);
  return true;
}

function rebalanceColumnsForDirectedEdges(columns, edges) {
  const total = columns.reduce((sum, column) => sum + column.length, 0);
  const maxPerColumn = Math.ceil(total / columns.length) + 3;
  for (let pass = 0; pass < 8; pass += 1) {
    const columnOf = new Map();
    columns.forEach((column, columnIndex) => {
      column.forEach((group) => columnOf.set(group.group_id, columnIndex));
    });
    let moved = false;
    for (const edge of edges) {
      if (edge.weak) continue;
      const fromColumn = columnOf.get(edge.from);
      const toColumn = columnOf.get(edge.to);
      if (!Number.isFinite(fromColumn) || !Number.isFinite(toColumn) || fromColumn < toColumn) continue;
      if (toColumn < columns.length - 1 && columns[toColumn + 1].length < maxPerColumn) {
        moved = moveGroupBetweenColumns(edge.to, toColumn, toColumn + 1, columns) || moved;
      } else if (fromColumn > 0 && columns[fromColumn - 1].length < maxPerColumn) {
        moved = moveGroupBetweenColumns(edge.from, fromColumn, fromColumn - 1, columns) || moved;
      }
    }
    if (!moved) break;
  }
}

function degreeByGroup(groups, edges) {
  const degree = new Map(groups.map((group) => [group.group_id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  return degree;
}

function orderColumnsForFewerCrossings(columns, centroids, edges, degree) {
  const columnOf = new Map();
  const order = new Map();
  const adjacency = new Map();
  columns.forEach((column, columnIndex) => {
    column.forEach((group, rowIndex) => {
      columnOf.set(group.group_id, columnIndex);
      order.set(group.group_id, rowIndex);
      adjacency.set(group.group_id, []);
    });
  });
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  for (const column of columns) {
    column.sort((a, b) => (centroids.get(a.group_id)?.y || 0) - (centroids.get(b.group_id)?.y || 0)
      || (degree.get(b.group_id) || 0) - (degree.get(a.group_id) || 0)
      || (a.label || "").localeCompare(b.label || ""));
    column.forEach((group, rowIndex) => order.set(group.group_id, rowIndex));
  }
  for (let pass = 0; pass < 8; pass += 1) {
    const sweep = pass % 2 === 0
      ? [...columns.keys()]
      : [...columns.keys()].reverse();
    for (const columnIndex of sweep) {
      columns[columnIndex].sort((a, b) => {
        const scoreA = neighborOrderScore(a.group_id, columnIndex, columnOf, order, adjacency, centroids, degree);
        const scoreB = neighborOrderScore(b.group_id, columnIndex, columnOf, order, adjacency, centroids, degree);
        return scoreA - scoreB || (a.label || "").localeCompare(b.label || "");
      });
      columns[columnIndex].forEach((group, rowIndex) => order.set(group.group_id, rowIndex));
    }
  }
}

function neighborOrderScore(groupId, columnIndex, columnOf, order, adjacency, centroids, degree) {
  const neighborRows = (adjacency.get(groupId) || [])
    .filter((neighborId) => Math.abs((columnOf.get(neighborId) ?? columnIndex) - columnIndex) <= 1)
    .map((neighborId) => order.get(neighborId))
    .filter((row) => Number.isFinite(row));
  const neighborScore = neighborRows.length
    ? neighborRows.reduce((sum, row) => sum + row, 0) / neighborRows.length
    : 0;
  const semanticScore = (centroids.get(groupId)?.y || 0) * 0.002;
  const hubLift = -Math.min(8, degree.get(groupId) || 0) * 0.035;
  return neighborScore * (neighborRows.length ? 1 : 0) + semanticScore + hubLift;
}

function computeDagNodeLayout(groups, links, containerW, containerH) {
  const n = groups.length;
  const edges = layoutDirectedEdges(groups, links);
  const scores = softCausalRanks(groups, edges);
  const centroids = new Map(groups.map((group) => [group.group_id, groupMapCentroid(group)]));
  const degree = degreeByGroup(groups, edges);
  const minColumns = n <= 8 ? 2 : (n > 30 && (containerW || 900) > 720) ? 4 : 3;
  const columnCount = clampNumber(Math.round((containerW || 900) / 210), minColumns, Math.min(7, Math.max(minColumns, n)));
  const columns = assignDagColumns(groups, scores, columnCount);
  rebalanceColumnsForDirectedEdges(columns, edges);
  orderColumnsForFewerCrossings(columns, centroids, edges, degree);

  const maxRows = Math.max(...columns.map((column) => column.length), 1);
  const nodeMaxWidth = columnCount <= 3 ? 170 : 185;
  const fontSize = n > 42 ? 11 : n > 30 ? 12 : 13;
  const rowGap = clampNumber(Math.floor((containerH || 720) / Math.max(maxRows + 1, 2)), 64, 98);
  const columnGap = clampNumber(Math.floor((containerW || 900) / Math.max(columnCount + 0.5, 2)), 188, 270);
  const graphWidth = Math.max((columnCount - 1) * columnGap + nodeMaxWidth + 80, (containerW || 900) * 0.92);
  const graphHeight = Math.max((maxRows + 1) * rowGap, (containerH || 720) * 0.92);
  const positions = new Map();
  const params = {
    fontSize,
    vMargin: n > 34 ? 6 : 8,
    hMargin: n > 34 ? 10 : 13,
    nodeMaxWidth,
    edgeWidth: n > 34 ? 1.1 : 1.25,
    rowGap,
    columnGap,
  };

  const layoutMode = ["hierarchical", "organic"].includes(state.dagLayoutMode)
    ? state.dagLayoutMode
    : "auto";
  const useOrganicLayout = layoutMode === "organic" || (layoutMode === "auto" && n >= 28);
  if (useOrganicLayout) {
    seedOrganicDagPositions(groups, centroids, scores, degree, positions, graphWidth, graphHeight, columnCount);
  } else {
    columns.forEach((column, columnIndex) => {
      const x = (columnIndex - (columnCount - 1) / 2) * columnGap;
      const startY = -((column.length - 1) * rowGap) / 2;
      column.forEach((group, rowIndex) => {
        const score = scores.get(group.group_id) || 0.5;
        const yJitter = ((score * 997) % 1 - 0.5) * Math.min(16, rowGap * 0.18);
        positions.set(group.group_id, {
          x,
          y: startY + rowIndex * rowGap + yJitter,
          column: columnIndex,
          row: rowIndex,
        });
      });
    });
  }
  relaxDagLayoutPositions(groups, links, positions, params, graphWidth, graphHeight);
  resolveDagNodeOverlaps(groups, positions, params, graphWidth, graphHeight);
  const fixedAnchorIds = pinDagAnchorPositions(positions, graphWidth, graphHeight);
  for (let pass = 0; pass < 3; pass += 1) {
    clearDagStudyArrowCorridor(groups, positions, params, graphHeight, fixedAnchorIds);
    resolveDagNodeOverlaps(groups, positions, params, graphWidth, graphHeight, fixedAnchorIds);
  }
  clearDagStudyArrowCorridor(groups, positions, params, graphHeight, fixedAnchorIds);

  return {
    positions,
    params,
    signature: [
      n,
      links.length,
      columnCount,
      maxRows,
      Math.round(containerW || 0),
      Math.round(containerH || 0),
      layoutMode,
      state.project?.iv_group_id || "no-iv",
      state.project?.dv_group_id || "no-dv",
      state.showConfoundersOnly
        ? `confounders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
        : state.showCollidersOnly
          ? `colliders:${state.confounderMaxPathLength}:bottlenecked:${state.excludeBottleneckedConfounders}:path-links:${state.hideIrrelevantConfounderLinks}`
        : state.filterDagByCausalRelevance ? "causal" : "all",
    ].join(":"),
    graphWidth,
    graphHeight,
  };
}

function pinDagAnchorPositions(positions, graphWidth, graphHeight) {
  const ivId = state.project?.iv_group_id;
  const dvId = state.project?.dv_group_id;
  if (!positions.has(ivId) || !positions.has(dvId) || ivId === dvId) return new Set();
  const points = [...positions.values()];
  const minX = Math.min(...points.map((point) => point.x), -graphWidth / 2);
  const maxX = Math.max(...points.map((point) => point.x), graphWidth / 2);
  const minY = Math.min(...points.map((point) => point.y), -graphHeight / 2);
  const maxY = Math.max(...points.map((point) => point.y), graphHeight / 2);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const maxOffset = Math.max(90, graphWidth / 2 - 115);
  const offset = Math.min(maxOffset, Math.max(150, graphWidth * 0.24));
  Object.assign(positions.get(ivId), { x: centerX - offset, y: centerY });
  Object.assign(positions.get(dvId), { x: centerX + offset, y: centerY });
  return new Set([ivId, dvId]);
}

function clearDagStudyArrowCorridor(groups, positions, params, graphHeight, anchorIds) {
  if (anchorIds.size !== 2) return;
  const iv = positions.get(state.project?.iv_group_id);
  const dv = positions.get(state.project?.dv_group_id);
  if (!iv || !dv) return;
  const left = Math.min(iv.x, dv.x);
  const right = Math.max(iv.x, dv.x);
  const centerY = (iv.y + dv.y) / 2;
  const corridorHalfHeight = Math.max(24, (params.fontSize || 12) * 1.8);
  const maxY = graphHeight / 2;
  const boxes = dagNodeBoxes(groups, { positions, params });
  for (const group of groups) {
    if (anchorIds.has(group.group_id)) continue;
    const box = boxes.get(group.group_id);
    const position = positions.get(group.group_id);
    if (!box || !position) continue;
    const overlapsHorizontally = box.x + box.w > left + 12 && box.x < right - 12;
    const overlapsVertically = box.y + box.h > centerY - corridorHalfHeight
      && box.y < centerY + corridorHalfHeight;
    if (!overlapsHorizontally || !overlapsVertically) continue;
    const placeAbove = position.y < centerY
      || (Math.abs(position.y - centerY) < 1 && stableHash(group.group_id) % 2 === 0);
    const clearance = corridorHalfHeight + box.h / 2 + 12;
    const preferredY = centerY + (placeAbove ? -clearance : clearance);
    const alternativeY = centerY + (placeAbove ? clearance : -clearance);
    const preferredFits = Math.abs(preferredY) <= maxY;
    position.y = clampNumber(preferredFits ? preferredY : alternativeY, -maxY, maxY);
  }
}

function seedOrganicDagPositions(groups, centroids, scores, degree, positions, graphWidth, graphHeight, columnCount) {
  const xs = [...centroids.values()].map((point) => point.x);
  const ys = [...centroids.values()].map((point) => point.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const sortedByRank = groups
    .slice()
    .sort((a, b) => (scores.get(a.group_id) || 0) - (scores.get(b.group_id) || 0)
      || (a.label || "").localeCompare(b.label || ""));
  const rowOrder = new Map(sortedByRank.map((group, index) => [group.group_id, index]));
  for (const group of groups) {
    const centroid = centroids.get(group.group_id) || { x: 0, y: 0 };
    const rank = scores.get(group.group_id) || 0.5;
    const semanticX = normalizedValue(centroid.x, minX, maxX);
    const semanticY = normalizedValue(centroid.y, minY, maxY);
    const order = rowOrder.get(group.group_id) || 0;
    const degreeLift = Math.min(0.16, Math.sqrt(degree.get(group.group_id) || 0) * 0.035);
    const x = ((rank - 0.5) * 0.82 + (semanticX - 0.5) * 0.20) * graphWidth;
    const y = ((semanticY - 0.5) * 0.80 + ((order % 5) - 2) * 0.018 - degreeLift * 0.18) * graphHeight;
    positions.set(group.group_id, {
      x: clampNumber(x, -graphWidth / 2, graphWidth / 2),
      y: clampNumber(y, -graphHeight / 2, graphHeight / 2),
      column: clampNumber(Math.floor(rank * columnCount), 0, columnCount - 1),
      row: order,
    });
  }
}

function resolveDagNodeOverlaps(groups, positions, params, graphWidth, graphHeight, fixedIds = new Set()) {
  const ids = groups.map((group) => group.group_id);
  const maxX = graphWidth / 2;
  const maxY = graphHeight / 2;
  for (let iter = 0; iter < 80; iter += 1) {
    const boxes = dagNodeBoxes(groups, { positions, params });
    let moved = false;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const aId = ids[i];
        const bId = ids[j];
        const a = boxes.get(aId);
        const b = boxes.get(bId);
        if (!a || !b) continue;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + 18;
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + 18;
        if (overlapX <= 0 || overlapY <= 0) continue;
        const aPos = positions.get(aId);
        const bPos = positions.get(bId);
        const xFirst = overlapX < overlapY;
        const sx = Math.sign((a.cx - b.cx) || (stableHash(aId) % 2 ? 1 : -1));
        const sy = Math.sign((a.cy - b.cy) || (stableHash(bId) % 2 ? 1 : -1));
        const fullDx = xFirst ? sx * overlapX : sx * Math.min(overlapX, 8) * 0.28;
        const fullDy = xFirst ? sy * Math.min(overlapY, 8) * 0.28 : sy * overlapY;
        const aFixed = fixedIds.has(aId);
        const bFixed = fixedIds.has(bId);
        const aShare = aFixed ? 0 : bFixed ? 1 : 0.55;
        const bShare = bFixed ? 0 : aFixed ? 1 : 0.55;
        aPos.x = clampNumber(aPos.x + fullDx * aShare, -maxX, maxX);
        bPos.x = clampNumber(bPos.x - fullDx * bShare, -maxX, maxX);
        aPos.y = clampNumber(aPos.y + fullDy * aShare, -maxY, maxY);
        bPos.y = clampNumber(bPos.y - fullDy * bShare, -maxY, maxY);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function distanceFromPointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return { distance: Math.hypot(point.x - a.x, point.y - a.y), closest: a, t: 0 };
  const t = clampNumber(((point.x - a.x) * dx + (point.y - a.y) * dy) / len2, 0, 1);
  const closest = { x: a.x + t * dx, y: a.y + t * dy };
  return { distance: Math.hypot(point.x - closest.x, point.y - closest.y), closest, t };
}

function addForce(forces, id, x, y) {
  const force = forces.get(id);
  if (!force) return;
  force.x += x;
  force.y += y;
}

function relaxDagLayoutPositions(groups, links, positions, params, graphWidth, graphHeight) {
  const ids = groups.map((group) => group.group_id);
  const anchors = new Map(ids.map((id) => [id, { ...positions.get(id) }]));
  const directedEdges = layoutDirectedEdges(groups, links).filter((edge) => positions.has(edge.from) && positions.has(edge.to));
  const groupByGroupId = new Map(groups.map((group) => [group.group_id, group]));
  const maxX = graphWidth / 2;
  const maxY = graphHeight / 2;

  for (let iter = 0; iter < 90; iter += 1) {
    const boxes = dagNodeBoxes(groups, { positions, params });
    const forces = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    const cooling = 1 - iter / 110;

    for (const edge of directedEdges) {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      for (const id of ids) {
        if (id === edge.from || id === edge.to) continue;
        const p = positions.get(id);
        const box = boxes.get(id);
        if (!p || !box) continue;
        const { distance, closest, t } = distanceFromPointToSegment(p, a, b);
        if (t <= 0.08 || t >= 0.92) continue;
        const clearance = Math.max(box.w, box.h) * 0.62 + 20;
        if (distance >= clearance) continue;
        let nx = p.x - closest.x;
        let ny = p.y - closest.y;
        const norm = Math.hypot(nx, ny) || 1;
        nx /= norm;
        ny /= norm;
        const strength = ((clearance - distance) / clearance) * (edge.weak ? 2.2 : 3.2) * cooling;
        addForce(forces, id, nx * strength, ny * strength);
      }
    }

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const aId = ids[i];
        const bId = ids[j];
        const a = boxes.get(aId);
        const b = boxes.get(bId);
        if (!a || !b) continue;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + 16;
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + 16;
        if (overlapX <= 0 || overlapY <= 0) continue;
        let dx = a.cx - b.cx;
        let dy = a.cy - b.cy;
        const norm = Math.hypot(dx, dy) || 1;
        dx /= norm;
        dy /= norm;
        const strength = Math.min(8, Math.min(overlapX, overlapY) * 0.14) * cooling;
        addForce(forces, aId, dx * strength, dy * strength);
        addForce(forces, bId, -dx * strength, -dy * strength);
      }
    }

    for (const id of ids) {
      const position = positions.get(id);
      const anchor = anchors.get(id);
      const group = groupByGroupId.get(id);
      const force = forces.get(id);
      if (!position || !anchor || !force) continue;
      const hubDamping = Math.min(0.04, Math.sqrt(group?.variable_ids?.length || 1) * 0.0015);
      const organic = ids.length >= 28;
      force.x += (anchor.x - position.x) * ((organic ? 0.004 : 0.012) + hubDamping);
      force.y += (anchor.y - position.y) * (organic ? 0.0025 : 0.006);
      const maxStep = 10 * cooling + 1.5;
      position.x = clampNumber(position.x + clampNumber(force.x, -maxStep, maxStep), -maxX, maxX);
      position.y = clampNumber(position.y + clampNumber(force.y, -maxStep, maxStep), -maxY, maxY);
    }
  }
}

function wrapDagLabel(label, maxChars = 20) {
  const words = String(label || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars || !current) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3).join("\n");
}

function stableHash(text) {
  let hash = 0;
  for (let index = 0; index < String(text || "").length; index += 1) {
    hash = ((hash << 5) - hash + String(text).charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function dagLabelMetrics(label, layoutParams = {}) {
  const maxChars = (layoutParams.nodeMaxWidth || 185) <= 170 ? 18 : 22;
  const wrapped = wrapDagLabel(label, maxChars);
  const lines = wrapped.split("\n").filter(Boolean);
  const fontSize = layoutParams.fontSize || 12;
  const hMargin = layoutParams.hMargin || 10;
  const vMargin = layoutParams.vMargin || 6;
  const longest = Math.max(...lines.map((line) => line.length), 8);
  return {
    label: wrapped,
    width: clampNumber(longest * fontSize * 0.62 + hMargin * 2 + 18, 92, layoutParams.nodeMaxWidth || 185),
    height: Math.max(32, lines.length * fontSize * 1.24 + vMargin * 2 + 8),
  };
}

function dagNodeBoxes(groups, layout) {
  const boxes = new Map();
  for (const group of groups) {
    const point = layout.positions.get(group.group_id);
    if (!point) continue;
    const metrics = dagLabelMetrics(group.label, layout.params);
    boxes.set(group.group_id, {
      x: point.x - metrics.width / 2,
      y: point.y - metrics.height / 2,
      w: metrics.width,
      h: metrics.height,
      cx: point.x,
      cy: point.y,
    });
  }
  return boxes;
}
  const result = computeDagNodeLayout(groups, links, width, height);
  return { ...result, boxes: dagNodeBoxes(groups, result) };
}

