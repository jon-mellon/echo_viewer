const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertSafeJson(value, label, { maxDepth = 24, maxNodes = 250000 } = {}) {
  let nodes = 0;
  const visit = (item, path, depth) => {
    nodes += 1;
    if (nodes > maxNodes) throw new Error(`${label} is too large.`);
    if (depth > maxDepth) throw new Error(`${path} is nested too deeply.`);
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error(`${path} must contain a finite number.`);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(item)) throw new Error(`${path} contains an unsupported value.`);
    for (const [key, entry] of Object.entries(item)) {
      if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path} contains forbidden key ${key}.`);
      visit(entry, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, label, 0);
  return value;
}

function requireArray(payload, key, label) {
  if (Object.hasOwn(payload, key) && !Array.isArray(payload[key])) {
    throw new Error(`${label}.${key} must be an array.`);
  }
}

function requireRecord(payload, key, label, { nullable = false } = {}) {
  if (!Object.hasOwn(payload, key)) return;
  if (nullable && payload[key] === null) return;
  if (!isRecord(payload[key])) throw new Error(`${label}.${key} must be an object.`);
}

function requireString(record, key, path, { optional = false } = {}) {
  if (optional && !Object.hasOwn(record, key)) return;
  if (typeof record[key] !== "string" || !record[key].trim()) {
    throw new Error(`${path}.${key} must be a nonempty string.`);
  }
}

function validateGroups(groups, label) {
  const ids = new Set();
  for (const [index, group] of groups.entries()) {
    const path = `${label}.groups[${index}]`;
    if (!isRecord(group)) throw new Error(`${path} must be an object.`);
    requireString(group, "group_id", path);
    if (ids.has(group.group_id)) throw new Error(`${label} contains duplicate group_id ${group.group_id}.`);
    ids.add(group.group_id);
    if (!Array.isArray(group.variable_ids)) throw new Error(`${path}.variable_ids must be an array.`);
    if (group.variable_ids.some(id => typeof id !== "string" || !id)) {
      throw new Error(`${path}.variable_ids must contain nonempty strings.`);
    }
    if (new Set(group.variable_ids).size !== group.variable_ids.length) {
      throw new Error(`${path}.variable_ids contains duplicates.`);
    }
  }
  return ids;
}

export function validateProjectPayload(payload) {
  if (!isRecord(payload)) throw new Error("Project payload must be an object.");
  assertSafeJson(payload, "Project payload");
  for (const key of [
    "groups", "links", "decisions", "grouping_imports", "grouping_exports", "carve_outs",
    "manual_edges", "rejected_variables", "restored_variable_ids", "undoHistory", "actionLog",
  ]) requireArray(payload, key, "Project payload");
  for (const key of ["filters", "link_decisions", "seeds", "definitionDraft"]) {
    requireRecord(payload, key, "Project payload", { nullable: key === "definitionDraft" });
  }
  requireRecord(payload, "publication", "Project payload", { nullable: true });
  const groupIds = validateGroups(payload.groups || [], "Project payload");
  for (const [index, edge] of (payload.manual_edges || []).entries()) {
    const path = `Project payload.manual_edges[${index}]`;
    if (!isRecord(edge)) throw new Error(`${path} must be an object.`);
    for (const key of ["edge_id", "source_group_id", "target_group_id"]) requireString(edge, key, path);
    if (groupIds.size && (!groupIds.has(edge.source_group_id) || !groupIds.has(edge.target_group_id))) {
      throw new Error(`${path} references an unknown group.`);
    }
  }
  return payload;
}

export function validateGroupingSchema(schema) {
  if (!isRecord(schema)) throw new Error("Grouping schema must be an object.");
  assertSafeJson(schema, "Grouping schema");
  if (!Array.isArray(schema.groups)) throw new Error("Grouping schema.groups must be an array.");
  validateGroups(schema.groups, "Grouping schema");
  if (Object.hasOwn(schema, "rejected_variables") && !Array.isArray(schema.rejected_variables)) {
    throw new Error("Grouping schema.rejected_variables must be an array.");
  }
  return schema;
}
