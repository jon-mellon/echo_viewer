import { canonicalFolderHash, stableJson, writeGroupingSchemaFolder } from "./grouping_schema_writer.mjs";
import { publicSchemaBaseUrl, lookupPublishedSchema } from "./publication_access.mjs";
import { PUBLISHED_SCHEMA_BUCKET } from "./publication_constants.mjs";
import { canonicalPublishedReference, isPublishedFileUrl, publishedReferenceUrl, schemaSource } from "./schema_source.mjs";
import { cloudflareApiConfigured, CLOUDFLARE_API_URL } from "./cloudflare_config.mjs";
import { ensureOwner, publishFiles } from "./cloudflare_api.mjs";
import { ensureAnonymousPublicationUser } from "./dag_anonymous_auth.mjs";
import { createCompiledArtifacts, evidenceSnapshotForSchema, fullCompileDag,
  COMPILED_DAG_PATH, COMPILED_MANIFEST_PATH, DAG_COMPILER_VERSION } from "./compiled_dag.mjs";
import { publicCompiledDag, publicLinkDecisions, publicFindingDecisions, publicSchemaProjection } from "./public_schema_projection.mjs";

export const CANONICAL_BASELINE_ID = "a0118906-2366-4cc8-8809-bafdf3860c23";
export const CANONICAL_BASELINE_HASH = "0afd5f28c1b5456c47cfba84467bea1d62c6dc923a5851281a98d461f60066b4";

export function formatSupabaseError(error) {
  if (!error) return "Unknown Supabase error";
  const parts = [error.message || String(error)];
  for (const key of ["code", "details", "hint", "status", "statusCode"]) {
    if (error[key] !== undefined && error[key] !== null && error[key] !== "") parts.push(`${key}: ${error[key]}`);
  }
  return parts.join(" | ");
}

function contentType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".yaml")) return "application/yaml";
  if (path.endsWith(".tsv")) return "text/tab-separated-values";
  return "application/octet-stream";
}

