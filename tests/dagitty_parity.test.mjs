import assert from "node:assert/strict";
import test from "node:test";

import {
  createGraph,
  filterGraphByColliders,
  filterGraphByConfounders,
  filterGraphLinks,
  filterGraphNodes,
} from "../site/dag_graph.mjs";
import {
  DAGITTY_GIT_COMMIT,
  DagittyParityUnsupportedError,
  dagittyBoundedDirectedPaths,
  graphToDagitty,
} from "./dagitty_adapter.mjs";

const PINNED_DAGITTY_COMMIT = "7a657776dc8f5e5ba4e323edb028e2c2aaf29327";

function edge(source, target, index = 0) {
  // Exercise both viewer encodings while preserving source -> target.
  return index % 2 === 0
    ? { group_a: source, group_b: target, direction_type: "A_TO_B" }
    : { group_a: target, group_b: source, direction_type: "B_TO_A" };
}

function referenceConfounders(graph, ivId, dvId, maxPathLength, requireDisjoint = false) {
  const withoutDv = filterGraphNodes(
    graph,
    new Set([...graph.nodeIds].filter((nodeId) => nodeId !== dvId)),
  );
  const withoutIv = filterGraphNodes(
    graph,
    new Set([...graph.nodeIds].filter((nodeId) => nodeId !== ivId)),
  );
  const result = new Set();
  for (const nodeId of graph.nodeIds) {
    if (nodeId === ivId || nodeId === dvId) continue;
    const toIv = dagittyBoundedDirectedPaths(withoutDv, nodeId, ivId, maxPathLength);
    const toDv = dagittyBoundedDirectedPaths(withoutIv, nodeId, dvId, maxPathLength);
    if (!toIv.length || !toDv.length) continue;
    if (requireDisjoint && !toIv.some((ivPath) => toDv.some((dvPath) => pathsAreInternallyDisjoint(ivPath, dvPath)))) {
      continue;
    }
    result.add(nodeId);
  }
  return result;
}

function referenceColliders(graph, ivId, dvId, maxPathLength) {
  const withoutDv = filterGraphNodes(
    graph,
    new Set([...graph.nodeIds].filter((nodeId) => nodeId !== dvId)),
  );
  const withoutIv = filterGraphNodes(
    graph,
    new Set([...graph.nodeIds].filter((nodeId) => nodeId !== ivId)),
  );
  const result = new Set();
  for (const nodeId of graph.nodeIds) {
    if (nodeId === ivId || nodeId === dvId) continue;
    const fromIv = dagittyBoundedDirectedPaths(withoutDv, ivId, nodeId, maxPathLength);
    const fromDv = dagittyBoundedDirectedPaths(withoutIv, dvId, nodeId, maxPathLength);
    if (fromIv.length && fromDv.length) result.add(nodeId);
  }
  return result;
}

function pathsAreInternallyDisjoint(left, right) {
  const leftInternal = new Set(left.slice(1, -1));
  return right.slice(1, -1).every((nodeId) => !leftInternal.has(nodeId));
}

function assertSetEqual(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

function representativeDag() {
  const nodeIds = [
    "direct",
    "indirect",
    "iv_side",
    "dv_side",
    "iv",
    "dv",
    "mediator",
    "collider",
    "anchor_only",
    "unrelated",
  ];
  const pairs = [
    ["direct", "iv"],
    ["direct", "dv"],
    ["indirect", "iv_side"],
    ["iv_side", "iv"],
    ["indirect", "dv_side"],
    ["dv_side", "dv"],
    ["iv", "mediator"],
    ["mediator", "dv"],
    ["iv", "collider"],
    ["dv", "collider"],
    ["anchor_only", "iv"],
    ["unrelated", "collider"],
  ];
  return createGraph(nodeIds, pairs.map(([source, target], index) => edge(source, target, index)));
}

test("Dagitty dependency is pinned to the reviewed upstream commit", () => {
  assert.equal(DAGITTY_GIT_COMMIT, PINNED_DAGITTY_COMMIT);
});

test("unrestricted common-ancestor classification matches Dagitty on a valid DAG", () => {
  const graph = representativeDag();
  const maxPathLength = graph.nodeIds.size - 1;
  const ours = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength });
  const dagitty = referenceConfounders(graph, "iv", "dv", maxPathLength);

  assertSetEqual(ours.metadata.confounderIds, dagitty);
  assertSetEqual(ours.metadata.confounderIds, new Set(["direct", "indirect"]));
  assert.equal(graphToDagitty(graph).getNumberOfEdges(), graph.links.length);
});

