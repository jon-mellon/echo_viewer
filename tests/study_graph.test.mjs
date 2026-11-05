import test from "node:test";
import assert from "node:assert/strict";
import { graphClaimPreview, confirmGraphClaim, effectiveStudyGraph, directedEffects, bypassPath, claimConflicts } from "../site/study_graph.mjs";
import { diagnosticKey, diagnosticReviewRows } from "../site/confounder_status.mjs";
import { variableSchema } from "../site/schema_views.mjs";
import { canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { validateGroupingSchema } from "../site/data_validation.mjs";
import { snapshotProject, restoreSnapshot } from "../site/dag_project.mjs";

const effect = (sourceId, targetId) => ({ sourceId, targetId });
const link = (a, b, extra = {}) => ({ edge_id: `${a}-${b}`, group_a: a, group_b: b, direction_type: "A_TO_B", display_status: "active", ...extra });
function project(links = [link("c", "y")]) {
  return { schema_version: "groupings-v3", grouping_set_id: "test", label: "Reusable definitions", membership_unit: "canonical_variable",
    groups: ["x", "y", "c", "m", "z", "z2"].map(group_id => ({ group_id, label: group_id, variable_ids: [`v-${group_id}`] })),
    links, iv_group_id: "x", dv_group_id: "y", instrument_group_id: "z",
    confounder_statuses: {}, exclusion_statuses: {}, decisions: [] };
}
function record(p, kind, id, decision) {
  const field = kind === "exclusion" ? "exclusion_statuses" : "confounder_statuses";
  return { ...p, [field]: { ...p[field], [diagnosticKey(p, kind, id)]: decision } };
}

test("claims preview and reject direct effects without changing baseline evidence or schema", () => {
  const p = project(), original = structuredClone(p);
  const preview = graphClaimPreview(p, "confounders", "c", "causes_y_only_via_x");
  assert.deepEqual(preview.suggested, [effect("c", "y")]);
  const decision = confirmGraphClaim(p, preview, preview.suggested);
  const next = record(p, "confounders", "c", decision);
  const graph = effectiveStudyGraph(next);
  assert.deepEqual(directedEffects(graph.links), [effect("c", "x")]);
  assert.equal(graph.links[0].is_user_claim, true);
  assert.deepEqual(p, original);
  assert.deepEqual(variableSchema(next), variableSchema(p));
  const restored = record(next, "confounders", "c", { status: "unaddressed" });
  assert.deepEqual(effectiveStudyGraph(restored).links, p.links);
});

test("indirect bypasses require user edge selection and traversal terminates on cycles", () => {
  const p = project([link("c", "m"), link("m", "c"), link("m", "y"), link("x", "c")]);
  const preview = graphClaimPreview(p, "confounders", "c", "causes_y_only_via_x");
  assert.deepEqual(preview.suggested, []);
  assert.throws(() => confirmGraphClaim(p, preview, []), /still bypasses/);
  const decision = confirmGraphClaim(p, preview, [effect("m", "y")]);
  const graph = effectiveStudyGraph(record(p, "confounders", "c", decision));
  assert.ok(directedEffects(graph.links).some(e => e.sourceId === "x" && e.targetId === "c"));
  assert.ok(directedEffects(graph.links).some(e => e.sourceId === "c" && e.targetId === "x"));
  assert.equal(bypassPath(directedEffects(graph.links), "c", "y", "x"), null);
});

test("evidence rejection coexists with asserting the effect, but explicit contrary claims are flagged", () => {
  let p = project([link("c", "y"), link("c", "x", { display_status: "excluded" })]);
  const preview = graphClaimPreview(p, "confounders", "c", "causes_y_only_via_x");
  assert.deepEqual(claimConflicts(p, preview, preview.suggested), []);
  p = record(p, "exclusion", "m", { status: "variable_only_via_x", rejected_effects: [effect("c", "x")], asserted_effects: [effect("m", "x")] });
  assert.equal(claimConflicts(p, preview, preview.suggested).length, 1);
  const next = record(p, "confounders", "c", confirmGraphClaim(p, preview, preview.suggested));
  assert.ok(effectiveStudyGraph(next).links.some(e => e.is_user_claim && e.group_a === "c" && e.group_b === "x"));
  assert.equal(next.links.find(e => e.edge_id === "c-x").display_status, "excluded");
});

test("restoring one claim preserves independently rejected effects, including reverse directions", () => {
  let p = project([link("c", "m", { direction_type: "BIDIRECTIONAL" }), link("c", "x", { display_status: "excluded" })]);
  const decision = { status: "causes_y_only_via_x", rejected_effects: [effect("c", "m")], asserted_effects: [] };
  p = record(p, "confounders", "c", decision);
  p = record(p, "confounders", "m", decision);
  p = record(p, "confounders", "c", { status: "unaddressed" });
  const graph = effectiveStudyGraph(p);
  assert.equal(graph.links.find(e => e.edge_id === "c-m").direction_type, "B_TO_A");
  assert.equal(graph.links.find(e => e.edge_id === "c-x").display_status, "excluded");
});

test("removals and exclusion claims have the correct study scope and survive undo", () => {
  let p = record(project(), "exclusion", "c", { status: "removed_other", text: "Private rationale" });
  assert.equal(effectiveStudyGraph(p).removed.has("c"), true);
  assert.equal(effectiveStudyGraph({ ...p, instrument_group_id: "z2" }).removed.has("c"), false);
  assert.equal(effectiveStudyGraph({ ...p, dv_group_id: "m" }).removed.has("c"), false);
  const rows = diagnosticReviewRows(p, [], "exclusion");
  assert.equal(rows[0].rejected, true);
  assert.equal(rows[0].text, "Private rationale");
  const snapshot = snapshotProject(p, "build");
  p = record(p, "exclusion", "c", { status: "unaddressed" });
  assert.equal(restoreSnapshot(p, snapshot).project.exclusion_statuses[diagnosticKey(p, "exclusion", "c")].status, "removed_other");
});

test("public artifacts expose independent schemas and reproducible study claims without private notes", async () => {
  const p = record(project(), "confounders", "c", { status: "causes_y_only_via_x", text: "PRIVATE-NOTE",
    asserted_effects: [effect("c", "x")], rejected_effects: [effect("c", "y")] });
  const { files } = await canonicalizeWorkingSchema(p);
  const reusable = JSON.parse(new TextDecoder().decode(files.get("variable-schema.json")));
  const decisions = JSON.parse(new TextDecoder().decode(files.get("study-decisions.json")));
  assert.equal(reusable.confounder_statuses, undefined);
  assert.ok(decisions.confounder_statuses[diagnosticKey(p, "confounders", "c")].asserted_effects.length);
  for (const bytes of files.values()) assert.doesNotMatch(new TextDecoder().decode(bytes), /PRIVATE-NOTE/);
  validateGroupingSchema({ ...p, confounder_statuses: decisions.confounder_statuses });
});
