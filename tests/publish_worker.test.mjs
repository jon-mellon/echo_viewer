import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, cleanExpiredUploads, handle } from "../cloudflare/publish-worker/src/index.mjs";
import { fakeD1, fakeR2 } from "./support/fake_cloudflare.mjs";

const ORIGIN = "https://echo.epistemicinfra.org";
const API = "https://api.example";
const NOW = 1_800_000_000;
const encoder = new TextEncoder();

function setup() {
  const env = { DB: fakeD1(), BUCKET: fakeR2(), TURNSTILE_SECRET: "ts-secret", OWNER_SECRET: "owner-secret",
    ALLOWED_ORIGINS: `${ORIGIN},https://www.jonathanmellon.com`, OBJECT_PREFIX: "published-schemas/" };
  const turnstile = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(init.body);
    turnstile.push(Object.fromEntries(body));
    return new Response(JSON.stringify({ success: body.get("response") === "good-token" }));
  };
  const call = (method, path, { body, headers = {}, now = NOW, address = "1.2.3.4", raw } = {}) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const request = new Request(API + path, { method, body: payload, headers: { "cf-connecting-ip": address, origin: ORIGIN, ...headers } });
    return handle(request, env, { fetchImpl, now });
  };
  return { env, call, turnstile };
}

async function newOwner(call, address = "1.2.3.4") {
  const response = await call("POST", "/v1/owners", { body: { turnstile: "good-token" }, address });
  assert.equal(response.status, 201);
  return (await response.json()).token;
}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = n => String(n).padStart(64, "0");
const files = { "manifest.json": encoder.encode('{"format_version":"groupings-v3"}'), "groups.tsv": encoder.encode("group_id\tlabel\n"),
  "compiled/manifest.json": encoder.encode("{}") };
const declared = Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length }));
const startBody = (n = 1, extra = {}) => ({ publication_id: id(n), content_hash: hash(n), compiler_version: "1",
  row: { title: "A schema", description: "d", evidence_snapshot: "snap", parent_schema_id: id(99),
    compiled_manifest_path: "compiled/manifest.json", compiled_manifest_hash: hash(7) }, files: declared, ...extra });
const authed = token => ({ "x-owner-token": token });
const put = (call, token, n, path, bytes, extra = {}) => call("PUT", `/v1/publications/${id(n)}/files/${path}`,
  { raw: bytes, headers: { ...authed(token), "content-length": String(bytes.length), ...extra } });

async function publish(call, token, n = 1) {
  assert.equal((await call("POST", "/v1/publications", { body: startBody(n), headers: authed(token) })).status, 201);
  for (const [path, bytes] of Object.entries(files)) assert.equal((await put(call, token, n, path, bytes)).status, 204, path);
  return call("POST", `/v1/publications/${id(n)}/finish`, { headers: authed(token) });
}

