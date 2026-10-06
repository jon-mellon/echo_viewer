"use strict";

import {
  appendOverlapSegments,
  expandBox,
  pointInsideBox,
  routePointForNode,
  routeOverlapPenalty,
  segmentIntersectsExpandedBox,
  simplifyRoute,
} from "./dag_routing_geometry.mjs";

const DEFAULT_CONFIG = {
  hardObstaclePadding: 10,
  softObstaclePadding: 24,
  corridorSamples: 24,
  corridorPenalty: 420,
  hardObstaclePenalty: 100000,
  softObstaclePenalty: 120,
  bendPenalty: 18,
  laneStep: 22,
  maxLanes: 8,
};

const OVERLAP_GRID_CELL = 38;
const SCORE_EPS = 1e-9;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function studyArrowCorridor({ ivId, dvId, positions, boxes, fontSize = 12 }) {
  const ivBox = boxes.get(ivId);
  const dvBox = boxes.get(dvId);
  const iv = positions.get(ivId);
  const dv = positions.get(dvId);
  if (!ivBox || !dvBox || !iv || !dv) return null;
  const leftBox = iv.x <= dv.x ? ivBox : dvBox;
  const rightBox = iv.x <= dv.x ? dvBox : ivBox;
  const left = leftBox.x + leftBox.w + 10;
  const right = rightBox.x - 10;
  if (right <= left) return null;
  const centerY = (iv.y + dv.y) / 2;
  const halfHeight = Math.max(22, fontSize * 1.7);
  return { x: left, y: centerY - halfHeight, w: right - left, h: halfHeight * 2 };
}

function routeObstacles(boxes, sourceId, targetId, options) {
  return [...boxes]
    .filter(([groupId]) => groupId !== sourceId && groupId !== targetId)
    .map(([, box]) => ({
      hard: expandBox(box, options.hardObstaclePadding),
      soft: expandBox(box, options.softObstaclePadding),
    }));
}

export function scoreRoute(points, { boxes, sourceId, targetId, corridor = null, config = {}, obstacles = null }) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const preparedObstacles = obstacles || routeObstacles(boxes, sourceId, targetId, options);
  let score = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    score += Math.hypot(b.x - a.x, b.y - a.y) * 0.025;
    if (corridor) {
      for (let sample = 1; sample < options.corridorSamples; sample += 1) {
        const t = sample / options.corridorSamples;
        if (pointInsideBox({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, corridor)) {
          score += options.corridorPenalty;
        }
      }
    }
    for (const obstacle of preparedObstacles) {
      if (segmentIntersectsExpandedBox(a, b, obstacle.hard)) score += options.hardObstaclePenalty;
      else if (segmentIntersectsExpandedBox(a, b, obstacle.soft)) score += options.softObstaclePenalty;
    }
  }
  return score + Math.max(0, points.length - 2) * options.bendPenalty;
}

// Keep the public single-edge routine behavior unchanged. The bulk routeEdges path
// below uses a graph-level prepared context and spatial index.
export function routeEdge(link, { positions, boxes, occupiedRoutes = [], occupiedSegments = null, corridor = null, config = {} }) {
  const isReversed = link.direction_type === "B_TO_A";
  const sourceId = isReversed ? link.group_b : link.group_a;
  const targetId = isReversed ? link.group_a : link.group_b;
  const sourceBox = boxes.get(sourceId);
  const targetBox = boxes.get(targetId);
  const sourcePoint = positions.get(sourceId);
  const targetPoint = positions.get(targetId);
  if (!sourceBox || !targetBox || !sourcePoint || !targetPoint) return null;
  const options = { ...DEFAULT_CONFIG, ...config };
  const obstacles = routeObstacles(boxes, sourceId, targetId, options);

  const directStart = routePointForNode(sourceBox, targetPoint);
  const directEnd = routePointForNode(targetBox, sourcePoint);
  const xs = [...boxes.values()].flatMap((box) => [box.x, box.x + box.w]);
  const ys = [...boxes.values()].flatMap((box) => [box.y, box.y + box.h]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const midX = (directStart.x + directEnd.x) / 2;
  const midY = (directStart.y + directEnd.y) / 2;
  const dx = directEnd.x - directStart.x;
  const dy = directEnd.y - directStart.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const bendBase = Math.max(46, Math.min(110, len * 0.22));
  const candidates = [[directStart, directEnd]];
  for (const offset of [bendBase, -bendBase, bendBase * 1.7, -bendBase * 1.7]) {
    candidates.push([directStart, {
      x: clamp(midX + px * offset, minX - 28, maxX + 28),
      y: clamp(midY + py * offset, minY - 28, maxY + 28),
    }, directEnd]);
  }
  if (corridor) {
    for (const bypassY of [corridor.y - 30, corridor.y + corridor.h + 30]) {
      candidates.push([directStart, { x: directStart.x, y: bypassY },
        { x: directEnd.x, y: bypassY }, directEnd]);
    }
  }

  let best = null;
  let bestScore = Infinity;
  let bestOverlap = Infinity;
  const consider = (candidate) => {
    const simplified = simplifyRoute(candidate);
    const actualPoints = [sourcePoint, ...simplified.slice(1, -1), targetPoint];
    const geometryScore = scoreRoute(actualPoints, { boxes, sourceId, targetId, corridor, config, obstacles });
    if (geometryScore >= bestScore) return;
    const overlap = routeOverlapPenalty(actualPoints, occupiedRoutes, occupiedSegments);
    const score = geometryScore + overlap;
    if (score < bestScore) {
      best = simplified;
      bestScore = score;
      bestOverlap = overlap;
    }
  };
  candidates.forEach(consider);

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const laneCenters = horizontal ? [midY, minY - 30, maxY + 30] : [midX, minX - 30, maxX + 30];
  for (let lane = 1; (bestOverlap > 0 || bestScore >= options.hardObstaclePenalty)
    && lane <= Math.min(options.maxLanes, occupiedRoutes.length + 1); lane += 1) {
    for (const center of laneCenters) {
      for (const sign of [-1, 1]) {
        const coordinate = center + sign * lane * options.laneStep;
        consider(horizontal
          ? [directStart, { x: directStart.x, y: coordinate }, { x: directEnd.x, y: coordinate }, directEnd]
          : [directStart, { x: coordinate, y: directStart.y }, { x: coordinate, y: directEnd.y }, directEnd]);
      }
    }
  }
  return { sourceId, targetId, points: best || [directStart, directEnd], score: bestScore, overlapPenalty: bestOverlap };
}

function countCorridorSamples(a, b, corridor, n) {
  let lo = 1;
  let hi = n - 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const constrain = (v0, delta, min, max) => {
    if (delta === 0) {
      if (v0 < min || v0 > max) {
        lo = 1;
        hi = 0;
      }
      return;
    }
    let t0 = (min - v0) / delta;
    let t1 = (max - v0) / delta;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, Math.ceil(t0 * n - 1e-12));
    hi = Math.min(hi, Math.floor(t1 * n + 1e-12));
  };

  constrain(a.x, dx, corridor.x, corridor.x + corridor.w);
  constrain(a.y, dy, corridor.y, corridor.y + corridor.h);
  return hi >= lo ? hi - lo + 1 : 0;
}

