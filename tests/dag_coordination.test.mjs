import test from "node:test";
import assert from "node:assert/strict";
import { attachDagInteractions } from "../site/dag_interactions.mjs";
import { createRenderCoordinator } from "../site/render_coordinator.mjs";
import { applyLogicalEdgeHover, createDagNetworkController, selectionUpdatesForSegments } from "../site/dag_network_controller.mjs";

test("connected edge hover updates routed segments in one batch", () => {
  const calls = [];
  const dataset = { update: records => calls.push(records) };
  applyLogicalEdgeHover([{ id: "a::seg0", width: 1 }, { id: "a::seg1", width: 4 }], dataset);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(record => record.id), ["a::seg0", "a::seg1"]);
  assert.deepEqual(calls[0].map(record => record.width), [3.4, 6.2]);
  assert.ok(calls[0].every(record => record.color.color === "#9a5a0a" && record.shadow.enabled));
  applyLogicalEdgeHover([], dataset);
  assert.equal(calls.length, 1);
});

test("DAG rerenders only reconfigure vis when visual options change", async () => {
  const groups = ["a", "b", "c", "d"].map(group_id => ({ group_id, label: group_id, variable_ids: [] }));
  const state = {
    project: { groups, links: [], iv_group_id: "a", dv_group_id: "d" },
    componentGroupIds: new Set(groups.map(group => group.group_id)),
    variableById: new Map(), dagLayoutMode: "auto", selectedEdgeId: null,
    colliderGroupIds: new Set(), colliderPathGroupIds: new Set(),
    confounderGroupIds: new Set(), confounderPathGroupIds: new Set(), visibleLinks: [],
  };
  const dagNetwork = { clientWidth: 630, clientHeight: 700,
    addEventListener() {}, removeEventListener() {} };
  class DataSet {
    constructor(items) { this.items = new Map(items.map(item => [item.id, item])); this.updateCalls = []; }
    getIds() { return [...this.items.keys()]; }
    update(items) {
      this.updateCalls.push(items);
      for (const item of items) this.items.set(item.id, item);
    }
    remove(ids) { for (const id of ids) this.items.delete(id); }
  }
  const networks = [];
  class Network {
    constructor(element, data, options) {
      this.data = data; this.options = options; this.setOptionsCalls = 0;
      this.boundingBoxCalls = 0; this.handlers = new Map(); networks.push(this);
    }
    on(name, handler) { this.handlers.set(name, handler); }
    off(name) { this.handlers.delete(name); }
    redraw() {} fit() {} moveTo() {}
    getScale() { return 0.5; }
    getViewPosition() { return { x: 0, y: 0 }; }
    setOptions(options) { this.options = options; this.setOptionsCalls++; }
    getBoundingBox(id) {
      this.boundingBoxCalls++;
      const index = groups.findIndex(group => group.group_id === id);
      return { left: index * 400, right: index * 400 + 100, top: 0, bottom: 40 };
    }
  }
  const controller = createDagNetworkController({ state,
    elements: { dagNetwork }, visApi: { DataSet, Network },
    clusterRep: id => id, groupColor: () => "#000", dagGroups: () => groups,
    groupById: id => groups.find(group => group.group_id === id),
    drawMap() {}, setMapMode() {}, renderAll() {}, selectEdge() {},
  });
  controller.renderDag();
  await controller.whenRendered();
  const firstScale = controller.minimumDagScale();
  controller.minimumDagScale();
  networks[0].handlers.get("zoom")();
  assert.equal(networks[0].boundingBoxCalls, networks[0].data.nodes.getIds().length);
  controller.renderDag();
  await controller.whenRendered();
  controller.minimumDagScale();
  assert.equal(networks[0].boundingBoxCalls, networks[0].data.nodes.getIds().length * 2);
  assert.equal(networks[0].data.nodes.updateCalls.length, 0);
  assert.equal(networks.length, 1);
  assert.equal(networks[0].setOptionsCalls, 0);
  dagNetwork.clientWidth = 1200;
  controller.renderDag();
  await controller.whenRendered();
  assert.equal(networks[0].setOptionsCalls, 1);
  assert.equal(networks[0].options.nodes.widthConstraint.maximum, 185);
  assert.equal(networks[0].data.nodes.updateCalls.length, 1);
  assert.ok(controller.minimumDagScale() > firstScale);
});

test("edge selection updates only the old and new routed links", () => {
  const segments = new Map([
    ["a::seg0", "a"], ["a::seg1", "a"], ["b::seg0", "b"], ["c::seg0", "c"],
  ]);
  const links = ["a", "b", "c"].map(edge_id => ({ edge_id }));
  const updates = selectionUpdatesForSegments(segments, "a", "b", links,
    link => ({ color: link.edge_id === "b" ? "selected" : "normal" }));
  assert.deepEqual(updates, [
    { id: "a::seg0", color: "normal" },
    { id: "a::seg1", color: "normal" },
    { id: "b::seg0", color: "selected" },
  ]);
  assert.deepEqual(selectionUpdatesForSegments(segments, "b", "b", links, () => ({})), []);
  assert.deepEqual(selectionUpdatesForSegments(segments, "b", null, links,
    () => ({ color: "normal" })), [{ id: "b::seg0", color: "normal" }]);
});

