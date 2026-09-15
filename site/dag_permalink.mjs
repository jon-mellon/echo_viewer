export const PERMALINK_VERSION = "1";

const booleanFields = {
  causal: "filterDagByCausalRelevance", conf: "showConfoundersOnly",
  coll: "showCollidersOnly", bottle: "excludeBottleneckedConfounders",
  paths: "hideIrrelevantConfounderLinks", vl: "showVariableLabels", gl: "showGroupLabels",
};

export function permalinkInput(location = globalThis.location) {
  const params = new URL(location.href).searchParams;
  if (params.get("p") !== PERMALINK_VERSION) return null;
  return params;
}

export function schemaMatchesProject(schema, project) {
  if (!schema || !project || schema.grouping_set_id !== project.active_grouping_set_id) return false;
  if ((project.manual_edges || []).some(edge => !edge.deleted)) return false;
  if (Object.keys(project.link_decisions || {}).length) return false;
  const source = new Map((schema.groups || []).map(group => [group.group_id, group]));
  if ((project.groups || []).length !== source.size) return false;
  return project.groups.every(group => {
    const original = source.get(group.source_group_id || group.group_id);
    if (!original || (group.label || "") !== (original.label || "") || (group.notes || "") !== (original.notes || "")) return false;
    return JSON.stringify([...(group.variable_ids || [])].sort()) === JSON.stringify([...(original.variable_ids || [])].sort());
  });
}

export function buildPermalink({ location, schemaUrl, dataVersion, state }) {
  const url = new URL(location.href);
  url.search = "";
  const values = {
    p: PERMALINK_VERSION, schema_url: schemaUrl, data_version: dataVersion,
    iv: state.project.iv_group_id, dv: state.project.dv_group_id,
    mode: state.workflowMode, layout: state.dagLayoutMode, vlayout: state.variableLayoutSource,
    path: String(state.confounderMaxPathLength),
    selected_group: state.activeGroupId || "", selected_variable: state.selectedVariableId || "",
    selected_edge: state.selectedEdgeId || "", sort: state.groupListSort || "",
    fs: state.fullscreenPanel || "",
    mz: String(state.map?.transform?.scale ?? ""), mx: String(state.map?.transform?.tx ?? ""),
    my: String(state.map?.transform?.ty ?? ""),
    dz: String(state.dagViewport?.scale ?? ""), dx: String(state.dagViewport?.position?.x ?? ""),
    dy: String(state.dagViewport?.position?.y ?? ""),
  };
  for (const [parameter, field] of Object.entries(booleanFields)) values[parameter] = state[field] ? "1" : "0";
  for (const [key, value] of Object.entries(values)) if (value !== "") url.searchParams.set(key, value);
  return url.href;
}

export function applyPermalink(params, state) {
  if (!params) return false;
  const groups = state.project.groups || [];
  const resolveGroup = id => groups.find(group => group.group_id === id || group.source_group_id === id)?.group_id;
  const iv = resolveGroup(params.get("iv"));
  const dv = resolveGroup(params.get("dv"));
  if (!iv || !dv || iv === dv) throw new Error("Permalink IV or DV is absent from the referenced schema.");
  state.project.iv_group_id = iv;
  state.project.dv_group_id = dv;
  for (const group of groups) {
    if (group.group_id === iv) group.type = "iv";
    else if (group.group_id === dv) group.type = "dv";
    else if (group.type === "iv" || group.type === "dv") group.type = "candidate";
  }
  const ivGroup = groups.find(group => group.group_id === iv);
  const dvGroup = groups.find(group => group.group_id === dv);
  state.seeds = {
    ...(state.seeds || {}),
    iv: new Set(ivGroup?.variable_ids || []),
    dv: new Set(dvGroup?.variable_ids || []),
  };
  state.workflowMode = params.get("mode") || "dag";
  state.dagLayoutMode = ["auto", "hierarchical", "organic"].includes(params.get("layout")) ? params.get("layout") : "auto";
  state.variableLayoutSource = params.get("vlayout") || state.variableLayoutSource;
  state.selectedUoa = null;
  state.uoaFilterEnabled = false;
  state.confounderMaxPathLength = Math.max(1, Math.min(99, Number(params.get("path")) || 1));
  for (const [parameter, field] of Object.entries(booleanFields)) if (params.has(parameter)) state[field] = params.get(parameter) === "1";
  state.activeGroupId = resolveGroup(params.get("selected_group")) || null;
  state.selectedVariableId = params.get("selected_variable") || null;
  state.selectedEdgeId = params.get("selected_edge") || null;
  state.groupListSort = params.get("sort") === "alpha" ? "alpha" : "relevance";
  state.fullscreenPanel = ["variable-map", "dag"].includes(params.get("fs")) ? params.get("fs") : null;
  const numeric = key => Number(params.get(key));
  if (["mz", "mx", "my"].every(key => params.has(key) && Number.isFinite(numeric(key)))) {
    state.map ||= {};
    state.map.transform = { scale: numeric("mz"), tx: numeric("mx"), ty: numeric("my") };
    state.permalinkMapViewport = true;
  }
  if (["dz", "dx", "dy"].every(key => params.has(key) && Number.isFinite(numeric(key)))) {
    state.permalinkDagViewport = { scale: numeric("dz"), position: { x: numeric("dx"), y: numeric("dy") } };
  }
  return true;
}

export const CUSTOM_SCHEMA_INSTRUCTIONS = `This view cannot be shared yet because its schema differs from the hosted schema.\n\n1. Click “Export schema”.\n2. Convert the exported JSON with: convert_groupings_schema.py to-folder exported.json schema/\n3. Commit the entire schema/ folder to a public GitHub repository.\n4. Use the raw.githubusercontent.com URL for that folder, ending with “/”.\n5. Reopen this viewer with ?schema_url=<encoded raw folder URL>.\n6. Confirm the hosted schema loads, recreate the view, then click “Copy permalink” again.\n\nThe host must permit browser CORS requests and serve every file listed by manifest.json.`;
