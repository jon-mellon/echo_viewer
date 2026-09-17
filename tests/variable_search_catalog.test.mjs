import test from "node:test";
import assert from "node:assert/strict";
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
