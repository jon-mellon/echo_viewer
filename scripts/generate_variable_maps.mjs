import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const [variablesPath, layoutsPath, manifestPath, output = "site/variable-maps"] = process.argv.slice(2);
if (!variablesPath || !layoutsPath || !manifestPath) throw new Error("Usage: generate_variable_maps.mjs variables.parquet layouts.parquet snapshot-manifest.json [output]");
const manifest = JSON.parse(readFileSync(manifestPath));
const snapshot = manifest.evidence_snapshot;
if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error("Invalid snapshot");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [relation, file] of [["variable_occurrences", variablesPath], ["variable_layouts", layoutsPath]]) {
  const bytes = readFileSync(file), integrity = manifest.identity?.legacy_relation_integrity?.[relation];
  if (bytes.length !== integrity?.bytes || hash(bytes) !== integrity.sha256) throw new Error(`Invalid ${relation} integrity`);
}
const quote = path => path.replaceAll("'", "''");
const rows = JSON.parse(execFileSync("duckdb", ["-json", "-c", `SELECT o.* EXCLUDE(field_preview_json, metadata_blob_json), l.map_x, l.map_y, l.layout_source
  FROM read_parquet('${quote(variablesPath)}') o JOIN read_parquet('${quote(layoutsPath)}') l USING(variable_id) ORDER BY o.index`],
{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
const layouts = [...new Set(rows.map(r => r.layout_source))];
if (layouts.length !== 1) throw new Error("Choose one immutable layout source");
const layoutSource = layouts[0];
const groups = new Map();
for (const { layout_source, ...row } of rows) {
  const category = row.category || "";
  if (!groups.has(category)) groups.set(category, []);
  groups.get(category).push(row);
}
const root = `${output}/${snapshot}`;
mkdirSync(root, { recursive: true });
const entries = {};
let totalBytes = 0;
for (const variables of groups.values()) {
  const key = hash(variables.map(r => r.variable_id).sort().join("\n"));
  const bytes = gzipSync(JSON.stringify({ format: "echo-variable-map-v1", evidence_snapshot: snapshot, layout_source: layoutSource, variables }), { level: 9 });
  const sha256 = hash(bytes);
  writeFileSync(`${root}/${sha256}.json.gz`, bytes);
  entries[key] = { sha256, bytes: bytes.length };
  totalBytes += bytes.length;
}
const bytes = gzipSync(JSON.stringify({ format: "echo-variable-map-index-v1", evidence_snapshot: snapshot, layout_source: layoutSource, entries }), { level: 9 });
writeFileSync(`${root}/index.json.gz`, bytes);
console.log(JSON.stringify({ snapshot, layoutSource, groups: groups.size, variables: rows.length, totalBytes, indexBytes: bytes.length, indexSha256: hash(bytes) }));
