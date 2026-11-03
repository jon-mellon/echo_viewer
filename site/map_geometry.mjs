"use strict";

import { Delaunay } from "./vendor/d3-delaunay.mjs";

export function worldToScreen(x, y, transform) {
  return { x: x * transform.scale + transform.tx, y: y * transform.scale + transform.ty };
}

export function screenToWorld(x, y, transform) {
  return { x: (x - transform.tx) / transform.scale, y: (y - transform.ty) / transform.scale };
}

export function clipPolygonByHalfPlane(polygon, px, py, nx, ny) {
  if (!polygon.length) return [];
  const inside = p => (p.x - px) * nx + (p.y - py) * ny >= 0;
  const result = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const aIn = inside(a), bIn = inside(b);
    if (aIn) result.push(a);
    if (aIn !== bIn) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const denominator = dx * nx + dy * ny;
      const denominatorScale = Math.abs(dx * nx) + Math.abs(dy * ny);
      if (Math.abs(denominator) > Number.EPSILON * Math.max(Number.MIN_VALUE, denominatorScale) * 16) {
        const t = ((px - a.x) * nx + (py - a.y) * ny) / denominator;
        result.push({ x: a.x + t * dx, y: a.y + t * dy });
      }
    }
  }
  return result;
}

function coordinateKey(x, y) {
  return `${x === 0 ? 0 : x}\u0000${y === 0 ? 0 : y}`;
}

function voronoiBounds(sites, paddingFraction) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const site of sites) {
    minx = Math.min(minx, site.x); maxx = Math.max(maxx, site.x);
    miny = Math.min(miny, site.y); maxy = Math.max(maxy, site.y);
  }
  const spanX = maxx - minx, spanY = maxy - miny;
  const referenceSpan = Math.max(spanX, spanY);
  // A singleton has no data-defined scale. This fallback only determines its
  // otherwise arbitrary display territory; all non-degenerate layouts remain
  // exactly scale-equivariant.
  const fallbackSpan = Math.max(Math.abs(minx), Math.abs(miny), 1);
  const effectiveSpan = referenceSpan > 0 ? referenceSpan : fallbackSpan;
  const padX = (spanX > 0 ? spanX : effectiveSpan) * paddingFraction;
  const padY = (spanY > 0 ? spanY : effectiveSpan) * paddingFraction;
  return [minx - padX, miny - padY, maxx + padX, maxy + padY];
}

/**
 * Construct exact bounded Voronoi cells in O(n log n) time.
 *
 * The returned Map carries three documented metadata properties:
 * `adjacency` contains exact Delaunay neighbours, `ownerById` maps coincident
 * sites to one deterministic owner, and `bounds` is [xmin, ymin, xmax, ymax].
 * Only owners receive cells, preventing coincident sites from drawing
 * overlapping polygons.
 */
