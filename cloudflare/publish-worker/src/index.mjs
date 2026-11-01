// Echo's publishing API. Anonymous people publish schemas without an account:
//   POST /v1/owners                      (Turnstile) -> an anonymous owner id and token
//   POST /v1/publications                (owner)     -> reserve a publication and the files it may write
//   PUT  /v1/publications/:id/files/*    (owner)     -> write one declared file, create-only, into R2
//   POST /v1/publications/:id/finish     (owner)     -> check the files are all there, then register it
//   GET  /v1/schemas/:id                             -> the registry row
//   GET  /v1/splits?group_id=...                     -> approved splits that include a source group
// Files are written once and never replaced or deleted by clients, so published
// schemas stay immutable. The viewer verifies content hashes when it reads them, so
// the worker bounds what can be written rather than recomputing the hash.

export const LIMITS = {
  maxFiles: 500,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 120 * 1024 * 1024,
  uploadTtlSeconds: 3600,
  ownersPerAddressPerHour: 20,
  publicationsPerOwnerPerDay: 30,
  publicationsPerAddressPerDay: 60,
  publicationsPerDay: 500,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const CONTENT_TYPES = { json: "application/json", yaml: "application/yaml", tsv: "text/tab-separated-values" };
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };

const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = { vary: "Origin" };
  if (origin && allowedOrigins(env).has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, PUT, OPTIONS";
    headers["access-control-allow-headers"] = "content-type, x-owner-token";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

function json(data, status, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
}

async function readJson(request, limit = 256 * 1024) {
  const text = await request.text();
  if (text.length > limit) fail(413, "too_large", "Request body is too large.");
  try { return JSON.parse(text); } catch { return fail(400, "bad_json", "Body must be JSON."); }
}

/** Counts one use of a limit in a fixed window; refuses once the limit is passed. */
async function spend(db, scope, key, windowSeconds, limit, now) {
  const window = Math.floor(now / windowSeconds) * windowSeconds;
  const row = await db.prepare(
    "insert into rate_counters (scope, key, window, n) values (?, ?, ?, 1) "
    + "on conflict (scope, key, window) do update set n = n + 1 returning n").bind(scope, key, window).first();
  if (row.n > limit) fail(429, "rate_limited", "Too many requests. Please try again later.");
}

async function verifyTurnstile(env, token, address, fetchImpl) {
  if (!token || typeof token !== "string") fail(400, "turnstile_required", "A Turnstile token is required.");
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (address) body.set("remoteip", address);
  const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json().catch(() => ({}));
  if (!result.success) fail(403, "turnstile_failed", "Could not verify that you are a person.");
}

async function ownerFrom(request, env) {
  const token = request.headers.get("x-owner-token") || "";
  const [ownerId, signature] = token.split(".");
  if (!UUID.test(ownerId || "") || !signature) fail(401, "owner_required", "An owner token is required.");
  if (!safeEqual(signature, await hmac(env.OWNER_SECRET, ownerId))) fail(401, "owner_invalid", "The owner token is not valid.");
  return ownerId;
}

function validatePublication(body) {
  if (!body || typeof body !== "object") fail(400, "bad_request", "Body must be an object.");
  const { publication_id: id, content_hash: contentHash, compiler_version: compilerVersion, row, files } = body;
  if (!UUID.test(id || "")) fail(400, "bad_publication_id", "publication_id must be a UUID.");
  if (!HASH.test(contentHash || "")) fail(400, "bad_content_hash", "content_hash must be a SHA-256 hex digest.");
  if (typeof compilerVersion !== "string" || !compilerVersion || compilerVersion.length > 16) fail(400, "bad_compiler_version", "compiler_version is required.");
  if (!row || typeof row !== "object" || typeof row.title !== "string" || !row.title.trim() || row.title.length > 300) fail(400, "bad_row", "row.title is required.");
  if (row.description != null && (typeof row.description !== "string" || row.description.length > 5000)) fail(400, "bad_row", "row.description is too long.");
  if (row.parent_schema_id != null && !UUID.test(row.parent_schema_id)) fail(400, "bad_row", "row.parent_schema_id must be a UUID.");
  for (const field of ["evidence_snapshot", "compiled_manifest_path", "compiled_manifest_hash"]) {
    if (row[field] != null && (typeof row[field] !== "string" || row[field].length > 300)) fail(400, "bad_row", `row.${field} is not valid.`);
  }
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.maxFiles) fail(400, "bad_files", `Between 1 and ${LIMITS.maxFiles} files are required.`);
  const seen = new Set();
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !PATH.test(file.path) || file.path.split("/").includes("..") || file.path.length > 200) fail(400, "bad_path", "A file path is not valid.");
    if (seen.has(file.path)) fail(400, "duplicate_path", `Duplicate path ${file.path}.`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.maxFileBytes) fail(400, "bad_size", `File ${file.path} has an unacceptable size.`);
    total += file.size;
  }
  if (total > LIMITS.maxTotalBytes) fail(413, "too_large", "The publication is too large.");
  if (!seen.has("manifest.json")) fail(400, "no_manifest", "manifest.json is required.");
  return { id: id.toLowerCase(), contentHash, compilerVersion, row, files };
}

