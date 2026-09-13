import assert from "node:assert/strict";
import test from "node:test";

import { validateGroupingSchema, validateProjectPayload } from "../site/data_validation.mjs";

const group = (id = "g", variableIds = ["v"]) => ({ group_id: id, variable_ids: variableIds });

test("project validation accepts a minimal well-formed import", () => {
  const payload = {
    schema_version: "dag-builder-project-v1",
    groups: [group()], manual_edges: [{ edge_id: "e", source_group_id: "g", target_group_id: "g" }],
    filters: {}, link_decisions: {}, seeds: { iv: [], dv: [] },
  };
  assert.equal(validateProjectPayload(payload), payload);
});

test("project validation rejects malformed collections and broken edge references", () => {
  assert.throws(() => validateProjectPayload({ groups: {} }), /groups must be an array/);
  assert.throws(() => validateProjectPayload({ groups: [{ group_id: "g", variable_ids: "v" }] }), /variable_ids must be an array/);
  assert.throws(() => validateProjectPayload({ groups: [group("g"), group("g")] }), /duplicate group_id/);
  assert.throws(() => validateProjectPayload({ groups: [group("g", ["v", "v"])] }), /contains duplicates/);
  assert.throws(() => validateProjectPayload({
    groups: [group("g")],
    manual_edges: [{ edge_id: "e", source_group_id: "g", target_group_id: "missing" }],
  }), /unknown group/);
});

test("validation rejects prototype-sensitive keys and resource-exhaustion inputs", () => {
  const polluted = JSON.parse('{"groups":[],"__proto__":{"polluted":true}}');
  assert.throws(() => validateProjectPayload(polluted), /forbidden key __proto__/);
  let nested = "leaf";
  for (let index = 0; index < 30; index += 1) nested = { child: nested };
  assert.throws(() => validateProjectPayload({ groups: [], nested }), /nested too deeply/);
});

test("grouping validation rejects invalid groups and rejected-variable collections", () => {
  assert.equal(validateGroupingSchema({ groups: [group()] }).groups.length, 1);
  assert.throws(() => validateGroupingSchema({ groups: null }), /groups must be an array/);
  assert.throws(() => validateGroupingSchema({ groups: [group("g"), group("g")] }), /duplicate group_id/);
  assert.throws(() => validateGroupingSchema({ groups: [], rejected_variables: {} }), /must be an array/);
});
