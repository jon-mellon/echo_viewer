import test from "node:test";
import assert from "node:assert/strict";
import { attachDagInteractions } from "../site/dag_interactions.mjs";
import { createRenderCoordinator } from "../site/render_coordinator.mjs";

test("network events use live state and dispose only their own listeners", () => {
  const handlers = new Map(), listeners = new Map(), calls = [];
  const network = { on: (n, h) => handlers.set(n, h), off: (n, h) => { assert.equal(handlers.get(n), h); handlers.delete(n); },
    getScale: () => 0.1, getViewPosition: () => ({ x: 0, y: 0 }), moveTo: p => calls.push(["zoom", p.scale]) };
  const element = { addEventListener: (n, h) => listeners.set(n, h),
    removeEventListener: (n, h) => { assert.equal(listeners.get(n), h); listeners.delete(n); },
    clientWidth: 200, clientHeight: 120 };
  let diagnostic = false;
  const detach = attachDagInteractions(network, element, {
    minimumScale: () => 0.5, contentBounds: () => ({ left: -100, right: 100, top: -50, bottom: 50 }),
    drawPathLanes: () => calls.push("draw"),
    highlightEdge: id => calls.push(["hover", id]), clearEdgeHover: () => calls.push("clearEdge"),
    clearPathHover: () => calls.push("clearPath"), highlightPaths: id => calls.push(["paths", id]),
    isDiagnosticCandidate: () => diagnostic, hasGroup: id => id === "g",
    logicalEdgeId: id => id === "segment" ? "logical" : id,
    focusGroup: id => calls.push(["focus", id]), openGroup: id => calls.push(["open", id]),
    zoomToPoint: position => calls.push(["zoomAt", position]),
    selectEdge: id => calls.push(["edge", id]),
  });
  handlers.get("zoom")();
  handlers.get("selectNode")({ nodes: ["bend"] });
  handlers.get("selectNode")({ nodes: ["g"] });
  handlers.get("doubleClick")({ nodes: ["g"] });
  handlers.get("doubleClick")({ nodes: [], edges: [], pointer: { canvas: { x: 42, y: -7 } } });
  handlers.get("doubleClick")({ nodes: [], edges: ["segment"], pointer: { canvas: { x: 1, y: 2 } } });
  handlers.get("selectEdge")({ edges: ["segment"] });
  handlers.get("hoverNode")({ node: "g" });
  diagnostic = true;
  handlers.get("hoverNode")({ node: "g" });
  listeners.get("mouseleave")();
  assert.deepEqual(calls, [["zoom", 0.5], ["focus", "g"], ["open", "g"],
    ["zoomAt", { x: 42, y: -7 }], ["edge", "logical"],
    "clearPath", ["paths", "g"], "clearEdge", "clearPath"]);
  detach();
  assert.equal(handlers.size, 0);
  assert.equal(listeners.size, 0);
});

test("render coordination preserves rebuild order, comparison precedence and final autosave", () => {
  const calls = [];
  let comparing = false;
  const view = new Proxy({}, { get: (_, name) => (...args) => {
    calls.push([name, ...args]);
    return name === "renderVariableComparison" ? comparing : undefined;
  } });
  const coordinator = createRenderCoordinator(view);
  coordinator.rebuildProject();
  assert.deepEqual(calls.slice(0, 3).map(c => c[0]), ["buildCandidateQueue", "aggregateGroupLinks", "computeVisibleLinks"]);
  assert.equal(calls.at(-1)[0], "saveProjectLocally");
  assert.ok(calls.some(c => c[0] === "renderSelectedEdge"));
  calls.length = 0; comparing = true;
  coordinator.renderAll();
  assert.deepEqual(calls.filter(c => c[0] === "renderSearch"), [["renderSearch", "iv"], ["renderSearch", "dv"]]);
  assert.equal(calls.some(c => c[0] === "renderSelectedEdge"), false);
  assert.equal(calls.at(-1)[0], "saveProjectLocally");
  calls.length = 0;
  coordinator.selectEdge();
  assert.deepEqual(calls.map(c => c[0]), ["refreshDagEdgeSelection", "renderSelectedEdge"]);
});
