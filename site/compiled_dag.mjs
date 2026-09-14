import { aggregateGroupLinks, linkKey } from "./dag_link_aggregation.mjs";

export const COMPILED_DAG_FORMAT = "echo-compiled-dag-v1";
export const DAG_COMPILER_VERSION = "1";
export const COMPILED_DAG_PATH = "compiled/dag.json";
export const COMPILED_MANIFEST_PATH = "compiled/manifest.json";

const encoder = new TextEncoder();
const compareText = (a, b) => String(a).localeCompare(String(b));

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJsonBytes(value) {
  return encoder.encode(JSON.stringify(stableValue(value)) + "\n");
}

export async function sha256Hex(bytes, cryptoApi = globalThis.crypto) {
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function evidenceSnapshotForSchema(schema) {
  return schema?.built_against?.record_signature
    || schema?.built_against?.snapshot_id
    || schema?.cache_compatibility?.record_signature
    || schema?.cache_compatibility?.snapshot_id
    || "working-schema";
}

export function projectForSchema(schema, project = {}) {
  const groups = (schema.groups || []).map(group => ({ ...group, variable_ids: [...(group.variable_ids || [])] }));
  const ids = new Set(groups.map(group => group.group_id));
  return {
    ...project,
    groups,
    iv_group_id: ids.has(project.iv_group_id) ? project.iv_group_id : "",
    dv_group_id: ids.has(project.dv_group_id) ? project.dv_group_id : "",
    manual_edges: project.manual_edges || [],
    link_decisions: project.link_decisions || {},
  };
}

export function indexRawLinks(rawLinks) {
  const rawLinksById = new Map();
  const linkLookup = new Map();
  for (const link of rawLinks || []) {
    const id = link.raw_causal_link_id;
    if (!id || rawLinksById.has(id)) continue;
    rawLinksById.set(id, link);
    const key = linkKey(link.source_variable_id, link.target_variable_id);
    if (!linkLookup.has(key)) linkLookup.set(key, []);
    linkLookup.get(key).push(id);
  }
  return { rawLinksById, linkLookup };
}

/** Canonical correctness implementation: membership + raw occurrences -> aggregate DAG. */
export function fullCompileDag({ schema, project = {}, rawLinks = [], linkLookup, rawLinksById }) {
  const indexed = linkLookup && rawLinksById ? { linkLookup, rawLinksById } : indexRawLinks(rawLinks);
  const compileProject = projectForSchema(schema, project);
  const edges = aggregateGroupLinks({ project: compileProject, ...indexed }).map(edge => ({
    ...edge,
    a_to_b_occurrence_count: edge.a_to_b_raw_link_ids.length,
    b_to_a_occurrence_count: edge.b_to_a_raw_link_ids.length,
    causal_link_occurrence_count: edge.a_to_b_raw_link_ids.length + edge.b_to_a_raw_link_ids.length,
  }));
  const nodes = compileProject.groups.map(group => ({
    group_id: group.group_id,
    label: group.label || "",
    member_count: (group.variable_ids || []).length,
    ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
  })).sort((a, b) => compareText(a.group_id, b.group_id));
  return { format: COMPILED_DAG_FORMAT, compiler_version: DAG_COMPILER_VERSION, nodes, edges };
}

export async function createCompiledArtifacts({ publicationId, schemaHash, evidenceSnapshot, dag, cryptoApi = globalThis.crypto }) {
  const boundDag = { ...dag, publication_id: publicationId, schema_hash: schemaHash, evidence_snapshot: evidenceSnapshot,
    compiler_version: DAG_COMPILER_VERSION };
  const dagBytes = stableJsonBytes(boundDag);
  const dagHash = await sha256Hex(dagBytes, cryptoApi);
  const manifest = {
    format: COMPILED_DAG_FORMAT,
    publication_id: publicationId,
    schema_hash: schemaHash,
    evidence_snapshot: evidenceSnapshot,
    compiler_version: DAG_COMPILER_VERSION,
    artifacts: { dag: { path: COMPILED_DAG_PATH, sha256: dagHash, bytes: dagBytes.byteLength } },
    row_counts: { group_nodes: dag.nodes.length, group_edges: dag.edges.length },
  };
  const manifestBytes = stableJsonBytes(manifest);
  return { dag: boundDag, dagBytes, manifest, manifestBytes };
}

export async function validateCompiledArtifact({ publication, manifest, dag, cryptoApi = globalThis.crypto }) {
  const expected = {
    publication_id: publication.id,
    schema_hash: publication.content_hash,
    evidence_snapshot: publication.evidence_snapshot,
    compiler_version: DAG_COMPILER_VERSION,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest?.[key] !== value || dag?.[key] !== value) throw new Error(`Compiled DAG ${key} mismatch.`);
  }
  if (manifest.format !== COMPILED_DAG_FORMAT || dag.format !== COMPILED_DAG_FORMAT) throw new Error("Unsupported compiled DAG format.");
  if (manifest.row_counts?.group_nodes !== dag.nodes?.length || manifest.row_counts?.group_edges !== dag.edges?.length) {
    throw new Error("Compiled DAG row count mismatch.");
  }
  const hash = await sha256Hex(stableJsonBytes(dag), cryptoApi);
  if (hash !== manifest.artifacts?.dag?.sha256) throw new Error("Compiled DAG artifact hash mismatch.");
  return dag;
}