test("node hover cannot apply a partial physical-segment highlight", () => {
  const controller = createDagNetworkController({});
  const interaction = controller.visNetworkOptions().interaction;
  assert.equal(interaction.hoverConnectedEdges, false);
  assert.equal(interaction.selectConnectedEdges, false);
});

test("network events use live state and dispose only their own listeners", () => {
  const handlers = new Map(), listeners = new Map(), calls = [];
  const network = { on: (n, h) => handlers.set(n, h), off: (n, h) => { assert.equal(handlers.get(n), h); handlers.delete(n); },
    getScale: () => 0.1, getViewPosition: () => ({ x: 0, y: 0 }), moveTo: p => calls.push(["zoom", p.scale]),
    unselectAll: () => calls.push("unselect") };
  const element = { addEventListener: (n, h) => listeners.set(n, h),
    removeEventListener: (n, h) => { assert.equal(listeners.get(n), h); listeners.delete(n); },
    clientWidth: 200, clientHeight: 120 };
  let diagnostic = false;
  const detach = attachDagInteractions(network, element, {
    minimumScale: () => 0.5, contentBounds: () => ({ left: -100, right: 100, top: -50, bottom: 50 }),
    drawPathLanes: () => calls.push("draw"),
    highlightEdge: id => calls.push(["hover", id]), clearEdgeHover: id => calls.push(["clearEdge", id]),
    highlightNodeEdges: id => calls.push(["nodeEdges", id]),
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
  handlers.get("blurEdge")({ edge: "old-segment" });
  handlers.get("hoverNode")({ node: "g" });
  diagnostic = true;
  handlers.get("hoverNode")({ node: "g" });
  listeners.get("mouseleave")();
  assert.deepEqual(calls, [["zoom", 0.5], ["focus", "g"], "unselect", ["open", "g"],
    ["zoomAt", { x: 42, y: -7 }], ["edge", "logical"], "unselect", ["clearEdge", "old-segment"],
    "clearPath", ["nodeEdges", "g"], ["clearEdge", undefined], ["paths", "g"],
    "clearPath", ["clearEdge", undefined]]);
  detach();
  assert.equal(handlers.size, 0);
  assert.equal(listeners.size, 0);
});

test("touch taps hold diagnostic paths and require a second tap for the definition", () => {
  const handlers = new Map(), listeners = new Map(), calls = [];
  const network = {
    on: (name, handler) => handlers.set(name, handler),
    off: name => handlers.delete(name),
    getNodeAt: point => point.x === 12 ? "candidate" : undefined,
    unselectAll: () => calls.push("unselect"),
  };
  const element = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
  };
  const detach = attachDagInteractions(network, element, {
    isDiagnosticCandidate: id => id === "candidate",
    hasGroup: id => ["candidate", "other"].includes(id),
    clearPathHover: () => calls.push("clearPath"),
    clearEdgeHover: () => calls.push("clearEdge"),
    highlightPaths: id => calls.push(["paths", id]),
    highlightNodeEdges: id => calls.push(["nodeEdges", id]),
    focusGroup: id => calls.push(["definition", id]),
    openGroup: id => calls.push(["open", id]),
    logicalEdgeId: id => id,
  });
  listeners.get("touchstart")();
  handlers.get("selectNode")({ nodes: ["candidate"] });
  assert.equal(calls.some(call => call[0] === "definition"), false);
  assert.deepEqual(calls.slice(-3), ["clearEdge", ["paths", "candidate"], "unselect"]);
  handlers.get("blurNode")();
  assert.notEqual(calls.at(-1), "clearPath");
  handlers.get("doubleClick")({ nodes: [], edges: [], pointer: {
    DOM: { x: 12, y: 8 }, canvas: { x: 40, y: 20 },
  } });
  assert.deepEqual(calls.slice(-2), ["clearPath", ["definition", "candidate"]]);
  assert.equal(calls.some(call => call[0] === "zoomAt"), false);
  handlers.get("selectNode")({ nodes: ["candidate"], event: { srcEvent: { pointerType: "touch" } } });
  handlers.get("click")({ nodes: [], edges: [] });
  assert.deepEqual(calls.slice(-2), ["unselect", "clearPath"]);
  handlers.get("selectNode")({ nodes: ["candidate"], event: { srcEvent: { pointerType: "mouse" } } });
  assert.deepEqual(calls.slice(-2), [["definition", "candidate"], "unselect"]);
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
  coordinator.renderAll({ reuseDagGeometry: true });
  assert.deepEqual(calls.find(c => c[0] === "renderDag"), ["renderDag", { reuseGeometry: true }]);
  calls.length = 0;
  coordinator.selectEdge();
  assert.deepEqual(calls.map(c => c[0]), ["refreshDagEdgeSelection", "renderSelectedEdge"]);
  assert.deepEqual(calls[0], ["refreshDagEdgeSelection", { redraw: true }]);
  calls.length = 0;
  coordinator.selectEdge({ redraw: false });
  assert.deepEqual(calls[0], ["refreshDagEdgeSelection", { redraw: false }]);
});
