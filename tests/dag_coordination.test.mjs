import test from "node:test";
import assert from "node:assert/strict";
import { attachDagInteractions } from "../site/dag_interactions.mjs";
import { createRenderCoordinator } from "../site/render_coordinator.mjs";
import { createDagNetworkController, selectionUpdatesForSegments } from "../site/dag_network_controller.mjs";

test("DAG rerenders only reconfigure vis when visual options change", async () => {
  const groups = ["a", "b", "c", "d"].map(group_id => ({ group_id, label: group_id, variable_ids: [] }));
  const state = {
    project: { groups, links: [], iv_group_id: "a", dv_group_id: "d" },
    componentGroupIds: new Set(groups.map(group => group.group_id)),
    variableById: new Map(), dagLayoutMode: "hierarchical", selectedEdgeId: null,
    colliderGroupIds: new Set(), colliderPathGroupIds: new Set(),
    confounderGroupIds: new Set(), confounderPathGroupIds: new Set(), visibleLinks: [],
  };
  const dagNetwork = { clientWidth: 630, clientHeight: 700,
    addEventListener() {}, removeEventListener() {} };
  class DataSet {
    constructor(items) { this.items = new Map(items.map(item => [item.id, item])); }
    getIds() { return [...this.items.keys()]; }
    update(items) { for (const item of items) this.items.set(item.id, item); }
    remove(ids) { for (const id of ids) this.items.delete(id); }
  }
  const networks = [];
  class Network {
    constructor(element, data, options) { this.options = options; this.setOptionsCalls = 0; networks.push(this); }
    on() {} off() {} redraw() {} fit() {}
    setOptions(options) { this.options = options; this.setOptionsCalls++; }
  }
  const controller = createDagNetworkController({ state,
    elements: { dagNetwork, dagLayoutSelect: { value: "" } }, visApi: { DataSet, Network },
    clusterRep: id => id, groupColor: () => "#000", dagGroups: () => groups,
    groupById: id => groups.find(group => group.group_id === id),
    drawMap() {}, setMapMode() {}, renderAll() {}, selectEdge() {},
  });
  controller.renderDag();
  await controller.whenRendered();
  controller.renderDag();
  await controller.whenRendered();
  assert.equal(networks.length, 1);
  assert.equal(networks[0].setOptionsCalls, 0);
  dagNetwork.clientWidth = 1200;
  controller.renderDag();
  await controller.whenRendered();
  assert.equal(networks[0].setOptionsCalls, 1);
  assert.equal(networks[0].options.nodes.widthConstraint.maximum, 185);
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
    ["zoomAt", { x: 42, y: -7 }], ["edge", "logical"], ["clearEdge", "old-segment"],
    "clearPath", ["nodeEdges", "g"], ["clearEdge", undefined], ["paths", "g"],
    "clearPath", ["clearEdge", undefined]]);
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
});
