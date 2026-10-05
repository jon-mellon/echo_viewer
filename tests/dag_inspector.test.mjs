import test from "node:test";
import assert from "node:assert/strict";
import * as inspector from "../site/dag_inspector.mjs";

test("inspectors deduplicate evidence and preserve direction", () => {
  const link = { edge_id: "e", group_a: "a", group_b: "b", direction_type: "B_TO_A",
    is_target_relation: true, a_to_b_raw_link_ids: ["r", "missing"], b_to_a_raw_link_ids: ["r"] };
  const project = { groups: [
    { group_id: "a", label: "A", variable_ids: ["x"] },
    { group_id: "b", label: "B", variable_ids: ["y"] },
    { group_id: "extra", label: "A", variable_ids: ["x"] },
  ], iv_group_id: "a", dv_group_id: "b", links: [link],
    link_decisions: { e: { display_status: "excluded", exclude_reason: "reason" } } };
  const raw = { raw_causal_link_id: "r", source_variable_id: "x", target_variable_id: "y", paper_id: "paper" };
  const rawById = new Map([["r", raw]]);
  const variables = new Map([["x", { concept_label: "Concept X" }]]);
  const before = structuredClone(project);
  const edge = inspector.edgeInspector(link, project);
  assert.equal(edge.sourceLabel, "B");
  assert.equal(edge.targetLabel, "A");
  assert.equal(edge.rawCount, 2);
  assert.equal(edge.existingDecision.exclude_reason, "reason");
  assert.deepEqual(edge.actions.map(a => a.action), ["exclude", "restore"]);
  const provenance = inspector.provenanceModel(link, project, rawById, variables);
  assert.equal(provenance.rows.length, 1);
  assert.deepEqual(provenance.rows[0].source, { concept: "Concept X", classifications: ["A"] });
  assert.deepEqual(provenance.rows[0].target, { concept: "y", classifications: ["B"] });
  assert.deepEqual(inspector.studyInspector(project, rawById), {
    sourceLabel: "A", targetLabel: "B", rawIds: ["r", "missing"], keys: ["paper"],
  });
  assert.deepEqual(project, before);
  assert.equal(inspector.edgeInspector(null, project), null);
  assert.equal(inspector.studyInspector({ links: [] }, rawById), null);
});

test("absent evidence preserves empty provenance and comparison directions", () => {
  const project = { groups: [], link_decisions: {} };
  const link = { edge_id: "e", group_a: "a", group_b: "b", direction_type: "BIDIRECTIONAL",
    a_to_b_raw_link_ids: [], b_to_a_raw_link_ids: [] };
  assert.equal(inspector.edgeInspector(link, project).arrow, "↔");
  assert.deepEqual(inspector.provenanceModel(link, project, new Map(), new Map()).rows, []);
  const source = { variable_id: "x", display_label: "X" }, target = { variable_id: "y" };
  const rows = new Map([["r", { raw_causal_link_id: "r", causal_link_existence: "absent" }]]);
  const comparison = inspector.variableComparison(source, target, ["r", "missing"], ["r"], rows);
  assert.deepEqual(comparison.rows.map(r => r.direction), ["→", "←"]);
  assert.equal(comparison.rows[0].causal_link_existence, "absent");
  assert.equal(comparison.sourceLabel, "X");
  assert.equal(comparison.targetLabel, "y");
});

test("diagnostic evidence puts the witness-path direction before reverse evidence", () => {
  const link = { edge_id: "e", group_a: "a", group_b: "b", direction_type: "BIDIRECTIONAL",
    a_to_b_raw_link_ids: ["forward", "shared"], b_to_a_raw_link_ids: ["reverse", "shared"],
  };
  const project = { groups: [
    { group_id: "a", label: "A", variable_ids: ["a1"] },
    { group_id: "b", label: "B", variable_ids: ["b1"] },
  ], link_decisions: {} };
  const rawLinksById = new Map(["forward", "reverse", "shared"].map(id => [id, {
    raw_causal_link_id: id, source_variable_id: "a1", target_variable_id: "b1",
  }]));

  const confounderView = {
    showConfoundersOnly: true,
    confounderPathsByGroup: new Map([["b", { toIv: ["b", "a"], toDv: ["b", "dv"] }]]),
  };
  assert.equal(inspector.diagnosticEvidenceDirection(link, confounderView), "B_TO_A");
  assert.deepEqual(inspector.provenanceModel(
    link, project, rawLinksById, new Map(), confounderView,
  ).rows.map(row => row.raw.raw_causal_link_id), ["reverse", "shared", "forward"]);

  const colliderView = {
    showCollidersOnly: true,
    colliderPathsByGroup: new Map([["b", { fromIv: ["a", "b"], fromDv: ["dv", "b"] }]]),
  };
  assert.equal(inspector.diagnosticEvidenceDirection(link, colliderView), "A_TO_B");
  assert.deepEqual(inspector.provenanceModel(
    link, project, rawLinksById, new Map(), colliderView,
  ).rows.map(row => row.raw.raw_causal_link_id), ["forward", "shared", "reverse"]);
});

test("diagnostic evidence preserves stored order when an edge has no unique witness direction", () => {
  const link = { group_a: "a", group_b: "b", a_to_b_raw_link_ids: ["forward"],
    b_to_a_raw_link_ids: ["reverse"] };
  const project = { groups: [], link_decisions: {} };
  const bothDirections = { showConfoundersOnly: true, confounderPathsByGroup: new Map([
    ["one", { toIv: ["a", "b"] }], ["two", { toDv: ["b", "a"] }],
  ]) };
  assert.equal(inspector.diagnosticEvidenceDirection(link, bothDirections), null);
  assert.deepEqual(inspector.edgeInspector(link, project, bothDirections).rawIds, ["forward", "reverse"]);
});