export function dagEquals(left, right) {
  return JSON.stringify(stableValue({ nodes: left.nodes, edges: left.edges }))
    === JSON.stringify(stableValue({ nodes: right.nodes, edges: right.edges }));
}

function membership(schema) {
  return new Map((schema.groups || []).flatMap(group => (group.variable_ids || []).map(id => [id, group.group_id])));
}

/**
 * Exact batched update. Each incident raw occurrence is deduplicated, removed once
 * under the old ownership and added once under the new ownership. Rebuilding only
 * the affected aggregate pairs also preserves all existing display semantics.
 */
export function incrementCompiledDag({ compiledDag, oldSchema, newSchema, incidentRawLinks, project = {} }) {
  const oldOwner = membership(oldSchema);
  const newOwner = membership(newSchema);
  const changed = new Set([...new Set([...oldOwner.keys(), ...newOwner.keys()])]
    .filter(id => oldOwner.get(id) !== newOwner.get(id)));
  const incident = [...new Map((incidentRawLinks || [])
    .filter(link => changed.has(link.source_variable_id) || changed.has(link.target_variable_id))
    .map(link => [link.raw_causal_link_id, link])).values()];
  const affectedPairs = new Set();
  for (const link of incident) {
    for (const owners of [oldOwner, newOwner]) {
      const a = owners.get(link.source_variable_id), b = owners.get(link.target_variable_id);
      if (a && b && a !== b) affectedPairs.add([a, b].sort(compareText).join("__"));
    }
  }
  const incidentIds = new Set(incident.map(link => link.raw_causal_link_id));
  const edgesById = new Map((compiledDag.edges || []).map(edge => [edge.edge_id, {
    ...edge,
    a_to_b_raw_link_ids: (edge.a_to_b_raw_link_ids || []).filter(id => !incidentIds.has(id)),
    b_to_a_raw_link_ids: (edge.b_to_a_raw_link_ids || []).filter(id => !incidentIds.has(id)),
  }]));
  const additions = fullCompileDag({ schema: newSchema, project, rawLinks: incident }).edges;
  for (const addition of additions) {
    const current = edgesById.get(addition.edge_id);
    if (!current) edgesById.set(addition.edge_id, addition);
    else {
      current.a_to_b_raw_link_ids.push(...addition.a_to_b_raw_link_ids);
      current.b_to_a_raw_link_ids.push(...addition.b_to_a_raw_link_ids);
    }
  }
  const edges = [...edgesById.values()].flatMap(edge => {
    edge.a_to_b_raw_link_ids = [...new Set(edge.a_to_b_raw_link_ids)];
    edge.b_to_a_raw_link_ids = [...new Set(edge.b_to_a_raw_link_ids)];
    edge.a_to_b_occurrence_count = edge.a_to_b_raw_link_ids.length;
    edge.b_to_a_occurrence_count = edge.b_to_a_raw_link_ids.length;
    edge.causal_link_occurrence_count = edge.a_to_b_occurrence_count + edge.b_to_a_occurrence_count;
    edge.mapping_a_to_b_exists = edge.a_to_b_occurrence_count > 0;
    edge.mapping_b_to_a_exists = edge.b_to_a_occurrence_count > 0;
    const forward = edge.mapping_a_to_b_exists || edge.manual_a_to_b_exists || edge.is_target_relation;
    const reverse = edge.mapping_b_to_a_exists || edge.manual_b_to_a_exists;
    edge.direction_type = forward && reverse ? "BIDIRECTIONAL" : forward ? "A_TO_B" : reverse ? "B_TO_A" : "NO_MAPPING_LINK";
    edge.edge_source = edge.causal_link_occurrence_count
      ? (edge.is_manual ? "mapping_and_manual" : "mapping_derived") : "user_manual";
    return edge.causal_link_occurrence_count || edge.is_manual || edge.is_target_relation ? [edge] : [];
  }).sort((a, b) => compareText(a.edge_id, b.edge_id));
  const nodeById = new Map((compiledDag.nodes || []).map(node => [node.group_id, node]));
  const nodes = (newSchema.groups || []).map(group => ({
    ...(nodeById.get(group.group_id) || {}), group_id: group.group_id, label: group.label || "",
    member_count: (group.variable_ids || []).length,
    ...(Number.isFinite(group.similarity_coherence) ? { similarity_coherence: group.similarity_coherence } : {}),
  })).sort((a, b) => compareText(a.group_id, b.group_id));
  return { ...compiledDag, nodes, edges };
}
