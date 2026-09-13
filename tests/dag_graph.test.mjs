import assert from "node:assert/strict";
import test from "node:test";

import {
  connectedComponentGraph,
  createGraph,
  filterGraphByColliders,
  filterGraphByConfounders,
  filterGraphByLinkPairs,
  filterGraphLinks,
  filterGraphNodes,
  highlightedBidirectionalArrowDirections,
} from "../site/dag_graph.mjs";
import { pairKey } from "../site/edge_keys.mjs";

function link(groupA, groupB, direction = "A_TO_B", extra = {}) {
  return { group_a: groupA, group_b: groupB, direction_type: direction, ...extra };
}

test("node and link filters return new graphs without mutating their input", () => {
  const source = createGraph(["a", "b", "c"], [link("a", "b"), link("b", "c")]);
  const nodes = filterGraphNodes(source, new Set(["a", "b"]));
  const links = filterGraphLinks(source, (edge) => edge.group_b === "c");
  const pairs = filterGraphByLinkPairs(source, new Set([pairKey("a", "b")]));

  assert.deepEqual([...nodes.nodeIds], ["a", "b"]);
  assert.deepEqual(nodes.links, [source.links[0]]);
  assert.deepEqual(links.links, [source.links[1]]);
  assert.deepEqual(pairs.links, [source.links[0]]);
  assert.deepEqual([...source.nodeIds], ["a", "b", "c"]);
  assert.equal(source.links.length, 2);
  assert.notEqual(nodes, source);
});

test("unordered pair keys are order-independent and collision-free", () => {
  assert.equal(pairKey("a", "b"), pairKey("b", "a"));
  assert.notEqual(pairKey("a__b", "c"), pairKey("a", "b__c"));
  assert.notEqual(pairKey('a","b', "c"), pairKey("a", 'b","c'));
});

test("connected-component filtering treats links as undirected connectivity", () => {
  const graph = createGraph(
    ["a", "b", "c", "isolated"],
    [link("a", "b", "B_TO_A"), link("b", "c", "A_TO_B")],
  );
  const component = connectedComponentGraph(graph, "a");

  assert.deepEqual([...component.nodeIds], ["a", "b", "c"]);
  assert.equal(component.links.length, 2);
  assert.deepEqual([...connectedComponentGraph(graph, "missing").nodeIds], []);
});

test("highlighted bidirectional segments show only causally relevant arrowheads", () => {
  assert.deepEqual(
    highlightedBidirectionalArrowDirections("candidate", "middle", new Set(["middle"])),
    { from: false, to: true },
  );
  assert.deepEqual(
    highlightedBidirectionalArrowDirections("candidate", "middle", new Set(["candidate"])),
    { from: true, to: false },
  );
  assert.deepEqual(
    highlightedBidirectionalArrowDirections("candidate", "middle", new Set(["candidate", "middle"])),
    { from: true, to: true },
  );
  assert.deepEqual(
    highlightedBidirectionalArrowDirections("__route__edge__0", "middle", new Set(["middle"])),
    { from: false, to: true },
  );
  assert.deepEqual(
    highlightedBidirectionalArrowDirections("candidate", "__route__edge__0", new Set(["candidate"])),
    { from: true, to: false },
  );
});

test("direct common causes qualify at maximum path one", () => {
  const graph = createGraph(
    ["candidate", "iv", "dv", "other"],
    [link("candidate", "iv"), link("candidate", "dv"), link("other", "iv")],
  );
  const result = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 1 });

  assert.deepEqual([...result.metadata.confounderIds], ["candidate"]);
  assert.deepEqual([...result.nodeIds], ["candidate", "iv", "dv"]);
  assert.deepEqual(result.metadata.pathsByGroup.get("candidate"), {
    toIv: ["candidate", "iv"],
    toDv: ["candidate", "dv"],
  });
});

test("a route to one anchor through the other anchor does not qualify", () => {
  const graph = createGraph(
    ["candidate", "iv", "dv"],
    [link("candidate", "iv"), link("iv", "dv")],
  );
  const result = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 2 });

  assert.deepEqual([...result.metadata.confounderIds], []);
  assert.deepEqual([...result.nodeIds], ["iv", "dv"]);
});

test("bidirectional links retain pessimistic traversal in either direction", () => {
  const graph = createGraph(
    ["candidate", "middle", "iv", "dv"],
    [
      link("middle", "candidate", "BIDIRECTIONAL"),
      link("middle", "iv"),
      link("middle", "dv"),
    ],
  );
  const result = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 2 });

  assert(result.metadata.confounderIds.has("candidate"));
  assert.deepEqual(result.metadata.pathsByGroup.get("candidate"), {
    toIv: ["candidate", "middle", "iv"],
    toDv: ["candidate", "middle", "dv"],
  });
});