function makeFastContext(boxes, config) {
  const options = { ...DEFAULT_CONFIG, ...config };
  const n = boxes.size;
  const indexById = new Map();
  const hx0 = new Float64Array(n);
  const hx1 = new Float64Array(n);
  const hy0 = new Float64Array(n);
  const hy1 = new Float64Array(n);
  const sx0 = new Float64Array(n);
  const sx1 = new Float64Array(n);
  const sy0 = new Float64Array(n);
  const sy1 = new Float64Array(n);
  const bcx = new Float64Array(n);
  const bcy = new Float64Array(n);
  const hhx = new Float64Array(n);
  const hhy = new Float64Array(n);
  const shx = new Float64Array(n);
  const shy = new Float64Array(n);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let i = 0;

  for (const [id, box] of boxes) {
    indexById.set(id, i);
    const x1 = box.x + box.w;
    const y1 = box.y + box.h;
    minX = Math.min(minX, box.x);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, box.y);
    maxY = Math.max(maxY, y1);
    hx0[i] = box.x - options.hardObstaclePadding;
    hx1[i] = x1 + options.hardObstaclePadding;
    hy0[i] = box.y - options.hardObstaclePadding;
    hy1[i] = y1 + options.hardObstaclePadding;
    sx0[i] = box.x - options.softObstaclePadding;
    sx1[i] = x1 + options.softObstaclePadding;
    sy0[i] = box.y - options.softObstaclePadding;
    sy1[i] = y1 + options.softObstaclePadding;
    bcx[i] = box.x + box.w * 0.5;
    bcy[i] = box.y + box.h * 0.5;
    hhx[i] = box.w * 0.5 + options.hardObstaclePadding;
    hhy[i] = box.h * 0.5 + options.hardObstaclePadding;
    shx[i] = box.w * 0.5 + options.softObstaclePadding;
    shy[i] = box.h * 0.5 + options.softObstaclePadding;
    i += 1;
  }

  const obstacleCellSize = 160;
  const obstacleOriginX = minX - options.softObstaclePadding - 1;
  const obstacleOriginY = minY - options.softObstaclePadding - 1;
  const obstacleNx = Math.max(1, Math.ceil((maxX - minX + options.softObstaclePadding * 2 + 2) / obstacleCellSize) + 1);
  const obstacleNy = Math.max(1, Math.ceil((maxY - minY + options.softObstaclePadding * 2 + 2) / obstacleCellSize) + 1);
  const obstacleCells = new Array(obstacleNx * obstacleNy);
  for (let j = 0; j < n; j += 1) {
    let ix0 = Math.floor((sx0[j] - obstacleOriginX - 1e-9) / obstacleCellSize);
    let ix1 = Math.floor((sx1[j] - obstacleOriginX + 1e-9) / obstacleCellSize);
    let iy0 = Math.floor((sy0[j] - obstacleOriginY - 1e-9) / obstacleCellSize);
    let iy1 = Math.floor((sy1[j] - obstacleOriginY + 1e-9) / obstacleCellSize);
    if (ix0 < 0) ix0 = 0; if (iy0 < 0) iy0 = 0;
    if (ix1 >= obstacleNx) ix1 = obstacleNx - 1; if (iy1 >= obstacleNy) iy1 = obstacleNy - 1;
    for (let ix = ix0; ix <= ix1; ix += 1) {
      let cell = ix * obstacleNy + iy0;
      for (let iy = iy0; iy <= iy1; iy += 1, cell += 1) {
        let list = obstacleCells[cell];
        if (list === undefined) obstacleCells[cell] = list = [];
        list.push(j);
      }
    }
  }
  return {
    options, indexById, n,
    hx0, hx1, hy0, hy1,
    sx0, sx1, sy0, sy1, bcx, bcy, hhx, hhy, shx, shy,
    minX, maxX, minY, maxY,
    obstacleCellSize, obstacleOriginX, obstacleOriginY, obstacleNx, obstacleNy, obstacleCells,
    obstacleMarks: new Int32Array(n), obstacleStamp: 1,
  };
}

function segmentIntersectsRect(ax, ay, bx, by, x0, x1, y0, y1) {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;

  if (dx === 0) {
    if (ax < x0 || ax > x1) return false;
  } else {
    const inv = 1 / dx;
    let u0 = (x0 - ax) * inv;
    let u1 = (x1 - ax) * inv;
    if (u0 > u1) [u0, u1] = [u1, u0];
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    if (t0 > t1) return false;
  }

  if (dy === 0) {
    if (ay < y0 || ay > y1) return false;
  } else {
    const inv = 1 / dy;
    let u0 = (y0 - ay) * inv;
    let u1 = (y1 - ay) * inv;
    if (u0 > u1) [u0, u1] = [u1, u0];
    if (u0 > t0) t0 = u0;
    if (u1 < t1) t1 = u1;
    if (t0 > t1) return false;
  }
  return true;
}

function segmentIntersectsBoxSat(ax, ay, bx, by, cx, cy, hx, hy) {
  const dx = bx - ax;
  const dy = by - ay;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const mx2 = ax + bx - cx * 2;
  const my2 = ay + by - cy * 2;
  if (Math.abs(mx2) > hx * 2 + adx || Math.abs(my2) > hy * 2 + ady) return false;
  return Math.abs(dx * my2 - dy * mx2) <= 2 * (hx * ady + hy * adx) + 1e-9;
}