test("path-length filtered classifications match Dagitty on the same topology", () => {
  const graph = representativeDag();
  const expectedByLength = new Map([
    [1, ["direct"]],
    [2, ["direct", "indirect"]],
    [3, ["direct", "indirect"]],
  ]);
  for (const [maxPathLength, expected] of expectedByLength) {
    const ours = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength });
    const dagitty = referenceConfounders(graph, "iv", "dv", maxPathLength);
    assertSetEqual(ours.metadata.confounderIds, dagitty, `maximum path ${maxPathLength}`);
    assertSetEqual(ours.metadata.confounderIds, new Set(expected), `maximum path ${maxPathLength}`);
    assert.doesNotThrow(() => graphToDagitty(ours));
  }
});

test("direct and indirect collider classifications match Dagitty on a valid DAG", () => {
  const graph = createGraph(
    ["iv", "dv", "direct", "iv_side", "dv_side", "indirect", "iv_only", "dv_only"],
    [
      edge("iv", "direct", 0),
      edge("dv", "direct", 1),
      edge("iv", "iv_side", 2),
      edge("iv_side", "indirect", 3),
      edge("dv", "dv_side", 4),
      edge("dv_side", "indirect", 5),
      edge("iv", "iv_only", 6),
      edge("dv", "dv_only", 7),
    ],
  );
  const expectedByLength = new Map([
    [1, ["direct"]],
    [2, ["direct", "indirect"]],
  ]);

  for (const [maxPathLength, expected] of expectedByLength) {
    const ours = filterGraphByColliders(graph, { ivId: "iv", dvId: "dv", maxPathLength });
    const dagitty = referenceColliders(graph, "iv", "dv", maxPathLength);
    assertSetEqual(ours.metadata.colliderIds, dagitty, `maximum collider path ${maxPathLength}`);
    assertSetEqual(ours.metadata.colliderIds, new Set(expected), `maximum collider path ${maxPathLength}`);
    assert.doesNotThrow(() => graphToDagitty(ours));
  }

  const indirectPaths = filterGraphByColliders(graph, {
    ivId: "iv",
    dvId: "dv",
    maxPathLength: 2,
  }).metadata.pathsByGroup.get("indirect");
  assert.deepEqual(indirectPaths.fromIv, ["iv", "iv_side", "indirect"]);
  assert.deepEqual(indirectPaths.fromDv, ["dv", "dv_side", "indirect"]);
});

test("collider paths through the other anchor do not qualify", () => {
  const graph = createGraph(
    ["iv", "dv", "through_anchor", "valid"],
    [
      edge("iv", "dv", 0),
      edge("dv", "through_anchor", 1),
      edge("iv", "valid", 2),
      edge("dv", "valid", 3),
    ],
  );
  const ours = filterGraphByColliders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 2 });
  const dagitty = referenceColliders(graph, "iv", "dv", 2);

  assertSetEqual(ours.metadata.colliderIds, dagitty);
  assertSetEqual(ours.metadata.colliderIds, new Set(["valid"]));
});

test("collider classifications retain Dagitty parity after node and link filtering", () => {
  const full = createGraph(
    ["iv", "dv", "direct", "iv_side", "dv_side", "indirect", "unrelated"],
    [
      edge("iv", "direct", 0),
      edge("dv", "direct", 1),
      edge("iv", "iv_side", 2),
      edge("iv_side", "indirect", 3),
      edge("dv", "dv_side", 4),
      edge("dv_side", "indirect", 5),
      edge("unrelated", "iv_side", 6),
    ],
  );
  const variants = [
    ["full", full],
    ["node-filtered", filterGraphNodes(full, new Set([...full.nodeIds].filter((id) => id !== "dv_side")))],
    ["link-filtered", filterGraphLinks(full, (link) => !(link.group_a === "direct" || link.group_b === "direct"))],
  ];

  for (const [name, graph] of variants) {
    for (const maxPathLength of [1, 2, 3]) {
      const ours = filterGraphByColliders(graph, { ivId: "iv", dvId: "dv", maxPathLength });
      const dagitty = referenceColliders(graph, "iv", "dv", maxPathLength);
      assertSetEqual(ours.metadata.colliderIds, dagitty, `${name}, maximum collider path ${maxPathLength}`);
      assert.doesNotThrow(() => graphToDagitty(ours));
    }
  }
});

test("node- and link-filtered graph topologies retain Dagitty parity", () => {
  const full = representativeDag();
  const nodeFiltered = filterGraphNodes(
    full,
    new Set([...full.nodeIds].filter((nodeId) => nodeId !== "dv_side")),
  );
  const linkFiltered = filterGraphLinks(
    full,
    (link) => !(link.group_a === "direct" || link.group_b === "direct"),
  );
  for (const [name, graph] of [["node-filtered", nodeFiltered], ["link-filtered", linkFiltered]]) {
    for (const maxPathLength of [1, 2, 3]) {
      const ours = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength });
      const dagitty = referenceConfounders(graph, "iv", "dv", maxPathLength);
      assertSetEqual(ours.metadata.confounderIds, dagitty, `${name}, maximum path ${maxPathLength}`);
      assert.doesNotThrow(() => graphToDagitty(ours));
    }
  }
});

