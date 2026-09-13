import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { DAGITTY_GIT_COMMIT, DAGITTY_MODULE_URL } from "./dagitty_dependency.mjs";

const require = createRequire(import.meta.url);
let dagitty;
try {
  dagitty = require(fileURLToPath(DAGITTY_MODULE_URL));
} catch (error) {
  throw new Error(
    "Dagitty test dependency is not built. Run `node tests/ensure_dagitty.mjs` first.",
    { cause: error },
  );
}

export const { GraphAnalyzer, GraphParser } = dagitty;
export { DAGITTY_GIT_COMMIT };

export class DagittyParityUnsupportedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "DagittyParityUnsupportedError";
  }
}

export function graphToDagitty(graph) {
  if (graph.links.some((link) => link.direction_type === "BIDIRECTIONAL")) {
    throw new DagittyParityUnsupportedError(
      "BIDIRECTIONAL viewer links are pessimistic direction ambiguity, not Dagitty bidirected causal edges.",
    );
  }
  const statements = [...graph.nodeIds].map((nodeId) => `${quoteId(nodeId)};`);
  for (const link of graph.links) {
    if (link.direction_type === "A_TO_B") {
      statements.push(`${quoteId(link.group_a)} -> ${quoteId(link.group_b)};`);
    } else if (link.direction_type === "B_TO_A") {
      statements.push(`${quoteId(link.group_b)} -> ${quoteId(link.group_a)};`);
    }
  }
  const parsed = GraphParser.parseGuess(`dag { ${statements.join(" ")} }`);
  if (!GraphAnalyzer.validate(parsed)) {
    throw new DagittyParityUnsupportedError("The viewer topology is cyclic and is not a valid Dagitty DAG.");
  }
  return parsed;
}

export function dagittyBoundedDirectedPaths(graph, startId, targetId, maxPathLength) {
  const parsed = graphToDagitty(graph);
  const start = parsed.getVertex(startId);
  const target = parsed.getVertex(targetId);
  if (!start || !target) return [];
  return GraphAnalyzer.listPaths(parsed, true, 100000, [start], [target])
    .filter((pathGraph) => pathGraph.getNumberOfEdges() <= maxPathLength)
    .map((pathGraph) => orderedPath(pathGraph, startId, targetId));
}

function orderedPath(pathGraph, startId, targetId) {
  const nextById = new Map();
  for (const edge of pathGraph.getEdges()) nextById.set(edge.v1.id, edge.v2.id);
  const result = [startId];
  while (result.at(-1) !== targetId) {
    const nextId = nextById.get(result.at(-1));
    if (!nextId) throw new Error(`Dagitty returned a malformed directed path from ${startId} to ${targetId}.`);
    result.push(nextId);
  }
  return result;
}

function quoteId(value) {
  return JSON.stringify(String(value));
}
