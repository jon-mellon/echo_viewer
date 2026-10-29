import test from "node:test";
import assert from "node:assert/strict";
import { deriveDagView, excludedForConnectivity } from "../site/dag_view.mjs";

const groups = ["iv", "dv", "c", "x", "z"].map(group_id => ({ group_id }));
const link = (edge_id, group_a, group_b, direction_type, extra = {}) => ({
  edge_id, group_a, group_b, direction_type, display_status: "included", ...extra,
});
const links = [
  link("c_iv", "c", "iv", "A_TO_B"),
  link("c_dv", "c", "dv", "A_TO_B"),
  link("iv_x", "iv", "x", "A_TO_B"),
  link("dv_x", "dv", "x", "A_TO_B"),
  link("excluded", "iv", "z", "A_TO_B", { display_status: "excluded" }),
];

test("derived view combines causal, confounder and collider projections without mutation", () => {
  const before = structuredClone({ groups, links });
  const view = deriveDagView({
    groups, links, ivId: "iv", dvId: "dv", maxPathLength: 2,
    filterByCausalRelevance: true,
  });
  assert.equal(view.filterByCausalRelevance, true);
  // Excluded evidence no longer connects z to the IV component.
  assert.deepEqual([...view.componentGroupIds].sort(), ["c", "dv", "iv", "x"]);
  assert.deepEqual(view.visibleLinks.map(item => item.edge_id), ["c_iv", "c_dv", "iv_x", "dv_x"]);
  assert.deepEqual([...view.confounders.confounderIds], ["c"]);
  assert.deepEqual([...view.colliders.colliderIds], ["x"]);
  assert.deepEqual({ groups, links }, before);
});

test("diagnostic modes retain only witness links when requested", () => {
  const confounders = deriveDagView({
    groups, links, ivId: "iv", dvId: "dv", maxPathLength: 2,
    showConfoundersOnly: true, hideIrrelevantDiagnosticLinks: true,
  });
  assert.deepEqual([...confounders.componentGroupIds].sort(), ["c", "dv", "iv"]);
  assert.deepEqual(confounders.visibleLinks.map(item => item.edge_id), ["c_iv", "c_dv"]);

  const colliders = deriveDagView({
    groups, links, ivId: "iv", dvId: "dv", maxPathLength: 2,
    showCollidersOnly: true, hideIrrelevantDiagnosticLinks: true,
  });
  assert.deepEqual([...colliders.componentGroupIds].sort(), ["dv", "iv", "x"]);
  assert.deepEqual(colliders.visibleLinks.map(item => item.edge_id), ["iv_x", "dv_x"]);
});

test("a node linked only to the IV is absent from the confounder map", () => {
  const screenshotGroups = ["personality", "vote", "academic", "education", "exposure", "ideology"]
    .map(group_id => ({ group_id }));
  const screenshotLinks = [
    link("academic_iv", "academic", "personality", "BIDIRECTIONAL"),
    ...["education", "exposure", "ideology"].flatMap(id => [
      link(`${id}_iv`, id, "personality", "A_TO_B"),
      link(`${id}_dv`, id, "vote", "A_TO_B"),
    ]),
    link("target", "personality", "vote", "A_TO_B", { is_target_relation: true }),
  ];
  const view = deriveDagView({ groups: screenshotGroups, links: screenshotLinks,
    ivId: "personality", dvId: "vote", maxPathLength: 1,
    showConfoundersOnly: true, hideIrrelevantDiagnosticLinks: true });
  assert.deepEqual([...view.confounders.confounderIds].sort(), ["education", "exposure", "ideology"]);
  assert.equal(view.componentGroupIds.has("academic"), false);
  assert.equal(view.visibleLinks.some(edge => edge.edge_id === "academic_iv"), false);
});

test("confounder default leaves the map visible while anchors are missing", () => {
  const view = deriveDagView({
    groups, links, showConfoundersOnly: true, hideIrrelevantDiagnosticLinks: true,
  });
  assert.equal(view.componentGroupIds.size, groups.length);
  assert.deepEqual(view.visibleLinks.map(item => item.edge_id), ["c_iv", "c_dv", "iv_x", "dv_x"]);
});

