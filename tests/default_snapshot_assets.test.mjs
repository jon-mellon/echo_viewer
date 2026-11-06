import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PRODUCTION_EVIDENCE_MANIFEST, evidenceSnapshotIdFromManifestUrl } from "../site/dag_data_config.mjs";
import { SNAPSHOT_SEARCH_CATALOGS } from "../site/variable_search_catalog.mjs";
import { VARIABLE_MAP_BINDINGS } from "../site/variable_map_catalog.mjs";
import { createHash } from "node:crypto";
import { buildSite } from "../scripts/build_site.mjs";

const defaultSnapshot = evidenceSnapshotIdFromManifestUrl(PRODUCTION_EVIDENCE_MANIFEST);

test("the default evidence snapshot has a registered, matching search catalog", async () => {
  assert.match(defaultSnapshot, /^[0-9a-f]{64}$/);
  const path = SNAPSHOT_SEARCH_CATALOGS[defaultSnapshot];
  assert.ok(path, `Register ${defaultSnapshot}: node scripts/register_snapshot_assets.mjs ${defaultSnapshot}`);
  const file = new URL(`../site${path}`, import.meta.url);
  await access(file);
  const catalog = JSON.parse(gunzipSync(readFileSync(file)));
  assert.equal(catalog.evidence_snapshot, defaultSnapshot);
  assert.equal(catalog.records.length, catalog.count);
});

test("the default evidence snapshot has variable map bundles that match their registered index", () => {
  const binding = VARIABLE_MAP_BINDINGS[defaultSnapshot];
  assert.ok(binding, `Register ${defaultSnapshot}: node scripts/register_snapshot_assets.mjs ${defaultSnapshot}`);
  const root = new URL(`../site${binding.root}`, import.meta.url);
  const indexBytes = readFileSync(new URL("index.json.gz", root));
  assert.equal(indexBytes.length, binding.bytes);
  assert.equal(createHash("sha256").update(indexBytes).digest("hex"), binding.sha256);
  const index = JSON.parse(gunzipSync(indexBytes));
  assert.equal(index.evidence_snapshot, defaultSnapshot);
  assert.equal(index.layout_source, binding.layoutSource);
  const entries = Object.values(index.entries);
  assert.ok(entries.length > 50);
  for (const { sha256, bytes } of entries) {
    const file = readFileSync(new URL(`${sha256}.json.gz`, root));
    assert.equal(file.length, bytes);
    assert.equal(createHash("sha256").update(file).digest("hex"), sha256);
  }
});

test("building a site whose default snapshot lacks a catalog fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-default-assets-"));
  try {
    const source = join(root, "site");
    await mkdir(source);
    await writeFile(join(source, "dag_data_config.mjs"),
      `export const PRODUCTION_EVIDENCE_MANIFEST =\n  "https://data.epistemicinfra.org/evidence/layouts/browser-v2/${defaultSnapshot}/manifest.json";\n`);
    await writeFile(join(source, "index.html"), "<html></html>");
    await assert.rejects(buildSite(source, join(root, "out")), /no search catalog/);
    await mkdir(join(source, "search-catalogs"));
    await writeFile(join(source, "search-catalogs", `${defaultSnapshot}.json.gz`), "x");
    await buildSite(source, join(root, "out"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
