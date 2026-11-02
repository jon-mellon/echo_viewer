import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCHEMA_SOURCE, canonicalPublishedReference, publishedFileKey, publishedFileUrl,
  publishedReferenceUrl, schemaSource, schemaSourceOfUrl, schemaSourceRequested } from "../site/schema_source.mjs";
import { publicSchemaBaseUrl } from "../site/publication_access.mjs";
import { buildPermalink } from "../site/dag_permalink.mjs";
import { freshProjectUrl } from "../site/task_views.mjs";
import { publicationPermalink } from "../site/published_schema_loader.mjs";
import { SUPABASE_URL } from "../site/supabase_config.mjs";

const KEY = "owner-1/pub-1/groups/category-age.tsv";
const SUPABASE_FILE = `${SUPABASE_URL}/storage/v1/object/public/published-schemas/${KEY}`;
const CLOUDFLARE_FILE = `https://data.epistemicinfra.org/published-schemas/${KEY}`;
const at = href => ({ href });

test("Supabase stays the default until it is changed on purpose", () => {
  assert.equal(DEFAULT_SCHEMA_SOURCE, "supabase");
  assert.equal(schemaSource(at("https://echo.example/?p=1")), "supabase");
  assert.equal(schemaSource(undefined), "supabase");
  assert.equal(schemaSource(at("https://echo.example/?schema_source=cloudflare")), "cloudflare");
  assert.equal(schemaSource(at("https://echo.example/?schema_source=supabase")), "supabase");
  assert.equal(schemaSource(at("https://echo.example/?schema_source=elsewhere")), "supabase", "an unknown source falls back to the default");
});

test("a page that names a source is the only one that keeps naming it", () => {
  assert.equal(schemaSourceRequested(at("https://echo.example/?p=1")), false);
  assert.equal(schemaSourceRequested(at("https://echo.example/?schema_source=cloudflare")), true);
  assert.equal(schemaSourceRequested(at("https://echo.example/?schema_source=bogus")), false);
});

test("the same key has an address on each source, and either address gives the key back", () => {
  assert.equal(publishedFileUrl(KEY, "supabase"), SUPABASE_FILE);
  assert.equal(publishedFileUrl(KEY, "cloudflare"), CLOUDFLARE_FILE);
  assert.equal(publishedFileKey(SUPABASE_FILE), KEY);
  assert.equal(publishedFileKey(CLOUDFLARE_FILE), KEY);
  assert.equal(publishedFileUrl("o/p/a b.tsv", "cloudflare"), "https://data.epistemicinfra.org/published-schemas/o/p/a%20b.tsv");
  assert.equal(publishedFileKey("https://data.epistemicinfra.org/published-schemas/o/p/a%20b.tsv"), "o/p/a b.tsv");
  assert.equal(schemaSourceOfUrl(CLOUDFLARE_FILE), "cloudflare");
  assert.equal(schemaSourceOfUrl(SUPABASE_FILE), "supabase");
});

test("only published schema files are accepted", () => {
  for (const url of ["https://evil.example/published-schemas/o/p/a.tsv",
    "https://data.epistemicinfra.org/evidence/layouts/browser-v2/x/manifest.json",
    "https://data.epistemicinfra.org/published-schemas/",
    "https://data.epistemicinfra.org/published-schemas/o/../../etc/passwd",
    `${SUPABASE_URL}/storage/v1/object/public/other-bucket/o/p/a.tsv`,
    `${SUPABASE_URL}/rest/v1/published_schemas`]) {
    assert.equal(publishedFileKey(url), null, url);
  }
  const base = `${SUPABASE_URL}/storage/v1/object/public/published-schemas/o/p/`;
  assert.equal(publishedReferenceUrl("https://evil.example/published-schemas/o/p/a.tsv", base), null);
  assert.throws(() => canonicalPublishedReference("https://evil.example/x"), /Not a published schema/);
});

