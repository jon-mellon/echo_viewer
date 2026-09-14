import { supabase } from "./supabase_client.mjs";
import { PRODUCTION_APP_ORIGIN } from "./dag_data_config.mjs";
import { loadGroupingSchemaFolder } from "./grouping_schema_loader.mjs";
import { canonicalFolderHash } from "./grouping_schema_writer.mjs";
import { buildPermalink } from "./dag_permalink.mjs";
import { COMPILED_DAG_PATH, COMPILED_MANIFEST_PATH, sha256Hex, stableJsonBytes,
  validateCompiledArtifact } from "./compiled_dag.mjs";

export const PUBLISHED_SCHEMA_BUCKET = "published-schemas";

export function publicationPermalink(publicationId, location = globalThis.location, state = null) {
  const origin = location?.origin || PRODUCTION_APP_ORIGIN;
  const url = state
    ? new URL(buildPermalink({
        location: new URL("/", origin),
        schemaUrl: "",
        dataVersion: state.data?.snapshot?.snapshot_id || "",
        state,
      }))
    : new URL("/", origin);
  url.searchParams.delete("schema_url");
  url.searchParams.set("schema", publicationId);
  return url.href;
}

export function publicationId(location = globalThis.location) {
  return location ? new URL(location.href).searchParams.get("schema") || "" : "";
}

export function publicSchemaBaseUrl(client, storagePrefix) {
  const { data } = client.storage.from(PUBLISHED_SCHEMA_BUCKET).getPublicUrl(`${storagePrefix}/manifest.json`);
  if (!data?.publicUrl) throw new Error("Supabase did not return a public schema URL.");
  return data.publicUrl.replace(/manifest\.json$/, "");
}

export async function lookupPublishedSchema(publicationId, client = supabase) {
  if (!client) throw new Error("Supabase is not configured.");
  if (!/^[0-9a-f-]{36}$/i.test(publicationId)) throw new Error("Invalid schema publication ID.");
  const { data, error } = await client.from("published_schemas")
    .select("id, owner_id, content_hash, storage_prefix, parent_schema_id, title, description, evidence_snapshot, compiled_manifest_path, compiled_manifest_hash, compiler_version")
    .eq("id", publicationId)
    .single();
  if (error) throw error;
  return data;
}

export async function loadPublishedSchema(publicationId, client = supabase, fetchImpl = globalThis.fetch) {
  const publication = await lookupPublishedSchema(publicationId, client);
  const baseUrl = publicSchemaBaseUrl(client, publication.storage_prefix);
  const files = new Map();
  const cachingFetch = async (url, options) => {
    const absolute = new URL(url).href;
    const relative = absolute.slice(new URL(baseUrl).href.length);
    if (!files.has(relative)) {
      let response;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        response = await fetchImpl(absolute, options);
        if (response.status !== 429) break;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 250 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      if (!response.ok) return response;
      files.set(relative, new Uint8Array(await response.arrayBuffer()));
    }
    return new Response(files.get(relative), { status: 200 });
  };
  const schema = await loadGroupingSchemaFolder(baseUrl, cachingFetch);
  const downloadedHash = await canonicalFolderHash(files);
  if (downloadedHash !== publication.content_hash) {
    throw new Error(`Published schema hash mismatch: registry ${publication.content_hash}, downloaded ${downloadedHash}.`);
  }
  let compiledDag = null;
  let compiledFallbackReason = null;
  try {
    const [manifestResponse, dagResponse] = await Promise.all([
      cachingFetch(new URL(publication.compiled_manifest_path || COMPILED_MANIFEST_PATH, baseUrl)),
      cachingFetch(new URL(COMPILED_DAG_PATH, baseUrl)),
    ]);
    if (!manifestResponse.ok || !dagResponse.ok) throw new Error("Published schema has no compiled DAG artifact.");
    const manifest = await manifestResponse.json();
    const dag = await dagResponse.json();
    if (publication.compiled_manifest_hash
        && await sha256Hex(stableJsonBytes(manifest)) !== publication.compiled_manifest_hash) {
      throw new Error("Compiled manifest registry hash mismatch.");
    }
    compiledDag = await validateCompiledArtifact({ publication, manifest, dag });
  } catch (error) {
    compiledFallbackReason = error instanceof Error ? error.message : String(error);
  }
  return { schema, publication, compiledDag, compiledFallbackReason };
}
