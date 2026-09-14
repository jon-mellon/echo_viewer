import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "./app_contracts.mjs";
export { GROUPING_FORMAT_VERSION } from "./app_contracts.mjs";
const SCHEMA_KEYS = ["schema_version", "grouping_set_id", "label", "description"];
const REJECTED_COLUMNS = [
  "variable_id", "member_variable_ids", "label", "reason", "flagged_at", "previous_group_ids",
];
const LIST_COLUMNS = new Set(["member_variable_ids", "previous_group_ids"]);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function scalar(value) {
  return JSON.stringify(value);
}

function mapping(values, preferred = []) {
  const ordered = preferred.filter(key => Object.hasOwn(values, key));
  ordered.push(...Object.keys(values).filter(key => !ordered.includes(key)).sort());
  return ordered.map(key => `${key}: ${scalar(values[key])}\n`).join("");
}

function tsvCell(value) {
  const text = String(value ?? "");
  return /["\t\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tsv(rows, columns) {
  return [columns, ...rows.map(row => columns.map(column => row[column] ?? ""))]
    .map(row => row.map(tsvCell).join("\t"))
    .join("\n") + "\n";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value), null, 2) + "\n";
}

function groupFilename(groupId) {
  if (!groupId) throw new Error("Every published group must have a non-empty group_id.");
  return `${encodeURIComponent(groupId).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}.tsv`;
}

async function sha256Hex(bytes, cryptoApi) {
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateSchema(schema) {
  if (schema?.schema_version !== GROUPING_FORMAT_VERSION || !Array.isArray(schema.groups)) {
    throw new Error(`Working schema must use schema_version ${GROUPING_FORMAT_VERSION}.`);
  }
  if (schema.membership_unit !== GROUPING_MEMBERSHIP_UNIT) {
    throw new Error(`Working schema must use ${GROUPING_MEMBERSHIP_UNIT} membership.`);
  }
  const groupIds = new Set();
  const owners = new Map();
  for (const group of schema.groups) {
    if (!group?.group_id || groupIds.has(group.group_id) || !Array.isArray(group.variable_ids)) {
      throw new Error(`Invalid or duplicate published group_id: ${group?.group_id}`);
    }
    groupIds.add(group.group_id);
    for (const variableId of group.variable_ids) {
      if (!variableId || (owners.has(variableId) && owners.get(variableId) !== group.group_id)) {
        throw new Error(`Canonical variable ${variableId} has conflicting group ownership.`);
      }
      owners.set(variableId, group.group_id);
    }
  }
}

/** Mirror grouping_schema.write_folder with byte-stable browser files. */
export async function writeGroupingSchemaFolder(schema, cryptoApi = globalThis.crypto) {
  validateSchema(schema);
  const encoder = new TextEncoder();
  const textFiles = new Map();
  const schemaValues = Object.fromEntries(SCHEMA_KEYS.filter(key => Object.hasOwn(schema, key)).map(key => [key, schema[key]]));
  schemaValues.schema_version = GROUPING_FORMAT_VERSION;
  textFiles.set("schema.yaml", mapping(schemaValues, SCHEMA_KEYS));

  const groupRows = [];
  const groupMembershipFiles = {};
  for (const group of [...schema.groups].sort((left, right) => compareText(left.group_id, right.group_id))) {
    const definition = Object.fromEntries(Object.entries(group).filter(([key]) => key !== "variable_ids"));
    delete definition.group_id;
    groupRows.push({ group_id: group.group_id, metadata: stableJson(definition).trimEnd() });
    const relative = `memberships/${groupFilename(group.group_id)}`;
    groupMembershipFiles[group.group_id] = relative;
    const rows = [...new Set(group.variable_ids)].sort(compareText).map(variable_id => ({ variable_id }));
    textFiles.set(relative, tsv(rows, ["variable_id"]));
  }
  textFiles.set("groups.tsv", tsv(groupRows, ["group_id", "metadata"]));

  let rejectedFile = null;
  if (schema.rejected_variables?.length) {
    rejectedFile = "rejected.tsv";
    const rows = [...schema.rejected_variables]
      .sort((left, right) => compareText(String(left.variable_id || ""), String(right.variable_id || "")))
      .map(item => Object.fromEntries(REJECTED_COLUMNS.map(column => {
        const value = item[column] ?? (LIST_COLUMNS.has(column) ? [] : "");
        return [column, LIST_COLUMNS.has(column) ? scalar([...value].sort()) : value];
      })));
    textFiles.set(rejectedFile, tsv(rows, REJECTED_COLUMNS));
  }

  const structural = new Set([...SCHEMA_KEYS, "groups", "rejected_variables", "cache_compatibility", "built_against", "migration_provenance"]);
  const extra = Object.fromEntries(Object.keys(schema).filter(key => !structural.has(key)).sort().map(key => [key, schema[key]]));
  if (Array.isArray(extra.hidden_variable_ids)) extra.hidden_variable_ids = [...new Set(extra.hidden_variable_ids)].sort();
  const manifest = {
    format_version: GROUPING_FORMAT_VERSION,
    schema_file: "schema.yaml",
    groups_file: "groups.tsv",
    group_membership_files: groupMembershipFiles,
    membership_unit: schema.membership_unit,
    rejected_file: rejectedFile,
    compatibility: schema.cache_compatibility || {},
    built_against: schema.built_against || {},
    provenance: schema.migration_provenance || {},
    extra,
    top_level_fields: Object.keys(schema).sort(),
  };
  textFiles.set("manifest.json", stableJson(manifest));
  return new Map([...textFiles.entries()].map(([path, text]) => [path, encoder.encode(text)]));
}

export async function canonicalFolderHash(files, cryptoApi = globalThis.crypto) {
  const index = [];
  for (const [path, bytes] of [...files.entries()].sort(([left], [right]) => compareText(left, right))) {
    index.push({ path, size: bytes.byteLength, sha256: await sha256Hex(bytes, cryptoApi) });
  }
  return sha256Hex(new TextEncoder().encode(JSON.stringify(index)), cryptoApi);
}
