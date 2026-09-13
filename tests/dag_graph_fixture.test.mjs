import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  connectedComponentGraph,
  confounderPathNodeRole,
  createGraph,
  filterGraphByColliders,
  filterGraphByConfounders,
  filterGraphByLinkPairs,
  filterGraphLinks,
  filterGraphNodes,
} from "../site/dag_graph.mjs";

const artifactDir = new URL("./acceptance/artifacts/playwright-2026-08-31/", import.meta.url);
const project = JSON.parse(await readFile(new URL("project-fixture.json", artifactDir), "utf8"));
const manifest = JSON.parse(await readFile(new URL("topology-manifest.json", artifactDir), "utf8"));
const expectedByFile = new Map(
  manifest.topologies.map((topology) => [topology.artifact.split("/").pop(), topology]),
);

function excludedForConnectivity(link) {
  return link.display_status === "excluded" && !link.is_manual && !link.is_target_relation;
}

function displayedLink(link) {
  if (link.display_status === "hidden") return false;
  return link.display_status !== "excluded" || link.is_manual || link.is_target_relation;
}

function graphForState({
  causal = true,
  confounders = false,
  maxPathLength = 1,
  excludeBottlenecked = false,
  pathLinksOnly = false,
} = {}) {
  const accepted = project.groups.filter((group) => group.status === "accepted");
  const fullGraph = createGraph(accepted.map((group) => group.group_id), project.links);
  const connectivityGraph = filterGraphLinks(fullGraph, (link) => !excludedForConnectivity(link));
  const confounderGraph = filterGraphByConfounders(fullGraph, {
    ivId: project.iv_group_id,
    dvId: project.dv_group_id,
    maxPathLength,
    excludeBottlenecked,
    traversableLink: (link) => !excludedForConnectivity(link) && link.display_status !== "hidden",
  });
  let visibleGraph = confounders
    ? confounderGraph
    : causal
      ? connectedComponentGraph(connectivityGraph, project.iv_group_id)
      : fullGraph;
  visibleGraph = filterGraphNodes(fullGraph, visibleGraph.nodeIds);
  visibleGraph = filterGraphLinks(visibleGraph, displayedLink);
  if (confounders && pathLinksOnly) {
    visibleGraph = filterGraphByLinkPairs(visibleGraph, confounderGraph.metadata.linkPairKeys);
  }
  return { graph: visibleGraph, confounderMetadata: confounderGraph.metadata };
}

