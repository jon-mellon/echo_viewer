import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../site/supabase_config.mjs";
import { DEFAULT_SCHEMA_PUBLICATION_ID, PRODUCTION_EVIDENCE_MANIFEST,
  PRODUCTION_EVIDENCE_SNAPSHOT_BASE, evidenceSnapshotIdFromManifestUrl } from "../site/dag_data_config.mjs";
import { browserV2ManifestLayout, validateBrowserV2EvidenceBinding } from "../site/dag_manifest.mjs";
import { loadGroupingSchemaFolder } from "../site/grouping_schema_loader.mjs";
import { canonicalFolderHash } from "../site/grouping_schema_writer.mjs";
import { validateCompiledArtifact } from "../site/compiled_dag.mjs";
import { validateGroupingSchema } from "../site/data_validation.mjs";
import { searchVariables as echoSearchVariables } from "../site/dag_search.mjs";
import { pairKey } from "../site/dag_link_aggregation.mjs";
import { lookupPublishedSchema, publicSchemaBaseUrl } from "../site/publication_access.mjs";

const execFileAsync = promisify(execFile);
const HASH = /^[0-9a-f]{64}$/i;
const ID = /^[0-9a-f-]{36}$/i;

export function agentHome() {
  return resolve(process.env.ECHO_AGENT_HOME || ".echo-agent");
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safePath(root, relative) {
  if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new Error("Unsafe snapshot path.");
  return join(root, relative);
}
async function downloadVerified(url, path, integrity) {
  try {
    const existing = await readFile(path);
    if (existing.length === integrity.bytes && sha256(existing) === integrity.sha256) return existing;
  } catch { /* download missing or invalid file */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== integrity.bytes || sha256(bytes) !== integrity.sha256) throw new Error(`Integrity check failed: ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  return bytes;
}
async function eachLimited(items, limit, fn) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await fn(items[index++]);
  }));
}
function publicClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function clonePublication({ publicationId = DEFAULT_SCHEMA_PUBLICATION_ID,
  home = agentHome(), snapshotId = "", onProgress = () => {} } = {}) {
  if (!ID.test(publicationId)) throw new Error("Invalid publication ID.");
  const client = publicClient();
  const publication = await lookupPublishedSchema(publicationId, client);
  // Publication evidence_snapshot can be a logical record signature, so the
  // physical retrieval layout is independently selectable and then validated.
  const selectedId = snapshotId || evidenceSnapshotIdFromManifestUrl(PRODUCTION_EVIDENCE_MANIFEST);
  if (!HASH.test(selectedId)) throw new Error("Invalid evidence snapshot ID.");
  const manifestUrl = `${PRODUCTION_EVIDENCE_SNAPSHOT_BASE}${selectedId}/manifest.json`;
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`Evidence manifest download failed: ${manifestResponse.status}`);
  const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  browserV2ManifestLayout(manifest);
  const snapshotDir = join(home, "snapshots", selectedId);
  const legacyBase = new URL(`/${manifest.identity.legacy_manifest}`, manifestUrl);
  const files = Object.entries(manifest.files).map(([relative, integrity]) => ({
    path: safePath(snapshotDir, relative), url: new URL(relative, manifestUrl).href, integrity,
  }));
  for (const [relation, integrity] of Object.entries(manifest.identity.legacy_relation_integrity || {})) {
    files.push({ path: safePath(snapshotDir, `canonical/${relation}.parquet`),
      url: new URL(integrity.url, legacyBase).href, integrity });
  }
  let done = 0;
  await eachLimited(files, 8, async file => {
    await downloadVerified(file.url, file.path, file.integrity);
    onProgress(++done, files.length);
  });
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(join(snapshotDir, "manifest.json"), manifestBytes);
  const metadata = await duckRows(`SELECT metadata_json FROM read_parquet(${sqlString(join(snapshotDir, "canonical/build_metadata.parquet"))})`);
  validateBrowserV2EvidenceBinding({ manifest, manifestUrl, metadata: JSON.parse(metadata[0]?.metadata_json || "{}"),
    expectedRecordSignature: publication.evidence_snapshot });

  const publicationDir = join(home, "publications", publicationId);
  const baseUrl = publicSchemaBaseUrl(client, publication.storage_prefix);
  const publicUrl = path => new URL(path, baseUrl).href;
  const schemaManifestResponse = await fetch(publicUrl("manifest.json"));
  if (!schemaManifestResponse.ok) throw new Error("Could not download publication manifest.");
  const schemaManifest = JSON.parse(await schemaManifestResponse.text());
  const paths = ["manifest.json", schemaManifest.schema_file, schemaManifest.groups_file,
    ...Object.values(schemaManifest.group_membership_files || {}), schemaManifest.rejected_file,
    publication.compiled_manifest_path].filter(Boolean);
  const compiledManifestResponse = await fetch(publicUrl(publication.compiled_manifest_path));
  if (!compiledManifestResponse.ok) throw new Error("Could not download compiled manifest.");
  const compiledManifestBytes = Buffer.from(await compiledManifestResponse.arrayBuffer());
  if (publication.compiled_manifest_hash && sha256(compiledManifestBytes) !== publication.compiled_manifest_hash) {
    throw new Error("Published compiled manifest hash mismatch.");
  }
  const compiledManifest = JSON.parse(compiledManifestBytes.toString("utf8"));
  paths.push(compiledManifest.artifacts?.dag?.path);
  const schemaFiles = new Map();
  await eachLimited([...new Set(paths.filter(Boolean))], 8, async relative => {
    const response = await fetch(publicUrl(relative));
    if (!response.ok) throw new Error(`Could not download publication file ${relative}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const path = safePath(publicationDir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    if (!relative.startsWith("compiled/")) schemaFiles.set(relative, bytes);
  });
  if (await canonicalFolderHash(schemaFiles) !== publication.content_hash) throw new Error("Published schema hash mismatch.");
  const localFetch = async url => {
    try { return new Response(await readFile(new URL(url)), { status: 200 }); }
    catch { return new Response("Missing local schema file", { status: 404 }); }
  };
  const schema = validateGroupingSchema(await loadGroupingSchemaFolder(pathToFileURL(`${publicationDir}/`).href, localFetch));
  const compiledDag = JSON.parse(await readFile(join(publicationDir, compiledManifest.artifacts.dag.path), "utf8"));
  await validateCompiledArtifact({ publication, manifest: compiledManifest, dag: compiledDag });
  await writeFile(join(publicationDir, "publication.json"), JSON.stringify({ publication, snapshotId: selectedId }) + "\n");
  return { publication, schema, compiledDag, snapshotId: selectedId, snapshotDir, publicationDir };
}

export async function openLocalPublication(publicationId = DEFAULT_SCHEMA_PUBLICATION_ID, home = agentHome()) {
  if (!ID.test(publicationId)) throw new Error("Invalid publication ID.");
  const publicationDir = join(home, "publications", publicationId);
  const { publication, snapshotId } = JSON.parse(await readFile(join(publicationDir, "publication.json"), "utf8"));
  const snapshotDir = join(home, "snapshots", snapshotId);
  await stat(join(snapshotDir, "manifest.json"));
  const evidenceManifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf8"));
  if (evidenceManifest.evidence_snapshot !== snapshotId) throw new Error("Cached snapshot identity mismatch.");
  const integrityFiles = [
    ...Object.entries(evidenceManifest.files).map(([path, integrity]) => ({ path, integrity })),
    ...Object.entries(evidenceManifest.identity.legacy_relation_integrity || {}).map(([name, integrity]) =>
      ({ path: `canonical/${name}.parquet`, integrity })),
  ];
  for (const { path, integrity } of integrityFiles) {
    const bytes = await readFile(safePath(snapshotDir, path));
    if (bytes.length !== integrity.bytes || sha256(bytes) !== integrity.sha256) {
      throw new Error(`Cached evidence integrity failed: ${path}`);
    }
  }
  const localFetch = async url => {
    try { return new Response(await readFile(new URL(url)), { status: 200 }); }
    catch { return new Response("Missing local schema file", { status: 404 }); }
  };
  const schema = validateGroupingSchema(await loadGroupingSchemaFolder(pathToFileURL(`${publicationDir}/`).href, localFetch));
  const manifest = JSON.parse(await readFile(join(publicationDir, "manifest.json"), "utf8"));
  const schemaPaths = ["manifest.json", manifest.schema_file, manifest.groups_file,
    ...Object.values(manifest.group_membership_files), manifest.rejected_file].filter(Boolean);
  const verified = await canonicalFolderHash(new Map(await Promise.all(schemaPaths
    .map(async path => [path, await readFile(safePath(publicationDir, path))]))));
  if (verified !== publication.content_hash) throw new Error("Cached publication hash mismatch.");
  return { publication, schema, snapshotId, snapshotDir, publicationDir };
}

export function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
export async function duckRows(sql) {
  const { stdout } = await execFileAsync("duckdb", ["-json", "-c", sql], { maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export function localEvidence(snapshotDir) {
  const relation = name => sqlString(join(snapshotDir, `canonical/${name}.parquet`));
  const list = values => values.map(sqlString).join(",");
  return {
    async variables(ids) {
      if (!ids.length) return [];
      return duckRows(`SELECT * FROM read_parquet(${relation("variable_occurrences")}) WHERE variable_id IN (${list(ids)}) ORDER BY index`);
    },
    async searchVariables(query, limit = 40) {
      const n = Math.max(1, Math.min(200, Number(limit) || 40));
      const variables = await duckRows(`SELECT * FROM read_parquet(${relation("variable_occurrences")})`);
      return echoSearchVariables(query, { variables, selectedUoa: null, uoaFilterEnabled: false }, n);
    },
    async neighbors(ids) {
      if (!ids.length) return [];
      return duckRows(`SELECT * FROM read_parquet(${relation("variable_neighbors")}) WHERE variable_id IN (${list(ids)}) ORDER BY variable_id,display_rank`);
    },
    async rawLinks(ids = null) {
      const where = ids?.length ? ` WHERE raw_causal_link_id IN (${list(ids)})` : "";
      return duckRows(`SELECT * FROM read_parquet(${relation("causal_link_occurrences")})${where}`);
    },
    async incidentLinks(ids) {
      if (!ids.length) return [];
      return duckRows(`SELECT * FROM read_parquet(${relation("causal_link_occurrences")}) WHERE source_variable_id IN (${list(ids)}) OR target_variable_id IN (${list(ids)})`);
    },
    async candidateInputs() {
      const metadata = await duckRows(`SELECT metadata_json FROM read_parquet(${relation("build_metadata")})`);
      const layout = JSON.parse(metadata[0]?.metadata_json || "{}").layout?.default_source;
      if (!layout) throw new Error("Snapshot has no default variable layout.");
      const variables = await duckRows(`SELECT v.variable_id,l.map_x,l.map_y FROM read_parquet(${relation("variable_occurrences")}) v JOIN read_parquet(${relation("variable_layouts")}) l USING (variable_id) WHERE l.layout_source=${sqlString(layout)}`);
      const similarity = await duckRows(`SELECT source,target,weight FROM read_parquet(${relation("similarity_edges")}) WHERE layout_source=${sqlString(layout)}`);
      const rawLinks = await this.rawLinks();
      const linkLookup = new Map();
      for (const link of rawLinks) {
        const key = `${link.source_variable_id}->${link.target_variable_id}`;
        if (!linkLookup.has(key)) linkLookup.set(key, []);
        linkLookup.get(key).push(link.raw_causal_link_id);
      }
      return { variables: new Map(variables.map(variable => [variable.variable_id, variable])),
        similarityEdgeMap: new Map(similarity.map(edge => [pairKey(edge.source, edge.target), edge.weight])),
        linkLookup };
    },
  };
}
