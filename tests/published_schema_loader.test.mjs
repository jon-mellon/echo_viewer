import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fetchPublishedFile } from "../site/published_schema_loader.mjs";

const source = await readFile(new URL("../site/published_schema_loader.mjs", import.meta.url), "utf8");
const bootstrapSource = await readFile(new URL("../site/project_bootstrap.mjs", import.meta.url), "utf8");

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

test("published files retry transient network failures and server errors", async () => {
  const attempts = [], delays = [];
  const response = await fetchPublishedFile("https://example.test/schema/groups.tsv", {}, async url => {
    attempts.push(url);
    if (attempts.length === 1) throw new TypeError("Failed to fetch");
    if (attempts.length === 2) return { status: 503, headers: new Headers() };
    return { status: 200 };
  }, ms => { delays.push(ms); });
  assert.equal(response.status, 200);
  assert.equal(attempts.length, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("published files fail with the URL after repeated network errors", async () => {
  let attempts = 0;
  await assert.rejects(() => fetchPublishedFile("https://example.test/schema/groups.tsv", {}, async () => {
    attempts += 1;
    throw new TypeError("Failed to fetch");
  }, () => {}), /https:\/\/example\.test\/schema\/groups\.tsv: Failed to fetch/);
  assert.equal(attempts, 5);
});

test("startup waits for the first compiled graph render before schema hydration", () => {
  const startup = bootstrapSource.indexOf('setStartupStage("Rendering graph…")');
  const render = bootstrapSource.indexOf("renderAll();", startup);
  const ready = bootstrapSource.indexOf("await dagNetworkController.whenRendered?.();", startup);
  const finish = bootstrapSource.indexOf("finishStartupLoading();", startup);
  const hydrate = bootstrapSource.indexOf("state.data.load_published_schema", startup);
  assert.ok(render >= 0 && render < ready && ready < finish && finish < hydrate);
});

test("completed hydration rechecks publication state after installing the full schema", () => {
  const completion = bootstrapSource.indexOf("state.publishedSchemaHydrated = true");
  const apply = bootstrapSource.indexOf("applyLoadedSchema(schema);", completion);
  const refresh = bootstrapSource.indexOf("publicationController.refreshPublicationState?.();", completion);
  assert.ok(completion >= 0 && completion < apply && apply < refresh);
});

test("publication permalink is independent of the storage URL", () => {
  assert.match(source, /buildPermalink\(\{/);
  assert.match(source, /dataVersion: state\.data\?\.snapshot\?\.snapshot_id/);
  assert.match(source, /url\.searchParams\.delete\("schema_url"\)/);
  assert.match(source, /url\.searchParams\.set\("schema", publicationId\)/);
  assert.match(source, /const hasView = Boolean\(anchor\("iv"\)/);
});
