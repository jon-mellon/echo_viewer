import assert from "node:assert/strict";
import test from "node:test";

import { browserV2ManifestLayout, browserV2ShardPath, manifestFileEntries } from "../site/dag_manifest.mjs";

test("manifest relations become quoted SQL identifiers", () => {
  assert.deepEqual(manifestFileEntries({
    build_metadata: { url: "metadata.parquet" },
    select: { url: "reserved-word.parquet" },
  }), [
    { relation: "build_metadata", sqlIdentifier: '"build_metadata"', file: { url: "metadata.parquet" } },
    { relation: "select", sqlIdentifier: '"select"', file: { url: "reserved-word.parquet" } },
  ]);
});

test("browser-v2 manifests expose validated retrieval patterns", () => {
  const snapshot = "a".repeat(64);
  const manifest = { layout_version: "browser-v2", evidence_snapshot: snapshot,
    lookup: { path: "lookup/variable-shards.parquet", key: "variable_index", value: "shard_id" },
    shards: { count: 13, variables: "variables/shard-{shard_id:05d}.parquet",
      causal_links_by_source: "causal-links/by-source/shard-{shard_id:05d}.parquet",
      causal_links_by_target: "causal-links/by-target/shard-{shard_id:05d}.parquet",
      neighbors: "neighbors/shard-{shard_id:05d}.parquet" } };
  assert.equal(browserV2ManifestLayout(manifest).lookup, "lookup/variable-shards.parquet");
  assert.equal(browserV2ShardPath(manifest.shards.variables, 7), "variables/shard-00007.parquet");
  assert.throws(() => browserV2ManifestLayout({ ...manifest, layout_version: "browser-v3" }), /Unsupported/);
  assert.throws(() => browserV2ShardPath("shard.parquet", 1), /pattern/);
});

test("manifest relations reject SQL fragments and malformed file records", () => {
  for (const relation of ["records; DROP VIEW records", 'records" AS SELECT 1--', "two words", "9records"]) {
    assert.throws(
      () => manifestFileEntries({ [relation]: { url: "data.parquet" } }),
      /Invalid evidence relation name/,
    );
  }
  assert.throws(() => manifestFileEntries(null), /files must be an object/);
  assert.throws(() => manifestFileEntries([]), /files must be an object/);
  assert.throws(() => manifestFileEntries({ records: {} }), /nonempty file URL/);
});
