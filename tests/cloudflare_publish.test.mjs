import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkingSchema, canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { loadGroupingSchemaFolder } from "../site/grouping_schema_loader.mjs";
import { canonicalFolderHash, stableJson } from "../site/grouping_schema_writer.mjs";
import { lookupPublishedSchema } from "../site/publication_access.mjs";
import { loadPublishedSchema } from "../site/published_schema_loader.mjs";
import { browsePublishedSplits } from "../site/published_split_browser.mjs";
import { canonicalPublishedReference } from "../site/schema_source.mjs";
import { handle } from "../cloudflare/publish-worker/src/index.mjs";
import { fakeD1, fakeR2 } from "./support/fake_cloudflare.mjs";

// The viewer's publishing client talking to the real worker code (fake R2 and SQLite behind it).
const API = "https://echo-api.test";
const FILES = "https://data.epistemicinfra.org/published-schemas/";
const schema = groups => ({ schema_version: "groupings-v3", grouping_set_id: "test", label: "Test",
  membership_unit: "canonical_variable", built_against: { record_signature: "snapshot" }, groups });
const group = (group_id, variable_ids) => ({ group_id, label: group_id, variable_ids });
const PARENT = "00000000-0000-4000-8000-000000000099";

async function world(parentPrefix = "old") {
  const env = { DB: fakeD1(), BUCKET: fakeR2(), TURNSTILE_SECRET: "s", OWNER_SECRET: "o", ALLOWED_ORIGINS: "", OBJECT_PREFIX: "published-schemas/" };
  const original = schema([group("education", ["a", "b"]), group("health", ["c"])]);
  for (const [path, bytes] of (await canonicalizeWorkingSchema(original)).files) await env.BUCKET.put(`published-schemas/${parentPrefix}/${path}`, bytes);
  const challenges = [];
  const turnstile = async () => new Response(JSON.stringify({ success: true }));
  const apiFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body instanceof Uint8Array) headers.set("content-length", String(init.body.length));
    challenges.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return handle(new Request(url, { ...init, headers }), env, { fetchImpl: turnstile, now: 1_800_000_000 });
  };
  // Published files are read from R2 by their public address.
  const readFetch = async url => {
    const key = decodeURIComponent(String(url).replace(FILES, "published-schemas/"));
    const object = env.BUCKET.objects.get(key);
    return object ? new Response(object.bytes) : new Response(null, { status: 404 });
  };
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  let solved = 0;
  const cloudflare = { apiUrl: API, fetchImpl: apiFetch, storage, solve: async () => { solved++; return "good-token"; } };
  return { env, original, readFetch, cloudflare, calls: challenges, store, solved: () => solved, parentPrefix };
}

const publish = (w, changed, overrides = {}) => publishWorkingSchema({ schema: changed, source: "cloudflare", cloudflare: w.cloudflare,
  previousPublication: { publication_id: PARENT, storage_prefix: w.parentPrefix }, client: null, fetchImpl: w.readFetch,
  compileInput: { rawLinks: [] }, ...overrides });

test("a schema published from a Cloudflare page lands in R2 and the D1 registry and loads back identically", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const result = await publish(w, changed);
  assert.equal(result.reused, false);
  const prefix = `${result.owner_id}/${result.publicationId}/`;
  assert.equal(result.storage_prefix, prefix.slice(0, -1));
  const written = [...w.env.BUCKET.objects.keys()].filter(key => key.startsWith(`published-schemas/${prefix}`)).map(key => key.slice(`published-schemas/${prefix}`.length));
  assert.ok(written.includes("manifest.json") && written.includes("compiled/manifest.json") && written.includes("memberships/verbal.tsv"));
  assert.equal(written.includes("memberships/health.tsv"), false, "unchanged memberships are references, not copies");
  assert.equal(result.fileCount, written.length);

  const manifest = JSON.parse(new TextDecoder().decode(w.env.BUCKET.objects.get(`published-schemas/${prefix}manifest.json`).bytes));
  // References are stored in the one canonical (Supabase) form, even though the parent was read from R2.
  assert.equal(manifest.group_membership_references.health,
    canonicalPublishedReference(`${FILES}old/memberships/health.tsv`));

  // The registry answers for it, and the files read back to the same canonical hash.
  const row = await lookupPublishedSchema(result.publicationId, null, { source: "cloudflare", apiUrl: API, fetchImpl: w.cloudflare.fetchImpl });
  assert.equal(row.content_hash, result.contentHash);
  assert.equal(row.storage_prefix, prefix.slice(0, -1));
  const loaded = await loadGroupingSchemaFolder(`${FILES}${prefix}`, w.readFetch);
  assert.deepEqual(loaded.groups.find(g => g.group_id === "health").variable_ids, ["c"]);
  const logical = new Map(written.filter(path => !path.startsWith("compiled/")).map(path => [path, w.env.BUCKET.objects.get(`published-schemas/${prefix}${path}`).bytes]));
  delete manifest.group_membership_references;
  logical.set("manifest.json", new TextEncoder().encode(stableJson(manifest)));
  logical.set("memberships/health.tsv", w.env.BUCKET.objects.get("published-schemas/old/memberships/health.tsv").bytes);
  assert.equal(await canonicalFolderHash(logical), result.contentHash);
});

