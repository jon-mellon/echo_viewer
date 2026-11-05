import test from "node:test";
import assert from "node:assert/strict";
import { effectiveStudyGraph, directedEffects } from "../site/study_graph.mjs";
import { diagnosticKey, diagnosticReviewRows, LIGHT_STATUSES, publicDiagnosticStatuses, EXCLUSION_STATUSES } from "../site/confounder_status.mjs";
import { variableSchema } from "../site/schema_views.mjs";
import { canonicalizeWorkingSchema } from "../site/dag_publication_core.mjs";
import { validateGroupingSchema } from "../site/data_validation.mjs";
import { snapshotProject, restoreSnapshot } from "../site/dag_project.mjs";

const link = (a, b, extra = {}) => ({ edge_id: `${a}-${b}`, group_a: a, group_b: b, direction_type: "A_TO_B", display_status: "active", ...extra });
function project(links = [link("c", "y"), link("c", "x"), link("x", "y")]) {
  return { schema_version: "groupings-v3", grouping_set_id: "test", label: "Reusable definitions", membership_unit: "canonical_variable",
    groups: ["x", "y", "c", "m", "z", "z2"].map(group_id => ({ group_id, label: group_id, variable_ids: [`v-${group_id}`] })),
    links, iv_group_id: "x", dv_group_id: "y", instrument_group_id: "z",
    confounder_statuses: {}, exclusion_statuses: {}, decisions: [] };
}
function record(p, kind, id, decision) {
  const field = kind === "exclusion" ? "exclusion_statuses" : "confounder_statuses";
  return { ...p, [field]: { ...p[field], [diagnosticKey(p, kind, id)]: decision } };
}

test("every disposition except removal keeps the variable and its links in the study graph", () => {
  for (const status of ["explicitly_controlled", "accounted_for_by_design", "not_in_minimal_adjustment_set", "causes_y_only_via_x"]) {
    const p = record(project(), "confounders", "c", { status });
    const graph = effectiveStudyGraph(p);
    assert.equal(graph.removed.size, 0);
    assert.deepEqual(graph.links, p.links);
    assert.equal(graph.groups.length, p.groups.length);
  }
  for (const status of ["instrument_only_via_x", "variable_only_via_x"]) {
    const p = record(project(), "exclusion", "c", { status });
    assert.deepEqual(effectiveStudyGraph(p).links, p.links);
  }
});

test("the via-cause dispositions are drawn faded, like the other accounted-for ones", () => {
  for (const status of ["explicitly_controlled", "accounted_for_by_design", "not_in_minimal_adjustment_set",
    "causes_y_only_via_x", "instrument_only_via_x", "variable_only_via_x"]) assert.ok(LIGHT_STATUSES.has(status), status);
  assert.ok(!LIGHT_STATUSES.has("unaddressed") && !LIGHT_STATUSES.has("removed_other"));
});

test("a faded variable stays a candidate; only removal moves it to rejected candidates", () => {
  let p = record(project(), "confounders", "c", { status: "causes_y_only_via_x" });
  assert.equal(diagnosticReviewRows(p, ["c"], "confounders")[0].rejected, false);
  p = record(p, "confounders", "c", { status: "removed_other", text: "Outside the population" });
  assert.equal(diagnosticReviewRows(p, ["c"], "confounders")[0].rejected, true);
});

test("removals have the correct study scope and survive undo", () => {
  let p = record(project(), "exclusion", "c", { status: "removed_other", text: "Private rationale" });
  assert.equal(effectiveStudyGraph(p).removed.has("c"), true);
  assert.ok(!effectiveStudyGraph(p).links.some(e => e.group_a === "c" || e.group_b === "c"));
  assert.equal(effectiveStudyGraph({ ...p, instrument_group_id: "z2" }).removed.has("c"), false);
  assert.equal(effectiveStudyGraph({ ...p, dv_group_id: "m" }).removed.has("c"), false);
  const rows = diagnosticReviewRows(p, [], "exclusion");
  assert.equal(rows[0].rejected, true);
  assert.equal(rows[0].text, "Private rationale");
  const snapshot = snapshotProject(p, "build");
  p = record(p, "exclusion", "c", { status: "unaddressed" });
  assert.equal(restoreSnapshot(p, snapshot).project.exclusion_statuses[diagnosticKey(p, "exclusion", "c")].status, "removed_other");
});

test("the study graph never changes the baseline evidence or the reusable schema", () => {
  const p = project(), original = structuredClone(p);
  const next = record(record(p, "confounders", "c", { status: "causes_y_only_via_x" }), "confounders", "m", { status: "removed_other", text: "n" });
  effectiveStudyGraph(next);
  assert.deepEqual(p, original);
  assert.deepEqual(variableSchema(next), variableSchema(p));
  assert.deepEqual(directedEffects(next.links), directedEffects(p.links));
});

test("public artifacts expose independent schemas and decisions without private notes", async () => {
  const p = record(project(), "confounders", "c", { status: "causes_y_only_via_x", text: "PRIVATE-NOTE" });
  const { files } = await canonicalizeWorkingSchema(p);
  const reusable = JSON.parse(new TextDecoder().decode(files.get("variable-schema.json")));
  const decisions = JSON.parse(new TextDecoder().decode(files.get("study-decisions.json")));
  assert.equal(reusable.confounder_statuses, undefined);
  assert.equal(decisions.confounder_statuses[diagnosticKey(p, "confounders", "c")].status, "causes_y_only_via_x");
  for (const bytes of files.values()) assert.doesNotMatch(new TextDecoder().decode(bytes), /PRIVATE-NOTE/);
  validateGroupingSchema({ ...p, confounder_statuses: decisions.confounder_statuses });
});

test("decisions saved when graph claims existed still load, and their edge lists are not published", () => {
  const old = { status: "causes_y_only_via_x", rejected_effects: [{ sourceId: "c", targetId: "y" }], asserted_effects: [{ sourceId: "c", targetId: "x" }] };
  const p = record(project(), "confounders", "c", old);
  validateGroupingSchema(p);
  assert.deepEqual(effectiveStudyGraph(p).links, p.links);
  assert.deepEqual(Object.values(publicDiagnosticStatuses(p.confounder_statuses))[0], { status: "causes_y_only_via_x" });
  assert.ok(Object.hasOwn(EXCLUSION_STATUSES, "instrument_only_via_x"));
});