function scoreRouteFast(points, sourceIndex, targetIndex, corridor, ctx, cutoff) {
  const options = ctx.options;
  let score = Math.max(0, points.length - 2) * options.bendPenalty;
  if (score >= cutoff) return score;

  for (let s = 0; s < points.length - 1; s += 1) {
    const a = points[s];
    const b = points[s + 1];
    const ax = a.x;
    const ay = a.y;
    const bx = b.x;
    const by = b.y;
    const dx = bx - ax;
    const dy = by - ay;
    score += Math.hypot(dx, dy) * 0.025;
    if (score >= cutoff) return score;

    if (corridor) {
      const hits = countCorridorSamples(a, b, corridor, options.corridorSamples);
      if (hits) {
        score += hits * options.corridorPenalty;
        if (score >= cutoff) return score;
      }
    }

    const x0 = ax < bx ? ax : bx;
    const x1 = ax > bx ? ax : bx;
    const y0 = ay < by ? ay : by;
    const y1 = ay > by ? ay : by;

    for (let i = 0; i < ctx.n; i += 1) {
      if (i === sourceIndex || i === targetIndex) continue;
      if (x1 < ctx.sx0[i] || x0 > ctx.sx1[i] || y1 < ctx.sy0[i] || y0 > ctx.sy1[i]) continue;

      if (!(x1 < ctx.hx0[i] || x0 > ctx.hx1[i] || y1 < ctx.hy0[i] || y0 > ctx.hy1[i])
        && segmentIntersectsRect(ax, ay, bx, by, ctx.hx0[i], ctx.hx1[i], ctx.hy0[i], ctx.hy1[i])) {
        score += options.hardObstaclePenalty;
      } else if (segmentIntersectsRect(ax, ay, bx, by, ctx.sx0[i], ctx.sx1[i], ctx.sy0[i], ctx.sy1[i])) {
        score += options.softObstaclePenalty;
      }
      if (score >= cutoff) return score;
    }
  }
  return score;
}

function lowerBoundNumber(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function upperBoundNumber(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function insertSortedNumber(a, x) {
  a.splice(upperBoundNumber(a, x), 0, x);
}

class AxisAggregateIndex {
  constructor() {
    this.vKeys = [];
    this.hKeys = [];
    this.vGroups = [];
    this.hGroups = [];
  }

  _group(keys, groups, key) {
    const pos = lowerBoundNumber(keys, key);
    if (pos < keys.length && keys[pos] === key) return groups[pos];
    const g = { lo: [], hi: [], clo: [], chi: [] };
    keys.splice(pos, 0, key);
    groups.splice(pos, 0, g);
    return g;
  }

  addXY(ax, ay, bx, by) {
    const eps = 1e-9;
    if (ax === bx) {
      const g = this._group(this.vKeys, this.vGroups, ax);
      const lo = ay < by ? ay : by;
      const hi = ay > by ? ay : by;
      const d = hi - lo;
      insertSortedNumber(g.lo, lo + eps * d);
      insertSortedNumber(g.hi, hi - eps * d);
      insertSortedNumber(g.clo, lo);
      insertSortedNumber(g.chi, hi);
      return true;
    }

    if (ay === by) {
      const g = this._group(this.hKeys, this.hGroups, ay);
      const lo = ax < bx ? ax : bx;
      const hi = ax > bx ? ax : bx;
      const d = hi - lo;
      insertSortedNumber(g.lo, lo + eps * d);
      insertSortedNumber(g.hi, hi - eps * d);
      insertSortedNumber(g.clo, lo);
      insertSortedNumber(g.chi, hi);
      return true;
    }

    return false;
  }

  countXY(ax, ay, bx, by) {
    const eps = 1e-9;
    const qdx = bx - ax;
    const qdy = by - ay;
    let hits = 0;

    if (qdx !== 0) {
      const adx = Math.abs(qdx);
      const minx = (ax < bx ? ax : bx) + eps * adx;
      const maxx = (ax > bx ? ax : bx) - eps * adx;
      const keys = this.vKeys;
      const groups = this.vGroups;

      for (
        let j = upperBoundNumber(keys, minx), je = lowerBoundNumber(keys, maxx);
        j < je;
        j += 1
      ) {
        const x = keys[j];
        const y = ay + ((x - ax) / qdx) * qdy;
        const g = groups[j];
        hits += lowerBoundNumber(g.lo, y) - upperBoundNumber(g.hi, y);
      }
    } else if (qdy !== 0) {
      const tol = eps / Math.abs(qdy);
      const keys = this.vKeys;
      const groups = this.vGroups;
      const qlo = ay < by ? ay : by;
      const qhi = ay > by ? ay : by;

      for (
        let j = lowerBoundNumber(keys, ax - tol), je = upperBoundNumber(keys, ax + tol);
        j < je;
        j += 1
      ) {
        const x = keys[j];
        if (Math.abs((x - ax) * qdy) >= eps) continue;
        const g = groups[j];
        hits += upperBoundNumber(g.clo, qhi) - lowerBoundNumber(g.chi, qlo);
      }
    }

    if (qdy !== 0) {
      const ady = Math.abs(qdy);
      const miny = (ay < by ? ay : by) + eps * ady;
      const maxy = (ay > by ? ay : by) - eps * ady;
      const keys = this.hKeys;
      const groups = this.hGroups;

      for (
        let j = upperBoundNumber(keys, miny), je = lowerBoundNumber(keys, maxy);
        j < je;
        j += 1
      ) {
        const y = keys[j];
        const x = ax + ((y - ay) / qdy) * qdx;
        const g = groups[j];
        hits += lowerBoundNumber(g.lo, x) - upperBoundNumber(g.hi, x);
      }
    } else if (qdx !== 0) {
      const tol = eps / Math.abs(qdx);
      const keys = this.hKeys;
      const groups = this.hGroups;
      const qlo = ax < bx ? ax : bx;
      const qhi = ax > bx ? ax : bx;

      for (
        let j = lowerBoundNumber(keys, ay - tol), je = upperBoundNumber(keys, ay + tol);
        j < je;
        j += 1
      ) {
        const y = keys[j];
        if (Math.abs((y - ay) * qdx) >= eps) continue;
        const g = groups[j];
        hits += upperBoundNumber(g.clo, qhi) - lowerBoundNumber(g.chi, qlo);
      }
    }

    return hits;
  }
}

class DenseSegmentIndex {
  constructor(ctx, maxSegments, cellSize = OVERLAP_GRID_CELL, axisAggregate = false) {
    this.cellSize = cellSize;
    this.axis = axisAggregate ? new AxisAggregateIndex() : null;

    const margin = ctx.options.maxLanes * ctx.options.laneStep + 80;
    this.originX = ctx.minX - margin;
    this.originY = ctx.minY - margin;
    this.nx = Math.max(1, Math.ceil((ctx.maxX - ctx.minX + margin * 2) / cellSize) + 1);
    this.ny = Math.max(1, Math.ceil((ctx.maxY - ctx.minY + margin * 2) / cellSize) + 1);

    this.cells = new Array(this.nx * this.ny);
    this.count = 0;
    this.marks = new Int32Array(maxSegments);
    this.stamp = 1;

    this.ax = new Float64Array(maxSegments);
    this.ay = new Float64Array(maxSegments);
    this.bx = new Float64Array(maxSegments);
    this.by = new Float64Array(maxSegments);
    this.dx = new Float64Array(maxSegments);
    this.dy = new Float64Array(maxSegments);
    this.x0 = new Float64Array(maxSegments);
    this.x1 = new Float64Array(maxSegments);
    this.y0 = new Float64Array(maxSegments);
    this.y1 = new Float64Array(maxSegments);
  }

  addXY(ax, ay, bx, by) {
    if (this.axis && this.axis.addXY(ax, ay, bx, by)) return;

    const i = this.count++;
    this.ax[i] = ax;
    this.ay[i] = ay;
    this.bx[i] = bx;
    this.by[i] = by;
    this.dx[i] = bx - ax;
    this.dy[i] = by - ay;

    const x0 = ax < bx ? ax : bx;
    const x1 = ax > bx ? ax : bx;
    const y0 = ay < by ? ay : by;
    const y1 = ay > by ? ay : by;
    this.x0[i] = x0;
    this.x1[i] = x1;
    this.y0[i] = y0;
    this.y1[i] = y1;

    const cs = this.cellSize;
    const ox = this.originX;
    const oy = this.originY;
    const nx = this.nx;
    const ny = this.ny;
    const cells = this.cells;

    let ix = Math.floor((ax - ox) / cs);
    let iy = Math.floor((ay - oy) / cs);
    let ex = Math.floor((bx - ox) / cs);
    let ey = Math.floor((by - oy) / cs);

    if (ix < 0) ix = 0;
    else if (ix >= nx) ix = nx - 1;

    if (iy < 0) iy = 0;
    else if (iy >= ny) iy = ny - 1;

    if (ex < 0) ex = 0;
    else if (ex >= nx) ex = nx - 1;

    if (ey < 0) ey = 0;
    else if (ey >= ny) ey = ny - 1;

    const dx = bx - ax;
    const dy = by - ay;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    let tMaxX = stepX === 0
      ? Infinity
      : (((stepX > 0 ? (ix + 1) * cs + ox : ix * cs + ox) - ax) / dx);

    let tMaxY = stepY === 0
      ? Infinity
      : (((stepY > 0 ? (iy + 1) * cs + oy : iy * cs + oy) - ay) / dy);

    const tDeltaX = stepX === 0 ? Infinity : cs / adx;
    const tDeltaY = stepY === 0 ? Infinity : cs / ady;

    for (;;) {
      const cell = ix * ny + iy;
      let list = cells[cell];
      if (list === undefined) cells[cell] = list = [];
      list.push(i);

      if (ix === ex && iy === ey) break;

      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }

      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) break;
    }
  }
}

