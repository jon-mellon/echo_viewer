#!/usr/bin/env node
// Generate and register the static assets a published evidence snapshot needs
// for fast evidence loading: today, its variable search catalog (concept labels
// for every endpoint, keyed by snapshot). Run this when a snapshot is published,
// before it becomes a default. Usage:
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
