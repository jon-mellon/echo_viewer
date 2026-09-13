import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  worldToScreen, screenToWorld, clipPolygonByHalfPlane, computeVoronoiCells,
  polygonsTouch, polygonAreaAndCentroid, regionLabelAnchor,
  buildRegionLabelComponents, computeGroupRegions, pointInPolygon,
  boxesOverlap, placeLabel, centroid, distance,
} from '../site/map_geometry.mjs';

const square = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
const transform = { scale: 2, tx: 10, ty: -4 };

test('coordinate transforms round-trip without shared state', () => {
  const screen = worldToScreen(3, -2, transform);
  assert.deepEqual(screen, { x: 16, y: -8 });
  assert.deepEqual(screenToWorld(screen.x, screen.y, transform), { x: 3, y: -2 });
  assert.deepEqual(transform, { scale: 2, tx: 10, ty: -4 });
});

test('half-plane clipping preserves the input and expected polygon area', () => {
  const clipped = clipPolygonByHalfPlane(square, 0, 0, 1, 0);
  assert.deepEqual(square, [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]);
  assert.equal(polygonAreaAndCentroid(clipped).area, 2);
  assert.deepEqual(polygonAreaAndCentroid(clipped).centroid, { x: 0.5, y: 0 });
});

function approximatelyEqual(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} is not approximately ${expected}`);
}

test('exact Voronoi construction is deterministic, bounded and owns coincident sites once', () => {
  const sites = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 0, y: 10 }, { id: 'duplicate', x: 0, y: 0 }];
  const first = computeVoronoiCells(sites);
  const second = computeVoronoiCells([...sites].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.size, 3);
  assert.equal(first.ownerById.get('duplicate'), 'a');
  assert.deepEqual(first.bounds, [-0.6, -0.6, 10.6, 10.6]);
  for (const polygon of first.values()) {
    assert.ok(polygon.length >= 3);
    assert.ok(polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  }
  assert.equal(computeVoronoiCells([]).size, 0);
});

test('Voronoi cells cover their bounds, contain their sites and have planar symmetric adjacency', () => {
  const sites = [
    { id: 'a', x: -2, y: -1 }, { id: 'b', x: 3, y: -0.5 },
    { id: 'c', x: 0.25, y: 4 }, { id: 'd', x: -1, y: 2 },
    { id: 'e', x: 1.5, y: 1.25 },
  ];
  const cells = computeVoronoiCells(sites);
  const [xmin, ymin, xmax, ymax] = cells.bounds;
  const cellArea = [...cells.values()]
    .reduce((sum, polygon) => sum + polygonAreaAndCentroid(polygon).area, 0);
  approximatelyEqual(cellArea, (xmax - xmin) * (ymax - ymin), 1e-11);
  for (const site of sites) {
    assert.equal(pointInPolygon(site, cells.get(site.id)), true, `${site.id} is outside its cell`);
  }
  let directedEdges = 0;
  for (const [id, neighbors] of cells.adjacency) {
    directedEdges += neighbors.size;
    for (const neighbor of neighbors) assert.equal(cells.adjacency.get(neighbor)?.has(id), true);
  }
  assert.ok(directedEdges / 2 <= 3 * sites.length - 6);
});

test('Voronoi geometry and adjacency are invariant to coordinate units', () => {
  const sites = [
    { id: 'a', x: -2.5, y: 1 }, { id: 'b', x: 0, y: -3 },
    { id: 'c', x: 4, y: 2 }, { id: 'd', x: 1, y: 5 },
  ];
  const baseline = computeVoronoiCells(sites);
  for (const factor of [1e-6, 1e6]) {
    const scaled = computeVoronoiCells(sites.map(site => ({
      ...site, x: site.x * factor, y: site.y * factor,
    })));
    assert.deepEqual(scaled.adjacency, baseline.adjacency);
    for (const [id, polygon] of baseline) {
      const scaledPolygon = scaled.get(id);
      assert.equal(scaledPolygon.length, polygon.length);
      for (let i = 0; i < polygon.length; i += 1) {
        approximatelyEqual(scaledPolygon[i].x / factor, polygon[i].x, 1e-8);
        approximatelyEqual(scaledPolygon[i].y / factor, polygon[i].y, 1e-8);
      }
    }
  }
});

test('Voronoi construction remains interactive at representative-map scale', { timeout: 5000 }, () => {
  const count = 10000;
  const sites = Array.from({ length: count }, (_, index) => ({
    id: `v${String(index).padStart(5, '0')}`,
    x: (index % 100) + ((index * 37) % 101) * 1e-4,
    y: Math.floor(index / 100) + ((index * 53) % 103) * 1e-4,
  }));
  const started = performance.now();
  const cells = computeVoronoiCells(sites);
  const elapsed = performance.now() - started;
  assert.equal(cells.size, count);
  assert.ok(elapsed < 2000, `10,000-site Voronoi build took ${elapsed.toFixed(1)} ms`);
});

test('regions deduplicate cluster members and expose connected components', () => {
  const cells = new Map([
    ['a', [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]],
    ['b', [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }]],
    ['c', [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 11, y: 11 }, { x: 10, y: 11 }]],
  ]);
  const variables = new Map([['a', { map_x: 0, map_y: 0 }], ['b', { map_x: 1, map_y: 0 }], ['c', { map_x: 10, map_y: 10 }]]);
  const regions = computeGroupRegions([{ group_id: 'g', variable_ids: ['a', 'a', 'b', 'c'] }], {
    cells, clusterRep: id => id, variables, transform,
  });
  assert.equal(regions.get('g').territories.length, 3);
  assert.equal(regions.get('g').components.length, 2);
  assert.equal(polygonsTouch(cells.get('a'), cells.get('b')), true);
  assert.equal(polygonsTouch(cells.get('a'), cells.get('c')), false);
});

test('region components use exact Voronoi adjacency when available', () => {
  const sites = [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 },
    { id: 'c', x: 2, y: 0 }, { id: 'd', x: 20, y: 20 },
  ];
  const cells = computeVoronoiCells(sites);
  const variables = new Map(sites.map(site => [site.id, { map_x: site.x, map_y: site.y }]));
  const regions = computeGroupRegions([
    { group_id: 'connected', variable_ids: ['a', 'b', 'c'] },
    { group_id: 'separate', variable_ids: ['a', 'c'] },
  ], { cells, clusterRep: id => id, variables, transform });
  assert.equal(regions.get('connected').components.length, 1);
  assert.equal(regions.get('separate').components.length, 2);
});

test('polygon anchors choose the largest territory centroid and transform it', () => {
  const anchor = regionLabelAnchor([square, [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }, { x: 5, y: 6 }]], null, transform);
  assert.deepEqual(anchor, { x: 10, y: -4 });
  assert.deepEqual(buildRegionLabelComponents([square]), [{ territories: [square], cx: 0, cy: 0 }]);
});

test('point, box, label and scalar geometry helpers are deterministic', () => {
  assert.equal(pointInPolygon({ x: 0, y: 0 }, square), true);
  assert.equal(pointInPolygon({ x: 2, y: 0 }, square), false);
  assert.equal(boxesOverlap({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 1, w: 2, h: 2 }), true);
  assert.equal(boxesOverlap({ x: 0, y: 0, w: 1, h: 1 }, { x: 1, y: 1, w: 2, h: 2 }), false);
  const placed = placeLabel({ x: 50, y: 50 }, { w: 20, h: 10 }, [], 100, 100, false);
  assert.deepEqual(placed, { x: 59, y: 45, w: 20, h: 10 });
  const second = placeLabel({ x: 50, y: 50 }, { w: 20, h: 10 }, [placed], 100, 100, false);
  assert.ok(second);
  assert.equal(boxesOverlap({ x: second.x - 4, y: second.y - 4, w: second.w + 8, h: second.h + 8 },
    { x: placed.x - 4, y: placed.y - 4, w: placed.w + 8, h: placed.h + 8 }), false);
  assert.deepEqual(centroid(['a', 'b'], new Map([['a', { map_x: 0, map_y: 2 }], ['b', { map_x: 2, map_y: 4 }]])), { x: 1, y: 3 });
  assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});
