import test from 'node:test';
import assert from 'node:assert/strict';
import * as mapInteractions from '../site/map_interactions.mjs';
import {
  expandBox,
  pointInsideBox,
  segmentOrientation,
  pointOnSegment,
  lineSegmentsIntersect,
  segmentIntersectsBox,
  routePointForNode,
  simplifyRoute,
  routeOverlapPenalty,
} from '../site/dag_routing_geometry.mjs';
import { routeEdge, routeEdges, studyArrowCorridor } from '../site/dag_router.mjs';
import { routeNodeData, routesToVisData } from '../site/dag_vis_routing.mjs';
import { dagNodeBoxes } from '../site/dag_layout.mjs';
import { computeDagRender } from '../site/dag_render_compute.mjs';
import * as pathHighlights from '../site/dag_path_highlights.mjs';
import { createDagMapViewController } from '../site/dag_map_view_controller.mjs';
import { createDagNetworkController } from '../site/dag_network_controller.mjs';

test('geometry primitives remain independently testable', () => {
  assert.deepEqual(expandBox({ x: 1, y: 2, w: 3, h: 4 }, 2), { x: -1, y: 0, w: 7, h: 8 });
  assert.equal(pointInsideBox({ x: 2, y: 3 }, { x: 1, y: 2, w: 3, h: 4 }), true);
  assert.equal(segmentOrientation({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }), 1);
  assert.equal(pointOnSegment({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }), true);
  assert.equal(lineSegmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }), true);
  assert.equal(segmentIntersectsBox({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: -1, w: 2, h: 2 }), true);
  assert.deepEqual(routePointForNode({ cx: 0, cy: 0, w: 10, h: 10 }, { x: 20, y: 0 }), { x: 12, y: 0 });
  assert.deepEqual(simplifyRoute([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]), [{ x: 0, y: 0 }, { x: 10, y: 0 }]);
});

test('overlapping and reversed runs are penalized, crossings are allowed', () => {
    const line = [{ x: 0, y: 0 }, { x: 500, y: 0 }];
    assert.ok(routeOverlapPenalty(line, [[...line].reverse()]) > 1000);
    assert.equal(routeOverlapPenalty(line, [[{ x: 250, y: -100 }, { x: 250, y: 100 }]]), 0);
    assert.equal(routeOverlapPenalty(line, [[{ x: 0, y: 22 }, { x: 500, y: 22 }]]), 0);
});

test('links sharing a bypass retain separately selectable segments', () => {
    const positions = new Map([
      ['religion', { x: 0, y: 0 }], ['education', { x: 200, y: 60 }],
      ['interest', { x: 700, y: 60 }], ['personality', { x: 950, y: 0 }],
    ]);
    const boxes = new Map([...positions].map(([id, p]) => [id, { cx: p.x, cy: p.y, x: p.x - 45, y: p.y - 15, w: 90, h: 30 }]));
    const occupied = [];
    for (const [a, b] of [['religion', 'personality'], ['religion', 'interest'], ['education', 'personality']]) {
      const route = routeEdge({ edge_id: `${a}-${b}`, group_a: a, group_b: b, direction_type: 'A_TO_B' }, { positions, boxes, occupiedRoutes: occupied, corridor: { x: 180, y: -25, w: 500, h: 50 } });
      const points = [positions.get(a), ...route.points.slice(1, -1), positions.get(b)];
      assert.equal(routeOverlapPenalty(points, occupied), 0, `${a} -> ${b} shares a run`);
      occupied.push(points);
    }
});

test('route planning is deterministic and handles missing endpoints', () => {
  const positions = new Map([['a', { x: 0, y: 0 }], ['b', { x: 200, y: 0 }]]);
  const boxes = new Map([['a', { x: -45, y: -15, w: 90, h: 30, cx: 0, cy: 0 }], ['b', { x: 155, y: -15, w: 90, h: 30, cx: 200, cy: 0 }]]);
  const links = [{ edge_id: 'b', group_a: 'a', group_b: 'b', direction_type: 'A_TO_B' }, { edge_id: 'a', group_a: 'a', group_b: 'b', direction_type: 'B_TO_A' }];
  const first = routeEdges(links, { positions, boxes });
  const second = routeEdges([...links].reverse(), { positions, boxes });
  assert.deepEqual(first, second);
  assert.equal(routeEdge({ group_a: 'missing', group_b: 'b', direction_type: 'A_TO_B' }, { positions, boxes }), null);
});

test('vis adapter preserves selectable logical edge IDs', () => {
  const routes = [{ link: { edge_id: 'edge-1', direction_type: 'BIDIRECTIONAL' }, sourceId: 'a', targetId: 'b', points: [{ x: 0, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 0 }] }];
  const result = routesToVisData(routes, { edgeStyle: () => ({ color: 'green', arrows: { to: { enabled: true }, from: { enabled: true } } }), edgeTitle: () => 'title' });
  assert.deepEqual(result.edgeSegments.get('edge-1::seg0'), 'edge-1');
  assert.equal(result.edgeData.at(-1).arrows.to.enabled, true);
  assert.equal(result.edgeData[0].arrows.to.enabled, false);
  assert.equal(result.edgeData[0].arrows.from.enabled, true);
  assert.equal(result.edgeData.at(-1).arrows.from, undefined);
  assert.equal(routeNodeData('__route__edge-1__0', { x: 50, y: 20 }).physics, false);
});