test("an owner needs a verified Turnstile token, and the token it gets is checked on every use", async () => {
  const { call, turnstile } = setup();
  assert.equal((await call("POST", "/v1/owners", { body: {} })).status, 400);
  assert.equal((await call("POST", "/v1/owners", { body: { turnstile: "bad" } })).status, 403);
  const token = await newOwner(call);
  assert.match(token, /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  assert.equal(turnstile.at(-1).secret, "ts-secret");
  assert.equal(turnstile.at(-1).remoteip, "1.2.3.4");
  const forged = `${token.split(".")[0]}.${"0".repeat(64)}`;
  assert.equal((await call("POST", "/v1/publications", { body: startBody(), headers: authed(forged) })).status, 401);
  assert.equal((await call("POST", "/v1/publications", { body: startBody() })).status, 401);
});

test("owners are limited per address", async () => {
  const { call } = setup();
  for (let i = 0; i < LIMITS.ownersPerAddressPerHour; i++) await newOwner(call, "9.9.9.9");
  assert.equal((await call("POST", "/v1/owners", { body: { turnstile: "good-token" }, address: "9.9.9.9" })).status, 429);
  assert.equal((await call("POST", "/v1/owners", { body: { turnstile: "good-token" }, address: "8.8.8.8" })).status, 201);
});

test("a publication is reserved, written file by file into R2, then registered and readable", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  const owner = token.split(".")[0];
  const finished = await publish(call, token);
  assert.equal(finished.status, 201);
  const { row } = await finished.json();
  assert.equal(row.storage_prefix, `${owner}/${id(1)}`);
  const registryFile = `published-schemas/_registry/${id(1)}.json`;
  assert.deepEqual([...env.BUCKET.objects.keys()].filter(key => key !== registryFile).sort(),
    Object.keys(files).map(path => `published-schemas/${owner}/${id(1)}/${path}`).sort());
  // The registry row is also a static file, identical to what the API answers, cached like the other files.
  const staticRow = JSON.parse(new TextDecoder().decode(env.BUCKET.objects.get(registryFile).bytes));
  assert.deepEqual(staticRow, await (await call("GET", `/v1/schemas/${id(1)}`)).json());
  assert.equal(env.BUCKET.objects.get(registryFile).httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.equal("total_bytes" in staticRow, false);
  assert.equal(staticRow.created_at, new Date(NOW * 1000).toISOString());
  const stored = env.BUCKET.objects.get(`published-schemas/${owner}/${id(1)}/manifest.json`);
  assert.deepEqual(stored.bytes, files["manifest.json"]);
  assert.equal(stored.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(stored.httpMetadata.contentType, "application/json");
  const read = await call("GET", `/v1/schemas/${id(1)}`);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(await read.json(), { ...row, created_at: (await (await call("GET", `/v1/schemas/${id(1)}`)).json()).created_at });
  // The reservation is gone once it is registered.
  assert.equal(env.DB.raw.prepare("select count(*) as n from publication_uploads").get().n, 0);
  assert.equal((await call("GET", "/v1/schemas/not-a-uuid")).status, 400);
  assert.equal((await call("GET", `/v1/schemas/${id(2)}`)).status, 404);
});

test("publishing the same content again returns the earlier publication", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  await publish(call, token);
  const again = await call("POST", "/v1/publications", { body: startBody(1, { publication_id: id(2) }), headers: authed(token) });
  assert.equal(again.status, 200);
  const body = await again.json();
  assert.equal(body.reused, true);
  assert.equal(body.row.id, id(1));
  assert.equal(env.DB.raw.prepare("select count(*) as n from publication_uploads").get().n, 0);
  // Another owner publishing the same bytes is a publication of their own.
  const other = await newOwner(call, "5.5.5.5");
  const theirs = await call("POST", "/v1/publications", { body: startBody(1, { publication_id: id(3) }), headers: authed(other) });
  assert.equal(theirs.status, 201);
});

test("published files are create-only: a file already written is never replaced", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  await publish(call, token);
  const key = `published-schemas/${token.split(".")[0]}/${id(1)}/manifest.json`;
  const before = env.BUCKET.objects.get(key).bytes;
  // A second reservation cannot reuse the id, and even a still-open one cannot overwrite a written file.
  assert.equal((await call("POST", "/v1/publications", { body: startBody(1, { content_hash: hash(5) }), headers: authed(token) })).status, 409);
  await call("POST", "/v1/publications", { body: startBody(4), headers: authed(token) });
  assert.equal((await put(call, token, 4, "manifest.json", files["manifest.json"])).status, 204);
  assert.equal((await put(call, token, 4, "manifest.json", files["manifest.json"])).status, 409);
  assert.deepEqual(env.BUCKET.objects.get(key).bytes, before);
});

