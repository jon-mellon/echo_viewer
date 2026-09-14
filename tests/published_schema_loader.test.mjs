import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../site/published_schema_loader.mjs", import.meta.url), "utf8");

test("publication loader resolves the registry before loading the public folder", () => {
  assert.match(source, /from\("published_schemas"\)/);
  assert.match(source, /\.eq\("id", publicationId\)/);
  assert.match(source, /loadGroupingSchemaStructure\(baseUrl, schemaFetch\)/);
  assert.match(source, /canonicalFolderHash\(schemaFiles\)/);
  assert.match(source, /Published schema hash mismatch/);
});

test("publication cache identity includes the compiled manifest binding", () => {
  assert.match(source, /echo-published-v2-/);
  assert.match(source, /publication\.content_hash/);
  assert.match(source, /publication\.compiled_manifest_hash/);
});

test("publication permalink is independent of the storage URL", () => {
  assert.match(source, /buildPermalink\(\{/);
  assert.match(source, /dataVersion: state\.data\?\.snapshot\?\.snapshot_id/);
  assert.match(source, /url\.searchParams\.delete\("schema_url"\)/);
  assert.match(source, /url\.searchParams\.set\("schema", publicationId\)/);
});
