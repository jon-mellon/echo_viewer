import assert from "node:assert/strict";
import test from "node:test";

import { applyPermalink, buildPermalink, schemaMatchesProject } from "../site/dag_permalink.mjs";

const schema = { grouping_set_id: "schema", groups: [
  { group_id: "cause", label: "Cause", notes: "", variable_ids: ["v1"] },
  { group_id: "outcome", label: "Outcome", notes: "", variable_ids: ["v2"] },
] };
const project = { active_grouping_set_id: "schema", iv_group_id: "cause", dv_group_id: "outcome",
  groups: schema.groups.map(group => ({ ...group, source_group_id: group.group_id })),
  link_decisions: {} };

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
  assert.equal(params.has("layout"), false);
  assert.equal(params.has("causal"), false);
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
  assert.equal(restored.dagLayoutMode, "auto");
});

test("legacy layout links open with auto layout", () => {
  const params = new URLSearchParams("p=1&iv=cause&dv=outcome&layout=organic");
  const state = { project: structuredClone(project), seeds: { iv: new Set(), dv: new Set() } };
  assert.equal(applyPermalink(params, state), true);
  assert.equal(state.dagLayoutMode, "auto");
  assert.equal(state.showConfoundersOnly, true);
  assert.equal(state.showCollidersOnly, false);
});

test("older causal links use one of the three available views", () => {
  const state = { project: structuredClone(project), seeds: { iv: new Set(), dv: new Set() } };
  applyPermalink(new URLSearchParams("p=1&iv=cause&dv=outcome&causal=1&conf=0&coll=0"), state);
  assert.equal(state.showConfoundersOnly, false);
  assert.equal(state.showCollidersOnly, false);
});

test("a collider permalink works when confounders is the app default", () => {
  const state = { project: structuredClone(project), showConfoundersOnly: true,
    showCollidersOnly: false, seeds: { iv: new Set(), dv: new Set() } };
  applyPermalink(new URLSearchParams("p=1&iv=cause&dv=outcome&coll=1"), state);
  assert.equal(state.showConfoundersOnly, false);
  assert.equal(state.showCollidersOnly, true);
});

test("an instrument permalink restores the exclusive exclusion view", () => {
  const state = { project: structuredClone(project), showConfoundersOnly: true,
    seeds: { iv: new Set(), dv: new Set() } };
  state.project.groups.push({ group_id: "instrument", label: "Instrument", variable_ids: ["v3"] });
  applyPermalink(new URLSearchParams("p=1&iv=cause&dv=outcome&instrument=instrument&conf=1&coll=1"), state);
  assert.equal(state.project.instrument_group_id, "instrument");
  assert.equal(state.showExclusionViolations, true);
  assert.equal(state.showConfoundersOnly, false);
  assert.equal(state.showCollidersOnly, false);
});

test("edited or imported schemas are not shareable", () => {
  assert.equal(schemaMatchesProject(schema, project), true);
  const edited = structuredClone(project);
  edited.groups[0].variable_ids.push("v3");
  assert.equal(schemaMatchesProject(schema, edited), false);
  assert.equal(schemaMatchesProject({ ...schema, grouping_set_id: "custom" }, project), false);
});

test("a permalink fails explicitly when its anchors are absent", () => {
  const params = new URLSearchParams("p=1&iv=missing&dv=outcome");
  assert.throws(() => applyPermalink(params, { project: structuredClone(project) }), /absent/);
});
