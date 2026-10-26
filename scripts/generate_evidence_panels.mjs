import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { evidenceManifestUrl, evidenceSnapshotIdFromManifestUrl } from "../site/dag_data_config.mjs";

const [parquet, compiledPath, catalogPath, manifestPath, output = "site/evidence-panels"] = process.argv.slice(2);
if (!parquet || !compiledPath || !catalogPath || !manifestPath) throw new Error("Usage: generate_evidence_panels.mjs findings.parquet compiled.json search-catalog.json.gz snapshot-manifest.json [output]");
const compiled = JSON.parse(readFileSync(compiledPath));
const catalog = JSON.parse(gunzipSync(readFileSync(catalogPath)));
const snapshot = evidenceSnapshotIdFromManifestUrl(evidenceManifestUrl({ href: `https://echo.epistemicinfra.org/?data_version=${compiled.evidence_snapshot}` }));
if (!/^[a-f0-9]{64}$/.test(snapshot) || catalog.evidence_snapshot !== snapshot) throw new Error("Snapshot mismatch");
const manifest = JSON.parse(readFileSync(manifestPath));
const canonicalBytes = readFileSync(parquet);
const canonicalHash = createHash("sha256").update(canonicalBytes).digest("hex");
const canonicalIntegrity = manifest.identity?.legacy_relation_integrity?.causal_link_occurrences;
if (manifest.evidence_snapshot !== snapshot || canonicalIntegrity?.sha256 !== canonicalHash
  || canonicalIntegrity?.bytes !== canonicalBytes.length) throw new Error("Canonical findings integrity mismatch");
const rows = JSON.parse(execFileSync("duckdb", ["-json", "-c", `SELECT * FROM read_parquet('${parquet.replaceAll("'", "''")}')`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
const byId = new Map(rows.map(row => [row.raw_causal_link_id, row]));
const variables = new Map(catalog.records.map(r => [r[0], { variable_id: r[0], display_label: r[1], concept_label: r[2] }]));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = `${output}/${snapshot}`;
mkdirSync(root, { recursive: true });
const entries = {};
let total = 0;
for (const edge of compiled.edges) {
  const ids = [...new Set([...(edge.a_to_b_raw_link_ids || []), ...(edge.b_to_a_raw_link_ids || [])])].sort();
  if (!ids.length) continue;
  const key = hash(ids.join("\n"));
  if (entries[key]) continue;
  const links = ids.map(id => {
    if (!byId.has(id)) throw new Error(`Missing finding ${id}`);
    return byId.get(id);
  });
  const endpoints = [...new Set(links.flatMap(r => [r.source_variable_id, r.target_variable_id]))].sort();
  const labels = endpoints.map(id => {
    if (!variables.has(id)) throw new Error(`Missing concept ${id}`);
    return variables.get(id);
  });
  const bytes = gzipSync(JSON.stringify({ format: "echo-evidence-panel-v1", evidence_snapshot: snapshot, links, variables: labels }), { level: 9 });
  const digest = hash(bytes);
  writeFileSync(`${root}/${digest}.json.gz`, bytes);
  entries[key] = { sha256: digest, bytes: bytes.length };
  total += bytes.length;
}
const index = gzipSync(JSON.stringify({ format: "echo-evidence-panel-index-v1", evidence_snapshot: snapshot, entries }), { level: 9 });
writeFileSync(`${root}/index.json.gz`, index);
console.log(JSON.stringify({ snapshot, packs: Object.keys(entries).length, totalBytes: total, indexBytes: index.length, indexSha256: hash(index) }));
