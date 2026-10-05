function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function layoutDirectedEdges(groups, links) {
  const indexById = new Map();
  for (let i = 0; i < groups.length; i += 1) indexById.set(groups[i].group_id, i);
  const edges = [];
  for (const link of links || []) {
    const a = indexById.get(link.group_a);
    const b = indexById.get(link.group_b);
    if (a === undefined || b === undefined) continue;
    if (link.direction_type === "BIDIRECTIONAL") {
      edges.push({ from: link.group_a, to: link.group_b, fromIndex: a, toIndex: b, link, weak: true });
      edges.push({ from: link.group_b, to: link.group_a, fromIndex: b, toIndex: a, link, weak: true });
    } else if (link.direction_type === "B_TO_A") {
      edges.push({ from: link.group_b, to: link.group_a, fromIndex: b, toIndex: a, link, weak: false });
    } else {
      edges.push({ from: link.group_a, to: link.group_b, fromIndex: a, toIndex: b, link, weak: false });
    }
  }
  return edges;
}

function normalizedValue(value, min, max) {
  if (!Number.isFinite(value) || max <= min) return 0.5;
  return clampNumber((value - min) / (max - min), 0, 1);
}

function softCausalRanks(groups, edges) {
  const n = groups.length;
  const ranks = new Float64Array(n);
  const degreeBias = new Float64Array(n);
  const indexById = new Map();
  for (let i = 0; i < n; i += 1) indexById.set(groups[i].group_id, i);

  const m = edges.length;
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const weight = new Float64Array(m);
  for (let e = 0; e < m; e += 1) {
    const edge = edges[e];
    const a = edge.fromIndex ?? indexById.get(edge.from);
    const b = edge.toIndex ?? indexById.get(edge.to);
    from[e] = a;
    to[e] = b;
    weight[e] = edge.weak ? 0.18 : 1;
    const biasWeight = edge.weak ? 0.25 : 1;
    degreeBias[a] -= 0.08 * biasWeight;
    degreeBias[b] += 0.08 * biasWeight;
  }

  const rankIterations = n <= 8 ? 30 : 120;
  for (let iter = 0; iter < rankIterations; iter += 1) {
    for (let e = 0; e < m; e += 1) {
      const a = from[e];
      const b = to[e];
      const error = (ranks[a] + 1) - ranks[b];
      let step = error * 0.018 * weight[e];
      if (step < -0.035) step = -0.035;
      else if (step > 0.035) step = 0.035;
      ranks[a] -= step;
      ranks[b] += step;
    }
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += ranks[i];
    mean /= Math.max(1, n);
    for (let i = 0; i < n; i += 1) ranks[i] = (ranks[i] - mean) * 0.985 + degreeBias[i];
  }

  let min = 0;
  let max = 1;
  for (let i = 0; i < n; i += 1) {
    if (ranks[i] < min) min = ranks[i];
    if (ranks[i] > max) max = ranks[i];
  }
  const scale = max > min ? 1 / (max - min) : 0;
  const out = new Map();
  for (let i = 0; i < n; i += 1) {
    const value = scale ? (ranks[i] - min) * scale : 0.5;
    out.set(groups[i].group_id, value < 0 ? 0 : value > 1 ? 1 : value);
  }
  return out;
}

