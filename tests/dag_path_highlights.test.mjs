import test from "node:test";
import assert from "node:assert/strict";
import * as highlights from "../site/dag_path_highlights.mjs";

function recorder() {
  const commands = [];
  const context = new Proxy({}, {
    get: (_, key) => (...args) => commands.push([key, ...args]),
    set: (_, key, value) => { commands.push([key, value]); return true; },
  });
  return { context, commands };
}

test("highlight model classifies path edges, dims others and preserves inputs", () => {
  const visibleLinks = [
    { edge_id: "to_iv", group_a: "c", group_b: "iv", direction_type: "BIDIRECTIONAL" },
    { edge_id: "to_dv", group_a: "c", group_b: "dv", direction_type: "A_TO_B" },
    { edge_id: "other", group_a: "iv", group_b: "x", direction_type: "A_TO_B" },
  ];
  const edges = visibleLinks.map(link => ({ id: link.edge_id, from: link.group_a, to: link.group_b,
    arrows: { to: { enabled: true } }, color: { color: "gray" }, title: link.edge_id }));
  const nodes = ["iv", "dv", "c", "x"].map(id => ({ id, color: { background: "white" } }));
  const before = structuredClone({ visibleLinks, edges, nodes });
  const model = highlights.buildPathHighlightModel({
    paths: { toIv: ["c", "iv"], toDv: ["c", "dv"] },
    visibleLinks, edges, nodes, groupId: "c", ivId: "iv", dvId: "dv",
    showConfoundersOnly: true, confounderGroupIds: new Set(["c"]),
    studyDesignEdgeId: "study",
  });
  assert.deepEqual(model.laneSegments.map(item => item.role), ["iv", "dv"]);
  assert.equal(model.laneSegments[0].arrows.to.enabled, true);
  assert.equal(model.laneSegments[0].arrows.from.enabled, false);
  assert.equal(model.edgeUpdates.find(item => item.id === "to_iv").color.opacity, 0);
  assert.equal(model.edgeUpdates.find(item => item.id === "other").color.opacity, 0.07);
  assert.equal(model.nodeUpdates.find(item => item.id === "x").opacity, 0.16);
  assert.equal(model.nodeUpdates.find(item => item.id === "c").borderWidth, 5);
  assert.deepEqual({ visibleLinks, edges, nodes }, before);
});

test("polyline helpers separate overlapping runs and place clear arrowheads", () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.equal(highlights.polylineLength(points), 100);
  assert.deepEqual(highlights.pointAlongPolyline(points, 0.25).point, { x: 25, y: 0 });
  const separated = highlights.separateHighlightRuns(points, [[{ x: 0, y: 0 }, { x: 100, y: 0 }]], 1, 1);
  assert.ok(separated.some(point => point.y === 15));
  const marker = highlights.highlightedArrowMarker(points, false, [
    { x: 88, y: -10, w: 20, h: 20 },
  ], 1);
  assert.ok(marker.point.x < 76);
});

test("arrow marker relaxes its node halo for tightly spaced highlighted links", () => {
  const marker = highlights.highlightedArrowMarker(
    [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    false,
    [
      { x: -10, y: -10, w: 52, h: 20 },
      { x: 58, y: -10, w: 52, h: 20 },
    ],
    1,
  );

  assert.ok(marker);
  assert.ok(marker.point.x > 42 && marker.point.x < 58);
});

test("lane renderer produces separated strokes and arrow canvas commands", () => {
  const { context, commands } = recorder();
  const rendered = highlights.drawPathLanes(context, {
    segments: [{ logicalEdgeId: "edge", from: "c", to: "iv", role: "iv", color: "red",
      arrows: { to: { enabled: true } } }],
    positions: { c: { x: 0, y: 0 }, iv: { x: 100, y: 0 }, dv: { x: 100, y: 80 } },
    boxes: [{ x: 90, y: -10, w: 20, h: 20 }], scale: 1, ivId: "iv", dvId: "dv",
  });
  assert.equal(rendered.length, 1);
  assert.equal(commands.filter(command => command[0] === "stroke").length, 2);
  assert.ok(commands.some(command => command[0] === "fill"));
});