test("missing IV disables causal filtering and excluded evidence obeys connectivity exceptions", () => {
  const view = deriveDagView({ groups, links, ivId: "missing", dvId: "dv", filterByCausalRelevance: true });
  assert.equal(view.filterByCausalRelevance, false);
  assert.equal(view.componentGroupIds.size, groups.length);
  assert.equal(excludedForConnectivity({ display_status: "excluded" }), true);
  assert.equal(excludedForConnectivity({ display_status: "excluded", is_target_relation: true }), false);
});

test("instrument view finds bounded directed exclusion paths without the IV", () => {
  const instrumentGroups = ["z", "k1", "k2", "iv", "dv", "other"].map(group_id => ({ group_id }));
  const instrumentLinks = [
    link("z_k1", "z", "k1", "A_TO_B"),
    link("k1_dv", "k1", "dv", "A_TO_B"),
    link("k1_k2", "k1", "k2", "A_TO_B"),
    link("k2_dv", "k2", "dv", "A_TO_B"),
    link("z_iv", "z", "iv", "A_TO_B"),
    link("iv_dv", "iv", "dv", "A_TO_B"),
    link("excluded_visible", "iv", "k1", "A_TO_B", { display_status: "excluded" }),
    link("z_other", "z", "other", "A_TO_B", { display_status: "excluded" }),
    link("other_dv", "other", "dv", "A_TO_B"),
  ];
  const view = length => deriveDagView({ groups: instrumentGroups, links: instrumentLinks,
    ivId: "iv", dvId: "dv", instrumentId: "z", maxPathLength: length,
    showExclusionViolations: true });
  assert.deepEqual([...view(1).exclusionViolations.violationIds], []);
  assert.deepEqual([...view(2).exclusionViolations.violationIds], ["k1"]);
  assert.deepEqual([...view(2).componentGroupIds].sort(), ["dv", "iv", "k1", "z"]);
  assert.deepEqual(view(2).visibleLinks.map(item => item.edge_id), ["z_k1", "k1_dv"]);
  const allVisibleLinks = deriveDagView({ groups: instrumentGroups, links: instrumentLinks,
    ivId: "iv", dvId: "dv", instrumentId: "z", exclusionMaxPathLength: 2,
    showExclusionViolations: true, showAllExclusionLinks: true });
  assert.deepEqual([...allVisibleLinks.componentGroupIds].sort(), ["dv", "iv", "k1", "z"]);
  assert.deepEqual(allVisibleLinks.visibleLinks.map(item => item.edge_id),
    ["z_k1", "k1_dv", "z_iv", "iv_dv"]);
  assert.deepEqual([...view(3).exclusionViolations.violationIds].sort(), ["k1", "k2"]);
  const separateLengths = deriveDagView({ groups: instrumentGroups, links: instrumentLinks,
    ivId: "iv", dvId: "dv", instrumentId: "z", maxPathLength: 1,
    exclusionMaxPathLength: 2, showExclusionViolations: true });
  assert.deepEqual([...separateLengths.exclusionViolations.violationIds], ["k1"]);
});

test("exogeneity view finds common ancestors of the instrument and outcome", () => {
  const exogGroups = ["z", "iv", "dv", "common", "via", "through_z", "excluded"].map(group_id => ({ group_id }));
  const exogLinks = [
    link("common_via", "common", "via", "A_TO_B"),
    link("via_z", "via", "z", "A_TO_B"),
    link("common_dv", "common", "dv", "A_TO_B"),
    link("z_iv", "z", "iv", "A_TO_B"),
    link("iv_dv", "iv", "dv", "A_TO_B"),
    link("through_z", "through_z", "z", "A_TO_B"),
    link("excluded_z", "excluded", "z", "A_TO_B", { display_status: "excluded" }),
    link("excluded_dv", "excluded", "dv", "A_TO_B"),
  ];
  const view = length => deriveDagView({ groups: exogGroups, links: exogLinks,
    ivId: "iv", dvId: "dv", instrumentId: "z", maxPathLength: length,
    showExogeneity: true, hideIrrelevantDiagnosticLinks: true });
  assert.deepEqual([...view(1).exogeneity.confounderIds], []);
  const result = view(2);
  assert.deepEqual([...result.exogeneity.confounderIds], ["common"]);
  assert.deepEqual([...result.componentGroupIds].sort(), ["common", "dv", "iv", "via", "z"]);
  assert.deepEqual(result.visibleLinks.map(item => item.edge_id), ["common_via", "via_z", "common_dv"]);
  assert.deepEqual(result.exogeneity.pathsByGroup.get("common"), {
    toIv: ["common", "via", "z"], toDv: ["common", "dv"],
  });
});