function assignDagColumns(groups, scores, columnCount) {
  const ordered = groups.slice().sort((a, b) => (scores.get(a.group_id) || 0) - (scores.get(b.group_id) || 0)
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
    columns.forEach((column, columnIndex) => { column.forEach((group) => columnOf.set(group.group_id, columnIndex)); });
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
  const n = groups.length;
  const values = new Int32Array(n);
  const indexById = new Map();
  for (let i = 0; i < n; i += 1) indexById.set(groups[i].group_id, i);
  for (const edge of edges) {
    const a = edge.fromIndex ?? indexById.get(edge.from);
    const b = edge.toIndex ?? indexById.get(edge.to);
    if (a !== undefined) values[a] += 1;
    if (b !== undefined) values[b] += 1;
  }
  const degree = new Map();
  for (let i = 0; i < n; i += 1) degree.set(groups[i].group_id, values[i]);
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
  const score = new Map();
  const orderingPasses = columns.reduce((sum, column) => sum + column.length, 0) <= 8 ? 2 : 8;
  for (let pass = 0; pass < orderingPasses; pass += 1) {
    const start = pass % 2 === 0 ? 0 : columns.length - 1;
    const end = pass % 2 === 0 ? columns.length : -1;
    const step = pass % 2 === 0 ? 1 : -1;
    for (let columnIndex = start; columnIndex !== end; columnIndex += step) {
      const column = columns[columnIndex];
      score.clear();
      for (const group of column) {
        const groupId = group.group_id;
        const neighbors = adjacency.get(groupId) || [];
        let sum = 0;
        let count = 0;
        for (let i = 0; i < neighbors.length; i += 1) {
          const neighborId = neighbors[i];
          const neighborColumn = columnOf.get(neighborId);
          if (Math.abs((neighborColumn ?? columnIndex) - columnIndex) > 1) continue;
          const row = order.get(neighborId);
          if (!Number.isFinite(row)) continue;
          sum += row;
          count += 1;
        }
        const neighborScore = count ? sum / count : 0;
        score.set(groupId, neighborScore + (centroids.get(groupId)?.y || 0) * 0.002
          - Math.min(8, degree.get(groupId) || 0) * 0.035);
      }
      column.sort((a, b) => score.get(a.group_id) - score.get(b.group_id)
        || (a.label || "").localeCompare(b.label || ""));
      for (let rowIndex = 0; rowIndex < column.length; rowIndex += 1) order.set(column[rowIndex].group_id, rowIndex);
    }
  }
}

function neighborOrderScore(groupId, columnIndex, columnOf, order, adjacency, centroids, degree) {
  const neighborRows = (adjacency.get(groupId) || [])
    .filter((neighborId) => Math.abs((columnOf.get(neighborId) ?? columnIndex) - columnIndex) <= 1)
    .map((neighborId) => order.get(neighborId)).filter((row) => Number.isFinite(row));
  const neighborScore = neighborRows.length ? neighborRows.reduce((sum, row) => sum + row, 0) / neighborRows.length : 0;
  const semanticScore = (centroids.get(groupId)?.y || 0) * 0.002;
  const hubLift = -Math.min(8, degree.get(groupId) || 0) * 0.035;
  return neighborScore * (neighborRows.length ? 1 : 0) + semanticScore + hubLift;
}

function prepareDagNodeGeometry(groups, params) {
  const n = groups.length;
  const width = new Float64Array(n);
  const height = new Float64Array(n);
  const halfW = new Float64Array(n);
  const halfH = new Float64Array(n);
  const hashes = new Int32Array(n);
  const hubDamping = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const group = groups[i];
    const metrics = cachedDagLabelMetrics(group.label, params);
    width[i] = metrics.width;
    height[i] = metrics.height;
    halfW[i] = metrics.width * 0.5;
    halfH[i] = metrics.height * 0.5;
    hashes[i] = stableHash(group.group_id);
    hubDamping[i] = Math.min(0.04, Math.sqrt(group?.variable_ids?.length || 1) * 0.0015);
  }
  return { width, height, halfW, halfH, hashes, hubDamping };
}