test("only declared files of the owner's own open upload can be written", async () => {
  const { call } = setup();
  const token = await newOwner(call);
  const other = await newOwner(call, "6.6.6.6");
  await call("POST", "/v1/publications", { body: startBody(), headers: authed(token) });
  const bytes = encoder.encode("x");
  assert.equal((await put(call, token, 1, "extra.json", bytes)).status, 403, "undeclared");
  assert.equal((await put(call, token, 1, "groups.tsv", bytes)).status, 400, "wrong size");
  assert.equal((await put(call, token, 1, "groups.tsv", files["groups.tsv"], { "content-length": "999" })).status, 400);
  assert.equal((await put(call, other, 1, "groups.tsv", files["groups.tsv"])).status, 404, "someone else's upload");
  assert.equal((await put(call, token, 2, "groups.tsv", files["groups.tsv"])).status, 404, "no such upload");
  assert.equal((await call("PUT", `/v1/publications/${id(1)}/files/groups.tsv`, { raw: files["groups.tsv"] })).status, 401);
});

test("an upload expires, and finishing needs every declared file at its declared size", async () => {
  const { call } = setup();
  const token = await newOwner(call);
  await call("POST", "/v1/publications", { body: startBody(), headers: authed(token) });
  await put(call, token, 1, "manifest.json", files["manifest.json"]);
  const incomplete = await call("POST", `/v1/publications/${id(1)}/finish`, { headers: authed(token) });
  assert.equal(incomplete.status, 409);
  assert.deepEqual((await incomplete.json()).missing.sort(), ["compiled/manifest.json", "groups.tsv"]);
  assert.equal((await call("GET", `/v1/schemas/${id(1)}`)).status, 404, "nothing is registered until it is complete");
  const late = await put(call, token, 1, "groups.tsv", files["groups.tsv"]);
  assert.equal(late.status, 204);
  const expired = await call("PUT", `/v1/publications/${id(1)}/files/compiled/manifest.json`,
    { raw: files["compiled/manifest.json"], headers: { ...authed(token), "content-length": String(files["compiled/manifest.json"].length) }, now: NOW + LIMITS.uploadTtlSeconds + 1 });
  assert.equal(expired.status, 410);
});

test("requests that are malformed, oversized or aimed outside the publication are refused", async () => {
  const { call } = setup();
  const token = await newOwner(call);
  const start = body => call("POST", "/v1/publications", { body, headers: authed(token) });
  for (const [why, body] of [
    ["not an object", "nope"],
    ["bad id", startBody(1, { publication_id: "x" })],
    ["bad hash", startBody(1, { content_hash: "abc" })],
    ["no title", startBody(1, { row: { title: " " } })],
    ["no manifest", startBody(1, { files: [{ path: "groups.tsv", size: 1 }] })],
    ["traversal", startBody(1, { files: [...declared, { path: "../escape.json", size: 1 }] })],
    ["absolute", startBody(1, { files: [...declared, { path: "/etc/passwd", size: 1 }] })],
    ["empty segment", startBody(1, { files: [...declared, { path: "a//b.json", size: 1 }] })],
    ["duplicate", startBody(1, { files: [...declared, declared[0]] })],
    ["negative size", startBody(1, { files: [...declared, { path: "n.json", size: -1 }] })],
    ["huge file", startBody(1, { files: [...declared, { path: "big.tsv", size: LIMITS.maxFileBytes + 1 }] })],
    ["too many files", startBody(1, { files: Array.from({ length: LIMITS.maxFiles + 1 }, (_, i) => ({ path: i ? `f${i}.tsv` : "manifest.json", size: 1 })) })],
  ]) assert.ok([400, 413].includes((await start(body)).status), why);
  const total = startBody(1, { files: [...declared, ...Array.from({ length: 3 }, (_, i) => ({ path: `p${i}.tsv`, size: 15 * 1024 * 1024 }))] });
  assert.equal((await start(total)).status, 413, "total size");
  assert.equal((await call("POST", "/v1/publications", { raw: "{not json", headers: authed(token) })).status, 400);
  assert.equal((await call("GET", "/nothing")).status, 404);
  assert.equal((await call("DELETE", `/v1/schemas/${id(1)}`)).status, 404, "clients cannot delete");
});