test('DAG assembly retains visible nodes alongside routing bends, including without links', () => {
  const groups = [{ group_id: 'a', label: 'IV', variable_ids: [] }, { group_id: 'b', label: 'DV', variable_ids: [] }];
  const state = { project: { iv_group_id: 'a', dv_group_id: 'b', groups }, selectedEdgeId: null,
    showCollidersOnly: false, showConfoundersOnly: false, colliderGroupIds: new Set(),
    colliderPathGroupIds: new Set(), confounderGroupIds: new Set(), confounderPathGroupIds: new Set() };
  const controller = createDagNetworkController({ state, elements: {}, visApi: {}, clusterRep: id => id,
    groupColor: () => '#000', dagGroups: () => groups, groupById: id => groups.find(g => g.group_id === id),
    drawMap() {}, setMapMode() {}, renderAll() {}, selectEdge() {} });
  const layout = { positions: new Map([['a', { x: 0, y: 0 }], ['b', { x: 500, y: 0 }]]), params: { fontSize: 12 } };
  layout.boxes = dagNodeBoxes(groups, layout);
  const link = { edge_id: 'ab', group_a: 'a', group_b: 'b', direction_type: 'BIDIRECTIONAL',
    a_to_b_paper_table_keys: [], b_to_a_paper_table_keys: [] };
  for (const links of [[], [link]]) {
    const result = controller.routedDagData(groups, links, layout);
    assert.deepEqual(Array.from(result.nodeData.filter(n => n.label), n => n.id), ['a', 'b']);
    const ids = new Set(result.nodeData.map(n => n.id));
    for (const edge of result.edgeData) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to));
    }
    if (links.length) assert.ok(result.nodeData.length > 2, 'fixture exercises routing bends');
  }
});

test('worker-ready DAG computation is deterministic and leaves serializable inputs unchanged', () => {
  const input = {
    groups: [{ group_id: 'a', label: 'A' }, { group_id: 'b', label: 'B' }],
    links: [{ edge_id: 'ab', group_a: 'a', group_b: 'b', direction_type: 'A_TO_B' }],
    centroids: [['a', { x: 0, y: 0 }], ['b', { x: 10, y: 4 }]],
    ivId: 'a', dvId: 'b', mode: 'auto', width: 630, height: 700, viewSignature: 'test',
  };
  const before = structuredClone(input);
  const first = computeDagRender(input);
  const second = computeDagRender(structuredClone(input));
  const serializable = result => ({
    layout: { ...result.layout, positions: [...result.layout.positions], boxes: [...result.layout.boxes] },
    routes: result.routes,
  });
  assert.deepEqual(serializable(first), serializable(second));
  assert.deepEqual(input, before);
});

test('hover preserves a clear original route without new loops', () => {
  const points = [{ x: 0, y: 0 }, { x: 30, y: 120 }, { x: 500, y: 120 }, { x: 540, y: 0 }];
  assert.equal(JSON.stringify(pathHighlights.separateHighlightRuns(points, [], 1, -1)), JSON.stringify(points));
});

test('hover separates a study-arrow overlap and joins bends without backwards hooks', () => {
  const points = [{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: -200 }];
  const routed = pathHighlights.separateHighlightRuns(points, [[{ x: 0, y: 0 }, { x: 800, y: 0 }]], 1, -1);
  assert.ok(routed.some(p => p.y === -15));
  for (let i = 1; i < routed.length; i++) {
    assert.ok(routed[i].x >= routed[i - 1].x);
    assert.ok(routed[i].y <= routed[i - 1].y);
  }
});

test('arrow remains visible when the terminal segment is short or inside a wide node', () => {
  const points = [{ x: 0, y: 0 }, { x: 490, y: 0 }, { x: 500, y: 0 }];
  const boxes = [{ x: 410, y: -25, w: 180, h: 50 }];
  for (const scale of [0.4, 1, 2]) {
    const marker = pathHighlights.highlightedArrowMarker(points, false, boxes, scale);
    assert.ok(marker);
    assert.ok(marker.point.x < 410 - 12 / scale);
    assert.equal(marker.angle, 0);
  }
  const reversed = pathHighlights.highlightedArrowMarker(points, true, [{ x: -90, y: -25, w: 180, h: 50 }], 1);
  assert.ok(reversed.point.x > 102);
  assert.equal(reversed.angle, Math.PI);
});

test('variable map zoom floor uses the whole map after a neighborhood fit', () => {
  const state = { map: { transform: { scale: 5, tx: 0, ty: 0 }, fitScale: 5,
    canvas: { width: 1108, height: 1108 }, dpr: 1 }, variableById: new Map() };
  const controller = createDagMapViewController({ state, elements: {}, activeGroup: () => null,
    visibleVariables: () => [{ map_x: 0, map_y: 0 }, { map_x: 1000, map_y: 1000 }],
    isRejectedVariable: () => false, drawMap: () => {} });
  controller.zoom(500, 500, 0.00001);
  assert.equal(state.map.transform.scale, 0.8);
  const before = { ...state.map.transform };
  controller.zoom(500, 500, 0.1);
  assert.deepEqual(state.map.transform, before);
});


test('a slightly sloping run cannot disappear beneath a longer study arrow', () => {
  const routed = pathHighlights.separateHighlightRuns([{ x: 0, y: 0 }, { x: 200, y: -8 }],
    [[{ x: 0, y: 0 }, { x: 1000, y: 0 }]], 1, -1);
  assert.ok(routed.some(p => p.y < -14));
});