function pairPenalty(a, b, c, d) {
  return calibrationPenalty([a, b], [], [[c, d]]);
}

function calibrationPenalty(points, routes, rawSegments) {
  const prepared = [];
  for (const segment of rawSegments) appendOverlapSegments(prepared, segment);
  return routeOverlapPenalty(points, routes, prepared);
}

function sameNumber(a, b) {
  return Math.abs(a - b) <= SCORE_EPS;
}

function calibrateOverlapModel() {
  const p = (x, y) => ({ x, y });

  const properCases = [
    [p(0, 0), p(10, 10), p(0, 10), p(10, 0)],
    [p(0, 5), p(20, 5), p(7, 0), p(7, 12)],
    [p(-5, -2), p(9, 11), p(-3, 9), p(8, -4)],
  ];
  const properValues = properCases.map(([a, b, c, d]) => pairPenalty(a, b, c, d));
  const properPenalty = properValues.every((v) => sameNumber(v, properValues[0]))
    ? properValues[0]
    : null;

  const collinearCases = [
    [p(0, 0), p(20, 0), p(5, 0), p(15, 0)],
    [p(0, 0), p(20, 0), p(0, 0), p(20, 0)],
    [p(0, 0), p(20, 0), p(20, 0), p(30, 0)],
    [p(20, 0), p(0, 0), p(4, 0), p(12, 0)],
  ];
  const collinearValues = collinearCases.map(([a, b, c, d]) => pairPenalty(a, b, c, d));
  const collinearPenalty = collinearValues.every((v) => sameNumber(v, collinearValues[0]))
    ? collinearValues[0]
    : null;

  const endpointCases = [
    [p(0, 0), p(10, 0), p(10, 0), p(10, 10)],
    [p(0, 0), p(10, 10), p(10, 10), p(20, 0)],
  ];
  const endpointValues = endpointCases.map(([a, b, c, d]) => pairPenalty(a, b, c, d));
  const endpointPenalty = endpointValues.every((v) => sameNumber(v, endpointValues[0]))
    ? endpointValues[0]
    : null;

  let sawNearPenalty = false;
  let farNearPenalty = false;

  for (const distance of [0.5, 1, 2, 4, 8, 16, 32, 64]) {
    const values = [
      pairPenalty(p(0, 0), p(20, 0), p(2, distance), p(18, distance)),
      pairPenalty(p(0, 0), p(20, 0), p(10, distance), p(20, 10 + distance)),
    ];

    if (values.some((value) => Math.abs(value) > SCORE_EPS)) {
      sawNearPenalty = true;
      if (distance === 64) farNearPenalty = true;
    }
  }

  const padding = sawNearPenalty ? 64 : 0;
  const zeroMisses = !sawNearPenalty;

  const routeA = p(0, 0);
  const routeB = p(20, 0);
  const s1 = [p(5, -5), p(5, 5)];
  const s2 = [p(15, -5), p(15, 5)];

  const singles =
    pairPenalty(routeA, routeB, ...s1)
    + pairPenalty(routeA, routeB, ...s2);

  const combined = calibrationPenalty(
    [routeA, routeB],
    [],
    [s1, s2],
  );

  const occupiedAdditive = sameNumber(singles, combined);

  const r0 = p(0, 0);
  const r1 = p(10, 0);
  const r2 = p(20, 0);

  const routeWhole = calibrationPenalty(
    [r0, r1, r2],
    [],
    [s1, s2],
  );

  const routeSplit =
    calibrationPenalty([r0, r1], [], [s1, s2])
    + calibrationPenalty([r1, r2], [], [s1, s2]);

  const routeAdditive = sameNumber(routeWhole, routeSplit);

  const withRoutes = calibrationPenalty(
    [routeA, routeB],
    [[s1[0], s1[1]]],
    [s1],
  );

  const segmentsOnly = calibrationPenalty(
    [routeA, routeB],
    [],
    [s1],
  );

  const segmentsDominate = sameNumber(withRoutes, segmentsOnly);

  return {
    properPenalty,
    collinearPenalty,
    endpointPenalty,
    zeroMisses,
    padding,
    additive: occupiedAdditive && routeAdditive,
    local: !farNearPenalty,
    segmentsDominate,
  };
}

const OVERLAP_MODEL = calibrateOverlapModel();