test("an owner, an address and the service each have a daily publication limit", async () => {
  const { call } = setup();
  const token = await newOwner(call);
  for (let i = 1; i <= LIMITS.publicationsPerOwnerPerDay; i++) {
    assert.equal((await call("POST", "/v1/publications", { body: startBody(i, { content_hash: hash(i) }), headers: authed(token) })).status, 201);
  }
  const over = await call("POST", "/v1/publications", { body: startBody(500, { content_hash: hash(500) }), headers: authed(token) });
  assert.equal(over.status, 429);
  // The next day starts afresh.
  const tomorrow = await call("POST", "/v1/publications", { body: startBody(501, { content_hash: hash(501) }), headers: authed(token), now: NOW + 86400 });
  assert.equal(tomorrow.status, 201);
});

test("only the listed sites may call the API from a browser", async () => {
  const { call } = setup();
  const allowed = await call("GET", `/v1/schemas/${id(2)}`);
  assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
  const preflight = await call("OPTIONS", "/v1/publications");
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-owner-token/);
  const stranger = await call("GET", `/v1/schemas/${id(2)}`, { headers: { origin: "https://evil.example" } });
  assert.equal(stranger.headers.get("access-control-allow-origin"), null);
});

test("splits are listed for a source group, approved ones only, newest first", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  await publish(call, token);
  const insert = env.DB.raw.prepare("insert into published_split_index (publication_id, group_id, split_id, source_group_ids, name, description, storage_prefix, membership_path, owner_id, published_at, quality_status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (group, sources, at, status) => insert.run(id(1), group, `${group}-split`, JSON.stringify(sources), `${group} name`, "a long enough description", "p", "memberships/x.tsv", "o", at, status);
  row("old", ["a", "b"], "2026-01-01T00:00:00Z", "approved");
  row("new", ["a"], "2026-02-01T00:00:00Z", "approved");
  row("hidden", ["a"], "2026-03-01T00:00:00Z", "rejected");
  row("other", ["z"], "2026-04-01T00:00:00Z", "approved");
  const response = await call("GET", "/v1/splits?group_id=a");
  const rows = await response.json();
  assert.deepEqual(rows.map(item => item.group_id), ["new", "old"]);
  assert.deepEqual(rows[1].source_group_ids, ["a", "b"]);
  assert.equal((await call("GET", "/v1/splits")).status, 400);
});

test("uploads that never finished lose their files, and finished ones are kept", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  await publish(call, token, 1);
  await call("POST", "/v1/publications", { body: startBody(2, { content_hash: hash(2) }), headers: authed(token) });
  await put(call, token, 2, "manifest.json", files["manifest.json"]);
  const before = env.BUCKET.objects.size;
  const none = await cleanExpiredUploads(env, NOW + 10);
  assert.deepEqual(none, { uploads: 0, files: 0 });
  const swept = await cleanExpiredUploads(env, NOW + LIMITS.uploadTtlSeconds + 5);
  assert.deepEqual(swept, { uploads: 1, files: 1 });
  assert.equal(env.BUCKET.objects.size, before - 1);
  assert.ok([...env.BUCKET.objects.keys()].every(key => key.includes(id(1))), "the finished publication is untouched");
  assert.equal(env.DB.raw.prepare("select count(*) as n from publication_uploads").get().n, 0);
});

