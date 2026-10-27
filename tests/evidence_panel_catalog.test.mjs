import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { EvidencePanelCatalog, EVIDENCE_PANEL_BINDINGS, evidencePanelKey } from "../site/evidence_panel_catalog.mjs";
import { VariableMapCatalog, VARIABLE_MAP_BINDINGS } from "../site/variable_map_catalog.mjs";
import { VariableNeighborCatalog, VARIABLE_NEIGHBOR_BINDINGS } from "../site/variable_neighbor_catalog.mjs";
import { VariableIncidentCatalog, VARIABLE_INCIDENT_BINDINGS } from "../site/variable_incident_catalog.mjs";

const snapshot = Object.keys(EVIDENCE_PANEL_BINDINGS)[0];
const ids = ["rac8b599ab9eb30a2193b1383", "r6d6c6bc6e2a7907f05961172"];
const read = url => readFileSync(new URL(`../site${url}`, import.meta.url));

test("published source bundles share requests, include labels, and isolate snapshots", async () => {
  const requests = [];
  const catalog = new EvidencePanelCatalog({ fetchImpl: async url => {
    requests.push(url);
    return new Response(read(url));
  } });
  const [a, b] = await Promise.all([catalog.load(snapshot, ids), catalog.load(snapshot, [...ids].reverse())]);
  assert.equal(a, b);
  assert.equal(requests.length, 2);
  assert.deepEqual(a.links.map(r => r.raw_causal_link_id).sort(), [...ids].sort());
  assert.ok(a.links.every(r => r.paper_id && r.paper_title));
  assert.ok(a.variables.every(v => v.concept_label || v.display_label));
  assert.equal(await catalog.load("a".repeat(64), ids), null);
  assert.equal(await catalog.load(snapshot, ["missing"]), null);
  assert.equal(requests.length, 2);
});

test("corrupt bundles fail integrity and can be retried", async () => {
  let corrupt = true;
  const catalog = new EvidencePanelCatalog({ fetchImpl: async url => {
    const bytes = Buffer.from(read(url));
    if (corrupt && !url.endsWith("index.json.gz")) bytes[10] ^= 1;
    return new Response(bytes);
  } });
  await assert.rejects(catalog.load(snapshot, ids), /integrity/);
  corrupt = false;
  assert.equal((await catalog.load(snapshot, ids)).links.length, 2);
});

test("every deployed bundle matches its pinned integrity, request key, and endpoint coverage", async () => {
  const binding = EVIDENCE_PANEL_BINDINGS[snapshot];
  const indexBytes = read(`${binding.root}index.json.gz`);
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(indexBytes), binding.sha256);
  assert.equal(indexBytes.length, binding.bytes);
  const index = JSON.parse(gunzipSync(indexBytes));
  assert.equal(Object.keys(index.entries).length, 2818);
  for (const [key, entry] of Object.entries(index.entries)) {
    const bytes = read(`${binding.root}${entry.sha256}.json.gz`);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const panel = JSON.parse(gunzipSync(bytes));
    assert.equal(panel.evidence_snapshot, snapshot);
    assert.equal(await evidencePanelKey(panel.links.map(r => r.raw_causal_link_id)), key);
    const labels = new Set(panel.variables.map(v => v.variable_id));
    assert.ok(panel.links.every(r => labels.has(r.source_variable_id) && labels.has(r.target_variable_id)));
  }
});