const FAST_OVERLAP =
  OVERLAP_MODEL.additive
  && OVERLAP_MODEL.local
  && OVERLAP_MODEL.segmentsDominate
  && OVERLAP_MODEL.padding === 0
  && OVERLAP_MODEL.zeroMisses
  && OVERLAP_MODEL.properPenalty !== null
  && OVERLAP_MODEL.collinearPenalty !== null
  && OVERLAP_MODEL.endpointPenalty !== null;

const AXIS_OVERLAP_AGGREGATE =
  FAST_OVERLAP
  && sameNumber(
    OVERLAP_MODEL.properPenalty,
    OVERLAP_MODEL.collinearPenalty,
  )
  && Math.abs(OVERLAP_MODEL.endpointPenalty) <= SCORE_EPS;

function countCorridorSamplesXY(ax, ay, bx, by, corridor, n) {
  let lo = 1;
  let hi = n - 1;
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0) {
    if (ax < corridor.x || ax > corridor.x + corridor.w) return 0;
  } else {
    let t0 = (corridor.x - ax) / dx;
    let t1 = (corridor.x + corridor.w - ax) / dx;

    if (t0 > t1) {
      const q = t0;
      t0 = t1;
      t1 = q;
    }

    lo = Math.max(lo, Math.ceil(t0 * n - 1e-12));
    hi = Math.min(hi, Math.floor(t1 * n + 1e-12));
    if (hi < lo) return 0;
  }

  if (dy === 0) {
    if (ay < corridor.y || ay > corridor.y + corridor.h) return 0;
  } else {
    let t0 = (corridor.y - ay) / dy;
    let t1 = (corridor.y + corridor.h - ay) / dy;

    if (t0 > t1) {
      const q = t0;
      t0 = t1;
      t1 = q;
    }

    lo = Math.max(lo, Math.ceil(t0 * n - 1e-12));
    hi = Math.min(hi, Math.floor(t1 * n + 1e-12));
  }

  return hi >= lo ? hi - lo + 1 : 0;
}

function scoreCoords(c, n, sourceIndex, targetIndex, corridor, ctx, cutoff) {
  const options = ctx.options;
  let score = Math.max(0, n - 2) * options.bendPenalty;

  if (score >= cutoff) return score;

  const cs = ctx.obstacleCellSize;
  const ox = ctx.obstacleOriginX;
  const oy = ctx.obstacleOriginY;
  const nx = ctx.obstacleNx;
  const ny = ctx.obstacleNy;
  const cells = ctx.obstacleCells;
  const marks = ctx.obstacleMarks;

  for (let s = 0; s < n - 1; s += 1) {
    const o = s * 2;
    const ax = c[o];
    const ay = c[o + 1];
    const bx = c[o + 2];
    const by = c[o + 3];
    const dx = bx - ax;
    const dy = by - ay;

    score += Math.sqrt(dx * dx + dy * dy) * 0.025;
    if (score >= cutoff) return score;

    if (corridor) {
      const hits = countCorridorSamplesXY(
        ax,
        ay,
        bx,
        by,
        corridor,
        options.corridorSamples,
      );

      if (hits) {
        score += hits * options.corridorPenalty;
        if (score >= cutoff) return score;
      }
    }

    const x0 = ax < bx ? ax : bx;
    const x1 = ax > bx ? ax : bx;
    const y0 = ay < by ? ay : by;
    const y1 = ay > by ? ay : by;

    let stamp = ++ctx.obstacleStamp;

    if (stamp >= 0x7fffffff) {
      marks.fill(0);
      ctx.obstacleStamp = stamp = 1;
    }

    let ix = Math.floor((ax - ox) / cs);
    let iy = Math.floor((ay - oy) / cs);
    let ex = Math.floor((bx - ox) / cs);
    let ey = Math.floor((by - oy) / cs);

    if (ix < 0) ix = 0;
    else if (ix >= nx) ix = nx - 1;

    if (iy < 0) iy = 0;
    else if (iy >= ny) iy = ny - 1;

    if (ex < 0) ex = 0;
    else if (ex >= nx) ex = nx - 1;

    if (ey < 0) ey = 0;
    else if (ey >= ny) ey = ny - 1;

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    let tMaxX = stepX === 0
      ? Infinity
      : (((stepX > 0 ? (ix + 1) * cs + ox : ix * cs + ox) - ax) / dx);

    let tMaxY = stepY === 0
      ? Infinity
      : (((stepY > 0 ? (iy + 1) * cs + oy : iy * cs + oy) - ay) / dy);

    const tDeltaX = stepX === 0 ? Infinity : cs / adx;
    const tDeltaY = stepY === 0 ? Infinity : cs / ady;

    for (;;) {
      const list = cells[ix * ny + iy];

      if (list !== undefined) {
        for (let k = 0; k < list.length; k += 1) {
          const i = list[k];

          if (marks[i] === stamp) continue;
          marks[i] = stamp;

          if (i === sourceIndex || i === targetIndex) continue;

          if (
            x1 < ctx.sx0[i]
            || x0 > ctx.sx1[i]
            || y1 < ctx.sy0[i]
            || y0 > ctx.sy1[i]
          ) {
            continue;
          }

          if (
            !(
              x1 < ctx.hx0[i]
              || x0 > ctx.hx1[i]
              || y1 < ctx.hy0[i]
              || y0 > ctx.hy1[i]
            )
            && segmentIntersectsBoxSat(
              ax,
              ay,
              bx,
              by,
              ctx.bcx[i],
              ctx.bcy[i],
              ctx.hhx[i],
              ctx.hhy[i],
            )
          ) {
            score += options.hardObstaclePenalty;
          } else if (
            segmentIntersectsBoxSat(
              ax,
              ay,
              bx,
              by,
              ctx.bcx[i],
              ctx.bcy[i],
              ctx.shx[i],
              ctx.shy[i],
            )
          ) {
            score += options.softObstaclePenalty;
          }

          if (score >= cutoff) return score;
        }
      }

      if (ix === ex && iy === ey) break;

      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }

      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) break;
    }
  }

  return score;
}

function properIntersectionXY(ax, ay, bx, by, cx, cy, dx, dy) {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const den = abx * cdy - aby * cdx;

  if (Math.abs(den) < 1e-9) return false;

  const nt = (cx - ax) * cdy - (cy - ay) * cdx;
  const nu = (cx - ax) * aby - (cy - ay) * abx;
  const e = 1e-9;

  if (den > 0) {
    return (
      nt > e * den
      && nt < (1 - e) * den
      && nu > e * den
      && nu < (1 - e) * den
    );
  }

  return (
    nt < e * den
    && nt > (1 - e) * den
    && nu < e * den
    && nu > (1 - e) * den
  );
}

