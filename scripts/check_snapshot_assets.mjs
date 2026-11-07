#!/usr/bin/env node
// Fails when the default evidence snapshot has no precomputed viewer assets anywhere the viewer can find them.
//
// Without them the viewer queries the snapshot in the browser (DuckDB WebAssembly, tens of MB), which on a phone takes
// minutes: a snapshot promoted to the default without them once made opening a saved variable never finish. They are
// published by the data pipeline (harvest_abstracts, analysis/10k/echo_viewer_bundle) as
// layouts/browser-v2/<snapshot>/viewer-assets/. Until a snapshot's assets are published there, committed bundles under
// site/ are accepted with a warning; once they are, the committed ones can be deleted and this becomes the only gate.
//   node scripts/check_snapshot_assets.mjs [snapshot id]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PRODUCTION_EVIDENCE_MANIFEST, evidenceSnapshotIdFromManifestUrl } from "../site/dag_data_config.mjs";
import { fetchViewerAssets } from "../site/viewer_assets.mjs";
import { VARIABLE_MAP_BINDINGS } from "../site/variable_map_catalog.mjs";
import { SNAPSHOT_SEARCH_CATALOGS } from "../site/variable_search_catalog.mjs";

const snapshot = process.argv[2] || evidenceSnapshotIdFromManifestUrl(PRODUCTION_EVIDENCE_MANIFEST);
// ECHO_EVIDENCE_LAYOUTS_BASE points the check at another host (the tests use a local one).
const base = process.env.ECHO_EVIDENCE_LAYOUTS_BASE || PRODUCTION_EVIDENCE_MANIFEST.replace(/[0-9a-f]{64}\/manifest\.json$/, "");
const manifestUrl = `${base}${snapshot}/manifest.json`;
// The data host's CDN refuses some default client identifiers.
const get = (url, options) => fetch(url, { ...options, headers: { "User-Agent": "echo-viewer-ci/1" } });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const problems = [];

async function checked(url, entry, label) {
  const response = await get(url);
  if (!response.ok) { problems.push(`${label}: HTTP ${response.status}`); return null; }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) { problems.push(`${label}: size or hash differs from the manifest`); return null; }
  return bytes;
}

async function allWithLimit(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => { while (next < items.length) await work(items[next++]); }));
}

const { gunzipSync } = await import("node:zlib");
const found = await fetchViewerAssets(manifestUrl, snapshot, { fetchImpl: (url, options) => get(url, options) });
if (found) {
  const { assets } = found;
  for (const required of ["searchCatalog", "variableMaps"]) if (!assets[required]) problems.push(`published assets lack ${required}`);
  if (assets.searchCatalog) {
    // Size and hash come from the manifest; the catalog is the one asset fetched whole.
    const manifest = await (await get(found.url)).json();
    await checked(assets.searchCatalog, manifest.assets.search_catalog, "search catalog");
  }
  for (const [name, asset] of Object.entries(assets)) {
    if (name === "searchCatalog") continue;
    const index = await checked(`${asset.root}index.json.gz`, asset, `${name} index`);
    if (!index) continue;
    const entries = Object.entries(JSON.parse(gunzipSync(index)).entries);
    await allWithLimit(entries, 12, async ([key, entry]) => {
      const response = await get(`${asset.root}${entry.sha256}.json.gz`, { method: "HEAD" });
      const length = Number(response.headers.get("content-length"));
      if (!response.ok) problems.push(`${name} ${key.slice(0, 12)}: HTTP ${response.status}`);
      else if (length && length !== entry.bytes) problems.push(`${name} ${key.slice(0, 12)}: size differs from the index`);
    });
    console.log(`${name}: ${entries.length} files checked`);
  }
  if (problems.length) {
    console.error(`Published viewer assets for ${snapshot} are not usable:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Viewer assets for ${snapshot} are published and verified.`);
  process.exit(0);
}

// Not published yet: accept committed bundles, loudly.
const binding = VARIABLE_MAP_BINDINGS[snapshot];
const catalog = SNAPSHOT_SEARCH_CATALOGS[snapshot];
if (binding && catalog) {
  const index = readFileSync(new URL(`../site${binding.root}index.json.gz`, import.meta.url));
  if (index.length === binding.bytes && digest(index) === binding.sha256) {
    console.log(`::warning title=Viewer assets not published::${snapshot} is served from bundles committed to this repo. `
      + "Publish its viewer-assets with the data pipeline (harvest_abstracts viewer_assets.py), then delete the committed bundles.");
    process.exit(0);
  }
}
console.error(`Evidence snapshot ${snapshot} has no viewer assets, published or committed. The viewer would query the snapshot in the `
  + "browser, which takes minutes on a phone. Build them in harvest_abstracts (analysis/10k/echo_viewer_bundle/viewer_assets.py) and upload.");
process.exit(1);