test("the Supabase registry exports to SQL that loads into D1, publications before their splits, and loads twice safely", async () => {
  const { registrySql } = await import("../cloudflare/publish-worker/scripts/export_registry_sql.mjs");
  const schemas = [{ id: id(1), owner_id: id(50), content_hash: hash(1), title: "It's a schema", description: null, evidence_snapshot: "s",
    storage_prefix: `${id(50)}/${id(1)}`, parent_schema_id: null, compiled_manifest_path: "compiled/manifest.json",
    compiled_manifest_hash: hash(2), compiler_version: "1", created_at: "2026-09-12T15:36:39.375306+00:00" }];
  const splits = [
    { publication_id: id(1), group_id: "g", split_id: "s", source_group_ids: ["a", "b"], name: "n", description: "a long enough description",
      storage_prefix: `${id(50)}/${id(1)}`, membership_path: "memberships/g.tsv", owner_id: id(50), published_at: "2026-10-15T00:00:00+00:00",
      quality_status: "approved", quality_reason: null, checked_at: "2026-10-15T00:00:00+00:00" },
    { publication_id: id(77), group_id: "orphan", split_id: "s", source_group_ids: ["a"], name: "n", description: "a long enough description",
      storage_prefix: "x", membership_path: "m", owner_id: id(50), published_at: "2026-10-15T00:00:00+00:00",
      quality_status: "approved", quality_reason: null, checked_at: "2026-10-15T00:00:00+00:00" },
  ];
  const sql = registrySql({ schemas, splits });
  assert.ok(sql.indexOf("published_schemas") < sql.indexOf("published_split_index"));
  const { env, call } = setup();
  env.DB.exec(sql);
  env.DB.exec(sql);
  assert.equal(env.DB.raw.prepare("select count(*) as n from published_schemas").get().n, 1);
  assert.equal(env.DB.raw.prepare("select count(*) as n from published_split_index").get().n, 1, "a split whose publication is unknown is left out");
  const read = await (await call("GET", `/v1/schemas/${id(1)}`)).json();
  assert.equal(read.title, "It's a schema");
  assert.equal(read.description, null);
  assert.deepEqual((await (await call("GET", "/v1/splits?group_id=b")).json())[0].source_group_ids, ["a", "b"]);
});

// A publication of `bytes` in total: a small manifest and the rest in files under the per-file cap.
const declaredBytes = (n, bytes, extra = {}) => {
  const manifest = Math.min(bytes, 1000), pieces = [];
  for (let left = bytes - manifest; left > 0; left -= 15 * 1024 * 1024) pieces.push(Math.min(left, 15 * 1024 * 1024));
  return startBody(n, { content_hash: hash(n), files: [{ path: "manifest.json", size: manifest },
    ...pieces.map((size, i) => ({ path: `p${i}.tsv`, size }))], ...extra });
};

test("bytes are limited per owner, per address and overall each day, and a day's allowance renews", async () => {
  const MB = 1024 * 1024;
  const { call } = setup();
  const token = await newOwner(call);
  const start = (n, bytes, options = {}) => call("POST", "/v1/publications", { body: declaredBytes(n, bytes), headers: authed(token), ...options });
  // Five 30 MB publications use the owner's 150 MB; the sixth is refused although publications are few.
  for (let n = 1; n <= 5; n++) assert.equal((await start(n, 30 * MB)).status, 201, `publication ${n}`);
  assert.equal((await start(6, 30 * MB)).status, 429, "owner byte allowance");
  assert.equal((await start(6, 1000)).status, 429, "even a small one, once the allowance is gone");
  assert.equal((await start(7, 30 * MB, { now: NOW + 86400 })).status, 201, "renewed the next day");
  // Owners on one address share its 300 MB: two owners spend it, and a third (with allowance of their own) is refused.
  const second = await newOwner(call);
  for (let n = 20; n < 25; n++) {
    assert.equal((await call("POST", "/v1/publications", { body: declaredBytes(n, 30 * MB), headers: authed(second) })).status, 201, `second owner ${n}`);
  }
  const crowd = await newOwner(call);
  assert.equal((await call("POST", "/v1/publications", { body: declaredBytes(40, 30 * MB), headers: authed(crowd) })).status, 429,
    "address byte allowance spent, though this owner has used none of theirs");
  // Another address is unaffected.
  const third = await newOwner(call, "7.7.7.7");
  assert.equal((await call("POST", "/v1/publications", { body: declaredBytes(30, 30 * MB), headers: authed(third), address: "7.7.7.7" })).status, 201);
});

