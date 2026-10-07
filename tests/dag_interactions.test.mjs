import test from "node:test";
import assert from "node:assert/strict";
import { attachDagInteractions, constrainViewPosition } from "../site/dag_interactions.mjs";

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

test("a second touch on a node opens its definition before zoom", () => {
  const handlers = new Map(), listeners = new Map(), calls = [];
  const network = {
    on: (name, handler) => handlers.set(name, handler),
    off: name => handlers.delete(name),
    getNodeAt: point => point.x === 30 ? "candidate" : undefined,
    unselectAll() {},
  };
  const element = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
  const detach = attachDagInteractions(network, element, {
    hasGroup: id => id === "candidate", isDiagnosticCandidate: () => true,
    clearPathHover: () => {}, clearEdgeHover: () => {}, highlightPaths: () => calls.push("paths"),
    focusGroup: () => calls.push("definition"), zoomToPoint: () => calls.push("zoom"),
  });
  const touch = { clientX: 40, clientY: 50 };
  const tap = () => {
    listeners.get("touchstart")({ touches: [touch] });
    let prevented = false;
    listeners.get("touchend")({ changedTouches: [touch], touches: [], preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(tap(), false);
  assert.equal(tap(), true);
  assert.deepEqual(calls, ["definition"]);
  handlers.get("doubleClick")({ nodes: [], edges: [], pointer: { DOM: { x: 30, y: 30 }, canvas: { x: 0, y: 0 } } });
  assert.deepEqual(calls, ["definition"]);
  detach();
  assert.equal(handlers.size, 0);
  assert.equal(listeners.size, 0);
});