function collinearOverlapXY(ax, ay, bx, by, cx, cy, dx, dy) {
  const abx = bx - ax;
  const aby = by - ay;
  const cdx = dx - cx;
  const cdy = dy - cy;
  const den = abx * cdy - aby * cdx;

  if (Math.abs(den) >= 1e-9) return false;

  const cross = (cx - ax) * aby - (cy - ay) * abx;
  if (Math.abs(cross) >= 1e-9) return false;

  return (
    Math.max(Math.min(ax, bx), Math.min(cx, dx))
      <= Math.min(Math.max(ax, bx), Math.max(cx, dx))
    && Math.max(Math.min(ay, by), Math.min(cy, dy))
      <= Math.min(Math.max(ay, by), Math.max(cy, dy))
  );
}

function endpointTouchXY(ax, ay, bx, by, cx, cy, dx, dy) {
  return (
    (Math.abs(ax - cx) <= 1e-9 && Math.abs(ay - cy) <= 1e-9)
    || (Math.abs(ax - dx) <= 1e-9 && Math.abs(ay - dy) <= 1e-9)
    || (Math.abs(bx - cx) <= 1e-9 && Math.abs(by - cy) <= 1e-9)
    || (Math.abs(bx - dx) <= 1e-9 && Math.abs(by - dy) <= 1e-9)
  );
}

function overlapCoords(c, n, index, cutoff) {
  let hits = 0;
  const penalty = OVERLAP_MODEL.properPenalty;

  const uniform =
    penalty === OVERLAP_MODEL.collinearPenalty
    && Math.abs(OVERLAP_MODEL.endpointPenalty) <= SCORE_EPS;

  if (!uniform) {
    return overlapCoordsGeneric(c, n, index, cutoff);
  }

  const hitLimit = Number.isFinite(cutoff)
    ? Math.floor((cutoff + SCORE_EPS) / penalty)
    : Infinity;

  const cs = index.cellSize;
  const ox = index.originX;
  const oy = index.originY;
  const nx = index.nx;
  const ny = index.ny;
  const cells = index.cells;
  const marks = index.marks;
  const iax = index.ax;
  const iay = index.ay;
  const idx = index.dx;
  const idy = index.dy;
  const ix0a = index.x0;
  const ix1a = index.x1;
  const iy0a = index.y0;
  const iy1a = index.y1;
  const eps = 1e-9;

  for (let s = 0; s < n - 1; s += 1) {
    const o = s * 2;
    const ax = c[o];
    const ay = c[o + 1];
    const bx = c[o + 2];
    const by = c[o + 3];

    const x0 = ax < bx ? ax : bx;
    const x1 = ax > bx ? ax : bx;
    const y0 = ay < by ? ay : by;
    const y1 = ay > by ? ay : by;

    if (index.axis) {
      hits += index.axis.countXY(ax, ay, bx, by);
    }

    if (hits > hitLimit) return hits * penalty;

    let stamp = ++index.stamp;

    if (stamp >= 0x7fffffff) {
      marks.fill(0);
      index.stamp = stamp = 1;
    }

    let ix = Math.floor((ax - ox) / cs);
    let iy = Math.floor((ay - oy) / cs);
    let ex = Math.floor((bx - ox) / cs);
    let ey = Math.floor((by - oy) / cs);

    if (ix < 0) ix = 0;
    else if (ix >= nx) ix = nx - 1;

    if (iy < 0) iy = 0;
    else if (iy >= ny) iy = ny - 1;

    if (ex < 0) ex = 0;
    else if (ex >= nx) ex = nx - 1;

    if (ey < 0) ey = 0;
    else if (ey >= ny) ey = ny - 1;

    const qdx = bx - ax;
    const qdy = by - ay;
    const stepX = qdx > 0 ? 1 : qdx < 0 ? -1 : 0;
    const stepY = qdy > 0 ? 1 : qdy < 0 ? -1 : 0;
    const aqdx = Math.abs(qdx);
    const aqdy = Math.abs(qdy);

    let tMaxX = stepX === 0
      ? Infinity
      : (((stepX > 0 ? (ix + 1) * cs + ox : ix * cs + ox) - ax) / qdx);

    let tMaxY = stepY === 0
      ? Infinity
      : (((stepY > 0 ? (iy + 1) * cs + oy : iy * cs + oy) - ay) / qdy);

    const tDeltaX = stepX === 0 ? Infinity : cs / aqdx;
    const tDeltaY = stepY === 0 ? Infinity : cs / aqdy;

    for (;;) {
      const list = cells[ix * ny + iy];

      if (list !== undefined) {
        for (let k = 0; k < list.length; k += 1) {
          const i = list[k];

          if (marks[i] === stamp) continue;
          marks[i] = stamp;

          if (
            x1 < ix0a[i]
            || x0 > ix1a[i]
            || y1 < iy0a[i]
            || y0 > iy1a[i]
          ) {
            continue;
          }

          const rx = iax[i] - ax;
          const ry = iay[i] - ay;
          const sdx = idx[i];
          const sdy = idy[i];
          const den = qdx * sdy - qdy * sdx;
          const nu = rx * qdy - ry * qdx;

          let hit;

          if (Math.abs(den) < eps) {
            hit = Math.abs(nu) < eps;
          } else {
            const nt = rx * sdy - ry * sdx;

            if (den > 0) {
              hit =
                nt > eps * den
                && nt < (1 - eps) * den
                && nu > eps * den
                && nu < (1 - eps) * den;
            } else {
              hit =
                nt < eps * den
                && nt > (1 - eps) * den
                && nu < eps * den
                && nu > (1 - eps) * den;
            }
          }

          if (hit && ++hits > hitLimit) {
            return hits * penalty;
          }
        }
      }

      if (ix === ex && iy === ey) break;

      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }

      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) break;
    }
  }

  return hits * penalty;
}

