import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDagLayout } from '../site/dag_layout.mjs';
import { legacyLayout } from './fixtures/legacy_dag_layout.mjs';
import { routeEdges } from '../site/dag_router.mjs';
import { routesToVisData } from '../site/dag_vis_routing.mjs';

// Synthetic graphs exercise the small/large and auto-layout thresholds, with
// reversed links, ambiguous directions and a cycle. No research data is used.
function fixture(count, mode, width = 900, height = 720) {
  const groups = Array.from({ length: count }, (_, i) => ({
    group_id: `g${i}`, label: `Group ${i} with a long descriptive label`,
    variable_ids: Array.from({ length: i % 4 + 1 }, (_, j) => `v${i}-${j}`),
  }));
  const links = groups.slice(1).map((g, i) => ({
    edge_id: `e${i}`, group_a: groups[i].group_id, group_b: g.group_id,
    direction_type: ['A_TO_B', 'B_TO_A', 'BIDIRECTIONAL'][i % 3],
  }));
  if (count > 2) links.push({ edge_id: 'cycle', group_a: `g${count - 1}`, group_b: 'g0', direction_type: 'A_TO_B' });
  return { groups, links, centroids: new Map(groups.map((g, i) => [g.group_id, { x: i % 5 * 19, y: i % 7 * 13 }])),
    ivId: 'g0', dvId: `g${count - 1}`, mode, width, height };
}

for (const mode of ['auto', 'hierarchical', 'organic']) {
  for (const count of [0, 1, 8, 28, 43]) {
    test(`${mode}, ${count} nodes: exact legacy parity and unchanged inputs`, () => {
      const input = fixture(count, mode, count <= 8 ? 630 : 1100);
      const before = structuredClone(input);
      const expected = legacyLayout(input);
      const actual = computeDagLayout(input);
      assert.deepEqual(actual, expected);
      assert.deepEqual(input, before);
      assert.deepEqual(computeDagLayout(input), actual);
      assert.equal(actual.positions.size, count);
      assert.equal(actual.boxes.size, count);
      for (const group of input.groups) {
        const point = actual.positions.get(group.group_id);
        const box = actual.boxes.get(group.group_id);
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.equal(box.cx, point.x);
        assert.equal(box.cy, point.y);
      }
      if (count > 1) {
        const iv = actual.positions.get(input.ivId), dv = actual.positions.get(input.dvId);
        assert.ok(iv.x < dv.x);
        assert.equal(iv.y, dv.y);
      }
    });
  }
}

test('layout, routing and adapter preserve every endpoint', () => {
  const input = fixture(8, 'organic');
  const layout = computeDagLayout(input);
  const routes = routeEdges(input.links, layout);
  const rendered = routesToVisData(routes, { edgeStyle: () => ({}), edgeTitle: () => '' });
  const nodeIds = new Set([...layout.positions.keys(), ...rendered.nodeData.map(node => node.id)]);
  assert.equal(routes.length, input.links.length);
  for (const edge of rendered.edgeData) assert.ok(nodeIds.has(edge.from) && nodeIds.has(edge.to));
});

test('view signature changes refit identity without changing geometry', () => {
  const input = fixture(8, 'hierarchical');
  const base = computeDagLayout(input);
  const filtered = computeDagLayout({ ...input, viewSignature: 'confounders:2:bottlenecked:true:path-links:true' });
  assert.deepEqual(filtered.positions, base.positions);
  assert.deepEqual(filtered.boxes, base.boxes);
  assert.notEqual(filtered.signature, base.signature);
});

test('missing anchors and missing centroids produce finite positions', () => {
  const input = fixture(8, 'organic', 0, 0);
  input.ivId = 'missing';
  input.centroids = new Map();
  const layout = computeDagLayout(input);
  assert.equal(layout.positions.size, input.groups.length);
  for (const point of layout.positions.values()) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});
