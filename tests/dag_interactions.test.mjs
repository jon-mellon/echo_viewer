import test from "node:test";
import assert from "node:assert/strict";
import { constrainViewPosition } from "../site/dag_interactions.mjs";

test("DAG viewport keeps part of the graph visible", () => {
  const bounds = { left: -100, right: 100, top: -50, bottom: 50 };
  const viewport = { width: 200, height: 120 };
  assert.deepEqual(
    constrainViewPosition({ x: 1000, y: -1000 }, 2, bounds, viewport),
    { x: 134, y: -64 },
  );
  assert.deepEqual(
    constrainViewPosition({ x: -1000, y: 1000 }, 2, bounds, viewport),
    { x: -134, y: 64 },
  );
});

test("DAG viewport cannot stop at an empty corner of a sparse extent", () => {
  const bounds = {
    left: -100, right: 100, top: -100, bottom: 100,
    boxes: [
      { left: -110, right: -90, top: 90, bottom: 110 },
      { left: 90, right: 110, top: -110, bottom: -90 },
    ],
  };
  const result = constrainViewPosition(
    { x: -134, y: -134 }, 2, bounds, { width: 200, height: 200 },
  );
  const visible = bounds.boxes.some(box => {
    const x = ((box.left + box.right) / 2 - result.x) * 2 + 100;
    const y = ((box.top + box.bottom) / 2 - result.y) * 2 + 100;
    return x >= 32 && x <= 168 && y >= 32 && y <= 168;
  });
  assert.equal(visible, true);
});
