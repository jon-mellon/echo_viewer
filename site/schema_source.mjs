// Public schema files and registry rows are served from Cloudflare R2.
export const DEFAULT_SCHEMA_SOURCE = "cloudflare";

const PUBLIC_ORIGIN = "https://data.epistemicinfra.org";
const PUBLIC_PATH = "/published-schemas/";
// Old immutable manifests contain these addresses. Parse them only to recover
// the object key; no request is sent to this retired service.
const LEGACY_ORIGIN = "https://xfsivvvmsgzbdnthupzg.supabase.co";
const LEGACY_PATH = "/storage/v1/object/public/published-schemas/";
const encodeKey = key => key.split("/").map(encodeURIComponent).join("/");

export function publishedFileUrl(key) {
  return `${PUBLIC_ORIGIN}${PUBLIC_PATH}${encodeKey(key)}`;
}

function hasUnsafePathSegment(address) {
  const rawPath = String(address).match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i)?.[1];
  if (!rawPath) return false;
  try { return rawPath.split("/").some(part => [".", ".."].includes(decodeURIComponent(part)) || decodeURIComponent(part).includes("/")); }
  catch { return true; }
}

export function publishedFileKey(address) {
  if (hasUnsafePathSegment(address)) return null;
  const { origin, pathname } = new URL(address);
  const prefix = origin === PUBLIC_ORIGIN ? PUBLIC_PATH : origin === LEGACY_ORIGIN ? LEGACY_PATH : null;
  if (!prefix || !pathname.startsWith(prefix)) return null;
  const key = decodeURIComponent(pathname.slice(prefix.length));
  return key && !key.split("/").some(part => part === ".." || part === "") ? key : null;
}

export function isPublishedFileUrl(address, base) {
  const candidate = new URL(address), root = new URL(base);
  return candidate.origin === root.origin && Boolean(publishedFileKey(candidate));
}

export function publishedReferenceUrl(reference, base) {
  if (hasUnsafePathSegment(reference)) return null;
  const url = new URL(reference, base);
  const key = publishedFileKey(url);
  return key ? new URL(publishedFileUrl(key)) : null;
}

export function canonicalPublishedReference(address) {
  const key = publishedFileKey(address);
  if (!key) throw new Error("Not a published schema file address.");
  return publishedFileUrl(key);
}