test("sparse edge filtering counts distinct present papers before finding paths", () => {
  const evidence = new Map([
    ["a", { paper_id: "p1" }], ["b", { paper_id: "p1" }],
    ["c", { paper_id: "p2", causal_link_existence: "absent" }],
    ["d", { paper_id: "p2", causal_link_existence: "present" }],
  ]);
  const supportedLinks = [
    link("c_iv", "c", "iv", "A_TO_B", { a_to_b_raw_link_ids: ["a", "b", "c"] }),
    link("c_dv", "c", "dv", "A_TO_B", { a_to_b_raw_link_ids: ["a"], b_to_a_raw_link_ids: ["d"] }),
  ];
  const options = { groups, links: supportedLinks, ivId: "iv", dvId: "dv", rawLinksById: evidence };
  assert.equal(deriveDagView(options).visibleLinks.length, 2);
  const filtered = deriveDagView({ ...options, excludeSparseEdges: true });
  assert.deepEqual(filtered.visibleLinks.map(item => item.edge_id), ["c_dv"]);
  assert.equal(filtered.confounders.confounderIds.size, 0);
  assert.equal(deriveDagView({ ...options, excludeSparseEdges: true, minimumEdgePapers: 1 }).visibleLinks.length, 2);
  assert.equal(deriveDagView({ ...options, excludeSparseEdges: true, minimumEdgePapers: 3 }).visibleLinks.length, 0);
});


test("compact paper support matches full evidence without populating the detail cache", () => {
  const rawLinksById = new Map([
    ["a", { paper_id: "p1", source_variable_id: "v1" }],
    ["b", { paper_id: "p1", causal_link_existence: "present" }],
    ["c", { paper_id: "p2", causal_link_existence: "absent" }],
    ["d", { paper_id: "p2", causal_link_existence: "uncertain" }],
    ["e", { paper_id: "p2", causal_link_existence: "present" }],
  ]);
  const edgeSupportById = new Map([...rawLinksById].map(([id, row]) =>
    [id, { paper_id: row.paper_id, causal_link_existence: row.causal_link_existence }]));
  const edges = [
    link("sparse", "c", "iv", "A_TO_B", { a_to_b_raw_link_ids: ["a", "b", "c", "d"] }),
    link("supported", "c", "dv", "A_TO_B", { a_to_b_raw_link_ids: ["a"], b_to_a_raw_link_ids: ["e"] }),
  ];
  const full = deriveDagView({ groups, links: edges, rawLinksById, excludeSparseEdges: true });
  const details = new Map();
  const compact = deriveDagView({ groups, links: edges, rawLinksById: details,
    edgeSupportById, excludeSparseEdges: true });
  assert.deepEqual(compact.visibleLinks, full.visibleLinks);
  assert.deepEqual(compact.visibleLinks.map(edge => edge.edge_id), ["supported"]);
  assert.equal(details.size, 0);
  // Newly edited evidence can already be in the full cache, before another
  // compact scan is needed. Both caches participate in the same paper count.
  edgeSupportById.delete("e");
  details.set("e", rawLinksById.get("e"));
  assert.deepEqual(deriveDagView({ groups, links: edges, rawLinksById: details,
    edgeSupportById, excludeSparseEdges: true }).visibleLinks, full.visibleLinks);
});
