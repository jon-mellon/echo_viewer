import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, createReadStream, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const [neighborsPath, variablesPath, manifestPath, output = "site/variable-neighbors", kind = "neighbors"] = process.argv.slice(2);
const incidents = kind === "incidents";
if (!neighborsPath || !variablesPath || !manifestPath) throw new Error("Usage: generate_variable_neighbors.mjs neighbors.parquet variables.parquet snapshot-manifest.json [output]");
const manifest = JSON.parse(readFileSync(manifestPath)), snapshot = manifest.evidence_snapshot;
if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error("Invalid snapshot");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const [kind, path] of [[incidents ? "causal_link_occurrences" : "variable_neighbors", neighborsPath], ["variable_occurrences", variablesPath]]) {
  const bytes = readFileSync(path), integrity = manifest.identity?.legacy_relation_integrity?.[kind];
  if (bytes.length !== integrity?.bytes || hash(bytes) !== integrity.sha256) throw new Error(`Invalid ${kind} integrity`);
}
const quote = path => path.replaceAll("'", "''");
const columns = incidents
  ? ["raw_causal_link_id", "source_variable_id", "target_variable_id", "paper_id", "paper_title", "within_table_occurrence_id", "causal_link_existence", "identification_strategy", "target_population", "_row_order"]
  : ["variable_id", "neighbor_variable_id", "neighbor_index", "display_rank", "cosine_similarity", "llm_rank", "embedding_rank", "is_substantive_duplicate"];
const ids = JSON.parse(execFileSync("duckdb", ["-json", "-c", `SELECT variable_id FROM read_parquet('${quote(variablesPath)}') ORDER BY variable_id`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const buckets = new Map();
for (const { variable_id: id } of ids) {
  if (!/^v[a-f0-9]{16}$/.test(id)) throw new Error("Unsupported variable ID");
  const bucket = id.slice(1, 3);
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket).push(id);
}
const temporary = mkdtempSync(`${tmpdir()}/echo-neighbor-build-`);
const root = `${output}/${snapshot}`;
mkdirSync(root, { recursive: true });
const entries = {};
let totalBytes = 0, count = 0;
try {
  const query = incidents
    ? `WITH source AS (SELECT row_number() OVER () AS _row_order, * FROM read_parquet('${quote(neighborsPath)}'))
      SELECT DISTINCT bucket, source.* FROM source, LATERAL (VALUES (substr(source_variable_id, 2, 2)), (substr(target_variable_id, 2, 2))) buckets(bucket) ORDER BY bucket, _row_order`
    : `SELECT * FROM read_parquet('${quote(neighborsPath)}') ORDER BY variable_id, display_rank`;
  execFileSync("duckdb", ["-c", `COPY (${query})
    TO '${quote(temporary)}/rows.json' (FORMAT JSON)`]);
  const writeBucket = (bucket, rows) => {
    const variableIds = buckets.get(bucket);
    if (!variableIds) throw new Error(`Unknown neighbor bucket ${bucket}`);
    const bytes = gzipSync(JSON.stringify({ format: incidents ? "echo-variable-incidents-v1" : "echo-variable-neighbors-v1", evidence_snapshot: snapshot, variable_ids: variableIds, columns, rows }), { level: 9 });
    const sha256 = hash(bytes);
    writeFileSync(`${root}/${sha256}.json.gz`, bytes);
    entries[bucket] = { sha256, bytes: bytes.length };
    totalBytes += bytes.length;
    count += rows.length;
  };
  let current = null, rows = [];
  for await (const line of createInterface({ input: createReadStream(`${temporary}/rows.json`), crlfDelay: Infinity })) {
    const row = JSON.parse(line), bucket = incidents ? row.bucket : row.variable_id.slice(1, 3);
    if (current !== null && bucket !== current) { writeBucket(current, rows); rows = []; }
    current = bucket;
    rows.push(columns.map(column => row[column]));
  }
  if (current !== null) writeBucket(current, rows);
  for (const bucket of buckets.keys()) if (!entries[bucket]) writeBucket(bucket, []);
  const bytes = gzipSync(JSON.stringify({ format: incidents ? "echo-variable-incident-index-v1" : "echo-variable-neighbor-index-v1", evidence_snapshot: snapshot, entries }), { level: 9 });
  writeFileSync(`${root}/index.json.gz`, bytes);
  console.log(JSON.stringify({ snapshot, count, totalBytes, indexBytes: bytes.length, indexSha256: hash(bytes) }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