test("a parent's file reference is read from the same source as the schema that holds it", () => {
  const supabaseBase = `${SUPABASE_URL}/storage/v1/object/public/published-schemas/o/child/`;
  const cloudflareBase = "https://data.epistemicinfra.org/published-schemas/o/child/";
  // Manifests store the Supabase address.
  assert.equal(publishedReferenceUrl(SUPABASE_FILE, supabaseBase).href, SUPABASE_FILE, "unchanged on Supabase");
  assert.equal(publishedReferenceUrl(SUPABASE_FILE, cloudflareBase).href, CLOUDFLARE_FILE, "translated for Cloudflare");
  assert.equal(publishedReferenceUrl(CLOUDFLARE_FILE, supabaseBase).href, SUPABASE_FILE, "and back");
  assert.equal(publishedReferenceUrl(CLOUDFLARE_FILE, cloudflareBase).href, CLOUDFLARE_FILE);
  // Stored references stay in one form, whichever source was read.
  assert.equal(canonicalPublishedReference(CLOUDFLARE_FILE), SUPABASE_FILE);
  assert.equal(canonicalPublishedReference(SUPABASE_FILE), SUPABASE_FILE);
});

test("the schema folder comes from the page's source", () => {
  const client = { storage: { from: () => ({ getPublicUrl: path => ({ data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/published-schemas/${path}` } }) }) } };
  assert.equal(publicSchemaBaseUrl(client, "o/p", "supabase"), `${SUPABASE_URL}/storage/v1/object/public/published-schemas/o/p/`);
  assert.equal(publicSchemaBaseUrl(client, "o/p", "cloudflare"), "https://data.epistemicinfra.org/published-schemas/o/p/");
  // Without a browser location the default applies, and Cloudflare needs no Supabase client at all.
  assert.equal(publicSchemaBaseUrl(client, "o/p"), `${SUPABASE_URL}/storage/v1/object/public/published-schemas/o/p/`);
  assert.equal(publicSchemaBaseUrl(null, "o/p", "cloudflare"), "https://data.epistemicinfra.org/published-schemas/o/p/");
});

test("links and fresh projects keep the source only when the page named one", () => {
  const state = { project: { iv_group_id: "a", dv_group_id: "b" }, task: "causes", workflowMode: "setup",
    explore: { causes: {}, consequences: {} } };
  const link = href => new URL(buildPermalink({ location: new URL(href), schemaUrl: "", dataVersion: "v", state }));
  assert.equal(link("https://echo.example/?schema_source=cloudflare").searchParams.get("schema_source"), "cloudflare");
  assert.equal(link("https://echo.example/?p=1").searchParams.has("schema_source"), false);
  assert.equal(new URL(freshProjectUrl("https://echo.example/app/?task=causes&schema=s&schema_source=cloudflare")).searchParams.get("schema_source"), "cloudflare");
  assert.equal(new URL(freshProjectUrl("https://echo.example/app/?task=causes&schema=s")).searchParams.has("schema_source"), false);
});

test("a shared publication link keeps the source the page named", () => {
  const page = search => ({ origin: "https://echo.example", pathname: "/app/", href: `https://echo.example/app/${search}` });
  assert.equal(new URL(publicationPermalink("pub-1", page("?schema_source=cloudflare"), null)).searchParams.get("schema_source"), "cloudflare");
  assert.equal(new URL(publicationPermalink("pub-1", page("?p=1"), null)).searchParams.has("schema_source"), false);
});

test("a reference on the host the schema is already on is used as it is, and one outside the published area is refused", () => {
  const base = "https://example.test/storage/v1/object/public/published-schemas/old/";
  const same = "https://example.test/storage/v1/object/public/published-schemas/old/memberships/health.tsv";
  assert.equal(publishedReferenceUrl(same, base).href, same);
  assert.equal(canonicalPublishedReference(same), same, "stored unchanged");
  assert.equal(publishedReferenceUrl("https://example.test/elsewhere/health.tsv", base), null);
  assert.equal(publishedReferenceUrl(new URL("memberships/a.tsv", base).href, base).href, new URL("memberships/a.tsv", base).href);
});