function canonicalTopology(graph) {
  const labels = new Map(project.groups.map((group) => [group.group_id, group.label]));
  // Working-map exports include the anchors and link endpoints. They omit an
  // otherwise visible isolated node, so the topology oracle mirrors that
  // export contract rather than the renderer's node set.
  const exportedNodeIds = new Set([
    project.iv_group_id,
    project.dv_group_id,
    ...graph.links.flatMap((link) => [link.group_a, link.group_b]),
  ]);
  const nodes = project.groups
    .filter((group) => graph.nodeIds.has(group.group_id) && exportedNodeIds.has(group.group_id))
    .map((group) => ({ id: group.group_id, label: group.label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const edges = graph.links
    .map((link) => ({
      group_a: link.group_a,
      label_a: labels.get(link.group_a) || link.group_a,
      group_b: link.group_b,
      label_b: labels.get(link.group_b) || link.group_b,
      direction_type: link.direction_type,
    }))
    .sort((a, b) => {
      const left = `${a.label_a}\t${a.direction_type}\t${a.label_b}`;
      const right = `${b.label_a}\t${b.direction_type}\t${b.label_b}`;
      return left.localeCompare(right);
    });
  const canonicalText = [
    ...nodes.map((node) => `${node.id}\t${node.label}`),
    "--EDGES--",
    ...edges.map((edge) => [edge.group_a, edge.direction_type, edge.group_b].join("\t")),
  ].join("\n");
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    hash: createHash("sha256").update(canonicalText).digest("hex"),
  };
}

const checkpoints = [
  ["02-causal-view.json", {}],
  ["03-all-links-view.json", { causal: false }],
  ["05-path-1.json", { confounders: true }],
  ["06-path-2.json", { confounders: true, maxPathLength: 2 }],
  ["07-path-3.json", { confounders: true, maxPathLength: 3 }],
  ["08-path-4-full.json", { confounders: true, maxPathLength: 4 }],
  ["09-path-4-bottleneck.json", { confounders: true, maxPathLength: 4, excludeBottlenecked: true }],
  ["10-path-4-bottleneck-path-links.json", {
    confounders: true,
    maxPathLength: 4,
    excludeBottlenecked: true,
    pathLinksOnly: true,
  }],
  ["10-path-4-path-links.json", { confounders: true, maxPathLength: 4, pathLinksOnly: true }],
  ["13-path-99.json", { confounders: true, maxPathLength: 99 }],
  ["20-path-1-path-links.json", { confounders: true, pathLinksOnly: true }],
];

for (const [filename, options] of checkpoints) {
  test(`pure graph topology matches Playwright baseline ${filename}`, () => {
    const expected = expectedByFile.get(filename);
    assert(expected, `Missing topology manifest entry for ${filename}`);
    const { graph } = graphForState(options);
    const actual = canonicalTopology(graph);
    assert.deepEqual(actual, {
      nodeCount: expected.node_count,
      edgeCount: expected.edge_count,
      hash: expected.canonical_sha256,
    });
  });
}

function labelPath(path) {
  const labels = new Map(project.groups.map((group) => [group.group_id, group.label]));
  return path.map((nodeId) => labels.get(nodeId));
}

function idForLabel(label) {
  return project.groups.find((group) => group.label === label)?.group_id;
}

test("path-two output distinguishes confounders from retained mediators", () => {
  const { confounderMetadata } = graphForState({
    confounders: true,
    maxPathLength: 2,
    excludeBottlenecked: true,
    pathLinksOnly: true,
  });
  const options = { ivId: project.iv_group_id, dvId: project.dv_group_id };
  assert.equal(
    confounderPathNodeRole(confounderMetadata, idForLabel("indirect confounder"), options),
    "confounder",
  );
  assert.equal(
    confounderPathNodeRole(confounderMetadata, idForLabel("IV-path mediator"), options),
    "mediator",
  );
  assert.equal(
    confounderPathNodeRole(confounderMetadata, project.iv_group_id, options),
    "iv",
  );
  assert.equal(
    confounderPathNodeRole(confounderMetadata, project.dv_group_id, options),
    "dv",
  );
});

test("path-two collider output retains the fixture's anchor-to-candidate witnesses", () => {
  const accepted = project.groups.filter((group) => group.status === "accepted");
  const graph = createGraph(accepted.map((group) => group.group_id), project.links);
  const result = filterGraphByColliders(graph, {
    ivId: project.iv_group_id,
    dvId: project.dv_group_id,
    maxPathLength: 2,
    traversableLink: (link) => !excludedForConnectivity(link) && link.display_status !== "hidden",
  });

  assert.equal(result.metadata.colliderIds.size, 1);
  const colliderPaths = result.metadata.pathsByGroup.get(idForLabel("collider"));
  assert.deepEqual(labelPath(colliderPaths.fromIv), [
    "exposure",
    "IV-to-collider mediator",
    "collider",
  ]);
  assert.deepEqual(labelPath(colliderPaths.fromDv), [
    "outcome",
    "DV-to-collider mediator",
    "collider",
  ]);
});

test("path-four hover witnesses retain their current shortest-path choices", () => {
  const { confounderMetadata } = graphForState({ confounders: true, maxPathLength: 4 });
  const paths = confounderMetadata.pathsByGroup.get(idForLabel("long-path confounder"));
  assert.deepEqual(labelPath(paths.toIv), [
    "long-path confounder",
    "long IV mediator A",
    "long IV mediator B",
    "exposure",
  ]);
  assert.deepEqual(labelPath(paths.toDv), [
    "long-path confounder",
    "long DV mediator A",
    "long DV mediator B",
    "outcome",
  ]);
});

test("bottleneck-excluded hover uses the qualifying disjoint witness pair", () => {
  const { confounderMetadata } = graphForState({
    confounders: true,
    maxPathLength: 4,
    excludeBottlenecked: true,
  });
  const paths = confounderMetadata.pathsByGroup.get(idForLabel("indirect confounder"));
  assert.deepEqual(labelPath(paths.toIv), [
    "indirect confounder",
    "IV-path mediator",
    "exposure",
  ]);
  assert.deepEqual(labelPath(paths.toDv), [
    "indirect confounder",
    "DV-path mediator",
    "outcome",
  ]);
  assert.deepEqual(
    paths.toIv.slice(1, -1).filter((nodeId) => paths.toDv.slice(1, -1).includes(nodeId)),
    [],
  );
});
