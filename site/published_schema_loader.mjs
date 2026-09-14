import { supabase } from "./supabase_client.mjs";
import { PRODUCTION_APP_ORIGIN } from "./dag_data_config.mjs";
import { loadGroupingSchemaStructure } from "./grouping_schema_loader.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";
import { canonicalFolderHash } from "./grouping_schema_writer.mjs";
import { buildPermalink } from "./dag_permalink.mjs";
import { deriveDagView } from "./dag_view.mjs";
import { COMPILED_DAG_PATH, sha256Hex, stableJsonBytes,
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
  const memory = new Map();
  const cacheName = `echo-published-${publication.content_hash}`;
  const cachingFetch = async (url, options = {}) => {
    const absolute = new URL(url).href;
    if (!memory.has(absolute)) {
      const browserCache = globalThis.caches ? await globalThis.caches.open(cacheName) : null;
      const cached = browserCache ? await browserCache.match(absolute) : null;
      if (cached) memory.set(absolute, new Uint8Array(await cached.arrayBuffer()));
      else {
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
        const bytes = new Uint8Array(await response.arrayBuffer());
        memory.set(absolute, bytes);
        if (browserCache) await browserCache.put(absolute, new Response(bytes, {
          status: 200, headers: { "content-type": response.headers?.get?.("content-type") || "application/octet-stream" },
        }));
      }
    }
    return new Response(memory.get(absolute), { status: 200 });
  };
  let compiledDag = null;
  let compiledFallbackReason = null;
  try {
    if (!publication.compiled_manifest_path || !publication.compiler_version) {
      throw new Error("Published schema has no compiled DAG artifact.");
    }
    const [manifestResponse, dagResponse] = await Promise.all([
      cachingFetch(new URL(publication.compiled_manifest_path, baseUrl)),
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
  if (!compiledDag) {
    throw new Error(`Published schema has no valid compiled DAG: ${compiledFallbackReason}`);
  }
  const schema = {
    schema_version: GROUPING_FORMAT_VERSION,
    grouping_set_id: publication.id,
    label: publication.title || "Published grouping schema",
    description: publication.description || "",
    membership_unit: GROUPING_MEMBERSHIP_UNIT,
    built_against: { record_signature: publication.evidence_snapshot },
    cache_compatibility: { record_signature: publication.evidence_snapshot },
    groups: compiledDag.nodes.map(node => ({ group_id: node.group_id, label: node.label,
      member_count: node.member_count, variable_ids: [] })),
    rejected_variables: [],
  };
  const loadSchema = async () => {
    const schemaFiles = new Map();
    const schemaFetch = async (url, options) => {
      const response = await cachingFetch(url, options);
      if (response.ok) {
        const relative = new URL(url).href.slice(new URL(baseUrl).href.length);
        schemaFiles.set(relative, new Uint8Array(await response.clone().arrayBuffer()));
      }
      return response;
    };
    const staged = await loadGroupingSchemaStructure(baseUrl, schemaFetch);
    const parameters = new URL(globalThis.location?.href || "http://localhost/").searchParams;
    const bool = (key, fallback) => parameters.has(key) ? parameters.get(key) === "1" : fallback;
    const ivId = parameters.get("iv"), dvId = parameters.get("dv");
    const displayed = parameters.get("p") === "1" && ivId && dvId
      ? [...deriveDagView({
          groups: schema.groups,
          links: compiledDag.edges,
          ivId,
          dvId,
          maxPathLength: Math.max(1, Math.min(99, Number(parameters.get("path")) || 1)),
          excludeBottlenecked: bool("bottle", true),
          filterByCausalRelevance: bool("causal", true),
          showConfoundersOnly: bool("conf", false),
          showCollidersOnly: bool("coll", false),
          hideIrrelevantDiagnosticLinks: bool("paths", true),
        }).componentGroupIds]
      : [ivId, dvId].filter(Boolean);
    await staged.loadMemberships(displayed);
    const priorityReady = structuredClone(staged.schema);
    const complete = await staged.loadComplete();
    const downloadedHash = await canonicalFolderHash(schemaFiles);
    if (downloadedHash !== publication.content_hash) {
      throw new Error(`Published schema hash mismatch: registry ${publication.content_hash}, downloaded ${downloadedHash}.`);
    }
    return { schema: complete, priorityReady };
  };
  return { schema, loadSchema, publication, compiledDag, compiledFallbackReason };
}
