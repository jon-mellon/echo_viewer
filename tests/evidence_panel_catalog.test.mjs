import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { EvidencePanelCatalog, EVIDENCE_PANEL_BINDINGS, evidencePanelKey } from "../site/evidence_panel_catalog.mjs";

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