function overlapCoordsGeneric(c, n, index, cutoff) {
  let total = 0;

  const cs = index.cellSize;
  const ox = index.originX;
  const oy = index.originY;
  const nx = index.nx;
  const ny = index.ny;
  const cells = index.cells;
  const marks = index.marks;

  const properPenalty = OVERLAP_MODEL.properPenalty;
  const collinearPenalty = OVERLAP_MODEL.collinearPenalty;
  const endpointPenalty = OVERLAP_MODEL.endpointPenalty;
  const useEndpoint = Math.abs(endpointPenalty) > SCORE_EPS;

  const iax = index.ax;
  const iay = index.ay;
  const idx = index.dx;
  const idy = index.dy;
  const ix0a = index.x0;
  const ix1a = index.x1;
  const iy0a = index.y0;
  const iy1a = index.y1;

  const eps = 1e-9;

  for (let s = 0; s < n - 1; s += 1) {
    const o = s * 2;
    const ax = c[o];
    const ay = c[o + 1];
    const bx = c[o + 2];
    const by = c[o + 3];

    const x0 = ax < bx ? ax : bx;
    const x1 = ax > bx ? ax : bx;
    const y0 = ay < by ? ay : by;
    const y1 = ay > by ? ay : by;

    let stamp = ++index.stamp;

    if (stamp >= 0x7fffffff) {
      marks.fill(0);
      index.stamp = stamp = 1;
    }

    let ix = Math.floor((ax - ox) / cs);
    let iy = Math.floor((ay - oy) / cs);
    let ex = Math.floor((bx - ox) / cs);
    let ey = Math.floor((by - oy) / cs);

    if (ix < 0) ix = 0;
    else if (ix >= nx) ix = nx - 1;

    if (iy < 0) iy = 0;
    else if (iy >= ny) iy = ny - 1;

    if (ex < 0) ex = 0;
    else if (ex >= nx) ex = nx - 1;

    if (ey < 0) ey = 0;
    else if (ey >= ny) ey = ny - 1;

    const qdx = bx - ax;
    const qdy = by - ay;
    const stepX = qdx > 0 ? 1 : qdx < 0 ? -1 : 0;
    const stepY = qdy > 0 ? 1 : qdy < 0 ? -1 : 0;
    const aqdx = Math.abs(qdx);
    const aqdy = Math.abs(qdy);

    let tMaxX = stepX === 0
      ? Infinity
      : (((stepX > 0 ? (ix + 1) * cs + ox : ix * cs + ox) - ax) / qdx);

    let tMaxY = stepY === 0
      ? Infinity
      : (((stepY > 0 ? (iy + 1) * cs + oy : iy * cs + oy) - ay) / qdy);

    const tDeltaX = stepX === 0 ? Infinity : cs / aqdx;
    const tDeltaY = stepY === 0 ? Infinity : cs / aqdy;

    for (;;) {
      const list = cells[ix * ny + iy];

      if (list !== undefined) {
        for (let k = 0; k < list.length; k += 1) {
          const i = list[k];

          if (marks[i] === stamp) continue;
          marks[i] = stamp;

          if (
            x1 < ix0a[i]
            || x0 > ix1a[i]
            || y1 < iy0a[i]
            || y0 > iy1a[i]
          ) {
            continue;
          }

          const rx = iax[i] - ax;
          const ry = iay[i] - ay;
          const sdx = idx[i];
          const sdy = idy[i];
          const den = qdx * sdy - qdy * sdx;
          const nu = rx * qdy - ry * qdx;

          let hit = false;
          let pairPenalty = 0;

          if (Math.abs(den) < 1e-9) {
            if (Math.abs(nu) < 1e-9) {
              hit = true;
              pairPenalty = collinearPenalty;
            }
          } else {
            const nt = rx * sdy - ry * sdx;

            if (den > 0) {
              hit =
                nt > 1e-9 * den
                && nt < (1 - 1e-9) * den
                && nu > 1e-9 * den
                && nu < (1 - 1e-9) * den;
            } else {
              hit =
                nt < 1e-9 * den
                && nt > (1 - 1e-9) * den
                && nu < 1e-9 * den
                && nu > (1 - 1e-9) * den;
            }

            if (hit) pairPenalty = properPenalty;
          }

          if (!hit && useEndpoint) {
            const cx = iax[i];
            const cy = iay[i];
            const dx = cx + sdx;
            const dy = cy + sdy;

            hit = endpointTouchXY(
              ax,
              ay,
              bx,
              by,
              cx,
              cy,
              dx,
              dy,
            );

            if (hit) pairPenalty = endpointPenalty;
          }

          if (hit) {
            total += pairPenalty;
            if (total > cutoff + SCORE_EPS) return total;
          }
        }
      }

      if (ix === ex && iy === ey) break;

      if (tMaxX < tMaxY) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        iy += stepY;
        tMaxY += tDeltaY;
      } else {
        ix += stepX;
        iy += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }

      if (ix < 0 || ix >= nx || iy < 0 || iy >= ny) break;
    }
  }

  return total;
}

function cross3(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
}