test("publishing pauses at the storage ceiling, counting finished schemas and open uploads, and resumes when it is raised", async () => {
  const MB = 1024 * 1024;
  const { env, call } = setup();
  env.MAX_PUBLISHED_BYTES = String(60 * MB);
  const token = await newOwner(call);
  const start = (n, bytes) => call("POST", "/v1/publications", { body: declaredBytes(n, bytes), headers: authed(token) });
  assert.equal((await start(1, 25 * MB)).status, 201);
  assert.equal((await start(2, 25 * MB)).status, 201);
  const full = await start(3, 25 * MB);
  assert.equal(full.status, 507);
  assert.equal((await full.json()).error, "storage_full");
  assert.equal((await start(4, 5 * MB)).status, 201, "what still fits is accepted");
  env.MAX_PUBLISHED_BYTES = String(200 * MB);
  assert.equal((await start(3, 25 * MB)).status, 201, "raising the ceiling resumes publishing");
});

test("clients do not see the worker's byte bookkeeping, and the reserved bytes are what was declared", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  const finished = await publish(call, token);
  const { row } = await finished.json();
  assert.equal("total_bytes" in row, false);
  const stored = env.DB.raw.prepare("select total_bytes from published_schemas where id = ?").get(id(1)).total_bytes;
  assert.equal(stored, declared.reduce((total, file) => total + file.size, 0));
  const again = await (await call("POST", "/v1/publications", { body: startBody(1, { publication_id: id(2) }), headers: authed(token) })).json();
  assert.equal("total_bytes" in again.row, false);
});

test("the whole service has a daily byte allowance that no number of owners or addresses can get around", async () => {
  const { env, call } = setup();
  const window = Math.floor(NOW / 86400) * 86400;
  env.DB.raw.prepare("insert into rate_counters (scope, key, window, n) values ('global-bytes-day', 'all', ?, ?)").run(window, LIMITS.bytesPerDay - 500);
  const token = await newOwner(call, "3.3.3.3");
  const small = n => call("POST", "/v1/publications", { body: declaredBytes(n, 400), headers: authed(token), address: "3.3.3.3" });
  assert.equal((await small(1)).status, 201, "what is left of the allowance");
  assert.equal((await small(2)).status, 429, "then everyone is refused until the next day");
  const other = await newOwner(call, "4.4.4.4");
  assert.equal((await call("POST", "/v1/publications", { body: declaredBytes(3, 400), headers: authed(other), address: "4.4.4.4" })).status, 429);
});

test("finishing can be retried after registering failed: the static row is kept and the registry then agrees with it", async () => {
  const { env, call } = setup();
  const token = await newOwner(call);
  await call("POST", "/v1/publications", { body: startBody(), headers: authed(token) });
  for (const [path, bytes] of Object.entries(files)) await put(call, token, 1, path, bytes);
  // The first finish writes the static row, then the registry insert fails.
  env.DB.raw.exec("alter table published_schemas rename to published_schemas_away");
  const failed = await call("POST", `/v1/publications/${id(1)}/finish`, { headers: authed(token) });
  assert.equal(failed.status, 500);
  const registryFile = `published-schemas/_registry/${id(1)}.json`;
  const first = env.BUCKET.objects.get(registryFile).bytes;
  env.DB.raw.exec("alter table published_schemas_away rename to published_schemas");
  // A later finish (a different moment) leaves the static row alone, and D1 holds the same created_at.
  const retried = await call("POST", `/v1/publications/${id(1)}/finish`, { headers: authed(token), now: NOW + 600 });
  assert.equal(retried.status, 201);
  assert.deepEqual(env.BUCKET.objects.get(registryFile).bytes, first, "never rewritten");
  assert.equal((await (await call("GET", `/v1/schemas/${id(1)}`)).json()).created_at, JSON.parse(new TextDecoder().decode(first)).created_at);
});
