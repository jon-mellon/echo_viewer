"use strict";

import {
  pointInsideBox,
  routePointForNode,
  routeOverlapPenalty,
  segmentIntersectsBox,
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

export function scoreRoute(points, { boxes, sourceId, targetId, corridor = null, config = {} }) {
  const options = { ...DEFAULT_CONFIG, ...config };
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
    for (const [groupId, box] of boxes) {
      if (groupId === sourceId || groupId === targetId) continue;
      if (segmentIntersectsBox(a, b, box, options.hardObstaclePadding)) score += options.hardObstaclePenalty;
      else if (segmentIntersectsBox(a, b, box, options.softObstaclePadding)) score += options.softObstaclePenalty;
    }
  }
  return score + Math.max(0, points.length - 2) * options.bendPenalty;
}

export function routeEdge(link, { positions, boxes, occupiedRoutes = [], corridor = null, config = {} }) {
  const isReversed = link.direction_type === "B_TO_A";
  const sourceId = isReversed ? link.group_b : link.group_a;
  const targetId = isReversed ? link.group_a : link.group_b;
  const sourceBox = boxes.get(sourceId);
  const targetBox = boxes.get(targetId);
  const sourcePoint = positions.get(sourceId);
  const targetPoint = positions.get(targetId);
  if (!sourceBox || !targetBox || !sourcePoint || !targetPoint) return null;

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
    const overlap = routeOverlapPenalty(actualPoints, occupiedRoutes);
    const score = scoreRoute(actualPoints, { boxes, sourceId, targetId, corridor, config }) + overlap;
    if (score < bestScore) {
      best = simplified;
      bestScore = score;
      bestOverlap = overlap;
    }
  };
  candidates.forEach(consider);

  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const laneCenters = horizontal ? [midY, minY - 30, maxY + 30] : [midX, minX - 30, maxX + 30];
  const options = { ...DEFAULT_CONFIG, ...config };
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

export function routeEdges(links, { positions, boxes, corridor = null, config = {} }) {
  const routes = [];
  const occupiedRoutes = [];
  for (const link of [...links].sort((a, b) => String(a.edge_id).localeCompare(String(b.edge_id)))) {
    const route = routeEdge(link, { positions, boxes, occupiedRoutes, corridor, config });
    if (!route) continue;
    routes.push({ link, ...route });
    occupiedRoutes.push([positions.get(route.sourceId), ...route.points.slice(1, -1), positions.get(route.targetId)]);
  }
  return routes;
}
