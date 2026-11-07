import assert from "node:assert/strict";
import test from "node:test";
import { access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { SNAPSHOT_SEARCH_CATALOGS } from "../site/variable_search_catalog.mjs";
import { VARIABLE_MAP_BINDINGS } from "../site/variable_map_catalog.mjs";

// The current default snapshot's assets are published to the data host (see scripts/check_snapshot_assets.mjs);
// only older snapshots keep committed bundles, so every committed binding must match its files.
test("every committed search catalog matches its snapshot", async () => {
  for (const [snapshot, path] of Object.entries(SNAPSHOT_SEARCH_CATALOGS)) {
    const file = new URL(`../site${path}`, import.meta.url);
    await access(file);
    const catalog = JSON.parse(gunzipSync(readFileSync(file)));
    assert.equal(catalog.evidence_snapshot, snapshot);
    assert.equal(catalog.records.length, catalog.count);
  }
});

test("every committed variable map bundle matches its registered index", () => {
  for (const [snapshot, binding] of Object.entries(VARIABLE_MAP_BINDINGS)) {
    const root = new URL(`../site${binding.root}`, import.meta.url);
    const indexBytes = readFileSync(new URL("index.json.gz", root));
    assert.equal(indexBytes.length, binding.bytes);
    assert.equal(createHash("sha256").update(indexBytes).digest("hex"), binding.sha256);
    const index = JSON.parse(gunzipSync(indexBytes));
    assert.equal(index.evidence_snapshot, snapshot);
    assert.equal(index.layout_source, binding.layoutSource);
    for (const { sha256, bytes } of Object.values(index.entries)) {
      const file = readFileSync(new URL(`${sha256}.json.gz`, root));
      assert.equal(file.length, bytes);
      assert.equal(createHash("sha256").update(file).digest("hex"), sha256);
    }
  }
});
