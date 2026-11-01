import { PUBLISHED_SCHEMA_BUCKET } from "./publication_constants.mjs";
import { publishedFileUrl, schemaSource } from "./schema_source.mjs";
import { CLOUDFLARE_API_URL, cloudflareApiConfigured } from "./cloudflare_config.mjs";
import { getSchema } from "./cloudflare_api.mjs";

/** The folder holding one publication's files, on the page's schema source. */
export function publicSchemaBaseUrl(client, storagePrefix, source = schemaSource()) {
  if (source === "cloudflare") return `${publishedFileUrl(storagePrefix, "cloudflare")}/`;
  const { data } = client.storage.from(PUBLISHED_SCHEMA_BUCKET).getPublicUrl(`${storagePrefix}/manifest.json`);
  if (!data?.publicUrl) throw new Error("Supabase did not return a public schema URL.");
  return data.publicUrl.replace(/manifest\.json$/, "");
}

/**
 * The registry row of a publication. On a page that reads from Cloudflare, and once the publishing worker's address is
 * configured, the registry is the worker's; otherwise it is Supabase's table.
 */
export async function lookupPublishedSchema(publicationId, client, { source = schemaSource(), apiUrl = CLOUDFLARE_API_URL, fetchImpl } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(publicationId)) throw new Error("Invalid schema publication ID.");
  if (source === "cloudflare" && cloudflareApiConfigured(apiUrl)) return getSchema(publicationId, { apiUrl, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!client) throw new Error("Supabase is not configured.");
  const { data, error } = await client.from("published_schemas")
    .select("id, owner_id, content_hash, storage_prefix, parent_schema_id, title, description, evidence_snapshot, compiled_manifest_path, compiled_manifest_hash, compiler_version")
    .eq("id", publicationId)
    .single();
  if (error) throw error;
  return data;
}
