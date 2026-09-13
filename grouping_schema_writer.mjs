export const GROUPING_FORMAT_VERSION = "groupings-v2";
const SHARD_SIZE = 1000;
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
  return `${encodeURIComponent(groupId).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}.yaml`;
}

async function sha256Hex(bytes, cryptoApi) {
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function shardName(variableId, cryptoApi) {
  const match = /^v(\d+)$/.exec(variableId);
  if (match) return `${String(Math.floor(Number(match[1]) / SHARD_SIZE)).padStart(4, "0")}.tsv`;
  return `h${(await sha256Hex(new TextEncoder().encode(variableId), cryptoApi)).slice(0, 4)}.tsv`;
}

function validateSchema(schema) {
  if (schema?.schema_version !== GROUPING_FORMAT_VERSION || !Array.isArray(schema.groups)) {
    throw new Error("Working schema must use schema_version groupings-v2.");
  }
  if (schema.membership_unit !== "canonical_variable") {
    throw new Error("Working schema must use canonical_variable membership.");
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

  const groupFiles = [];
  const memberships = new Map();
  for (const group of [...schema.groups].sort((left, right) => compareText(left.group_id, right.group_id))) {
    const relative = `groups/${groupFilename(group.group_id)}`;
    groupFiles.push(relative);
    const definition = Object.fromEntries(Object.entries(group).filter(([key]) => key !== "variable_ids"));
    textFiles.set(relative, mapping(definition, ["group_id", "label", "notes", "similarity_coherence"]));
    for (const variableId of [...new Set(group.variable_ids)].sort()) {
      const filename = await shardName(variableId, cryptoApi);
      if (!memberships.has(filename)) memberships.set(filename, []);
      memberships.get(filename).push({ variable_id: variableId, group_id: group.group_id });
    }
  }

  const membershipShards = [];
  for (const filename of [...memberships.keys()].sort()) {
    const relative = `memberships/${filename}`;
    membershipShards.push(relative);
    const rows = memberships.get(filename).sort((left, right) => compareText(left.variable_id, right.variable_id));
    textFiles.set(relative, tsv(rows, ["variable_id", "group_id"]));
  }

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
    group_files: groupFiles,
    membership_shards: membershipShards,
    membership_sharding: {
      indexed_id_pattern: "^v([0-9]+)$",
      indexed_id_shard_size: SHARD_SIZE,
      fallback: "h + first 4 lowercase hex characters of SHA-256(variable_id)",
    },
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
