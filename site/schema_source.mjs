import { PUBLISHED_SCHEMA_BUCKET } from "./publication_constants.mjs";
import { SUPABASE_URL } from "./supabase_config.mjs";

// Where published schema files are read from. Supabase Storage is the default;
// `?schema_source=cloudflare` reads the same files, byte for byte, from the R2
// bucket behind data.epistemicinfra.org (see harvest_abstracts
// mirror_published_schemas_r2.py). Publishing still writes to Supabase, and the
// registry stays there. When Cloudflare is ready to be the default, change
// DEFAULT_SCHEMA_SOURCE; Supabase support can then be removed.
export const SCHEMA_SOURCES = ["supabase", "cloudflare"];
export const DEFAULT_SCHEMA_SOURCE = "supabase";
export const SCHEMA_SOURCE_PARAM = "schema_source";

const CLOUDFLARE_ORIGIN = "https://data.epistemicinfra.org";
const CLOUDFLARE_PATH = "/published-schemas/";
const SUPABASE_PATH = `/storage/v1/object/public/${PUBLISHED_SCHEMA_BUCKET}/`;

/** The source a page asks for, or the default when it names none or one that is unknown. */
export function schemaSource(location = globalThis.location) {
  if (!location) return DEFAULT_SCHEMA_SOURCE;
  const value = new URL(location.href).searchParams.get(SCHEMA_SOURCE_PARAM);
  return SCHEMA_SOURCES.includes(value) ? value : DEFAULT_SCHEMA_SOURCE;
}

/** True when the page names a source itself, so links made from it keep naming it. */
export function schemaSourceRequested(location = globalThis.location) {
  return Boolean(location) && SCHEMA_SOURCES.includes(new URL(location.href).searchParams.get(SCHEMA_SOURCE_PARAM));
}

const encodeKey = key => key.split("/").map(encodeURIComponent).join("/");

/** The address of one object, named by its bucket key (`<owner>/<publication>/<file>`), on a source. */
export function publishedFileUrl(key, source = schemaSource()) {
  return source === "cloudflare"
    ? `${CLOUDFLARE_ORIGIN}${CLOUDFLARE_PATH}${encodeKey(key)}`
    : `${SUPABASE_URL}${SUPABASE_PATH}${encodeKey(key)}`;
}

/** The bucket key an address points at, on either source; null for any other address. */
export function publishedFileKey(url) {
  const { origin, pathname } = new URL(url);
  const prefix = origin === CLOUDFLARE_ORIGIN ? CLOUDFLARE_PATH
    : origin === new URL(SUPABASE_URL).origin ? SUPABASE_PATH : null;
  if (!prefix || !pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(pathname.slice(prefix.length));
  return key && !key.split("/").some(part => part === ".." || part === "") ? key : null;
}

/** Which source an address belongs to. */
export function schemaSourceOfUrl(url) {
  return new URL(url).origin === CLOUDFLARE_ORIGIN ? "cloudflare" : "supabase";
}

const underPublishedPath = url => url.pathname.startsWith(SUPABASE_PATH) || url.pathname.startsWith(CLOUDFLARE_PATH);

/** True for an address inside the published schema area of the host `base` is on. */
export function isPublishedFileUrl(url, base) {
  const candidate = new URL(url), root = new URL(base);
  return candidate.origin === root.origin && underPublishedPath(candidate);
}

/**
 * A membership reference in a manifest, as an address on the same source as `base`;
 * null when it is not a published schema file. Manifests store the Supabase address
 * of a parent's file; the same file is at the same key on Cloudflare. A reference
 * on the host `base` is already on is used as it is.
 */
export function publishedReferenceUrl(reference, base) {
  const url = new URL(reference, base);
  if (isPublishedFileUrl(url, base)) return url;
  const key = publishedFileKey(url);
  return key ? new URL(publishedFileUrl(key, schemaSourceOfUrl(base))) : null;
}

/** The form a reference is stored in: the Supabase address, whichever source it was read from. */
export function canonicalPublishedReference(url) {
  const key = publishedFileKey(url);
  if (key) return publishedFileUrl(key, "supabase");
  const own = new URL(url);
  if (own.pathname.startsWith(SUPABASE_PATH)) return own.href;
  throw new Error("Not a published schema file address.");
}