test("collider bottleneck exclusion retains only candidates with disjoint witness paths", () => {
  const graph = createGraph(
    ["iv", "dv", "shared", "blocked", "iv-middle", "dv-middle", "disjoint"],
    [
      link("iv", "shared"),
      link("dv", "shared"),
      link("shared", "blocked"),
      link("iv", "iv-middle"),
      link("iv-middle", "disjoint"),
      link("dv", "dv-middle"),
      link("dv-middle", "disjoint"),
    ],
  );
  const result = filterGraphByColliders(graph, {
    ivId: "iv",
    dvId: "dv",
    maxPathLength: 2,
    excludeBottlenecked: true,
  });

  assert(result.metadata.bottleneckedIds.has("blocked"));
  assert(!result.metadata.colliderIds.has("blocked"));
  assert(result.metadata.colliderIds.has("disjoint"));
  assert.deepEqual(result.metadata.pathsByGroup.get("disjoint"), {
    fromIv: ["iv", "iv-middle", "disjoint"],
    fromDv: ["dv", "dv-middle", "disjoint"],
  });
});

test("collider filtering returns anchor-to-candidate witnesses and their path links", () => {
  const graph = createGraph(
    ["iv", "dv", "iv_side", "dv_side", "collider", "unrelated"],
    [
      { group_a: "iv", group_b: "iv_side", direction_type: "A_TO_B" },
      { group_a: "collider", group_b: "iv_side", direction_type: "B_TO_A" },
      { group_a: "dv", group_b: "dv_side", direction_type: "A_TO_B" },
      { group_a: "dv_side", group_b: "collider", direction_type: "A_TO_B" },
      { group_a: "unrelated", group_b: "collider", direction_type: "A_TO_B" },
    ],
  );
  const result = filterGraphByColliders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 2 });

  assert.deepEqual([...result.metadata.colliderIds], ["collider"]);
  assert.deepEqual(result.metadata.pathsByGroup.get("collider"), {
    fromIv: ["iv", "iv_side", "collider"],
    fromDv: ["dv", "dv_side", "collider"],
  });
  assert.deepEqual([...result.nodeIds], ["iv", "dv", "iv_side", "dv_side", "collider"]);
  assert.equal(result.metadata.linkPairKeys.size, 4);
});

test("bidirectional links retain pessimistic traversal for collider candidates", () => {
  const graph = createGraph(
    ["iv", "dv", "collider"],
    [
      { group_a: "collider", group_b: "iv", direction_type: "BIDIRECTIONAL" },
      { group_a: "dv", group_b: "collider", direction_type: "A_TO_B" },
    ],
  );
  const result = filterGraphByColliders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 1 });

  assert(result.metadata.colliderIds.has("collider"));
});

test("bottleneck exclusion removes a candidate only when no disjoint witness pair exists", () => {
  const graph = createGraph(
    ["bottlenecked", "shared", "disjoint", "ivSide", "dvSide", "iv", "dv"],
    [
      link("bottlenecked", "shared"),
      link("shared", "iv"),
      link("shared", "dv"),
      link("disjoint", "ivSide"),
      link("ivSide", "iv"),
      link("disjoint", "dvSide"),
      link("dvSide", "dv"),
    ],
  );
  const result = filterGraphByConfounders(graph, {
    ivId: "iv",
    dvId: "dv",
    maxPathLength: 2,
    excludeBottlenecked: true,
  });

  assert(result.metadata.bottleneckedIds.has("bottlenecked"));
  assert(!result.metadata.confounderIds.has("bottlenecked"));
  assert(result.metadata.confounderIds.has("disjoint"));
  assert.deepEqual(result.metadata.pathsByGroup.get("disjoint"), {
    toIv: ["disjoint", "ivSide", "iv"],
    toDv: ["disjoint", "dvSide", "dv"],
  });
});

test("traversableLink controls the topology used for graph calculations", () => {
  const graph = createGraph(
    ["candidate", "iv", "dv"],
    [link("candidate", "iv"), link("candidate", "dv", "A_TO_B", { hidden: true })],
  );
  const result = filterGraphByConfounders(graph, {
    ivId: "iv",
    dvId: "dv",
    maxPathLength: 1,
    traversableLink: (edge) => !edge.hidden,
  });

  assert.deepEqual([...result.metadata.confounderIds], []);
});
