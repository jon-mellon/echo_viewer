import { writeFile } from "node:fs/promises";

import {
  connectedComponentGraph,
  createGraph,
  filterGraphByConfounders,
  filterGraphByLinkPairs,
  filterGraphLinks,
  filterGraphNodes,
} from "../../site/dag_graph.mjs";

const artifactDir = new URL("./artifacts/playwright-2026-08-31/", import.meta.url);
const IV = "group_exposure";
const DV = "group_outcome";

const groupDefinitions = [
  [IV, "exposure", "iv"],
  [DV, "outcome", "dv"],
  ["group_direct_confounder", "direct confounder", "candidate"],
  ["group_indirect_confounder", "indirect confounder", "candidate"],
  ["group_iv_mediator", "IV-path mediator", "candidate"],
  ["group_dv_mediator", "DV-path mediator", "candidate"],
  ["group_bottlenecked", "bottlenecked candidate", "candidate"],
  ["group_shared_mediator", "shared mediator", "candidate"],
  ["group_long_confounder", "long-path confounder", "candidate"],
  ["group_long_iv_a", "long IV mediator A", "candidate"],
  ["group_long_iv_b", "long IV mediator B", "candidate"],
  ["group_long_dv_a", "long DV mediator A", "candidate"],
  ["group_long_dv_b", "long DV mediator B", "candidate"],
  ["group_collider", "collider", "candidate"],
  ["group_iv_to_collider", "IV-to-collider mediator", "candidate"],
  ["group_dv_to_collider", "DV-to-collider mediator", "candidate"],
];

const groups = groupDefinitions.map(([group_id, label, type], index) => ({
  group_id,
  label,
  variable_ids: [`synthetic_variable_${String(index + 1).padStart(2, "0")}`],
  status: "accepted",
  source: "synthetic_test_fixture",
  notes: "",
  type,
}));

function link(groupA, groupB, directionType = "A_TO_B", options = {}) {
  const edgeId = [groupA, groupB].sort().join("__");
  return {
    edge_id: edgeId,
    group_a: groupA,
    group_b: groupB,
    is_target_relation: options.isTargetRelation || false,
    target_direction: options.isTargetRelation ? "IV_TO_DV" : "",
    edge_source: "synthetic_test_fixture",
    is_manual: false,
    manual_edge_ids: [],
    mapping_a_to_b_exists: directionType !== "B_TO_A",
    mapping_b_to_a_exists: directionType !== "A_TO_B",
    manual_a_to_b_exists: false,
    manual_b_to_a_exists: false,
    direction_type: directionType,
    a_to_b_raw_link_ids: [],
    b_to_a_raw_link_ids: [],
    a_to_b_paper_table_keys: [],
    b_to_a_paper_table_keys: [],
    display_status: "active_by_default",
    user_decision: null,
  };
}

const links = [
  link(IV, DV, "A_TO_B", { isTargetRelation: true }),
  link("group_direct_confounder", IV),
  link("group_direct_confounder", DV, "BIDIRECTIONAL"),
  link("group_indirect_confounder", "group_iv_mediator"),
  link("group_iv_mediator", IV),
  link("group_indirect_confounder", "group_dv_mediator"),
  link("group_dv_mediator", DV),
  link("group_bottlenecked", "group_shared_mediator"),
  link("group_shared_mediator", IV),
  link("group_shared_mediator", DV),
  link("group_long_confounder", "group_long_iv_a"),
  link("group_long_iv_a", "group_long_iv_b"),
  link("group_long_iv_b", IV),
  link("group_long_confounder", "group_long_dv_a"),
  link("group_long_dv_a", "group_long_dv_b"),
  link("group_long_dv_b", DV),
  link(IV, "group_iv_to_collider"),
  link("group_iv_to_collider", "group_collider"),
  link(DV, "group_dv_to_collider"),
  link("group_dv_to_collider", "group_collider"),
];