export function computeVoronoiCells(representatives, { paddingFraction = 0.06 } = {}) {
  const cells = new Map();
  cells.adjacency = new Map();
  cells.ownerById = new Map();
  cells.bounds = null;
  if (!representatives.length) return cells;
  if (!(paddingFraction > 0) || !Number.isFinite(paddingFraction)) {
    throw new RangeError("paddingFraction must be a positive finite number");
  }

  const valid = representatives
    .filter(site => site?.id != null && Number.isFinite(site.x) && Number.isFinite(site.y))
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const uniqueSites = [];
  const ownerByCoordinate = new Map();
  for (const site of valid) {
    const key = coordinateKey(site.x, site.y);
    let owner = ownerByCoordinate.get(key);
    if (owner == null) {
      owner = site.id;
      ownerByCoordinate.set(key, owner);
      uniqueSites.push({ id: owner, x: site.x, y: site.y });
    }
    cells.ownerById.set(site.id, owner);
  }
  if (!uniqueSites.length) return cells;

  const bounds = voronoiBounds(uniqueSites, paddingFraction);
  // Delaunator uses a fixed numerical tolerance internally. Normalize before
  // triangulation so changing coordinate units cannot collapse a valid map or
  // alter its adjacency, then transform the exact cells back to world space.
  const centerX = (bounds[0] + bounds[2]) / 2;
  const centerY = (bounds[1] + bounds[3]) / 2;
  const normalizationScale = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  const normalizedSites = uniqueSites.map(site => ({
    ...site,
    normalizedX: (site.x - centerX) / normalizationScale,
    normalizedY: (site.y - centerY) / normalizationScale,
  }));
  const normalizedBounds = [
    (bounds[0] - centerX) / normalizationScale,
    (bounds[1] - centerY) / normalizationScale,
    (bounds[2] - centerX) / normalizationScale,
    (bounds[3] - centerY) / normalizationScale,
  ];
  const delaunay = Delaunay.from(
    normalizedSites, site => site.normalizedX, site => site.normalizedY,
  );
  const voronoi = delaunay.voronoi(normalizedBounds);
  cells.bounds = bounds;
  for (let index = 0; index < uniqueSites.length; index += 1) {
    const owner = uniqueSites[index].id;
    const rawPolygon = voronoi.cellPolygon(index);
    if (!rawPolygon || rawPolygon.length < 4) continue;
    // d3 closes each polygon by repeating its first vertex. Canvas closePath()
    // already does that, so retain each boundary vertex exactly once.
    const polygon = rawPolygon.slice(0, -1).map(([x, y]) => ({
      x: x * normalizationScale + centerX,
      y: y * normalizationScale + centerY,
    }));
    if (polygon.length >= 3) cells.set(owner, polygon);
    cells.adjacency.set(owner, new Set());
  }
  for (let index = 0; index < uniqueSites.length; index += 1) {
    const owner = uniqueSites[index].id;
    const adjacent = cells.adjacency.get(owner);
    if (!adjacent) continue;
    // Use bounded Voronoi adjacency rather than raw triangulation adjacency:
    // clipping can remove a Delaunay neighbour's shared edge at the map bound.
    for (const neighborIndex of voronoi.neighbors(index)) {
      const neighbor = uniqueSites[neighborIndex]?.id;
      if (neighbor != null && cells.has(neighbor)) adjacent.add(neighbor);
    }
  }
  return cells;
}

export function polygonsTouch(a, b, epsilon = null) {
  if (!a?.length || !b?.length) return false;
  let tolerance = epsilon;
  if (tolerance == null) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const point of [...a, ...b]) {
      minx = Math.min(minx, point.x); maxx = Math.max(maxx, point.x);
      miny = Math.min(miny, point.y); maxy = Math.max(maxy, point.y);
    }
    tolerance = Math.max(maxx - minx, maxy - miny, Number.MIN_VALUE) * 1e-9;
  }
  return a.some(pa => b.some(pb => Math.abs(pa.x - pb.x) <= tolerance && Math.abs(pa.y - pb.y) <= tolerance));
}

export function polygonAreaAndCentroid(polygon) {
  if (!polygon?.length) return { area: 0, centroid: null };
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross; cx += (a.x + b.x) * cross; cy += (a.y + b.y) * cross;
  }
  const area = Math.abs(twiceArea) / 2;
  const coordinateScale = polygon.reduce((largest, point) => Math.max(largest, Math.abs(point.x), Math.abs(point.y)), 0);
  const areaTolerance = Number.EPSILON * Math.max(coordinateScale * coordinateScale, Number.MIN_VALUE) * polygon.length * 32;
  if (Math.abs(twiceArea) <= areaTolerance) return { area, centroid: polygon[0] || null };
  return { area, centroid: { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) } };
}

export function regionLabelAnchor(territories, fallbackWorldCenter = null, transform = null) {
  let best = null, weightedX = 0, weightedY = 0, totalArea = 0;
  for (const polygon of territories) {
    const { area, centroid } = polygonAreaAndCentroid(polygon);
    if (!centroid || area <= 0) continue;
    weightedX += centroid.x * area; weightedY += centroid.y * area; totalArea += area;
    if (!best || area > best.area) best = { area, centroid };
  }
  const center = totalArea > 0 ? { x: weightedX / totalArea, y: weightedY / totalArea }
    : (best?.centroid || fallbackWorldCenter || { x: 0, y: 0 });
  const target = best?.centroid || center;
  return transform ? worldToScreen(target.x, target.y, transform) : target;
}

