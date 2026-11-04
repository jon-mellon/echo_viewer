import test from "node:test";
import assert from "node:assert/strict";
import { publishedFileUrl, publishedFileKey, publishedReferenceUrl,
  canonicalPublishedReference, isPublishedFileUrl } from "../site/schema_source.mjs";
import { publicSchemaBaseUrl } from "../site/publication_access.mjs";
import { publicationPermalink } from "../site/published_schema_loader.mjs";
import { freshProjectUrl } from "../site/task_views.mjs";

const key = "o/p/memberships/a.tsv";
const r2 = `https://data.epistemicinfra.org/published-schemas/${key}`;
const legacy = `https://xfsivvvmsgzbdnthupzg.supabase.co/storage/v1/object/public/published-schemas/${key}`;

test("public files use R2 and historical references resolve to the same key", () => {
  assert.equal(publishedFileUrl(key), r2);
  assert.equal(publishedFileKey(r2), key);
  assert.equal(publishedFileKey(legacy), key);
  assert.equal(publishedReferenceUrl(legacy, "https://data.epistemicinfra.org/published-schemas/o/child/").href, r2);
  assert.equal(canonicalPublishedReference(legacy), r2);
  assert.equal(canonicalPublishedReference(r2), r2);
  assert.equal(publicSchemaBaseUrl(null, "o/p"), "https://data.epistemicinfra.org/published-schemas/o/p/");
  assert.equal(isPublishedFileUrl(new URL(r2), new URL("https://data.epistemicinfra.org/published-schemas/o/child/")), true);
});

test("unknown and unsafe addresses are not accepted as published files", () => {
  for (const address of ["https://evil.example/a.tsv", "https://data.epistemicinfra.org/other/a.tsv",
    "https://data.epistemicinfra.org/published-schemas/o/%2E%2E/a.tsv"]) {
    assert.equal(publishedFileKey(address), null);
    assert.equal(publishedReferenceUrl(address, r2), null);
    assert.throws(() => canonicalPublishedReference(address), /Not a published schema/);
  }
});

test("new view and publication links drop old source selectors", () => {
  const page = new URL("https://echo.example/app/?schema_source=supabase");
  assert.equal(new URL(publicationPermalink("pub-1", page, null)).searchParams.has("schema_source"), false);
  assert.equal(new URL(freshProjectUrl("https://echo.example/app/?schema=s&schema_source=supabase")).searchParams.has("schema_source"), false);
});
