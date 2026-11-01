// Writes SQL that loads Supabase's published_schemas and published_split_index into the D1 registry.
// Both tables are public to read with the publishable key already in site/supabase_config.mjs.
//
//   node export_registry_sql.mjs > registry.sql
//   npx wrangler d1 execute echo-registry --remote --file registry.sql
//
// Rows are inserted with "insert or ignore", so running it again adds only what is new.
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../../../site/supabase_config.mjs";

const quote = value => value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`;

export const SCHEMA_COLUMNS = ["id", "owner_id", "content_hash", "title", "description", "evidence_snapshot", "storage_prefix",
  "parent_schema_id", "compiled_manifest_path", "compiled_manifest_hash", "compiler_version", "created_at"];
export const SPLIT_COLUMNS = ["publication_id", "group_id", "split_id", "source_group_ids", "name", "description", "storage_prefix",
  "membership_path", "owner_id", "published_at", "quality_status", "quality_reason", "checked_at"];

/** SQL for the registry, parents before children (a publication before the splits that point at it). */
export function registrySql({ schemas, splits }) {
  const insert = (table, columns, rows, cell) => rows.map(row =>
    `insert or ignore into ${table} (${columns.join(", ")}) values (${columns.map(column => cell(row, column)).join(", ")});`);
  const known = new Set(schemas.map(row => row.id));
  return [
    ...insert("published_schemas", SCHEMA_COLUMNS, schemas, (row, column) => quote(row[column])),
    ...insert("published_split_index", SPLIT_COLUMNS, splits.filter(row => known.has(row.publication_id)),
      (row, column) => quote(column === "source_group_ids" ? JSON.stringify(row[column]) : row[column])),
  ].join("\n") + "\n";
}

async function fetchAll(table, columns, base, key) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const response = await fetch(`${base}/rest/v1/${table}?select=${columns.join(",")}&order=created_at.asc,id.asc`
      .replace("order=created_at.asc,id.asc", table === "published_schemas" ? "order=created_at.asc" : "order=published_at.asc"), {
      headers: { apikey: key, authorization: `Bearer ${key}`, range: `${from}-${from + 999}`, "range-unit": "items" } });
    if (!response.ok) throw new Error(`${table}: HTTP ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const schemas = await fetchAll("published_schemas", SCHEMA_COLUMNS, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  const splits = await fetchAll("published_split_index", SPLIT_COLUMNS, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  process.stdout.write(registrySql({ schemas, splits }));
  process.stderr.write(`${schemas.length} publications, ${splits.length} approved splits\n`);
}