function fastRouteEdge(link, state) {
  const {
    positions,
    boxes,
    corridor,
    ctx,
    index,
    routeCount,
    occupiedRoutes,
    occupiedSegments,
  } = state;

  const isReversed = link.direction_type === "B_TO_A";
  const sourceId = isReversed ? link.group_b : link.group_a;
  const targetId = isReversed ? link.group_a : link.group_b;

  const sourceBox = boxes.get(sourceId);
  const targetBox = boxes.get(targetId);
  const sourcePoint = positions.get(sourceId);
  const targetPoint = positions.get(targetId);

  if (!sourceBox || !targetBox || !sourcePoint || !targetPoint) {
    return null;
  }

  const sourceIndex = ctx.indexById.get(sourceId);
  const targetIndex = ctx.indexById.get(targetId);
  const options = ctx.options;

  const directStart = routePointForNode(sourceBox, targetPoint);
  const directEnd = routePointForNode(targetBox, sourcePoint);

  const dsx = directStart.x;
  const dsy = directStart.y;
  const dex = directEnd.x;
  const dey = directEnd.y;

  const sx = sourcePoint.x;
  const sy = sourcePoint.y;
  const tx = targetPoint.x;
  const ty = targetPoint.y;

  const midX = (dsx + dex) * 0.5;
  const midY = (dsy + dey) * 0.5;
  const ddx = dex - dsx;
  const ddy = dey - dsy;

  const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
  const px = -ddy / len;
  const py = ddx / len;

  const bendBase = Math.max(
    46,
    Math.min(110, len * 0.22),
  );

  const c = new Float64Array(8);
  c[0] = sx;
  c[1] = sy;

  let best = null;
  let bestScore = Infinity;
  let bestOverlap = Infinity;

  const evaluate = (
    b1x,
    b1y,
    has1,
    b2x,
    b2y,
    has2,
  ) => {
    let n = 1;

    if (has1) {
      c[n * 2] = b1x;
      c[n * 2 + 1] = b1y;
      n += 1;
    }

    if (has2) {
      c[n * 2] = b2x;
      c[n * 2 + 1] = b2y;
      n += 1;
    }

    c[n * 2] = tx;
    c[n * 2 + 1] = ty;
    n += 1;

    let geometryScore = scoreCoords(
      c,
      n,
      sourceIndex,
      targetIndex,
      corridor,
      ctx,
      bestScore,
    );

    // Exterior lanes keep dense routes apart, but distant lanes enlarge the
    // fitted graph and make edges appear detached from their nodes. Prefer
    // nearby lanes unless they would cross a node or heavily overlap a route.
    if (options.compactOuterLanes) {
      let outside = 0;
      for (let bend = 1; bend < n - 1; bend += 1) {
        const x = c[bend * 2], y = c[bend * 2 + 1];
        outside = Math.max(outside, ctx.minX - x, x - ctx.maxX, ctx.minY - y, y - ctx.maxY);
      }
      geometryScore += 1.5 * Math.max(0, outside - 45) ** 2;
    }

    if (geometryScore >= bestScore) return;

    let overlap;

    if (FAST_OVERLAP) {
      overlap = overlapCoords(
        c,
        n,
        index,
        bestScore - geometryScore,
      );
    } else {
      const actual = new Array(n);

      for (let i = 0; i < n; i += 1) {
        actual[i] = {
          x: c[i * 2],
          y: c[i * 2 + 1],
        };
      }

      overlap = routeOverlapPenalty(
        actual,
        occupiedRoutes,
        occupiedSegments,
      );
    }

    const score = geometryScore + overlap;

    if (score < bestScore) {
      bestScore = score;
      bestOverlap = overlap;

      best = [directStart];

      if (has1) {
        best.push({
          x: b1x,
          y: b1y,
        });
      }

      if (has2) {
        best.push({
          x: b2x,
          y: b2y,
        });
      }

      best.push(directEnd);
    }
  };

  evaluate(
    0,
    0,
    false,
    0,
    0,
    false,
  );

  for (const mult of [1, -1, 1.7, -1.7]) {
    const offset = bendBase * mult;

    const bx = clamp(
      midX + px * offset,
      ctx.minX - 28,
      ctx.maxX + 28,
    );

    const by = clamp(
      midY + py * offset,
      ctx.minY - 28,
      ctx.maxY + 28,
    );

    const keep =
      Math.abs(
        cross3(
          dsx,
          dsy,
          bx,
          by,
          dex,
          dey,
        ),
      ) > 1e-9;

    evaluate(
      bx,
      by,
      keep,
      0,
      0,
      false,
    );
  }

  if (corridor) {
    for (const by of [
      corridor.y - 30,
      corridor.y + corridor.h + 30,
    ]) {
      const b1x = dsx;
      const b1y = by;
      const b2x = dex;
      const b2y = by;

      const keep1 =
        Math.abs(
          cross3(
            dsx,
            dsy,
            b1x,
            b1y,
            b2x,
            b2y,
          ),
        ) > 1e-9;

      const ax = keep1 ? b1x : dsx;
      const ay = keep1 ? b1y : dsy;

      const keep2 =
        Math.abs(
          cross3(
            ax,
            ay,
            b2x,
            b2y,
            dex,
            dey,
          ),
        ) > 1e-9;

      evaluate(
        b1x,
        b1y,
        keep1,
        b2x,
        b2y,
        keep2,
      );
    }
  }

  const horizontal =
    Math.abs(ddx) >= Math.abs(ddy);

  const lane0 =
    horizontal ? midY : midX;

  const lane1 =
    horizontal
      ? ctx.minY - 30
      : ctx.minX - 30;

  const lane2 =
    horizontal
      ? ctx.maxY + 30
      : ctx.maxX + 30;

  const laneLimit =
    Math.min(
      options.maxLanes,
      routeCount + 1,
    );

  for (
    let lane = 1;
    (
      bestOverlap > 0
      || bestScore >= options.hardObstaclePenalty
    )
    && lane <= laneLimit;
    lane += 1
  ) {
    const delta =
      lane * options.laneStep;

    for (let ci = 0; ci < 3; ci += 1) {
      const center =
        ci === 0
          ? lane0
          : ci === 1
            ? lane1
            : lane2;

      for (
        let sign = -1;
        sign <= 1;
        sign += 2
      ) {
        const coordinate =
          center + sign * delta;

        const b1x =
          horizontal
            ? dsx
            : coordinate;

        const b1y =
          horizontal
            ? coordinate
            : dsy;

        const b2x =
          horizontal
            ? dex
            : coordinate;

        const b2y =
          horizontal
            ? coordinate
            : dey;

        const keep1 =
          Math.abs(
            cross3(
              dsx,
              dsy,
              b1x,
              b1y,
              b2x,
              b2y,
            ),
          ) > 1e-9;

        const ax =
          keep1 ? b1x : dsx;

        const ay =
          keep1 ? b1y : dsy;

        const keep2 =
          Math.abs(
            cross3(
              ax,
              ay,
              b2x,
              b2y,
              dex,
              dey,
            ),
          ) > 1e-9;

        evaluate(
          b1x,
          b1y,
          keep1,
          b2x,
          b2y,
          keep2,
        );
      }
    }
  }

  return {
    sourceId,
    targetId,
    points: best || [directStart, directEnd],
    score: bestScore,
    overlapPenalty: bestOverlap,
  };
}

export function routeEdges(
  links,
  {
    positions,
    boxes,
    corridor = null,
    config = {},
  },
) {
  const routes = [];
  const ctx = makeFastContext(
    boxes,
    config,
  );

  const index =
    new DenseSegmentIndex(
      ctx,
      links.length * 4 + 16,
      OVERLAP_GRID_CELL,
      AXIS_OVERLAP_AGGREGATE,
    );

  const occupiedRoutes =
    FAST_OVERLAP ? null : [];

  const occupiedSegments =
    FAST_OVERLAP ? null : [];

  let routeCount = 0;

  const sorted =
    [...links].sort(
      (a, b) =>
        String(a.edge_id)
          .localeCompare(
            String(b.edge_id),
          ),
    );

  for (const link of sorted) {
    const route =
      fastRouteEdge(
        link,
        {
          positions,
          boxes,
          corridor,
          ctx,
          index,
          occupiedRoutes,
          occupiedSegments,
          routeCount,
        },
      );

    if (!route) continue;

    routes.push({
      link,
      ...route,
    });

    const source =
      positions.get(
        route.sourceId,
      );

    const target =
      positions.get(
        route.targetId,
      );

    let ax = source.x;
    let ay = source.y;

    for (
      let i = 1;
      i < route.points.length - 1;
      i += 1
    ) {
      const p =
        route.points[i];

      index.addXY(
        ax,
        ay,
        p.x,
        p.y,
      );

      ax = p.x;
      ay = p.y;
    }

    index.addXY(
      ax,
      ay,
      target.x,
      target.y,
    );

    if (!FAST_OVERLAP) {
      const occupied = [
        source,
        ...route.points.slice(
          1,
          -1,
        ),
        target,
      ];

      occupiedRoutes.push(
        occupied,
      );

      appendOverlapSegments(
        occupiedSegments,
        occupied,
      );
    }

    routeCount += 1;
  }

  return routes;
}
