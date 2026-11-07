import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fetchViewerAssets, bindViewerAssets, missingViewerAssets, viewerAssetsManifestUrl } from "../site/viewer_assets.mjs";
import { EvidencePanelCatalog } from "../site/evidence_panel_catalog.mjs";
import { VariableMapCatalog } from "../site/variable_map_catalog.mjs";
import { VariableNeighborCatalog } from "../site/variable_neighbor_catalog.mjs";
import { VariableIncidentCatalog } from "../site/variable_incident_catalog.mjs";
import { searchCatalogs, readSearchCatalogPayload } from "../site/variable_search_catalog.mjs";

// tests/fixtures/viewer-assets is the output of the data pipeline's viewer_assets.py (harvest_abstracts, analysis/10k/
// echo_viewer_bundle) for a six-variable snapshot. Reading it through the real catalogs is the contract between the two repos.
const SNAPSHOT = "a".repeat(64);
const HOST = "https://data.example/evidence/layouts/browser-v2/";
const LAYOUT_MANIFEST = `${HOST}${SNAPSHOT}/manifest.json`;
const FIXTURE = new URL("./fixtures/viewer-assets/", import.meta.url).pathname;
const id = number => `v${number.toString(16).padStart(2, "0")}${"0".repeat(14)}`;

function files(directory = FIXTURE) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** A data host that serves the fixture under the snapshot's viewer-assets folder. */
function host({ missing = [], tamper = [] } = {}) {
  const served = new Map(files().map(path => [`${HOST}${SNAPSHOT}/viewer-assets/${relative(FIXTURE, path)}`, readFileSync(path)]));
  const requests = [];
  const fetchImpl = async url => {
    requests.push(String(url));
    if (missing.some(part => String(url).includes(part)) || !served.has(String(url))) return new Response("not found", { status: 404 });
    let bytes = served.get(String(url));
    if (tamper.some(part => String(url).includes(part))) { bytes = Buffer.from(bytes); bytes[bytes.length - 1] ^= 1; }
    return new Response(bytes);
  };
  return { fetchImpl, requests };
}

function catalogs(fetchImpl) {
  return { searchCatalogs, variableMaps: new VariableMapCatalog({ fetchImpl }), variableNeighbors: new VariableNeighborCatalog({ fetchImpl }),
    variableIncidents: new VariableIncidentCatalog({ fetchImpl }), evidencePanels: new EvidencePanelCatalog({ bindings: {}, fetchImpl }) };
}

test("the sidecar manifest sits beside the layout manifest", () => {
  assert.equal(viewerAssetsManifestUrl(LAYOUT_MANIFEST), `${HOST}${SNAPSHOT}/viewer-assets/manifest.json`);
});

test("assets published beside a snapshot are found and every kind opens through the real catalogs", async () => {
  const { fetchImpl } = host();
  const found = await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl });
  assert.ok(found);
  assert.deepEqual(Object.keys(found.assets).sort(), ["evidencePanels", "searchCatalog", "variableIncidents", "variableMaps", "variableNeighbors"]);
  assert.equal(found.assets.variableMaps.root, `${HOST}${SNAPSHOT}/viewer-assets/variable-maps/`);
  const all = catalogs(fetchImpl);
  bindViewerAssets(SNAPSHOT, found, all);
  assert.deepEqual(missingViewerAssets(SNAPSHOT, all), []);

  // Variable map: a lookup for exactly a group's ids hits; any other set misses.
  const health = [id(3), id(4), id(5)];
  const map = await all.variableMaps.load(SNAPSHOT, health, "");
  assert.deepEqual(map.variables.map(row => row.variable_id), health);
  assert.equal(map.layout_source, "pca-v1");
  assert.equal(await all.variableMaps.load(SNAPSHOT, [id(3), id(4)], ""), null);

  const neighbors = await all.variableNeighbors.load(SNAPSHOT, [id(1)]);
  assert.ok(neighbors.length >= 1);
  const incidents = await all.variableIncidents.load(SNAPSHOT, [id(1)]);
  assert.ok(incidents.some(row => row.raw_causal_link_id === "l0"));
  const panel = await all.evidencePanels.load(SNAPSHOT, ["l0", "l1"]);
  assert.deepEqual(panel.links.map(link => link.raw_causal_link_id), ["l0", "l1"]);

  const catalog = await readSearchCatalogPayload(found.assets.searchCatalog, fetchImpl);
  assert.equal(catalog.format, "echo-variable-search-v1");
  assert.equal(catalog.records.length, 6);
  assert.equal(catalog.evidence_snapshot, SNAPSHOT);
});

test("a snapshot published without assets is not an error: there is nothing to bind and the gap is reported", async () => {
  const { fetchImpl } = host({ missing: ["viewer-assets/manifest.json"] });
  assert.equal(await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl }), null);
  const all = catalogs(fetchImpl);
  const other = "b".repeat(64);
  assert.deepEqual(missingViewerAssets(other, all), ["search catalog", "variable maps"]);
});

test("a manifest for another snapshot, or in another format, is ignored", async () => {
  const { fetchImpl } = host();
  assert.equal(await fetchViewerAssets(LAYOUT_MANIFEST, "c".repeat(64), { fetchImpl }), null);
  const wrongFormat = async () => new Response(JSON.stringify({ format: "other", evidence_snapshot: SNAPSHOT, assets: {} }));
  assert.equal(await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl: wrongFormat }), null);
});

test("an asset whose index entry is malformed is skipped and the rest are still used", async () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
  manifest.assets.variable_maps.index.sha256 = "nothex";
  delete manifest.assets.evidence_panels.root;
  const fetchImpl = async () => new Response(JSON.stringify(manifest));
  const found = await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl });
  assert.deepEqual(Object.keys(found.assets).sort(), ["searchCatalog", "variableIncidents", "variableNeighbors"]);
});

test("published assets replace a committed binding for the same snapshot", async () => {
  const { fetchImpl } = host();
  const found = await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl });
  const all = catalogs(fetchImpl);
  all.variableMaps.bindings[SNAPSHOT] = { root: "/variable-maps/committed/", bytes: 1, sha256: "0".repeat(64) };
  bindViewerAssets(SNAPSHOT, found, all);
  assert.equal(all.variableMaps.bindings[SNAPSHOT].root, found.assets.variableMaps.root);
});

test("a file changed on the data host is refused, so a corrupt bundle cannot reach the graph", async () => {
  const { fetchImpl } = host({ tamper: ["variable-maps/index.json.gz"] });
  const found = await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl });
  const all = catalogs(fetchImpl);
  bindViewerAssets(SNAPSHOT, found, all);
  await assert.rejects(all.variableMaps.load(SNAPSHOT, [id(3), id(4), id(5)], ""), /integrity mismatch/);
});

test("the committed bindings stay untouched by binding at run time", async () => {
  const { fetchImpl } = host();
  const found = await fetchViewerAssets(LAYOUT_MANIFEST, SNAPSHOT, { fetchImpl });
  const first = catalogs(fetchImpl), second = catalogs(fetchImpl);
  bindViewerAssets(SNAPSHOT, found, first);
  assert.equal(second.variableMaps.bindings[SNAPSHOT], undefined);
});
