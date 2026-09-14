import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";
/** @typedef {import("./app_contracts.mjs").GroupingSchema} GroupingSchema */
const LIST_COLUMNS = new Set(["member_variable_ids", "previous_group_ids"]);

function parseYamlMapping(text, source) {
  const result = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1 || line.slice(0, separator).trim() !== line.slice(0, separator)) {
      throw new Error(`Invalid mapping line ${index + 1} in ${source}.`);
    }
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1).trim();
    try {
      result[key] = JSON.parse(raw);
    } catch {
      result[key] = raw;
    }
  }
  return result;
}

function parseTsv(text, source) {
  const records = [];
  let record = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "\t" && !quoted) {
      record.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(value);
      if (record.some((cell) => cell !== "")) records.push(record);
      record = [];
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error(`Unterminated quoted TSV field in ${source}.`);
  if (value || record.length) {
    record.push(value);
    records.push(record);
  }
  if (!records.length) throw new Error(`Empty TSV file: ${source}.`);
  const columns = records[0];
  return records.slice(1).map((values, rowIndex) => {
    if (values.length !== columns.length) throw new Error(`Invalid TSV row ${rowIndex + 2} in ${source}.`);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load grouping schema file ${url}: ${response.status}`);
  return response.text();
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Load a folder schema using only ordinary static HTTP requests.
 * @returns {Promise<GroupingSchema>}
 */
export async function loadGroupingSchemaFolder(baseUrl, fetchImpl = fetch) {
  const staged = await loadGroupingSchemaStructure(baseUrl, fetchImpl);
  return staged.loadComplete();
}

/** Load schema/group metadata first, then allow memberships to be prioritized by group. */
export async function loadGroupingSchemaStructure(baseUrl, fetchImpl = fetch) {
  const base = new URL(baseUrl, globalThis.location?.href || "http://localhost/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const manifestUrl = new URL("manifest.json", base);
  const manifest = JSON.parse(await fetchText(manifestUrl, fetchImpl));
  if (manifest.format_version !== GROUPING_FORMAT_VERSION) {
    throw new Error(`Unsupported grouping schema format: ${manifest.format_version}.`);
  }
  const schema = parseYamlMapping(
    await fetchText(new URL(manifest.schema_file, base), fetchImpl), manifest.schema_file,
  );
  Object.assign(schema, manifest.extra || {});
  schema.schema_version = GROUPING_FORMAT_VERSION;
  schema.membership_unit = manifest.membership_unit || GROUPING_MEMBERSHIP_UNIT;
  const present = new Set(manifest.top_level_fields || []);
  if (present.has("cache_compatibility") || !manifest.top_level_fields) schema.cache_compatibility = manifest.compatibility || {};
  if (present.has("built_against")) schema.built_against = manifest.built_against || {};
  if (present.has("migration_provenance")) schema.migration_provenance = manifest.provenance || {};

  if (!manifest.groups_file || !manifest.group_membership_files) {
    throw new Error("Grouping schema manifest is missing per-group membership files.");
  }
  const groups = new Map();
  const groupRows = parseTsv(await fetchText(new URL(manifest.groups_file, base), fetchImpl), manifest.groups_file);
  for (const row of groupRows) {
    if (!row.group_id || groups.has(row.group_id)) throw new Error(`Invalid or duplicate group_id in ${manifest.groups_file}.`);
    let metadata;
    try {
      metadata = JSON.parse(row.metadata || "{}");
    } catch {
      throw new Error(`Invalid group metadata for ${row.group_id} in ${manifest.groups_file}.`);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Invalid group metadata for ${row.group_id} in ${manifest.groups_file}.`);
    }
    groups.set(row.group_id, { group_id: row.group_id, ...metadata, variable_ids: [] });
  }
  const membershipEntries = Object.entries(manifest.group_membership_files);
  if (membershipEntries.length !== groups.size || membershipEntries.some(([groupId]) => !groups.has(groupId))) {
    throw new Error("Grouping schema membership file map does not match groups.tsv.");
  }
  const owners = new Map(), loadedGroups = new Set();
  async function loadMemberships(groupIds) {
    const wanted = [...new Set(groupIds)].filter(groupId => groups.has(groupId) && !loadedGroups.has(groupId));
    const membershipRows = await mapWithConcurrency(wanted, 6, async groupId => {
      const relative = manifest.group_membership_files[groupId];
      return { groupId, rows: parseTsv(await fetchText(new URL(relative, base), fetchImpl), relative) };
    });
    for (const { groupId, rows } of membershipRows) {
      const variableIds = [];
      for (const row of rows) {
        if (!row.variable_id) throw new Error(`Empty variable_id in membership file for ${groupId}.`);
        if (owners.has(row.variable_id)) throw new Error(`Duplicate membership for ${row.variable_id}.`);
        owners.set(row.variable_id, groupId);
        variableIds.push(row.variable_id);
      }
      groups.get(groupId).variable_ids = variableIds.sort();
      loadedGroups.add(groupId);
    }
    return schema;
  }
  schema.groups = [...groups.values()].sort((a, b) => a.group_id.localeCompare(b.group_id));
  let rejectionPromise = null;
  async function loadRejected() {
    if (!rejectionPromise) rejectionPromise = (async () => {
      schema.rejected_variables = [];
      if (manifest.rejected_file) {
        const rows = parseTsv(await fetchText(new URL(manifest.rejected_file, base), fetchImpl), manifest.rejected_file);
        schema.rejected_variables = rows.map(row => {
          for (const column of LIST_COLUMNS) row[column] = JSON.parse(row[column] || "[]");
          return row;
        });
      }
      return schema.rejected_variables;
    })();
    return rejectionPromise;
  }
  async function loadComplete() {
    await Promise.all([loadMemberships(membershipEntries.map(([groupId]) => groupId)), loadRejected()]);
    return validateGroupingSchema(schema);
  }
  return { schema, manifest, loadMemberships, loadRejected, loadComplete, loadedGroups };
}

/**
 * Import legacy monolithic JSON during transition, preferring folder URLs.
 * @param {string | GroupingSchema} source
 * @returns {Promise<GroupingSchema>}
 */
export async function loadGroupingSchema(source, fetchImpl = fetch) {
  if (typeof source !== "string") return validateGroupingSchema(source);
  const url = new URL(source, globalThis.location?.href || "http://localhost/");
  if (url.pathname.endsWith(".json")) {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load grouping schema: ${response.status}`);
    return validateGroupingSchema(await response.json());
  }
  return loadGroupingSchemaFolder(url, fetchImpl);
}
