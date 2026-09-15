import assert from "node:assert/strict";
import test from "node:test";

import { applyPermalink, buildPermalink, schemaMatchesProject } from "../site/dag_permalink.mjs";

const schema = { grouping_set_id: "schema", groups: [
  { group_id: "cause", label: "Cause", notes: "", variable_ids: ["v1"] },
  { group_id: "outcome", label: "Outcome", notes: "", variable_ids: ["v2"] },
] };
const project = { active_grouping_set_id: "schema", iv_group_id: "cause", dv_group_id: "outcome",
  groups: schema.groups.map(group => ({ ...group, source_group_id: group.group_id })),
  manual_edges: [], link_decisions: {} };

test("compact permalink round trip preserves reproducible view settings", () => {
  const state = { project: structuredClone(project), workflowMode: "dag", dagLayoutMode: "hierarchical",
    variableLayoutSource: "corrected", selectedUoa: "person", confounderMaxPathLength: 4,
    filterDagByCausalRelevance: false, showConfoundersOnly: true, showCollidersOnly: false,
    excludeBottleneckedConfounders: true, hideIrrelevantConfounderLinks: true,
    showVariableLabels: false, showGroupLabels: true, uoaFilterEnabled: true,
    activeGroupId: "cause", selectedVariableId: "v1" };
  const href = buildPermalink({ location: { href: "http://localhost:8767/?old=1" },
    schemaUrl: "/config/schema/", dataVersion: "snapshot-7", state });
  const params = new URL(href).searchParams;
  const restored = { project: structuredClone(project), variableLayoutSource: "", filterDagByCausalRelevance: true,
    seeds: { iv: new Set(), dv: new Set() } };
  restored.project.groups[0].type = "candidate";
  restored.project.groups[1].type = "iv";
  assert.equal(applyPermalink(params, restored), true);
  assert.equal(params.get("data_version"), "snapshot-7");
  assert.equal(params.get("schema_url"), "/config/schema/");
  assert.equal(params.has("uoa"), false);
  assert.equal(params.has("uf"), false);
  assert.equal(restored.project.iv_group_id, "cause");
  assert.equal(restored.project.dv_group_id, "outcome");
  assert.equal(restored.project.groups[0].type, "iv");
  assert.equal(restored.project.groups[1].type, "dv");
  assert.deepEqual([...restored.seeds.iv], ["v1"]);
  assert.deepEqual([...restored.seeds.dv], ["v2"]);
  assert.equal(restored.showConfoundersOnly, true);
  assert.equal(restored.confounderMaxPathLength, 4);
  assert.equal(restored.selectedUoa, null);
  assert.equal(restored.uoaFilterEnabled, false);
  assert.equal(restored.selectedVariableId, "v1");
});

test("edited or imported schemas are not shareable", () => {
  assert.equal(schemaMatchesProject(schema, project), true);
  const edited = structuredClone(project);
  edited.groups[0].variable_ids.push("v3");
  assert.equal(schemaMatchesProject(schema, edited), false);
  assert.equal(schemaMatchesProject({ ...schema, grouping_set_id: "custom" }, project), false);
  assert.equal(schemaMatchesProject(schema, { ...project, manual_edges: [{ edge_id: "manual" }] }), false);
});

test("a permalink fails explicitly when its anchors are absent", () => {
  const params = new URLSearchParams("p=1&iv=missing&dv=outcome");
  assert.throws(() => applyPermalink(params, { project: structuredClone(project) }), /absent/);
});
