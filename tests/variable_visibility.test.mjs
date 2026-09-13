import test from "node:test";
import assert from "node:assert/strict";
import * as visibility from "../site/variable_visibility.mjs";
import * as projectOps from "../site/dag_project.mjs";
import { restoreProjectPayload } from "../site/project_persistence.mjs";

test("cluster indexing preserves canonical identity and does not mutate input", () => {
  const input = [
    { variable_id: "copy", canonical_variable_id: "canonical", map_x: 1, map_y: 2, index: 0, display_label: "Common" },
    { variable_id: "canonical", canonical_variable_id: "canonical", map_x: 1, map_y: 2, index: 1, display_label: "Other" },
  ];
  const before = structuredClone(input);
  const index = visibility.buildDuplicateClusters(input);
  assert.deepEqual(input, before);
  assert.equal(visibility.representative("copy", index.clusterOf), "canonical");
  assert.deepEqual(visibility.members("copy", index.clusterOf, index.clusterMembers), ["copy", "canonical"]);
  assert.equal(index.variables[1].cluster_display_variable_id, "copy");
});

test("restore survives save/reload/schema refresh; undo and re-rejection work", () => {
  const of = new Map([["copy", "canonical"]]);
  const members = new Map([["canonical", ["canonical", "copy"]]]);
  const schema = { grouping_set_id: "schema", groups: [], rejected_variables: [{ variable_id: "copy" }] };
  let project = projectOps.replaceSchemaGroups({ groups: [] }, schema, of, members);
  const before = projectOps.snapshotProject(project, "build");
  project = visibility.restoreRejection(project, "canonical", of, members);
  assert.equal(project.rejected_variables.length, 0);
  const payload = JSON.parse(JSON.stringify({ schema_version: "dag-builder-project-v1", ...project }));
  const loaded = restoreProjectPayload(payload, {}, "").project;
  assert.equal(projectOps.replaceSchemaGroups(loaded, schema, of, members).rejected_variables.length, 0);
  const undone = projectOps.restoreSnapshot(project, before).project;
  assert.equal(projectOps.replaceSchemaGroups(undone, schema, of, members).rejected_variables.length, 1);
  const rejected = visibility.rejectVariables(project, [{ variable_id: "copy" }], of, members);
  assert.deepEqual(rejected.restored_variable_ids, []);
  assert.equal(projectOps.replaceSchemaGroups(rejected, schema, of, members).rejected_variables.length, 1);
});
