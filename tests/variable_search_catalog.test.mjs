import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { StaticVariableSearchCatalog, hydrateSearchResult } from "../site/variable_search_catalog.mjs";

const payload = {
  format: "echo-variable-search-v1",
  count: 4,
  records: [
    ["v1", "Income", "Household income", "annual household earnings", "p1", "person",
      "v1 income household income annual household earnings p1 person", "income", "household income", 2],
    ["v2", "Income growth", "Growth", "change in income", "p2", "country",
      "v2 income growth growth change in income p2 country", "income growth", "growth", 1],
    ["v3", "Education", "Schooling", "years of completed schooling", "p3", "person",
      "v3 education schooling years of completed schooling p3 person", "education", "schooling", 3],
    ["v4", "Other", "Other concept", "household income measure", "p4", "person",
      "v4 other other concept household income measure p4 person", "other", "other concept", 4],
  ],
};

async function loadedCatalog() {
  const catalog = new StaticVariableSearchCatalog();
  await catalog.load("/catalog.json", async () => new Response(JSON.stringify(payload), { status: 200 }));
  return catalog;
}

test("fallback catalog yields during large builds and preserves search order", async () => {
  const variables = Array.from({ length: 2500 }, (_, index) => ({
    variable_id: `v${index}`, display_label: `Item ${index}`, index,
  }));
  let yielded = false;
  const catalog = new StaticVariableSearchCatalog();
  const loading = catalog.loadSnapshot("uncatalogued-snapshot", { loadRecords: async () => variables });
  setTimeout(() => { yielded = true; }, 0);
  await loading;
  assert.equal(yielded, true);
  assert.equal(catalog.records.length, variables.length);
  assert.deepEqual(catalog.searchVariables("Item 2499").map(row => row.variable_id), ["v2499"]);
});

test("concept labels reuse the matching snapshot without hydrating detail records", async () => {
  const catalog = await loadedCatalog();
  catalog.snapshotId = "snapshot-a";
  assert.deepEqual(catalog.conceptLabels(["v1", "v2", "v1", "missing"], "snapshot-a"), [
    { variable_id: "v2", concept_label: "Growth", display_label: "Income growth" },
    { variable_id: "v1", concept_label: "Household income", display_label: "Income" },
  ]);
  assert.equal(catalog.conceptLabels(["v1"], "snapshot-b"), null);
  assert.equal(new StaticVariableSearchCatalog().conceptLabels(["v1"], "snapshot-a"), null);
});

test("fresh global catalog searches without hydrated variables", async () => {
  const state = { variables: [], variableById: new Map() };
  const catalog = await loadedCatalog();
  assert.deepEqual(catalog.searchVariables("EDUC", 20).map(record => record.variable_id), ["v3"]);
  assert.equal(state.variableById.size, 0);
  assert.equal(state.variables.length, 0);
});

test("catalog search preserves substring, multi-term AND, and exact/prefix ranking", async () => {
  const catalog = await loadedCatalog();
  assert.deepEqual(catalog.searchVariables("come", 20).map(record => record.variable_id), ["v2", "v1", "v4"]);
  assert.deepEqual(catalog.searchVariables("house EARN", 20).map(record => record.variable_id), ["v1"]);
  assert.deepEqual(catalog.searchVariables("income", 20).map(record => record.variable_id), ["v1", "v2", "v4"]);
  assert.deepEqual(catalog.searchVariables("income growth", 20).map(record => record.variable_id), ["v2"]);
});

test("a lightweight result hydrates only the selected variable through the supplied path", async () => {
  const variableById = new Map();
  const calls = [];
  const hydrate = async ids => {
    calls.push(ids);
    variableById.set(ids[0], { variable_id: ids[0], metadata_blob: { full: true } });
  };
  const hydrated = await hydrateSearchResult("v3", hydrate, variableById);
  assert.deepEqual(calls, [["v3"]]);
  assert.equal(hydrated.metadata_blob.full, true);
  await hydrateSearchResult("v3", hydrate, variableById);
  assert.equal(calls.length, 1);
});

test("catalog loading does not mutate the application's hydrated-variable map", async () => {
  const variableById = new Map([["already", { variable_id: "already" }]]);
  const catalog = await loadedCatalog();
  assert.equal(catalog.records.length, 4);
  assert.deepEqual([...variableById.keys()], ["already"]);
});

test("deployed compressed catalog matches its source JSON", () => {
  const json = readFileSync(new URL("../site/variable-search-catalog.json", import.meta.url));
  const compressed = readFileSync(new URL("../site/variable-search-catalog.json.gz", import.meta.url));
  assert.deepEqual(gunzipSync(compressed), json);
});

test("browser catalog loader reads gzip responses", async () => {
  const catalog = new StaticVariableSearchCatalog();
  const compressed = gzipSync(JSON.stringify(payload));
  await catalog.load("/catalog.json.gz", async url => {
    assert.equal(url, "/catalog.json.gz");
    return new Response(compressed, { status: 200 });
  });
  assert.equal(catalog.searchVariables("income")[0].variable_id, "v1");
});

test("snapshot catalogs never silently use another snapshot's records", async () => {
  const snapshot = "b".repeat(64);
  const catalog = new StaticVariableSearchCatalog();
  let fetched = false;
  await catalog.loadSnapshot(snapshot, {
    fetchImpl: () => { fetched = true; throw new Error("wrong catalog"); },
    loadRecords: async () => [{ variable_id: "new-id", display_label: "School attendance", index: 1 }],
  });
  assert.equal(fetched, false);
  assert.equal(catalog.searchVariables("attendance")[0].variable_id, "new-id");
  catalog.assertCoverage(["new-id"]);
  assert.throws(() => catalog.assertCoverage(["old-id"]), /does not cover/);
  await assert.rejects(catalog.loadSnapshot("c".repeat(64)), /across evidence snapshots/);
});

test("a mislabeled catalog fails instead of showing partial results", async () => {
  const catalog = new StaticVariableSearchCatalog();
  catalog.snapshotId = "a".repeat(64);
  await assert.rejects(catalog.load("/catalog.json", async () => new Response(JSON.stringify({
    ...payload, evidence_snapshot: "b".repeat(64),
  }))), /snapshot mismatch/);
  assert.equal(catalog.status, "error");
});

test("bundled immutable catalogs declare their snapshot and include all exported variables", async () => {
  const { SNAPSHOT_SEARCH_CATALOGS } = await import("../site/variable_search_catalog.mjs");
  const counts = [14284, 97818];
  for (const [index, [snapshot, path]] of Object.entries(SNAPSHOT_SEARCH_CATALOGS).entries()) {
    const catalog = JSON.parse(gunzipSync(readFileSync(new URL(`../site${path}`, import.meta.url))));
    assert.equal(catalog.evidence_snapshot, snapshot);
    assert.equal(catalog.records.length, counts[index]);
    assert.equal(new Set(catalog.records.map(row => row[0])).size, counts[index]);
  }
});
