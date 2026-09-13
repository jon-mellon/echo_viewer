"use strict";

export function expandBox(box, padding) {
  return { x: box.x - padding, y: box.y - padding, w: box.w + padding * 2, h: box.h + padding * 2 };
}

export function pointInsideBox(point, box) {
  return point.x >= box.x && point.x <= box.x + box.w
    && point.y >= box.y && point.y <= box.y + box.h;
}

export function segmentOrientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function pointOnSegment(a, b, point) {
  return Math.min(a.x, b.x) - 1e-9 <= point.x && point.x <= Math.max(a.x, b.x) + 1e-9
    && Math.min(a.y, b.y) - 1e-9 <= point.y && point.y <= Math.max(a.y, b.y) + 1e-9;
}

export function lineSegmentsIntersect(a, b, c, d) {
  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);
  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
  if (Math.abs(o1) < 1e-9 && pointOnSegment(a, b, c)) return true;
  if (Math.abs(o2) < 1e-9 && pointOnSegment(a, b, d)) return true;
  if (Math.abs(o3) < 1e-9 && pointOnSegment(c, d, a)) return true;
  if (Math.abs(o4) < 1e-9 && pointOnSegment(c, d, b)) return true;
  return false;
}

export function segmentIntersectsBox(a, b, box, padding = 0) {
  const expanded = expandBox(box, padding);
  if (Math.max(a.x, b.x) < expanded.x || Math.min(a.x, b.x) > expanded.x + expanded.w
    || Math.max(a.y, b.y) < expanded.y || Math.min(a.y, b.y) > expanded.y + expanded.h) return false;
  if (pointInsideBox(a, expanded) || pointInsideBox(b, expanded)) return true;
  const corners = [
    { x: expanded.x, y: expanded.y },
    { x: expanded.x + expanded.w, y: expanded.y },
    { x: expanded.x + expanded.w, y: expanded.y + expanded.h },
    { x: expanded.x, y: expanded.y + expanded.h },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    if (lineSegmentsIntersect(a, b, corners[index], corners[(index + 1) % corners.length])) return true;
  }
  return false;
}

export function routePointForNode(box, toward) {
  const dx = toward.x - box.cx;
  const dy = toward.y - box.cy;
  const useHorizontal = Math.abs(dx) / Math.max(1, box.w) >= Math.abs(dy) / Math.max(1, box.h);
  if (useHorizontal) return { x: box.cx + Math.sign(dx || 1) * (box.w / 2 + 7), y: box.cy };
  return { x: box.cx, y: box.cy + Math.sign(dy || 1) * (box.h / 2 + 7) };
}

export function simplifyRoute(points) {
  const cleaned = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 3) cleaned.push(point);
  }
  for (let index = cleaned.length - 2; index > 0; index -= 1) {
    const prev = cleaned[index - 1];
    const cur = cleaned[index];
    const next = cleaned[index + 1];
    if (Math.abs(segmentOrientation(prev, cur, next)) < 1e-6 && pointOnSegment(prev, next, cur)) {
      cleaned.splice(index, 1);
    }
  }
  return cleaned;
}

export function routeOverlapPenalty(points, occupiedRoutes) {
  let penalty = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1) continue;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    for (const route of occupiedRoutes) {
      for (let other = 0; other < route.length - 1; other += 1) {
        const c = route[other];
        const d = route[other + 1];
        const otherLength = Math.hypot(d.x - c.x, d.y - c.y);
        if (otherLength < 1) continue;
        const parallel = Math.abs(ux * (d.y - c.y) - uy * (d.x - c.x)) / otherLength;
        if (parallel > 0.12) continue;
        const project = (point) => (point.x - a.x) * ux + (point.y - a.y) * uy;
        const start = Math.max(0, Math.min(project(c), project(d)));
        const end = Math.min(length, Math.max(project(c), project(d)));
        if (end - start <= 18) continue;
        const denominator = project(d) - project(c);
        const t = denominator === 0 ? 0 : ((start + end) / 2 - project(c)) / denominator;
        const distance = Math.abs((c.x + (d.x - c.x) * t - a.x) * uy
          - (c.y + (d.y - c.y) * t - a.y) * ux);
        if (distance < 16) penalty += (end - start) * 40 * (1 - distance / 16);
      }
    }
  }
  return penalty;
}
