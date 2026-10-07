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
  assert.deepEqual([...view(3).exclusionViolations.violationIds].sort(), ["k1", "k2"]);
  const separateLengths = deriveDagView({ groups: instrumentGroups, links: instrumentLinks,
    ivId: "iv", dvId: "dv", instrumentId: "z", maxPathLength: 1,
    exclusionMaxPathLength: 2, showExclusionViolations: true });
  assert.deepEqual([...separateLengths.exclusionViolations.violationIds], ["k1"]);
});
