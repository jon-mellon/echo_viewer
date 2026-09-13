import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../site/dag_publication.mjs", import.meta.url), "utf8");

test("working publication deduplicates before allocating or uploading", () => {
  const lookup = source.indexOf("findOwnedPublication(client, user.id, canonical.contentHash)");
  const allocation = source.indexOf("cryptoApi.randomUUID()", lookup);
  const upload = source.indexOf(".upload(", lookup);
  assert.ok(lookup > 0 && allocation > lookup && upload > allocation);
  assert.match(source, /if \(existing\) return .*reused: true/);
});

test("registry insert follows every upload and preserves baseline lineage", () => {
  const upload = source.indexOf(".upload(");
  const insert = source.indexOf('.from("published_schemas").insert', upload);
  assert.ok(insert > upload);
  assert.match(source, /CANONICAL_BASELINE_ID = "a0118906-2366-4cc8-8809-bafdf3860c23"/);
  assert.match(source, /parent_schema_id: parentSchemaId/);
});

test("share compares the current canonical hash and shares the last public version when stale", () => {
  assert.match(source, /canonical\.contentHash !== published\.content_hash/);
  assert.match(source, /Copied a view permalink using the last published schema/);
  assert.match(source, /Your current schema edits are still private/);
  assert.match(source, /publicationPermalink\(published\.publication_id/);
  assert.match(source, /getPermalinkState\(\)/);
});

test("share rebuilds a published permalink from the current view state", () => {
  const stablePermalink = source.slice(
    source.indexOf("function stablePermalink"),
    source.indexOf("function renderPublicationState"),
  );
  assert.match(stablePermalink, /publicationPermalink\(published\.publication_id, windowApi\.location, getPermalinkState\(\)\)/);
  assert.ok(stablePermalink.indexOf("published?.publication_id") < stablePermalink.indexOf("published?.permalink"));
});

test("successful sharing gives visible feedback on the share button", () => {
  assert.match(source, /button\.textContent = "✓ Copied"/);
  assert.match(source, /button\.classList\.add\("share-copied"\)/);
  assert.match(source, /button\.textContent = "Share view"/);
  assert.match(source, /showShareCopied\(\)/);
});

test("publication explicitly confirms public immutable access", () => {
  assert.match(source, /Publish this schema publicly\?/);
  assert.match(source, /immutable public version/);
  assert.match(source, /confirmPublicPublication\(\)/);
});

test("published state distinguishes private working-copy changes", () => {
  assert.match(source, /Public schema · Unpublished local changes/);
  assert.match(source, /Private working copy/);
  assert.match(source, /workingCopyChanged/);
});
