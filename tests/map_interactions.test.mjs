import test from "node:test";
import assert from "node:assert/strict";
import {
  appendBrushPoint,
  brushAction,
  contextMenuPosition,
  constrainTransform,
  eventPoint,
  nearestVariable,
  panTransform,
  selectionAfterClick,
  zoomTransform,
} from "../site/map_interactions.mjs";

const identity = (x, y) => ({ x, y });

test("event and brush helpers preserve map interaction semantics", () => {
  assert.deepEqual(eventPoint({ clientX: 15, clientY: 28 }, { left: 5, top: 8 }), { x: 10, y: 20 });
  assert.equal(brushAction({ mode: "draw_add", hasActiveGroup: false, seedSelectionPhase: true }), "add");
  assert.equal(brushAction({ mode: "draw_add", hasActiveGroup: false, seedSelectionPhase: false }), "select_vars");
  assert.equal(brushAction({ mode: "draw_remove", hasActiveGroup: true, seedSelectionPhase: false }), "remove");
  assert.deepEqual(appendBrushPoint([{ x: 0, y: 0 }], { x: 1, y: 1 }), [{ x: 0, y: 0 }]);
  assert.deepEqual(appendBrushPoint([{ x: 0, y: 0 }], { x: 4, y: 0 }), [{ x: 0, y: 0 }, { x: 4, y: 0 }]);
});

test("pan, zoom and nearest-node helpers are pure", () => {
  assert.deepEqual(panTransform({ x: 10, y: 20, tx: 3, ty: 4 }, 18, 25), { tx: 11, ty: 9 });
  assert.deepEqual(
    zoomTransform({ scale: 2, tx: 10, ty: 20 }, 20, 30, 2, { minScale: 1, maxScale: 3 }),
    { scale: 3, tx: 5, ty: 15 },
  );
  const variables = [
    { variable_id: "a", map_x: 10, map_y: 10 },
    { variable_id: "b", map_x: 30, map_y: 10 },
  ];
  assert.equal(nearestVariable(variables, { x: 27, y: 11 }, 5, {}, identity).variable_id, "b");
  assert.equal(nearestVariable(variables, { x: 27, y: 11 }, 2, {}, identity), null);
});

test("map viewport keeps part of the variable extent visible", () => {
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 50 };
  const viewport = { width: 200, height: 120 };
  assert.deepEqual(
    constrainTransform({ scale: 2, tx: 500, ty: -500 }, bounds, viewport),
    { scale: 2, tx: 168, ty: -68 },
  );
  assert.deepEqual(
    constrainTransform({ scale: 2, tx: -500, ty: 500 }, bounds, viewport),
    { scale: 2, tx: -168, ty: 88 },
  );
});

test("map viewport cannot stop at an empty corner of a sparse extent", () => {
  const bounds = {
    minX: 0, maxX: 100, minY: 0, maxY: 100,
    points: [{ x: 0, y: 100 }, { x: 100, y: 0 }],
  };
  const result = constrainTransform(
    { scale: 2, tx: 168, ty: 168 }, bounds, { width: 200, height: 200 },
  );
  const visible = bounds.points.some(point => {
    const x = point.x * result.scale + result.tx;
    const y = point.y * result.scale + result.ty;
    return x >= 32 && x <= 168 && y >= 32 && y <= 168;
  });
  assert.equal(visible, true);
});

test("selection and context-menu placement remain deterministic", () => {
  assert.deepEqual(selectionAfterClick({ variableId: "b", priorId: "a", shiftKey: true }), {
    comparisonVariableIds: ["a", "b"], selectedVariableIds: ["a", "b"],
  });
  assert.deepEqual(selectionAfterClick({ variableId: "b", priorId: "a", shiftKey: false }), {
    comparisonVariableIds: [], selectedVariableIds: ["b"],
  });
  assert.deepEqual(contextMenuPosition({
    clientX: 190, clientY: 90, rect: { left: 10, top: 10, width: 200, height: 100 },
    menuWidth: 120, menuHeight: 80,
  }), { left: 72, top: 12 });
});