test("bottleneck exclusion matches Dagitty path-pair enumeration on representative DAGs", () => {
  const graph = createGraph(
    ["bottlenecked", "shared", "disjoint", "iv_side", "dv_side", "iv", "dv"],
    [
      edge("bottlenecked", "shared", 0),
      edge("shared", "iv", 1),
      edge("shared", "dv", 2),
      edge("disjoint", "iv_side", 3),
      edge("iv_side", "iv", 4),
      edge("disjoint", "dv_side", 5),
      edge("dv_side", "dv", 6),
    ],
  );
  const ours = filterGraphByConfounders(graph, {
    ivId: "iv",
    dvId: "dv",
    maxPathLength: 2,
    excludeBottlenecked: true,
  });
  const dagitty = referenceConfounders(graph, "iv", "dv", 2, true);

  assertSetEqual(ours.metadata.confounderIds, dagitty);
  assert(ours.metadata.bottleneckedIds.has("bottlenecked"));
  assert(!ours.metadata.confounderIds.has("bottlenecked"));
  assert(ours.metadata.confounderIds.has("disjoint"));
});

test("deterministic generated DAGs match Dagitty before and after topology filters", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const full = generatedDag(seed, 9);
    const retainedNodes = new Set(
      [...full.nodeIds].filter((nodeId, index) => nodeId === "n7" || nodeId === "n8" || (index + seed) % 5 !== 0),
    );
    const variants = [
      ["full", full],
      ["node-filtered", filterGraphNodes(full, retainedNodes)],
      ["link-filtered", filterGraphLinks(full, (_link, index) => (index + seed) % 4 !== 0)],
    ];
    for (const [variantName, graph] of variants) {
      assert.doesNotThrow(() => graphToDagitty(graph), `seed ${seed}, ${variantName}`);
      for (const maxPathLength of [1, 2, 3, graph.nodeIds.size - 1]) {
        const ours = filterGraphByConfounders(graph, {
          ivId: "n7",
          dvId: "n8",
          maxPathLength,
        });
        const dagitty = referenceConfounders(graph, "n7", "n8", maxPathLength);
        assertSetEqual(
          ours.metadata.confounderIds,
          dagitty,
          `seed ${seed}, ${variantName}, maximum path ${maxPathLength}`,
        );
        assert.doesNotThrow(() => graphToDagitty(ours));

        const ourColliders = filterGraphByColliders(graph, {
          ivId: "n7",
          dvId: "n8",
          maxPathLength,
        });
        const dagittyColliders = referenceColliders(graph, "n7", "n8", maxPathLength);
        assertSetEqual(
          ourColliders.metadata.colliderIds,
          dagittyColliders,
          `seed ${seed}, ${variantName}, maximum collider path ${maxPathLength}`,
        );
        assert.doesNotThrow(() => graphToDagitty(ourColliders));
      }
    }
  }
});

test("bidirectional ambiguity keeps viewer behavior and is not misrepresented to Dagitty", () => {
  const graph = createGraph(
    ["candidate", "middle", "iv", "dv"],
    [
      { group_a: "candidate", group_b: "middle", direction_type: "BIDIRECTIONAL" },
      edge("middle", "iv", 0),
      edge("middle", "dv", 1),
    ],
  );
  const ours = filterGraphByConfounders(graph, { ivId: "iv", dvId: "dv", maxPathLength: 2 });

  assert(ours.metadata.confounderIds.has("candidate"));
  assert.throws(() => graphToDagitty(graph), DagittyParityUnsupportedError);
});

test("cyclic directed viewer states are explicitly outside Dagitty parity", () => {
  const graph = createGraph(
    ["a", "b", "c"],
    [edge("a", "b", 0), edge("b", "c", 1), edge("c", "a", 2)],
  );
  assert.throws(
    () => graphToDagitty(graph),
    (error) => error instanceof DagittyParityUnsupportedError && /cyclic/.test(error.message),
  );
});

function generatedDag(seed, nodeCount) {
  const nodeIds = Array.from({ length: nodeCount }, (_, index) => `n${index}`);
  const links = [];
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let source = 0; source < nodeCount; source += 1) {
    for (let target = source + 1; target < nodeCount; target += 1) {
      if (random() < 0.28) links.push(edge(nodeIds[source], nodeIds[target], links.length));
    }
  }
  return createGraph(nodeIds, links);
}
