import { PUBLISHED_SCHEMA_BUCKET } from "./publication_constants.mjs";
import { publishedFileUrl, schemaSource } from "./schema_source.mjs";
import { getPublishedRow } from "./cloudflare_api.mjs";

/** The folder holding one publication's files, on the page's schema source. */
export function publicSchemaBaseUrl(client, storagePrefix, source = schemaSource()) {
  if (source === "cloudflare") return `${publishedFileUrl(storagePrefix, "cloudflare")}/`;
  const { data } = client.storage.from(PUBLISHED_SCHEMA_BUCKET).getPublicUrl(`${storagePrefix}/manifest.json`);
  if (!data?.publicUrl) throw new Error("Supabase did not return a public schema URL.");
  return data.publicUrl.replace(/manifest\.json$/, "");
}

/**
 * The registry row of a publication: on a page that reads from Cloudflare, the static row beside the publication's
 * files; otherwise Supabase's table.
 */
export async function lookupPublishedSchema(publicationId, client, { source = schemaSource(), fetchImpl } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(publicationId)) throw new Error("Invalid schema publication ID.");
  if (source === "cloudflare") return getPublishedRow(publicationId, fetchImpl ? { fetchImpl } : {});
  if (!client) throw new Error("Supabase is not configured.");
  const { data, error } = await client.rpc("lookup_published_schema", { publication_id: publicationId });
  if (error) throw error;
  if (!data) throw new Error(`No published schema ${publicationId}.`);
  return data;
}
