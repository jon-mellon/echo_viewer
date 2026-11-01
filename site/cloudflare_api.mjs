import { CLOUDFLARE_API_URL, TURNSTILE_SITE_KEY } from "./cloudflare_config.mjs";
import { solveTurnstile } from "./turnstile.mjs";

// Client for the publishing worker (cloudflare/publish-worker/README.md lists its routes).
const OWNER_KEY = "echo-owner-token";

class CloudflareApiError extends Error {
  constructor(status, code, message) { super(message); this.name = "CloudflareApiError"; this.status = status; this.code = code; }
}

async function request(apiUrl, fetchImpl, path, init = {}) {
  const response = await fetchImpl(new URL(path, apiUrl), init);
  if (response.ok) return response;
  const body = await response.json().catch(() => ({}));
  throw new CloudflareApiError(response.status, body.error || "http_error", body.message || `The publishing service answered ${response.status}.`);
}

export const parseOwnerToken = token => (typeof token === "string" && /^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(token)
  ? { id: token.split(".")[0], token } : null);

/** The anonymous owner for this browser: kept in local storage, created (behind Turnstile) the first time. */
export async function ensureOwner({ apiUrl = CLOUDFLARE_API_URL, fetchImpl = globalThis.fetch.bind(globalThis),
  storage = globalThis.localStorage, solve = () => solveTurnstile(TURNSTILE_SITE_KEY) } = {}) {
  let stored = null;
  try { stored = parseOwnerToken(storage?.getItem(OWNER_KEY)); } catch { /* storage may be blocked */ }
  if (stored) return stored;
  const turnstile = await solve();
  const response = await request(apiUrl, fetchImpl, "/v1/owners", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ turnstile }) });
  const { token } = await response.json();
  const owner = parseOwnerToken(token);
  if (!owner) throw new Error("The publishing service returned an unusable owner token.");
  try { storage?.setItem(OWNER_KEY, token); } catch { /* the owner then lasts only for this publication */ }
  return owner;
}

export async function getSchema(publicationId, { apiUrl = CLOUDFLARE_API_URL, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  return (await request(apiUrl, fetchImpl, `/v1/schemas/${publicationId}`)).json();
}

export async function getSplits(groupId, { apiUrl = CLOUDFLARE_API_URL, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  return (await request(apiUrl, fetchImpl, `/v1/splits?group_id=${encodeURIComponent(groupId)}`)).json();
}

/**
 * Reserves the publication, writes each file (create-only), then registers it.
 * `files` is a Map of path to bytes. Returns the registry row, and whether it already existed.
 */
export async function publishFiles({ owner, publicationId, contentHash, compilerVersion, row, files, onProgress = () => {},
  apiUrl = CLOUDFLARE_API_URL, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const headers = { "x-owner-token": owner.token };
  const started = await (await request(apiUrl, fetchImpl, "/v1/publications", { method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ publication_id: publicationId, content_hash: contentHash, compiler_version: compilerVersion, row,
      files: entries.map(([path, bytes]) => ({ path, size: bytes.length })) }) })).json();
  if (started.reused) return { row: started.row, reused: true };
  for (const [index, [path, bytes]] of entries.entries()) {
    onProgress(index + 1, entries.length, path);
    await request(apiUrl, fetchImpl, `/v1/publications/${publicationId}/files/${path.split("/").map(encodeURIComponent).join("/")}`,
      { method: "PUT", headers, body: bytes });
  }
  const finished = await (await request(apiUrl, fetchImpl, `/v1/publications/${publicationId}/finish`, { method: "POST", headers })).json();
  return { row: finished.row, reused: false };
}
