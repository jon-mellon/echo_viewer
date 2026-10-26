import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [source, output = "site/variable-search-catalog.json", snapshotId = ""] = process.argv.slice(2);
if (!source) {
  console.error("Usage: node scripts/generate_variable_search_catalog.mjs <parquet path/glob> [output] [snapshot-id]");
  process.exit(2);
}
if (snapshotId && !/^[0-9a-f]{64}$/.test(snapshotId)) throw new Error("Snapshot ID must be 64 lowercase hex characters.");
const quotedSource = source.replaceAll("'", "''");
const sql = `SELECT variable_id, display_label, concept_label, raw_variable_text,
  paper_id, uoa, index FROM read_parquet('${quotedSource}') ORDER BY index`;
const variables = JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], {
  encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
}));
const normalized = value => String(value ?? "").trim().toLowerCase();
const records = variables.map(variable => {
  const fields = [variable.variable_id, variable.display_label, variable.concept_label,
    variable.raw_variable_text, variable.paper_id, variable.uoa];
  return [variable.variable_id, variable.display_label || "", variable.concept_label || "",
    variable.raw_variable_text || "", variable.paper_id || "", variable.uoa || "",
    normalized(fields.join(" ")), normalized(variable.display_label || variable.concept_label),
    normalized(variable.concept_label), Number(variable.index)];
});
const payload = JSON.stringify({ format: "echo-variable-search-v1", count: records.length, ...(snapshotId ? { evidence_snapshot: snapshotId } : {}), records });
if (!output.endsWith(".gz")) writeFileSync(output, payload);
const compressed = gzipSync(payload, { level: 9 });
writeFileSync(output.endsWith(".gz") ? output : `${output}.gz`, compressed);
console.log(JSON.stringify({ output, variables: records.length, bytes: Buffer.byteLength(payload),
  compressedBytes: compressed.length }));