test("the owner is created once and remembered, and publishing the same content again reuses the publication", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const first = await publish(w, changed);
  assert.equal(w.solved(), 1);
  assert.match(w.store.get("echo-owner-token"), /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  const objects = w.env.BUCKET.objects.size;
  const second = await publish(w, changed);
  assert.equal(w.solved(), 1, "no second human check");
  assert.equal(second.reused, true);
  assert.equal(second.publicationId, first.publicationId);
  assert.equal(w.env.BUCKET.objects.size, objects, "nothing was written again");
  // Another browser is another owner, with its own publication of the same bytes.
  const stranger = await world();
  stranger.env.BUCKET = w.env.BUCKET;
  stranger.env.DB = w.env.DB;
  const third = await publish(stranger, changed);
  assert.equal(third.reused, false);
  assert.notEqual(third.owner_id, first.owner_id);
});

test("publishing from a Cloudflare page without the worker configured is refused, not sent to Supabase", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("health", ["c"])]);
  const calls = [];
  const client = new Proxy({}, { get: (_, name) => { calls.push(name); throw new Error("Supabase must not be used"); } });
  await assert.rejects(publishWorkingSchema({ schema: changed, source: "cloudflare", cloudflare: { apiUrl: "" }, client,
    previousPublication: { publication_id: PARENT, storage_prefix: "old" }, fetchImpl: w.readFetch, compileInput: { rawLinks: [] } }),
  /not set up yet/);
  assert.deepEqual(calls, []);
});

test("a service failure while writing files surfaces instead of registering a half-written publication", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  let puts = 0;
  const flaky = async (url, init = {}) => {
    if (init.method === "PUT" && ++puts === 3) return new Response(JSON.stringify({ error: "server_error", message: "boom" }), { status: 500 });
    return w.cloudflare.fetchImpl(url, init);
  };
  await assert.rejects(publish(w, changed, { cloudflare: { ...w.cloudflare, fetchImpl: flaky } }), /boom/);
  assert.equal(w.env.DB.raw.prepare("select count(*) as n from published_schemas").get().n, 0, "nothing registered");
});

test("splits and registry reads use the worker only on a Cloudflare page with the worker configured", async () => {
  const w = await world();
  w.env.DB.raw.prepare("insert into published_schemas (id, owner_id, content_hash, title, storage_prefix) values (?, 'o', ?, 't', 'o/p')")
    .run(PARENT, "0".repeat(64));
  w.env.DB.raw.prepare("insert into published_split_index (publication_id, group_id, split_id, source_group_ids, name, description, storage_prefix, membership_path, owner_id, published_at, quality_status) values (?, 'g', 's', ?, 'n', 'a long enough description', 'o/p', 'memberships/g.tsv', 'o', '2026-01-01T00:00:00Z', 'approved')")
    .run(PARENT, JSON.stringify(["a", "b"]));
  const rows = await browsePublishedSplits(["a", "b"], null, { source: "cloudflare", apiUrl: API, fetchImpl: w.cloudflare.fetchImpl });
  assert.deepEqual(rows.map(row => row.group_id), ["g"]);
  assert.deepEqual(rows[0].source_group_ids, ["a", "b"]);
  // On the default source, or without the worker's address, the Supabase client is still required.
  await assert.rejects(browsePublishedSplits(["a"], null, { source: "supabase", apiUrl: API }), /Supabase is not configured/);
  await assert.rejects(browsePublishedSplits(["a"], null, { source: "cloudflare", apiUrl: "" }), /Supabase is not configured/);
  await assert.rejects(lookupPublishedSchema(PARENT, null, { source: "supabase", apiUrl: API }), /Supabase is not configured/);
});

test("a published schema that references its parent's files loads and verifies, even when both folder names are the same length", async () => {
  // Real folders are '<owner uuid>/<publication uuid>'. The loader once filed a parent's file under a slice of its address,
  // which for same-length folders was the real path, and then deleted it, so every such schema failed verification.
  const w = await world(`${"a".repeat(8)}-0000-4000-8000-000000000001/${"b".repeat(8)}-0000-4000-8000-000000000002`);
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const result = await publish(w, changed);
  const savedLocation = globalThis.location, savedFetch = globalThis.fetch;
  globalThis.location = new URL("https://echo.test/?schema_source=cloudflare");
  // The registry is read with the page's fetch, the files with the one passed in.
  globalThis.fetch = (url, init) => w.cloudflare.fetchImpl(url, init);
  try {
    const published = await loadPublishedSchema(result.publicationId, null, w.readFetch);
    const loaded = await published.loadSchema();
    assert.deepEqual(loaded.schema.groups.find(item => item.group_id === "health").variable_ids, ["c"], "a parent's file, by reference");
    assert.deepEqual(loaded.schema.groups.find(item => item.group_id === "verbal").variable_ids, ["a"], "its own file");
  } finally {
    globalThis.location = savedLocation;
    globalThis.fetch = savedFetch;
  }
});
