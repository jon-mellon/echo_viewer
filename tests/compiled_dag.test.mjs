import test from "node:test";
import assert from "node:assert/strict";
import { COMPILED_DAG_PATH, DAG_COMPILER_VERSION, createCompiledArtifacts, dagEquals,
  fullCompileDag, incrementCompiledDag, validateCompiledArtifact } from "../site/compiled_dag.mjs";

const group = (group_id, variable_ids, label = group_id) => ({ group_id, label, variable_ids });
const schema = groups => ({ groups });
const link = (id, source, target, paper = id) => ({ raw_causal_link_id: id,
  source_variable_id: source, target_variable_id: target, paper_id: paper,
  within_table_occurrence_id: id });
const raw = [link("r1", "v1", "v3"), link("r2", "v2", "v3"), link("r3", "v3", "v2"),
  link("r4", "v2", "v4"), link("r5", "v4", "v1"), link("r6", "v2", "v2")];
const base = schema([group("a", ["v1", "v2"], "A"), group("b", ["v3"], "B"), group("c", ["v4"], "C")]);

function counts(dag) {
  return Object.fromEntries(dag.edges.map(edge => [edge.edge_id, edge.causal_link_occurrence_count]));
}

function incremental(next, incident = raw) {
  const compiled = fullCompileDag({ schema: base, rawLinks: raw });
  return incrementCompiledDag({ compiledDag: compiled, oldSchema: base, newSchema: next, incidentRawLinks: incident });
}

test("unchanged compiled schema exactly matches full aggregation", () => {
  const compiled = fullCompileDag({ schema: base, rawLinks: raw });
  assert.ok(dagEquals(compiled, fullCompileDag({ schema: base, rawLinks: raw })));
  assert.deepEqual(counts(incremental(base, [])), counts(compiled));
});

test("one moved variable and edge-to-zero match full counts", () => {
  const next = schema([group("a", ["v1"]), group("b", ["v3", "v2"]), group("c", ["v4"])]);
  assert.deepEqual(counts(incremental(next)), counts(fullCompileDag({ schema: next, rawLinks: raw })));
});

test("multiple connected moved variables are deduplicated", () => {
  const next = schema([group("a", ["v1"]), group("b", ["v2"]), group("c", ["v3", "v4"])]);
  assert.deepEqual(counts(incremental(next, [...raw, raw[2], raw[2]])), counts(fullCompileDag({ schema: next, rawLinks: raw })));
});

test("reject and restore match full aggregation", () => {
  const rejected = schema([group("a", ["v1"]), group("b", ["v3"]), group("c", ["v4"])]);
  assert.deepEqual(counts(incremental(rejected)), counts(fullCompileDag({ schema: rejected, rawLinks: raw })));
  const rejectedDag = fullCompileDag({ schema: rejected, rawLinks: raw });
  const restored = incrementCompiledDag({ compiledDag: rejectedDag, oldSchema: rejected,
    newSchema: base, incidentRawLinks: raw });
  assert.deepEqual(counts(restored), counts(fullCompileDag({ schema: base, rawLinks: raw })));
});

test("create/delete, merge/split, and raw self-loops match full counts", () => {
  const created = schema([...base.groups, group("d", [])]);
  assert.deepEqual(counts(incremental(created, [])), counts(fullCompileDag({ schema: created, rawLinks: raw })));
  const merged = schema([group("a", ["v1", "v2", "v4"]), group("b", ["v3"])]);
  assert.deepEqual(counts(incremental(merged)), counts(fullCompileDag({ schema: merged, rawLinks: raw })));
  assert.equal(fullCompileDag({ schema: base, rawLinks: raw }).edges.flatMap(e => e.a_to_b_raw_link_ids.concat(e.b_to_a_raw_link_ids)).includes("r6"), false);
});

test("rename updates nodes without evidence", () => {
  const renamed = schema([group("a", ["v1", "v2"], "Renamed"), ...base.groups.slice(1)]);
  assert.equal(incremental(renamed, []).nodes[0].label, "Renamed");
});

test("compiled binding rejects snapshot and compiler mismatches", async () => {
  const dag = fullCompileDag({ schema: base, rawLinks: raw });
  const publication = { id: "pub", content_hash: "schema", evidence_snapshot: "snapshot" };
  const artifacts = await createCompiledArtifacts({ publicationId: "pub", schemaHash: "schema",
    evidenceSnapshot: "snapshot", dag });
  assert.equal(artifacts.manifest.artifacts.dag.path, COMPILED_DAG_PATH);
  await validateCompiledArtifact({ publication, manifest: artifacts.manifest, dag: artifacts.dag });
  await assert.rejects(validateCompiledArtifact({ publication: { ...publication, evidence_snapshot: "other" },
    manifest: artifacts.manifest, dag: artifacts.dag }), /evidence_snapshot mismatch/);
  await assert.rejects(validateCompiledArtifact({ publication, manifest: { ...artifacts.manifest,
    compiler_version: `${DAG_COMPILER_VERSION}-wrong` }, dag: artifacts.dag }), /compiler_version mismatch/);
});
