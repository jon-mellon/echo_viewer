import assert from "node:assert/strict";
import test from "node:test";

import { browserV2ManifestLayout, browserV2ShardPath, manifestFileEntries,
  validateBrowserV2EvidenceBinding } from "../site/dag_manifest.mjs";

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
  assert.equal(browserV2ManifestLayout(manifest).lookup_key, "variable_index");
  const byId = { ...manifest, lookup: { ...manifest.lookup, key: "variable_id" } };
  assert.equal(browserV2ManifestLayout(byId).lookup_key, "variable_id");
  assert.throws(() => browserV2ManifestLayout({ ...manifest, lookup: { ...manifest.lookup, key: "paper_id" } }),
    /unsupported lookup/);
  assert.equal(browserV2ShardPath(manifest.shards.variables, 7), "variables/shard-00007.parquet");
  assert.throws(() => browserV2ManifestLayout({ ...manifest, layout_version: "browser-v3" }), /Unsupported/);
  assert.throws(() => browserV2ShardPath("shard.parquet", 1), /pattern/);
});

test("browser layouts bind physical snapshot IDs separately from logical record signatures", () => {
  const physical = "a".repeat(64), signature = "b".repeat(64);
  const input = {
    manifest: { evidence_snapshot: physical },
    manifestUrl: `https://data.example/layouts/browser-v2/${physical}/manifest.json`,
    metadata: { cache_compatibility: { record_signature: signature } },
    expectedRecordSignature: signature,
  };
  assert.equal(validateBrowserV2EvidenceBinding(input), true);
  assert.equal(validateBrowserV2EvidenceBinding({ ...input,
    expectedRecordSignature: physical }), true);
  assert.throws(() => validateBrowserV2EvidenceBinding({ ...input,
    manifest: { evidence_snapshot: "c".repeat(64) } }), /URL snapshot/);
  assert.throws(() => validateBrowserV2EvidenceBinding({ ...input,
    expectedRecordSignature: "d".repeat(64) }), /record signature/);
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

test("publication record signatures resolve independently of the deployment default", async () => {
  const { evidenceManifestUrl } = await import("../site/dag_data_config.mjs");
  const location = new URL("https://echo.epistemicinfra.org/");
  const old = "99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0";
  const fresh = "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";
  assert.ok(evidenceManifestUrl(location, "5887939bf4e5d3619070a522f3ae11eee3f377c584bb8b2b3f77593c2b2248d4").includes(old));
  assert.ok(evidenceManifestUrl(location, "11a8ec4f4868185d15dceae798d7617387eb9216c51a8f5acff4e84282b09acd").includes(fresh));
  assert.ok(evidenceManifestUrl(new URL(`${location}?data_version=${old}`), fresh).includes(old));
});
