#!/usr/bin/env node
// Generate and register the static assets a published evidence snapshot needs
// for fast evidence loading: its variable search catalog (concept labels for every
// endpoint) and its variable map bundles (one per variable group, so a group's
// details open without the 34 MB query engine). Run this when a snapshot is
// published, before it becomes a default. Usage:
//   node scripts/register_snapshot_assets.mjs <64-hex snapshot id> [work-dir]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [snapshot, workDir = join(root, "dist", "snapshot-assets")] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(snapshot || "")) throw new Error("Usage: register_snapshot_assets.mjs <64-hex snapshot id> [work-dir]");
const DATA_HOST = "https://data.epistemicinfra.org/evidence";

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

const layout = await getJson(`${DATA_HOST}/layouts/browser-v2/${snapshot}/manifest.json`);
if (layout.evidence_snapshot !== snapshot) throw new Error("Layout manifest describes a different snapshot");
const legacyManifest = layout.identity?.legacy_manifest;
const integrity = layout.identity?.legacy_relation_integrity?.variable_occurrences;
if (!legacyManifest || !integrity?.url || !/^[0-9a-f]{64}$/.test(integrity.sha256 || "")) {
  throw new Error("Snapshot manifest does not declare variable_occurrences integrity");
}
const source = new URL(integrity.url, new URL(`/${legacyManifest}`, DATA_HOST)).href;
const response = await fetch(source);
if (!response.ok) throw new Error(`GET ${source}: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length !== integrity.bytes || createHash("sha256").update(bytes).digest("hex") !== integrity.sha256) {
  throw new Error("Downloaded variable_occurrences does not match the manifest");
}
mkdirSync(workDir, { recursive: true });
const parquet = join(workDir, `${snapshot}.variable_occurrences.parquet`);
writeFileSync(parquet, bytes);

const catalogPath = `site/search-catalogs/${snapshot}.json.gz`;
execFileSync("node", [join(root, "scripts/generate_variable_search_catalog.mjs"), parquet, join(root, catalogPath), snapshot], { stdio: "inherit" });

const modulePath = join(root, "site/variable_search_catalog.mjs");
const moduleSource = readFileSync(modulePath, "utf8");
const binding = `  "${snapshot}": "/${catalogPath.replace(/^site\//, "")}",\n`;
if (moduleSource.includes(`"${snapshot}":`)) console.log("Binding already registered.");
else {
  const marker = "export const SNAPSHOT_SEARCH_CATALOGS = Object.freeze({\n";
  if (!moduleSource.includes(marker)) throw new Error("variable_search_catalog.mjs no longer has the expected binding table");
  const insertAt = moduleSource.indexOf("});", moduleSource.indexOf(marker));
  writeFileSync(modulePath, moduleSource.slice(0, insertAt) + binding + moduleSource.slice(insertAt));
  console.log(`Registered ${snapshot} in site/variable_search_catalog.mjs`);
}

// Variable map bundles: one small file per group of variables, keyed by a hash of the group's ids.
async function download(name) {
  const integrityEntry = layout.identity.legacy_relation_integrity[name];
  const url = new URL(integrityEntry.url, new URL(`/${legacyManifest}`, DATA_HOST)).href;
  const reply = await fetch(url);
  if (!reply.ok) throw new Error(`GET ${url}: HTTP ${reply.status}`);
  const data = Buffer.from(await reply.arrayBuffer());
  if (data.length !== integrityEntry.bytes || createHash("sha256").update(data).digest("hex") !== integrityEntry.sha256) {
    throw new Error(`Downloaded ${name} does not match the manifest`);
  }
  const path = join(workDir, `${snapshot}.${name}.parquet`);
  writeFileSync(path, data);
  return path;
}
const layoutsParquet = await download("variable_layouts");
const manifestPath = join(workDir, `${snapshot}.manifest.json`);
writeFileSync(manifestPath, JSON.stringify(layout));
const mapsSummary = JSON.parse(execFileSync("node", [join(root, "scripts/generate_variable_maps.mjs"), parquet, layoutsParquet, manifestPath, join(root, "site/variable-maps")],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n").pop());
const mapModulePath = join(root, "site/variable_map_catalog.mjs");
const mapSource = readFileSync(mapModulePath, "utf8");
const mapBinding = `  "${snapshot}": {
    root: "/variable-maps/${snapshot}/",
    layoutSource: "${mapsSummary.layoutSource}", bytes: ${mapsSummary.indexBytes},
    sha256: "${mapsSummary.indexSha256}",
  },
`;
if (mapSource.includes(`"${snapshot}":`)) console.log("Variable map binding already registered; check its bytes and sha256 against the generated index.");
else {
  const marker = "export const VARIABLE_MAP_BINDINGS = Object.freeze({\n";
  if (!mapSource.includes(marker)) throw new Error("variable_map_catalog.mjs no longer has the expected binding table");
  writeFileSync(mapModulePath, mapSource.replace(marker, marker + mapBinding));
  console.log(`Registered ${snapshot} in site/variable_map_catalog.mjs (${mapsSummary.groups} groups, ${mapsSummary.variables} variables)`);
}