function computeDagLayoutUncached({
  groups,
  links,
  centroids = new Map(),
  ivId,
  dvId,
  mode = "auto",
  width: containerW,
  height: containerH,
  viewSignature = "all",
}) {
  const n = groups.length;
  const edges = layoutDirectedEdges(groups, links);
  const scores = softCausalRanks(groups, edges);
  const degree = degreeByGroup(groups, edges);
  const minColumns = n <= 8 ? 2 : (n > 30 && (containerW || 900) > 720) ? 4 : 3;
  const columnCount = clampNumber(
    Math.round((containerW || 900) / 210),
    minColumns,
    Math.min(7, Math.max(minColumns, n)),
  );
  const columns = assignDagColumns(groups, scores, columnCount);
  rebalanceColumnsForDirectedEdges(columns, edges);
  orderColumnsForFewerCrossings(columns, centroids, edges, degree);

  const maxRows = Math.max(...columns.map((column) => column.length), 1);
  const nodeMaxWidth = columnCount <= 3 ? 170 : 185;
  const fontSize = n > 42 ? 11 : n > 30 ? 12 : 13;
  const rowGap = clampNumber(
    Math.floor((containerH || 720) / Math.max(maxRows + 1, 2)),
    64,
    98,
  );
  const columnGap = clampNumber(
    Math.floor((containerW || 900) / Math.max(columnCount + 0.5, 2)),
    188,
    270,
  );
  const graphWidth = Math.max(
    (columnCount - 1) * columnGap + nodeMaxWidth + 80,
    (containerW || 900) * 0.92,
  );
  const graphHeight = Math.max(
    (maxRows + 1) * rowGap,
    (containerH || 720) * 0.92,
  );
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
  const nodeGeometry = prepareDagNodeGeometry(groups, params);

  const layoutMode = ["hierarchical", "organic"].includes(mode) ? mode : "auto";
  const useOrganicLayout = layoutMode === "organic" || (layoutMode === "auto" && n >= 28);
  if (useOrganicLayout) {
    seedOrganicDagPositions(
      groups,
      centroids,
      scores,
      degree,
      positions,
      graphWidth,
      graphHeight,
      columnCount,
    );
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

  relaxDagLayoutPositions(
    groups,
    edges,
    positions,
    params,
    graphWidth,
    graphHeight,
    nodeGeometry,
  );
  resolveDagNodeOverlaps(
    groups,
    positions,
    params,
    graphWidth,
    graphHeight,
    new Set(),
    nodeGeometry,
  );

  const fixedAnchorIds = pinDagAnchorPositions(
    positions,
    graphWidth,
    graphHeight,
    ivId,
    dvId,
  );

  for (let pass = 0; pass < 3; pass += 1) {
    clearDagStudyArrowCorridor(
      groups,
      positions,
      params,
      graphHeight,
      fixedAnchorIds,
      ivId,
      dvId,
    );
    resolveDagNodeOverlaps(
      groups,
      positions,
      params,
      graphWidth,
      graphHeight,
      fixedAnchorIds,
      nodeGeometry,
    );
  }

  clearDagStudyArrowCorridor(
    groups,
    positions,
    params,
    graphHeight,
    fixedAnchorIds,
    ivId,
    dvId,
  );

  return {
    positions,
    boxes: dagNodeBoxes(groups, { positions, params }),
    params,
    signature: [
      n,
      links.length,
      columnCount,
      maxRows,
      Math.round(containerW || 0),
      Math.round(containerH || 0),
      layoutMode,
      ivId || "no-iv",
      dvId || "no-dv",
      viewSignature,
    ].join(":"),
    graphWidth,
    graphHeight,
  };
}

function pinDagAnchorPositions(positions, graphWidth, graphHeight, ivId, dvId) {
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

function clearDagStudyArrowCorridor(
  groups,
  positions,
  params,
  graphHeight,
  anchorIds,
  ivId,
  dvId,
) {
  if (anchorIds.size !== 2) return;
  const iv = positions.get(ivId);
  const dv = positions.get(dvId);
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

    const overlapsHorizontally =
      box.x + box.w > left + 12 &&
      box.x < right - 12;

    const overlapsVertically =
      box.y + box.h > centerY - corridorHalfHeight &&
      box.y < centerY + corridorHalfHeight;

    if (!overlapsHorizontally || !overlapsVertically) continue;

    const placeAbove =
      position.y < centerY ||
      (
        Math.abs(position.y - centerY) < 1 &&
        stableHash(group.group_id) % 2 === 0
      );

    const clearance = corridorHalfHeight + box.h / 2 + 12;
    const preferredY = centerY + (placeAbove ? -clearance : clearance);
    const alternativeY = centerY + (placeAbove ? clearance : -clearance);
    const preferredFits = Math.abs(preferredY) <= maxY;

    position.y = clampNumber(
      preferredFits ? preferredY : alternativeY,
      -maxY,
      maxY,
    );
  }
}

function seedOrganicDagPositions(
  groups,
  centroids,
  scores,
  degree,
  positions,
  graphWidth,
  graphHeight,
  columnCount,
) {
  const xs = [...centroids.values()].map((point) => point.x);
  const ys = [...centroids.values()].map((point) => point.y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);

  const sortedByRank = groups
    .slice()
    .sort(
      (a, b) =>
        (scores.get(a.group_id) || 0) -
          (scores.get(b.group_id) || 0) ||
        (a.label || "").localeCompare(b.label || ""),
    );

  const rowOrder = new Map(
    sortedByRank.map((group, index) => [group.group_id, index]),
  );

  for (const group of groups) {
    const centroid = centroids.get(group.group_id) || { x: 0, y: 0 };
    const rank = scores.get(group.group_id) || 0.5;
    const semanticX = normalizedValue(centroid.x, minX, maxX);
    const semanticY = normalizedValue(centroid.y, minY, maxY);
    const order = rowOrder.get(group.group_id) || 0;
    const degreeLift = Math.min(
      0.16,
      Math.sqrt(degree.get(group.group_id) || 0) * 0.035,
    );

    const x =
      (
        (rank - 0.5) * 0.82 +
        (semanticX - 0.5) * 0.20
      ) * graphWidth;

    const y =
      (
        (semanticY - 0.5) * 0.80 +
        ((order % 5) - 2) * 0.018 -
        degreeLift * 0.18
      ) * graphHeight;

    positions.set(group.group_id, {
      x: clampNumber(x, -graphWidth / 2, graphWidth / 2),
      y: clampNumber(y, -graphHeight / 2, graphHeight / 2),
      column: clampNumber(
        Math.floor(rank * columnCount),
        0,
        columnCount - 1,
      ),
      row: order,
    });
  }
}

function resolveDagNodeOverlaps(
  groups,
  positions,
  params,
  graphWidth,
  graphHeight,
  fixedIds = new Set(),
  nodeGeometry = null,
) {
  const n = groups.length;
  if (n < 2) return;

  const maxX = graphWidth * 0.5;
  const maxY = graphHeight * 0.5;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const halfW = nodeGeometry?.halfW || new Float64Array(n);
  const halfH = nodeGeometry?.halfH || new Float64Array(n);
  const fixed = new Uint8Array(n);
  const hashes = nodeGeometry?.hashes || new Int32Array(n);
  const refs = new Array(n);

  for (let i = 0; i < n; i += 1) {
    const group = groups[i];
    const point = positions.get(group.group_id);
    refs[i] = point;
    x[i] = point?.x || 0;
    y[i] = point?.y || 0;

    if (!nodeGeometry) {
      const metrics = cachedDagLabelMetrics(group.label, params);
      halfW[i] = metrics.width * 0.5;
      halfH[i] = metrics.height * 0.5;
      hashes[i] = stableHash(group.group_id);
    }

    fixed[i] = fixedIds.has(group.group_id) ? 1 : 0;
  }

  for (let iter = 0; iter < 80; iter += 1) {
    let moved = false;

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const overlapX =
          halfW[i] +
          halfW[j] +
          18 -
          Math.abs(x[i] - x[j]);

        if (overlapX <= 0) continue;

        const overlapY =
          halfH[i] +
          halfH[j] +
          18 -
          Math.abs(y[i] - y[j]);

        if (overlapY <= 0) continue;

        const xFirst = overlapX < overlapY;
        const sx = Math.sign(
          (x[i] - x[j]) ||
          (hashes[i] % 2 ? 1 : -1),
        );
        const sy = Math.sign(
          (y[i] - y[j]) ||
          (hashes[j] % 2 ? 1 : -1),
        );

        const fullDx = xFirst
          ? sx * overlapX
          : sx * Math.min(overlapX, 8) * 0.28;

        const fullDy = xFirst
          ? sy * Math.min(overlapY, 8) * 0.28
          : sy * overlapY;

        const aFixed = fixed[i];
        const bFixed = fixed[j];

        const aShare = aFixed ? 0 : bFixed ? 1 : 0.55;
        const bShare = bFixed ? 0 : aFixed ? 1 : 0.55;

        let ax = x[i] + fullDx * aShare;
        let bx = x[j] - fullDx * bShare;
        let ay = y[i] + fullDy * aShare;
        let by = y[j] - fullDy * bShare;

        x[i] = ax < -maxX ? -maxX : ax > maxX ? maxX : ax;
        x[j] = bx < -maxX ? -maxX : bx > maxX ? maxX : bx;
        y[i] = ay < -maxY ? -maxY : ay > maxY ? maxY : ay;
        y[j] = by < -maxY ? -maxY : by > maxY ? maxY : by;

        moved = true;
      }
    }

    if (!moved) break;
  }

  for (let i = 0; i < n; i += 1) {
    if (!refs[i]) continue;
    refs[i].x = x[i];
    refs[i].y = y[i];
  }
}

function distanceFromPointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;

  if (len2 <= 1e-9) {
    return {
      distance: Math.hypot(point.x - a.x, point.y - a.y),
      closest: a,
      t: 0,
    };
  }

  const t = clampNumber(
    (
      (point.x - a.x) * dx +
      (point.y - a.y) * dy
    ) / len2,
    0,
    1,
  );

  const closest = {
    x: a.x + t * dx,
    y: a.y + t * dy,
  };

  return {
    distance: Math.hypot(
      point.x - closest.x,
      point.y - closest.y,
    ),
    closest,
    t,
  };
}

function addForce(forces, id, x, y) {
  const force = forces.get(id);
  if (!force) return;
  force.x += x;
  force.y += y;
}

function insertionSortByCoord(order, coords) {
  for (let i = 1; i < order.length; i += 1) {
    const value = order[i];
    const coord = coords[value];
    let j = i - 1;

    while (j >= 0 && coords[order[j]] > coord) {
      order[j + 1] = order[j];
      j -= 1;
    }

    order[j + 1] = value;
  }
}

function lowerBoundByCoord(order, coords, value) {
  let lo = 0;
  let hi = order.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (coords[order[mid]] < value) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function upperBoundByCoord(order, coords, value) {
  let lo = 0;
  let hi = order.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (coords[order[mid]] <= value) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function relaxDagLayoutPositions(
  groups,
  directedEdges,
  positions,
  params,
  graphWidth,
  graphHeight,
  nodeGeometry = null,
) {
  const n = groups.length;
  if (n === 0) return;

  const indexById = new Map();
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const anchorX = new Float64Array(n);
  const anchorY = new Float64Array(n);
  const forceX = new Float64Array(n);
  const forceY = new Float64Array(n);
  const edgeForceX = new Float64Array(n);
  const edgeForceY = new Float64Array(n);
  const clearance = new Float64Array(n);
  const halfW = nodeGeometry?.halfW || new Float64Array(n);
  const halfH = nodeGeometry?.halfH || new Float64Array(n);
  const hubDamping =
    nodeGeometry?.hubDamping ||
    new Float64Array(n);

  const pointRefs = new Array(n);
  const orderX = new Array(n);
  const orderY = new Array(n);

  let maxClearance = 0;
  let maxHalfW = 0;

  for (let i = 0; i < n; i += 1) {
    const group = groups[i];
    const id = group.group_id;
    indexById.set(id, i);

    const point = positions.get(id);
    pointRefs[i] = point;

    x[i] = anchorX[i] = point?.x || 0;
    y[i] = anchorY[i] = point?.y || 0;

    let width;
    let height;

    if (nodeGeometry) {
      width = nodeGeometry.width[i];
      height = nodeGeometry.height[i];
    } else {
      const metrics = cachedDagLabelMetrics(
        group.label,
        params,
      );
      width = metrics.width;
      height = metrics.height;
      halfW[i] = width * 0.5;
      halfH[i] = height * 0.5;
      hubDamping[i] = Math.min(
        0.04,
        Math.sqrt(group?.variable_ids?.length || 1) *
          0.0015,
      );
    }

    clearance[i] =
      Math.max(width, height) * 0.62 + 20;

    if (clearance[i] > maxClearance) {
      maxClearance = clearance[i];
    }

    if (halfW[i] > maxHalfW) {
      maxHalfW = halfW[i];
    }

    orderX[i] = i;
    orderY[i] = i;
  }

  const m = directedEdges.length;
  const edgeFrom = new Int32Array(m);
  const edgeTo = new Int32Array(m);
  const edgeStrength = new Float64Array(m);
  let edgeCount = 0;

  for (let e = 0; e < m; e += 1) {
    const edge = directedEdges[e];
    const a =
      edge.fromIndex ??
      indexById.get(edge.from);

    const b =
      edge.toIndex ??
      indexById.get(edge.to);

    if (a === undefined || b === undefined) continue;

    edgeFrom[edgeCount] = a;
    edgeTo[edgeCount] = b;
    edgeStrength[edgeCount] = edge.weak ? 2.2 : 3.2;
    edgeCount += 1;
  }

  const maxX = graphWidth * 0.5;
  const maxY = graphHeight * 0.5;
  const organic = n >= 28;

  const anchorXBase = organic ? 0.004 : 0.012;
  const anchorYBase = organic ? 0.0025 : 0.006;

  const relaxIterations = n <= 8 ? 4 : 36;

  for (
    let iter = 0;
    iter < relaxIterations;
    iter += 1
  ) {
    const cooling = 1 - iter / 110;

    const recomputeEdgeForces =
      n < 48 ||
      iter % 6 === 0;

    if (recomputeEdgeForces) {
      edgeForceX.fill(0);
      edgeForceY.fill(0);

      // Exact broad-phase pruning. Sorting ~100 nodes is much
      // cheaper than testing every node against every edge.
      // Query both axes and iterate whichever candidate interval
      // is smaller, then apply the original bbox test.
      insertionSortByCoord(orderX, x);
      insertionSortByCoord(orderY, y);

      for (
        let e = 0;
        e < edgeCount;
        e += 1
      ) {
        const a = edgeFrom[e];
        const b = edgeTo[e];

        const ax = x[a];
        const ay = y[a];
        const bx = x[b];
        const by = y[b];

        const vx = bx - ax;
        const vy = by - ay;
        const len2 = vx * vx + vy * vy;

        if (len2 <= 1e-9) continue;

        const minX =
          ax < bx ? ax : bx;

        const maxEdgeX =
          ax > bx ? ax : bx;

        const minY =
          ay < by ? ay : by;

        const maxEdgeY =
          ay > by ? ay : by;

        const invLen2 = 1 / len2;

        const xLo = lowerBoundByCoord(
          orderX,
          x,
          minX - maxClearance,
        );

        const xHi = upperBoundByCoord(
          orderX,
          x,
          maxEdgeX + maxClearance,
        );

        const yLo = lowerBoundByCoord(
          orderY,
          y,
          minY - maxClearance,
        );

        const yHi = upperBoundByCoord(
          orderY,
          y,
          maxEdgeY + maxClearance,
        );

        const useX =
          (xHi - xLo) <=
          (yHi - yLo);

        const order = useX
          ? orderX
          : orderY;

        const lo = useX
          ? xLo
          : yLo;

        const hi = useX
          ? xHi
          : yHi;

        for (
          let k = lo;
          k < hi;
          k += 1
        ) {
          const i = order[k];

          if (i === a || i === b) {
            continue;
          }

          const c = clearance[i];
          const px = x[i];
          const py = y[i];

          if (
            px < minX - c ||
            px > maxEdgeX + c ||
            py < minY - c ||
            py > maxEdgeY + c
          ) {
            continue;
          }

          const rawT =
            (
              (px - ax) * vx +
              (py - ay) * vy
            ) * invLen2;

          if (
            rawT <= 0.08 ||
            rawT >= 0.92
          ) {
            continue;
          }

          const cx =
            ax + rawT * vx;

          const cy =
            ay + rawT * vy;

          const dx =
            px - cx;

          const dy =
            py - cy;

          const dist2 =
            dx * dx +
            dy * dy;

          if (dist2 >= c * c) {
            continue;
          }

          const dist =
            Math.sqrt(dist2);

          const invDist =
            dist > 1e-9
              ? 1 / dist
              : 1;

          const strength =
            (
              (c - dist) / c
            ) *
            edgeStrength[e] *
            cooling;

          edgeForceX[i] +=
            dx *
            invDist *
            strength;

          edgeForceY[i] +=
            dy *
            invDist *
            strength;
        }
      }
    }

    forceX.set(edgeForceX);
    forceY.set(edgeForceY);

    // Re-sort x every step: edge forces may be reused, but
    // node-overlap broad-phase ordering must reflect current
    // positions exactly.
    if (!recomputeEdgeForces) {
      insertionSortByCoord(orderX, x);
    }

    for (
      let ai = 0;
      ai < n;
      ai += 1
    ) {
      const i = orderX[ai];
      const xi = x[i];
      const yi = y[i];

      const maxDx =
        halfW[i] +
        maxHalfW +
        16;

      for (
        let bj = ai + 1;
        bj < n;
        bj += 1
      ) {
        const j = orderX[bj];

        const dxAbs =
          x[j] - xi;

        if (dxAbs > maxDx) {
          break;
        }

        const overlapX =
          halfW[i] +
          halfW[j] +
          16 -
          dxAbs;

        if (overlapX <= 0) {
          continue;
        }

        const dyAbs =
          Math.abs(
            yi - y[j],
          );

        const overlapY =
          halfH[i] +
          halfH[j] +
          16 -
          dyAbs;

        if (overlapY <= 0) {
          continue;
        }

        let dx =
          xi - x[j];

        let dy =
          yi - y[j];

        let norm =
          Math.sqrt(
            dx * dx +
            dy * dy,
          );

        if (norm < 1e-9) {
          dx =
            (i & 1)
              ? 1
              : -1;

          dy =
            (j & 1)
              ? 1
              : -1;

          norm = Math.SQRT2;
        }

        const strength =
          Math.min(
            8,
            Math.min(
              overlapX,
              overlapY,
            ) * 0.14,
          ) *
          cooling /
          norm;

        const fx =
          dx * strength;

        const fy =
          dy * strength;

        forceX[i] += fx;
        forceY[i] += fy;
        forceX[j] -= fx;
        forceY[j] -= fy;
      }
    }

    const maxStep =
      10 * cooling +
      1.5;

    for (
      let i = 0;
      i < n;
      i += 1
    ) {
      let fx =
        forceX[i] +
        (
          anchorX[i] -
          x[i]
        ) *
        (
          anchorXBase +
          hubDamping[i]
        );

      let fy =
        forceY[i] +
        (
          anchorY[i] -
          y[i]
        ) *
        anchorYBase;

      if (fx < -maxStep) {
        fx = -maxStep;
      } else if (fx > maxStep) {
        fx = maxStep;
      }

      if (fy < -maxStep) {
        fy = -maxStep;
      } else if (fy > maxStep) {
        fy = maxStep;
      }

      let nx =
        x[i] + fx;

      let ny =
        y[i] + fy;

      if (nx < -maxX) {
        nx = -maxX;
      } else if (nx > maxX) {
        nx = maxX;
      }

      if (ny < -maxY) {
        ny = -maxY;
      } else if (ny > maxY) {
        ny = maxY;
      }

      x[i] = nx;
      y[i] = ny;
    }
  }

  for (
    let i = 0;
    i < n;
    i += 1
  ) {
    const point =
      pointRefs[i];

    if (!point) {
      continue;
    }

    point.x = x[i];
    point.y = y[i];
  }
}

export function wrapDagLabel(label, maxChars = 20) {
  const words = String(label || "")
    .split(/\s+/)
    .filter(Boolean);

  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current
      ? `${current} ${word}`
      : word;

    if (
      next.length <= maxChars ||
      !current
    ) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines
    .slice(0, 3)
    .join("\n");
}

function stableHash(text) {
  let hash = 0;
  const s = String(text || "");

  for (
    let index = 0;
    index < s.length;
    index += 1
  ) {
    hash =
      (
        (hash << 5) -
        hash +
        s.charCodeAt(index)
      ) | 0;
  }

  return Math.abs(hash);
}

function dagLabelMetrics(label, layoutParams = {}) {
  const maxChars =
    (layoutParams.nodeMaxWidth || 185) <= 170
      ? 18
      : 22;

  const wrapped =
    wrapDagLabel(
      label,
      maxChars,
    );

  const lines = wrapped
    .split("\n")
    .filter(Boolean);

  const fontSize =
    layoutParams.fontSize ||
    12;

  const hMargin =
    layoutParams.hMargin ||
    10;

  const vMargin =
    layoutParams.vMargin ||
    6;

  const longest =
    Math.max(
      ...lines.map(
        (line) => line.length,
      ),
      8,
    );

  return {
    label: wrapped,
    width: clampNumber(
      longest *
        fontSize *
        0.62 +
        hMargin * 2 +
        18,
      92,
      layoutParams.nodeMaxWidth ||
        185,
    ),
    height: Math.max(
      32,
      lines.length *
        fontSize *
        1.24 +
        vMargin * 2 +
        8,
    ),
  };
}

const labelMetricsByParams =
  new WeakMap();

function cachedDagLabelMetrics(label, params) {
  let cached =
    labelMetricsByParams.get(params);

  if (!cached) {
    cached = new Map();
    labelMetricsByParams.set(
      params,
      cached,
    );
  }

  const key =
    `${params.nodeMaxWidth}|` +
    `${params.fontSize}|` +
    `${params.hMargin}|` +
    `${params.vMargin}|` +
    `${String(label || "")}`;

  let metrics =
    cached.get(key);

  if (!metrics) {
    metrics =
      dagLabelMetrics(
        label,
        params,
      );

    cached.set(
      key,
      metrics,
    );
  }

  return metrics;
}

export function dagNodeBoxes(groups, layout) {
  const boxes = new Map();
  const params =
    layout.params || {};

  for (const group of groups) {
    const point =
      layout.positions.get(
        group.group_id,
      );

    if (!point) continue;

    const metrics =
      cachedDagLabelMetrics(
        group.label,
        params,
      );

    boxes.set(
      group.group_id,
      {
        x:
          point.x -
          metrics.width / 2,
        y:
          point.y -
          metrics.height / 2,
        w:
          metrics.width,
        h:
          metrics.height,
        cx:
          point.x,
        cy:
          point.y,
      },
    );
  }

  return boxes;
}

let lastDagLayoutCache = null;

function snapshotDagLayoutResult(result) {
  const positionEntries =
    new Array(
      result.positions.size,
    );

  let i = 0;

  for (
    const [id, p]
    of result.positions
  ) {
    positionEntries[i++] = [
      id,
      p.x,
      p.y,
      p.column,
      p.row,
    ];
  }

  const boxEntries =
    new Array(
      result.boxes.size,
    );

  i = 0;

  for (
    const [id, b]
    of result.boxes
  ) {
    boxEntries[i++] = [
      id,
      b.x,
      b.y,
      b.w,
      b.h,
      b.cx,
      b.cy,
    ];
  }

  return {
    positionEntries,
    boxEntries,
    params: {
      ...result.params,
    },
    signature:
      result.signature,
    graphWidth:
      result.graphWidth,
    graphHeight:
      result.graphHeight,
  };
}

function restoreDagLayoutSnapshot(snapshot) {
  const positions =
    new Map();

  for (
    let i = 0;
    i < snapshot.positionEntries.length;
    i += 1
  ) {
    const e =
      snapshot.positionEntries[i];

    positions.set(
      e[0],
      {
        x: e[1],
        y: e[2],
        column: e[3],
        row: e[4],
      },
    );
  }

  const boxes =
    new Map();

  for (
    let i = 0;
    i < snapshot.boxEntries.length;
    i += 1
  ) {
    const e =
      snapshot.boxEntries[i];

    boxes.set(
      e[0],
      {
        x: e[1],
        y: e[2],
        w: e[3],
        h: e[4],
        cx: e[5],
        cy: e[6],
      },
    );
  }

  return {
    positions,
    boxes,
    params: {
      ...snapshot.params,
    },
    signature:
      snapshot.signature,
    graphWidth:
      snapshot.graphWidth,
    graphHeight:
      snapshot.graphHeight,
  };
}

export function computeDagLayout(args) {
  const groups =
    args.groups;

  const links =
    args.links;

  const centroids =
    args.centroids;

  const mode =
    args.mode ?? "auto";

  const width =
    args.width;

  const height =
    args.height;

  const viewSignature =
    args.viewSignature ??
    "all";

  const cache =
    lastDagLayoutCache;

  if (
    cache &&
    cache.groups === groups &&
    cache.links === links &&
    cache.centroids === centroids &&
    cache.ivId === args.ivId &&
    cache.dvId === args.dvId &&
    cache.mode === mode &&
    cache.width === width &&
    cache.height === height &&
    cache.viewSignature === viewSignature
  ) {
    return restoreDagLayoutSnapshot(
      cache.snapshot,
    );
  }

  const result =
    computeDagLayoutUncached(args);

  lastDagLayoutCache = {
    groups,
    links,
    centroids,
    ivId: args.ivId,
    dvId: args.dvId,
    mode,
    width,
    height,
    viewSignature,
    snapshot:
      snapshotDagLayoutResult(
        result,
      ),
  };

  return result;
}