test("variable maps verify every coordinate bundle and share exact-set downloads", async () => {
  const binding = VARIABLE_MAP_BINDINGS[snapshot];
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const indexBytes = read(`${binding.root}index.json.gz`);
  assert.equal(hash(indexBytes), binding.sha256);
  assert.equal(indexBytes.length, binding.bytes);
  const index = JSON.parse(gunzipSync(indexBytes));
  let count = 0, first;
  for (const [key, entry] of Object.entries(index.entries)) {
    const bytes = read(`${binding.root}${entry.sha256}.json.gz`);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const payload = JSON.parse(gunzipSync(bytes));
    assert.equal(payload.evidence_snapshot, snapshot);
    assert.equal(payload.layout_source, binding.layoutSource);
    assert.equal(await evidencePanelKey(payload.variables.map(r => r.variable_id)), key);
    assert.ok(payload.variables.every(r => Number.isFinite(r.map_x) && Number.isFinite(r.map_y)
      && !("field_preview_json" in r) && !("metadata_blob_json" in r)));
    first ||= payload.variables.map(r => r.variable_id);
    count += payload.variables.length;
  }
  assert.equal(count, 97818);
  const requests = [];
  const catalog = new VariableMapCatalog({ fetchImpl: async url => { requests.push(url); return new Response(read(url)); } });
  const [a, b] = await Promise.all([catalog.load(snapshot, first), catalog.load(snapshot, [...first].reverse())]);
  assert.equal(a, b);
  assert.equal(requests.length, 2);
  assert.equal(await catalog.load(snapshot, first, "different-layout"), null);
  assert.equal(await catalog.load("a".repeat(64), first), null);
  assert.equal(requests.length, 2);
});

test("neighbor chunks have pinned coverage, share downloads, and return independent records", async () => {
  const binding = VARIABLE_NEIGHBOR_BINDINGS[snapshot];
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const bytes = read(`${binding.root}index.json.gz`);
  assert.equal(hash(bytes), binding.sha256);
  assert.equal(bytes.length, binding.bytes);
  const index = JSON.parse(gunzipSync(bytes));
  let rows = 0, variables = 0, selected;
  for (const [bucket, entry] of Object.entries(index.entries)) {
    const bytes = read(`${binding.root}${entry.sha256}.json.gz`);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const payload = JSON.parse(gunzipSync(bytes));
    assert.equal(payload.evidence_snapshot, snapshot);
    const covered = new Set(payload.variable_ids);
    assert.ok([...covered].every(id => id.slice(1, 3) === bucket));
    assert.ok(payload.rows.every(row => covered.has(row[0]) && row.length === 8));
    selected ||= payload.rows[0][0];
    rows += payload.rows.length;
    variables += covered.size;
  }
  assert.equal(rows, 1173816);
  assert.equal(variables, 97818);
  const requests = [];
  const catalog = new VariableNeighborCatalog({ fetchImpl: async url => { requests.push(url); return new Response(read(url)); } });
  const [a, b] = await Promise.all([catalog.load(snapshot, [selected]), catalog.load(snapshot, [selected])]);
  assert.deepEqual(a, b);
  assert.equal(requests.length, 2);
  const similarity = b[0].cosine_similarity;
  a[0].cosine_similarity = -1;
  assert.equal((await catalog.load(snapshot, [selected]))[0].cosine_similarity, similarity);
  assert.equal(await catalog.load("a".repeat(64), [selected]), null);
});

test("incident chunks cover both endpoints and deduplicate findings across buckets", async () => {
  const binding = VARIABLE_INCIDENT_BINDINGS[snapshot];
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const bytes = read(`${binding.root}index.json.gz`);
  assert.equal(hash(bytes), binding.sha256);
  const index = JSON.parse(gunzipSync(bytes));
  const findings = new Set();
  let pair;
  for (const [bucket, entry] of Object.entries(index.entries)) {
    const bytes = read(`${binding.root}${entry.sha256}.json.gz`);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal(bytes.length, entry.bytes);
    const payload = JSON.parse(gunzipSync(bytes));
    assert.equal(payload.evidence_snapshot, snapshot);
    const covered = new Set(payload.variable_ids);
    assert.ok([...covered].every(id => id.slice(1, 3) === bucket));
    for (const row of payload.rows) {
      assert.ok(covered.has(row[1]) || covered.has(row[2]));
      findings.add(row[0]);
      if (row[1].slice(1, 3) !== row[2].slice(1, 3)) pair ||= [row[1], row[2]];
    }
  }
  assert.equal(findings.size, 107493);
  const catalog = new VariableIncidentCatalog({ fetchImpl: async url => new Response(read(url)) });
  const rows = await catalog.load(snapshot, pair);
  assert.equal(new Set(rows.map(r => r.raw_causal_link_id)).size, rows.length);
  assert.ok(rows.every(r => pair.includes(r.source_variable_id) || pair.includes(r.target_variable_id)));
  assert.ok(rows.every(r => !("_row_order" in r)));
});