const project = {
  schema_version: "dag-builder-project-v1",
  saved_at: "2000-01-01T00:00:00.000Z",
  project_id: "synthetic_acceptance_fixture",
  active_grouping_set_id: "synthetic_grouping_v1",
  iv_group_id: IV,
  dv_group_id: DV,
  groups,
  links,
  candidate_queue: [],
  decisions: [],
  filters: {},
  grouping_imports: [],
  grouping_exports: [],
  carve_outs: [],
  link_decisions: [],
  manual_edges: [],
  rejected_variables: [],
  selectedUoa: "synthetic",
  uoaFilterEnabled: false,
  phase: "dag",
  workflowMode: "dag",
  dagLayoutMode: "auto",
  seeds: {},
  variableLayoutSource: "synthetic",
  exported_at: "2000-01-01T00:00:00.000Z",
};

function excludedForConnectivity(item) {
  return item.display_status === "excluded" && !item.is_manual && !item.is_target_relation;
}

function displayedLink(item) {
  if (item.display_status === "hidden") return false;
  return item.display_status !== "excluded" || item.is_manual || item.is_target_relation;
}

function graphForState({
  causal = true,
  confounders = false,
  maxPathLength = 1,
  excludeBottlenecked = false,
  pathLinksOnly = false,
} = {}) {
  const fullGraph = createGraph(groups.map((group) => group.group_id), links);
  const connectivityGraph = filterGraphLinks(fullGraph, (item) => !excludedForConnectivity(item));
  const confounderGraph = filterGraphByConfounders(fullGraph, {
    ivId: IV,
    dvId: DV,
    maxPathLength,
    excludeBottlenecked,
    traversableLink: (item) => !excludedForConnectivity(item) && item.display_status !== "hidden",
  });
  let visibleGraph = confounders
    ? confounderGraph
    : causal
      ? connectedComponentGraph(connectivityGraph, IV)
      : fullGraph;
  visibleGraph = filterGraphNodes(fullGraph, visibleGraph.nodeIds);
  visibleGraph = filterGraphLinks(visibleGraph, displayedLink);
  if (confounders && pathLinksOnly) {
    visibleGraph = filterGraphByLinkPairs(visibleGraph, confounderGraph.metadata.linkPairKeys);
  }
  return visibleGraph;
}

const checkpoints = [
  ["02-causal-view.json", {}],
  ["03-all-links-view.json", { causal: false }],
  ["05-path-1.json", { confounders: true }],
  ["06-path-2.json", { confounders: true, maxPathLength: 2 }],
  ["07-path-3.json", { confounders: true, maxPathLength: 3 }],
  ["08-path-4-full.json", { confounders: true, maxPathLength: 4 }],
  ["09-path-4-bottleneck.json", { confounders: true, maxPathLength: 4, excludeBottlenecked: true }],
  ["10-path-4-bottleneck-path-links.json", {
    confounders: true,
    maxPathLength: 4,
    excludeBottlenecked: true,
    pathLinksOnly: true,
  }],
  ["10-path-4-path-links.json", { confounders: true, maxPathLength: 4, pathLinksOnly: true }],
  ["13-path-99.json", { confounders: true, maxPathLength: 99 }],
  ["20-path-1-path-links.json", { confounders: true, pathLinksOnly: true }],
];

function exportGraph(graph) {
  return {
    schema_version: "working-causal-map-v1",
    exported_at: "2000-01-01T00:00:00.000Z",
    iv_group_id: IV,
    dv_group_id: DV,
    groups: groups.filter((group) => graph.nodeIds.has(group.group_id)),
    links: graph.links,
    manual_edges: [],
    rejected_variables: [],
    hidden_variable_ids: [],
    allows_bidirectional_links: true,
    allows_cycles: true,
  };
}

await writeFile(new URL("project-fixture.json", artifactDir), `${JSON.stringify(project, null, 2)}\n`);
for (const [filename, options] of checkpoints) {
  await writeFile(
    new URL(filename, artifactDir),
    `${JSON.stringify(exportGraph(graphForState(options)), null, 2)}\n`,
  );
}