const contentTypeOf = path => CONTENT_TYPES[path.split(".").pop()] || "application/octet-stream";
const objectKey = (env, prefix, path) => `${env.OBJECT_PREFIX || "published-schemas/"}${prefix}/${path}`;

async function startPublication(request, env, now, address) {
  const ownerId = await ownerFrom(request, env);
  const body = validatePublication(await readJson(request));
  const existing = await env.DB.prepare(
    "select * from published_schemas where owner_id = ? and content_hash = ? and compiler_version = ? limit 1")
    .bind(ownerId, body.contentHash, body.compilerVersion).first();
  if (existing) return json({ reused: true, row: existing }, 200);

  await spend(env.DB, "owner-day", ownerId, 86400, LIMITS.publicationsPerOwnerPerDay, now);
  await spend(env.DB, "address-day", address, 86400, LIMITS.publicationsPerAddressPerDay, now);
  await spend(env.DB, "global-day", "all", 86400, LIMITS.publicationsPerDay, now);
  const taken = await env.DB.prepare(
    "select 1 as taken from published_schemas where id = ? union all select 1 from publication_uploads where id = ?")
    .bind(body.id, body.id).first();
  if (taken) fail(409, "publication_exists", "That publication id is already in use.");

  const prefix = `${ownerId}/${body.id}`;
  const row = {
    id: body.id, owner_id: ownerId, content_hash: body.contentHash, title: body.row.title,
    description: body.row.description ?? null, evidence_snapshot: body.row.evidence_snapshot ?? null,
    storage_prefix: prefix, parent_schema_id: body.row.parent_schema_id ?? null,
    compiled_manifest_path: body.row.compiled_manifest_path ?? null,
    compiled_manifest_hash: body.row.compiled_manifest_hash ?? null, compiler_version: body.compilerVersion,
  };
  await env.DB.prepare(
    "insert into publication_uploads (id, owner_id, content_hash, row_json, files_json, expires_at) values (?, ?, ?, ?, ?, ?)")
    .bind(body.id, ownerId, body.contentHash, JSON.stringify(row), JSON.stringify(body.files), now + LIMITS.uploadTtlSeconds).run();
  return json({ reused: false, publication_id: body.id, storage_prefix: prefix, expires_in: LIMITS.uploadTtlSeconds }, 201);
}

async function reservation(env, ownerId, id, now) {
  if (!UUID.test(id)) fail(400, "bad_publication_id", "Invalid publication id.");
  const upload = await env.DB.prepare("select * from publication_uploads where id = ?").bind(id.toLowerCase()).first();
  if (!upload || upload.owner_id !== ownerId) fail(404, "no_upload", "No upload is open for this publication.");
  if (upload.expires_at < now) fail(410, "expired", "This upload has expired; start the publication again.");
  return { ...upload, row: JSON.parse(upload.row_json), files: JSON.parse(upload.files_json) };
}

async function putFile(request, env, id, path, now) {
  const ownerId = await ownerFrom(request, env);
  const upload = await reservation(env, ownerId, id, now);
  const declared = upload.files.find(file => file.path === path);
  if (!declared) fail(403, "undeclared_file", "That file was not declared when the publication started.");
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length !== declared.size) fail(400, "wrong_size", "Content-Length must equal the declared size.");
  if (!request.body && declared.size) fail(400, "no_body", "The file body is missing.");
  const stored = await env.BUCKET.put(objectKey(env, upload.row.storage_prefix, path), declared.size ? request.body : new Uint8Array(),
    { onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: contentTypeOf(path), cacheControl: CACHE_CONTROL } });
  if (stored === null) fail(409, "exists", "That file has already been written; published files are never replaced.");
  if (stored.size !== declared.size) fail(400, "wrong_size", "The body was not the declared size.");
  return new Response(null, { status: 204 });
}

