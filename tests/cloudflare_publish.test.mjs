import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkingSchema, canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { loadGroupingSchemaFolder } from "../site/grouping_schema_loader.mjs";
import { canonicalFolderHash, stableJson } from "../site/grouping_schema_writer.mjs";
import { lookupPublishedSchema } from "../site/publication_access.mjs";
import { loadPublishedSchema } from "../site/published_schema_loader.mjs";
import { browsePublishedSplits } from "../site/published_split_browser.mjs";
import { canonicalPublishedReference } from "../site/schema_source.mjs";
import { fakePublishService } from "./support/fake_publish_service.mjs";

// The viewer's publishing client talking to an in-memory stand-in for the publishing service (docs/publishing-api.md).
const API = "https://echo-api.test";
const FILES = "https://data.epistemicinfra.org/published-schemas/";
const schema = groups => ({ schema_version: "groupings-v3", grouping_set_id: "test", label: "Test",
  membership_unit: "canonical_variable", built_against: { record_signature: "snapshot" }, groups });
const group = (group_id, variable_ids) => ({ group_id, label: group_id, variable_ids });
const PARENT = "00000000-0000-4000-8000-000000000099";

async function world(parentPrefix = "old", service = null) {
  const first = !service;
  service ||= fakePublishService();
  const original = schema([group("education", ["a", "b"]), group("health", ["c"])]);
  if (first) for (const [path, bytes] of (await canonicalizeWorkingSchema(original)).files) service.objects.set(`published-schemas/${parentPrefix}/${path}`, { bytes });
  const calls = [];
  const apiFetch = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${new URL(url).pathname}`);
    return service.fetchImpl(url, init);
  };
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  let solved = 0;
  const cloudflare = { apiUrl: API, fetchImpl: apiFetch, storage, solve: async () => { solved++; return "good-token"; } };
  return { service, original, readFetch: service.readFetch, cloudflare, calls, store, solved: () => solved, parentPrefix };
}

const publish = (w, changed, overrides = {}) => publishWorkingSchema({ schema: changed, source: "cloudflare", cloudflare: w.cloudflare,
  previousPublication: { publication_id: PARENT, storage_prefix: w.parentPrefix }, client: null, fetchImpl: w.readFetch,
  compileInput: { rawLinks: [] }, ...overrides });

test("a schema published from a Cloudflare page lands in R2 with its registry row and loads back identically", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const result = await publish(w, changed);
  assert.equal(result.reused, false);
  const prefix = `${result.owner_id}/${result.publicationId}/`;
  assert.equal(result.storage_prefix, prefix.slice(0, -1));
  const written = [...w.service.objects.keys()].filter(key => key.startsWith(`published-schemas/${prefix}`)).map(key => key.slice(`published-schemas/${prefix}`.length));
  assert.ok(written.includes("manifest.json") && written.includes("compiled/manifest.json") && written.includes("memberships/verbal.tsv"));
  assert.equal(written.includes("memberships/health.tsv"), false, "unchanged memberships are references, not copies");
  assert.equal(result.fileCount, written.length);

  const manifest = JSON.parse(new TextDecoder().decode(w.service.objects.get(`published-schemas/${prefix}manifest.json`).bytes));
  // References are stored in the one canonical (Supabase) form, even though the parent was read from R2.
  assert.equal(manifest.group_membership_references.health,
    canonicalPublishedReference(`${FILES}old/memberships/health.tsv`));

  // The registry answers for it, and the files read back to the same canonical hash.
  // The registry row is read from its static file beside the publication's files, not from the worker.
  const row = await lookupPublishedSchema(result.publicationId, null, { source: "cloudflare", fetchImpl: w.readFetch });
  assert.equal(row.content_hash, result.contentHash);
  assert.equal(row.storage_prefix, prefix.slice(0, -1));
  const loaded = await loadGroupingSchemaFolder(`${FILES}${prefix}`, w.readFetch);
  assert.deepEqual(loaded.groups.find(g => g.group_id === "health").variable_ids, ["c"]);
  const logical = new Map(written.filter(path => !path.startsWith("compiled/")).map(path => [path, w.service.objects.get(`published-schemas/${prefix}${path}`).bytes]));
  delete manifest.group_membership_references;
  logical.set("manifest.json", new TextEncoder().encode(stableJson(manifest)));
  logical.set("memberships/health.tsv", w.service.objects.get("published-schemas/old/memberships/health.tsv").bytes);
  assert.equal(await canonicalFolderHash(logical), result.contentHash);
});

test("the owner is created once and remembered, and publishing the same content again reuses the publication", async () => {
  const w = await world();
  const changed = schema([group("verbal", ["a"]), group("nonverbal", ["b"]), group("health", ["c"])]);
  const first = await publish(w, changed);
  assert.equal(w.solved(), 1);
  assert.match(w.store.get("echo-owner-token"), /^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  const objects = w.service.objects.size;
  const second = await publish(w, changed);
  assert.equal(w.solved(), 1, "no second human check");
  assert.equal(second.reused, true);
  assert.equal(second.publicationId, first.publicationId);
  assert.equal(w.service.objects.size, objects, "nothing was written again");
  // Another browser is another owner, with its own publication of the same bytes.
  const stranger = await world("old", w.service);
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
  assert.equal(w.service.rows.size, 0, "nothing registered");
});

test("splits and registry reads use the worker only on a Cloudflare page with the worker configured", async () => {
  const w = await world();
  w.service.addSplit({ publication_id: PARENT, group_id: "g", split_id: "s", source_group_ids: ["a", "b"], name: "n",
    description: "a long enough description", storage_prefix: "o/p", membership_path: "memberships/g.tsv", owner_id: "o", published_at: "2026-01-01T00:00:00Z" });
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
  // The registry row is a static file, read with the page's fetch like the files; no call reaches the worker.
  const workerCalls = [];
  globalThis.fetch = (url, init) => String(url).startsWith(FILES) ? w.readFetch(url) : (workerCalls.push(String(url)), w.cloudflare.fetchImpl(url, init));
  try {
    const published = await loadPublishedSchema(result.publicationId, null, w.readFetch);
    const loaded = await published.loadSchema();
    assert.deepEqual(loaded.schema.groups.find(item => item.group_id === "health").variable_ids, ["c"], "a parent's file, by reference");
    assert.deepEqual(loaded.schema.groups.find(item => item.group_id === "verbal").variable_ids, ["a"], "its own file");
    assert.deepEqual(workerCalls, [], "reading a publication needs no worker request");
  } finally {
    globalThis.location = savedLocation;
    globalThis.fetch = savedFetch;
  }
});

test("a registry row is only accepted for the publication asked for, and with the fields the viewer relies on", async () => {
  const good = { id: PARENT, owner_id: "o", content_hash: "h".repeat(64), title: "T", storage_prefix: "o/p" };
  const serve = body => async () => body === null ? new Response(null, { status: 404 }) : new Response(JSON.stringify(body));
  const read = (body, id = PARENT) => lookupPublishedSchema(id, null, { source: "cloudflare", fetchImpl: serve(body) });
  assert.deepEqual(await read(good), good);
  await assert.rejects(read(null), /No published schema.*HTTP 404/);
  await assert.rejects(read({ ...good, id: "00000000-0000-4000-8000-0000000000aa" }), /not valid/, "another publication's row");
  for (const field of ["owner_id", "content_hash", "title", "storage_prefix"]) {
    await assert.rejects(read({ ...good, [field]: "" }), /not valid/, field);
  }
  await assert.rejects(read("a string"), /not valid/);
  await assert.rejects(lookupPublishedSchema("nope", null, { source: "cloudflare", fetchImpl: serve(good) }), /Invalid schema publication ID/);
  // The static file is found beside the publication's other files.
  const urls = [];
  await lookupPublishedSchema(PARENT.toUpperCase(), null, { source: "cloudflare", fetchImpl: async url => { urls.push(String(url)); return new Response(JSON.stringify(good)); } });
  assert.deepEqual(urls, [`${FILES}_registry/${PARENT}.json`], "lower-cased, under published-schemas/_registry/");
});