export function buildRegionLabelComponents(
  territories,
  fallbackWorldCenter = null,
  transform = null,
  territoryIds = null,
  adjacency = null,
) {
  if (!territories?.length) return [];
  const indexById = adjacency && territoryIds
    ? new Map(territoryIds.map((id, index) => [id, index]))
    : null;
  const visited = new Set(), components = [];
  for (let i = 0; i < territories.length; i += 1) {
    if (visited.has(i)) continue;
    const stack = [i], polygons = []; visited.add(i);
    while (stack.length) {
      const current = stack.pop(), polygon = territories[current]; polygons.push(polygon);
      if (indexById) {
        for (const neighborId of adjacency.get(territoryIds[current]) || []) {
          const neighborIndex = indexById.get(neighborId);
          if (neighborIndex != null && !visited.has(neighborIndex)) {
            visited.add(neighborIndex); stack.push(neighborIndex);
          }
        }
      } else {
        for (let j = 0; j < territories.length; j += 1) {
          if (!visited.has(j) && polygonsTouch(polygon, territories[j])) {
            visited.add(j); stack.push(j);
          }
        }
      }
    }
    const anchor = regionLabelAnchor(polygons, fallbackWorldCenter, transform);
    components.push({ territories: polygons, cx: anchor.x, cy: anchor.y });
  }
  return components;
}

export function computeGroupRegions(groups, { cells, clusterRep, variables, transform }) {
  const regions = new Map();
  for (const group of groups.filter(g => g.variable_ids?.length)) {
    const seen = new Set(), territories = [], territoryIds = []; let sx = 0, sy = 0, count = 0;
    for (const id of group.variable_ids) {
      const rep = clusterRep(id);
      const owner = cells.ownerById?.get(rep) ?? rep;
      if (seen.has(owner)) continue; seen.add(owner);
      const cell = cells.get(owner); if (!cell) continue;
      territories.push(cell); territoryIds.push(owner);
      const variable = variables.get(owner) || variables.get(rep);
      if (variable) { sx += variable.map_x; sy += variable.map_y; count += 1; }
    }
    if (!territories.length) continue;
    const fallback = count ? { x: sx / count, y: sy / count } : null;
    const anchor = regionLabelAnchor(territories, fallback, transform);
    regions.set(group.group_id, { territories, cx: anchor.x, cy: anchor.y,
      components: buildRegionLabelComponents(
        territories, fallback, transform, territoryIds, cells.adjacency,
      ) });
  }
  return regions;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i], b = polygon[j];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);
    if (intersects) inside = !inside;
  }
  return inside;
}

export function boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function placeLabel(screen, size, occupied, width, height, force, padding = 4) {
  const offsets = [
    { dx: 9, dy: -size.h / 2 }, { dx: 9, dy: 10 }, { dx: 9, dy: -size.h - 10 },
    { dx: -size.w - 9, dy: -size.h / 2 }, { dx: -size.w - 9, dy: 10 }, { dx: -size.w - 9, dy: -size.h - 10 },
    { dx: -size.w / 2, dy: 12 }, { dx: -size.w / 2, dy: -size.h - 12 },
  ];
  for (const offset of offsets) {
    const box = { x: screen.x + offset.dx, y: screen.y + offset.dy, w: size.w, h: size.h };
    if (box.x < 2 || box.y < 2 || box.x + box.w > width - 2 || box.y + box.h > height - 2) continue;
    const expanded = { x: box.x - padding, y: box.y - padding, w: box.w + padding * 2, h: box.h + padding * 2 };
    if (!occupied.some(other => boxesOverlap(expanded, {
      x: other.x - padding, y: other.y - padding,
      w: other.w + padding * 2, h: other.h + padding * 2,
    }))) return box;
  }
  if (!force) return null;
  return { x: Math.max(2, Math.min(width - size.w - 2, screen.x + 9)), y: Math.max(2, Math.min(height - size.h - 2, screen.y - size.h / 2)), w: size.w, h: size.h };
}

export function centroid(variableIds, variableById) {
  const points = variableIds.map(id => variableById.get(id)).filter(Boolean);
  if (!points.length) return { x: 0, y: 0 };
  return { x: points.reduce((sum, v) => sum + v.map_x, 0) / points.length,
    y: points.reduce((sum, v) => sum + v.map_y, 0) / points.length };
}

export function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
