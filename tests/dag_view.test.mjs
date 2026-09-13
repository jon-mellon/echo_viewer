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
  link("hidden", "iv", "z", "A_TO_B", { display_status: "hidden" }),
];

test("derived view combines causal, confounder and collider projections without mutation", () => {
  const before = structuredClone({ groups, links });
  const view = deriveDagView({
    groups, links, ivId: "iv", dvId: "dv", maxPathLength: 2,
    filterByCausalRelevance: true,
  });
  assert.equal(view.filterByCausalRelevance, true);
  // Hidden evidence is excluded from display but retains legacy connectivity.
  assert.deepEqual([...view.componentGroupIds].sort(), ["c", "dv", "iv", "x", "z"]);
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

test("missing IV disables causal filtering and excluded evidence obeys connectivity exceptions", () => {
  const view = deriveDagView({ groups, links, ivId: "missing", dvId: "dv", filterByCausalRelevance: true });
  assert.equal(view.filterByCausalRelevance, false);
  assert.equal(view.componentGroupIds.size, groups.length);
  assert.equal(excludedForConnectivity({ display_status: "excluded" }), true);
  assert.equal(excludedForConnectivity({ display_status: "excluded", is_manual: true }), false);
  assert.equal(excludedForConnectivity({ display_status: "excluded", is_target_relation: true }), false);
});