async function finishPublication(request, env, id, now) {
  const ownerId = await ownerFrom(request, env);
  const upload = await reservation(env, ownerId, id, now);
  const folder = objectKey(env, upload.row.storage_prefix, "");
  const present = new Map();
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: folder, limit: 1000, cursor });
    for (const object of page.objects) present.set(object.key.slice(folder.length), object.size);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const missing = upload.files.filter(file => present.get(file.path) !== file.size).map(file => file.path);
  if (missing.length) return json({ error: "incomplete", message: "Some files are missing or the wrong size.", missing: missing.slice(0, 20) }, 409);
  const row = upload.row;
  await env.DB.batch([
    env.DB.prepare(
      "insert into published_schemas (id, owner_id, content_hash, title, description, evidence_snapshot, storage_prefix, parent_schema_id, "
      + "compiled_manifest_path, compiled_manifest_hash, compiler_version) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.owner_id, row.content_hash, row.title, row.description, row.evidence_snapshot, row.storage_prefix,
        row.parent_schema_id, row.compiled_manifest_path, row.compiled_manifest_hash, row.compiler_version),
    env.DB.prepare("delete from publication_uploads where id = ?").bind(row.id),
  ]);
  return json({ row }, 201);
}

async function getSchema(env, id) {
  if (!UUID.test(id)) fail(400, "bad_publication_id", "Invalid publication id.");
  const row = await env.DB.prepare(
    "select id, owner_id, content_hash, title, description, evidence_snapshot, storage_prefix, parent_schema_id, "
    + "compiled_manifest_path, compiled_manifest_hash, compiler_version, created_at from published_schemas where id = ?")
    .bind(id.toLowerCase()).first();
  if (!row) fail(404, "not_found", "No such published schema.");
  return json(row, 200, { "cache-control": "public, max-age=300" });
}

async function getSplits(env, groupId) {
  if (!groupId || groupId.length > 200) fail(400, "bad_group_id", "group_id is required.");
  const { results } = await env.DB.prepare(
    "select publication_id, group_id, split_id, source_group_ids, name, description, storage_prefix, membership_path, owner_id, published_at "
    + "from published_split_index where quality_status = 'approved' "
    + "and exists (select 1 from json_each(source_group_ids) where value = ?) order by published_at desc limit 100")
    .bind(groupId).all();
  const rows = results.map(row => ({ ...row, source_group_ids: JSON.parse(row.source_group_ids) }));
  return json(rows, 200, { "cache-control": "public, max-age=60" });
}

/** Removes the files of uploads that never finished, so abandoned attempts do not accumulate. */
export async function cleanExpiredUploads(env, now = Math.floor(Date.now() / 1000)) {
  const { results } = await env.DB.prepare("select id, row_json from publication_uploads where expires_at < ? limit 50").bind(now).all();
  let removed = 0;
  for (const upload of results) {
    const folder = objectKey(env, JSON.parse(upload.row_json).storage_prefix, "");
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: folder, limit: 1000, cursor });
      if (page.objects.length) await env.BUCKET.delete(page.objects.map(object => object.key));
      removed += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await env.DB.prepare("delete from publication_uploads where id = ?").bind(upload.id).run();
  }
  await env.DB.prepare("delete from rate_counters where window < ?").bind(now - 2 * 86400).run();
  return { uploads: results.length, files: removed };
}

export async function handle(request, env, { fetchImpl = fetch, now = Math.floor(Date.now() / 1000) } = {}) {
  const cors = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  try {
    let response;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") fail(404, "not_found", "Not found.");
    if (request.method === "POST" && parts[1] === "owners" && parts.length === 2) {
      await spend(env.DB, "owners-hour", address, 3600, LIMITS.ownersPerAddressPerHour, now);
      await verifyTurnstile(env, (await readJson(request)).turnstile, address, fetchImpl);
      const ownerId = crypto.randomUUID();
      response = json({ owner_id: ownerId, token: `${ownerId}.${await hmac(env.OWNER_SECRET, ownerId)}` }, 201);
    } else if (request.method === "POST" && parts[1] === "publications" && parts.length === 2) {
      response = await startPublication(request, env, now, address);
    } else if (request.method === "PUT" && parts[1] === "publications" && parts[3] === "files" && parts.length > 4) {
      response = await putFile(request, env, parts[2], decodeURIComponent(parts.slice(4).join("/")), now);
    } else if (request.method === "POST" && parts[1] === "publications" && parts[3] === "finish" && parts.length === 4) {
      response = await finishPublication(request, env, parts[2], now);
    } else if (request.method === "GET" && parts[1] === "schemas" && parts.length === 3) {
      response = await getSchema(env, parts[2]);
    } else if (request.method === "GET" && parts[1] === "splits" && parts.length === 2) {
      response = await getSplits(env, url.searchParams.get("group_id"));
    } else fail(404, "not_found", "Not found.");
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error.code || "server_error", message: error instanceof HttpError ? error.message : "Something went wrong." },
      status, cors);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (_event, env, context) => context.waitUntil(cleanExpiredUploads(env)),
};
