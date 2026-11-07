import { publishedFileUrl } from "./schema_source.mjs";
import { getPublishedRow } from "./cloudflare_api.mjs";

/** The folder holding one publication's files in R2. */
export function publicSchemaBaseUrl(_client, storagePrefix) {
  return `${publishedFileUrl(storagePrefix)}/`;
}

/** The registry row is a static R2 object beside the publication's files. */
export async function lookupPublishedSchema(publicationId, _client, { fetchImpl } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(publicationId)) throw new Error("Invalid schema publication ID.");
  return getPublishedRow(publicationId, fetchImpl ? { fetchImpl } : {});
}
