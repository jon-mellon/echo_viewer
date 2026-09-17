import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [source, output = "site/variable-search-catalog.json"] = process.argv.slice(2);
if (!source) {
  console.error("Usage: node scripts/generate_variable_search_catalog.mjs <parquet path/glob> [output]");
  process.exit(2);
}
const quotedSource = source.replaceAll("'", "''");
const sql = `SELECT variable_id, display_label, concept_label, raw_variable_text,
  paper_id, uoa, index FROM read_parquet('${quotedSource}') ORDER BY index`;
const variables = JSON.parse(execFileSync("duckdb", ["-json", "-c", sql], {
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
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
const payload = JSON.stringify({ format: "echo-variable-search-v1", count: records.length, records });
writeFileSync(output, payload);
console.log(JSON.stringify({ output, variables: records.length, bytes: Buffer.byteLength(payload) }));
