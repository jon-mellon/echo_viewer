import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const artifactDir = new URL("./artifacts/playwright-2026-08-31/", import.meta.url);
const files = (await readdir(artifactDir))
  .filter((name) => name.endsWith(".json"))
  .filter((name) => !["project-fixture.json", "topology-manifest.json"].includes(name))
  .sort();

const manifest = {
  schema_version: "dag-interface-topology-manifest-v1",
  fixture: "synthetic_acceptance_fixture",
  direction_semantics: {
    A_TO_B: "group_a -> group_b",
    B_TO_A: "group_b -> group_a",
    BIDIRECTIONAL: "pessimistically traversable in either direction",
  },
  topologies: [],
};

for (const name of files) {
  const payload = JSON.parse(await readFile(new URL(name, artifactDir), "utf8"));
  const labels = new Map(payload.groups.map((group) => [group.group_id, group.label]));
  const nodes = payload.groups
    .map((group) => ({ id: group.group_id, label: group.label }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const edges = payload.links
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
  const directionCounts = Object.fromEntries(
    ["A_TO_B", "B_TO_A", "BIDIRECTIONAL"].map((direction) => [
      direction,
      edges.filter((edge) => edge.direction_type === direction).length,
    ]),
  );

  manifest.topologies.push({
    artifact: path.posix.join("artifacts/playwright-2026-08-31", name),
    iv_group_id: payload.iv_group_id,
    iv_label: labels.get(payload.iv_group_id),
    dv_group_id: payload.dv_group_id,
    dv_label: labels.get(payload.dv_group_id),
    node_count: nodes.length,
    edge_count: edges.length,
    direction_counts: directionCounts,
    canonical_sha256: createHash("sha256").update(canonicalText).digest("hex"),
    nodes,
    edges,
  });
}

await writeFile(
  new URL("topology-manifest.json", artifactDir),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