async function findOwnedPublication(client, ownerId, contentHash) {
  const { data, error } = await client.from("published_schemas")
    .select("id, owner_id, content_hash, storage_prefix, parent_schema_id, compiler_version, compiled_manifest_path")
    .eq("owner_id", ownerId)
    .eq("content_hash", contentHash)
    .eq("compiler_version", DAG_COMPILER_VERSION)
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function canonicalizeWorkingSchema(schema, cryptoApi = globalThis.crypto) {
  const files = await writeGroupingSchemaFolder(publicSchemaProjection(schema), cryptoApi);
  return { files, contentHash: await canonicalFolderHash(files, cryptoApi) };
}

/** The browser and local agent use this exact publication path. */
export async function publishWorkingSchema({
  schema,
  previousPublication,
  compiledDag = null,
  compileInput = null,
  client,
  cryptoApi = globalThis.crypto,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  // Where to publish: the page's schema source. The Cloudflare service settings (apiUrl, fetchImpl, storage, solve) can be given for tests.
  source = schemaSource(),
  cloudflare = {},
}) {
  const viaCloudflare = source === "cloudflare";
  if (viaCloudflare && !cloudflareApiConfigured(cloudflare.apiUrl ?? CLOUDFLARE_API_URL)) {
    throw new Error("Publishing to Cloudflare is not set up yet. Remove schema_source=cloudflare from the address to publish.");
  }
  const user = viaCloudflare ? await ensureOwner(cloudflare) : await ensureAnonymousPublicationUser(client);
  const publicSchema = publicSchemaProjection(schema);
  const canonical = await canonicalizeWorkingSchema(publicSchema, cryptoApi);
  // The Cloudflare service answers "already published" when it is asked to reserve the publication.
  const existing = viaCloudflare ? null : await findOwnedPublication(client, user.id, canonical.contentHash);
  if (existing) return { ...existing, publicationId: existing.id, contentHash: existing.content_hash, reused: true };

  const publicationId = cryptoApi.randomUUID();
  const storagePrefix = `${user.id}/${publicationId}`;
  const evidenceSnapshot = evidenceSnapshotForSchema(publicSchema);
  const publicProject = { ...(compileInput?.project || {}),
    link_decisions: publicLinkDecisions(publicSchema.link_decisions),
    finding_decisions: publicFindingDecisions(publicSchema.finding_decisions) };
  const dag = compiledDag
    ? publicCompiledDag(compiledDag, publicSchema.link_decisions)
    : fullCompileDag({ schema: publicSchema, ...(compileInput || {}), project: publicProject });
  const compiled = await createCompiledArtifacts({ publicationId, schemaHash: canonical.contentHash,
    evidenceSnapshot, dag, cryptoApi });
  const files = new Map(canonical.files);
  // Compare exact canonical membership bytes with the parent. References are
  // flattened to their original immutable object, avoiding chains of manifests.
  const parentId = previousPublication?.publication_id || CANONICAL_BASELINE_ID;
  let parentPrefix = previousPublication?.storage_prefix;
  if (!parentPrefix && /^[0-9a-f-]{36}$/i.test(parentId)) {
    parentPrefix = (await lookupPublishedSchema(parentId, client, { source, ...cloudflare })).storage_prefix;
  }
  if (parentPrefix) {
    const base = publicSchemaBaseUrl(client, parentPrefix, source);
    const response = await fetchImpl(new URL("manifest.json", base));
    if (!response.ok) throw new Error(`Could not read parent manifest: ${response.status}`);
    const parent = await response.json();
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    const references = {};
    const candidates = Object.entries(manifest.group_membership_files);
    let next = 0;
    async function compareMemberships() {
      while (next < candidates.length) {
        const [groupId, path] = candidates[next++];
        const oldPath = parent.group_membership_files?.[groupId];
        if (!oldPath) continue;
        const reference = parent.group_membership_references?.[groupId];
        const url = reference ? publishedReferenceUrl(reference, base) : new URL(oldPath, base);
        if (!url || !isPublishedFileUrl(url, base)) throw new Error(`Invalid parent membership reference for ${groupId}.`);
        const oldResponse = await fetchImpl(url);
        if (!oldResponse.ok) throw new Error(`Could not read parent membership for ${groupId}: ${oldResponse.status}`);
        const oldBytes = new Uint8Array(await oldResponse.arrayBuffer());
        const current = files.get(path);
        if (oldBytes.length === current.length && oldBytes.every((byte, index) => byte === current[index])) {
          // Stored as the Supabase address whichever source the parent was read from.
          references[groupId] = canonicalPublishedReference(url);
          files.delete(path);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, candidates.length) }, compareMemberships));
    if (Object.keys(references).length) {
      manifest.group_membership_references = references;
      files.set("manifest.json", new TextEncoder().encode(stableJson(manifest)));
    }
  }
  files.set(COMPILED_DAG_PATH, compiled.dagBytes);
  files.set(COMPILED_MANIFEST_PATH, compiled.manifestBytes);
  const entries = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const compiledManifestHash = await (async () => {
    const digest = await cryptoApi.subtle.digest("SHA-256", compiled.manifestBytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  })();
  const parentSchemaId = previousPublication?.publication_id || CANONICAL_BASELINE_ID;
  if (viaCloudflare) {
    const saved = await publishFiles({
      owner: user, publicationId, contentHash: canonical.contentHash, compilerVersion: compiled.manifest.compiler_version,
      row: { title: schema.label || "Published grouping schema", description: schema.description || null,
        evidence_snapshot: evidenceSnapshot, parent_schema_id: parentSchemaId, compiled_manifest_path: COMPILED_MANIFEST_PATH,
        compiled_manifest_hash: compiledManifestHash },
      files: new Map(entries), onProgress, apiUrl: cloudflare.apiUrl ?? CLOUDFLARE_API_URL,
      ...(cloudflare.fetchImpl ? { fetchImpl: cloudflare.fetchImpl } : {}),
    });
    return { ...saved.row, publicationId: saved.row.id, contentHash: saved.row.content_hash, fileCount: entries.length, reused: saved.reused };
  }
  for (const [index, [path, bytes]] of entries.entries()) {
    onProgress(index + 1, entries.length, path);
    const type = contentType(path);
    const { error } = await client.storage.from(PUBLISHED_SCHEMA_BUCKET).upload(
      `${storagePrefix}/${path}`, new Blob([bytes], { type }), { upsert: false, contentType: type },
    );
    if (error) throw error;
  }

  const row = {
    id: publicationId,
    owner_id: user.id,
    content_hash: canonical.contentHash,
    title: schema.label || "Published grouping schema",
    description: schema.description || null,
    evidence_snapshot: evidenceSnapshot,
    storage_prefix: storagePrefix,
    parent_schema_id: parentSchemaId,
    compiled_manifest_path: COMPILED_MANIFEST_PATH,
    compiled_manifest_hash: compiledManifestHash,
    compiler_version: compiled.manifest.compiler_version,
  };
  const { error: insertError } = await client.from("published_schemas").insert(row);
  if (insertError) throw insertError;
  return {
    ...row,
    publicationId,
    contentHash: canonical.contentHash,
    fileCount: entries.length,
    reused: false,
  };
}
