import { canonicalFolderHash, writeGroupingSchemaFolder } from "./grouping_schema_writer.mjs";
import { PUBLISHED_SCHEMA_BUCKET } from "./publication_constants.mjs";
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
}) {
  const user = await ensureAnonymousPublicationUser(client);
  const publicSchema = publicSchemaProjection(schema);
  const canonical = await canonicalizeWorkingSchema(publicSchema, cryptoApi);
  const existing = await findOwnedPublication(client, user.id, canonical.contentHash);
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
  files.set(COMPILED_DAG_PATH, compiled.dagBytes);
  files.set(COMPILED_MANIFEST_PATH, compiled.manifestBytes);
  const entries = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  for (const [index, [path, bytes]] of entries.entries()) {
    onProgress(index + 1, entries.length, path);
    const type = contentType(path);
    const { error } = await client.storage.from(PUBLISHED_SCHEMA_BUCKET).upload(
      `${storagePrefix}/${path}`, new Blob([bytes], { type }), { upsert: false, contentType: type },
    );
    if (error) throw error;
  }

  const parentSchemaId = previousPublication?.publication_id || CANONICAL_BASELINE_ID;
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
    compiled_manifest_hash: await (async () => {
      const digest = await cryptoApi.subtle.digest("SHA-256", compiled.manifestBytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    })(),
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
