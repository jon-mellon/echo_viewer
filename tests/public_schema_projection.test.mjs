import test from "node:test";
import assert from "node:assert/strict";
import { publicCompiledDag, publicSchemaProjection } from "../site/public_schema_projection.mjs";
import { writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";
import { createCompiledArtifacts } from "../site/compiled_dag.mjs";

test("publication keeps exclusion status while stripping private reasons", () => {
  const marker = "PRIVATE LEGAL REASON 73";
  const schema = {
    schema_version: "groupings-v3", grouping_set_id: "test", groups: [],
    link_decisions: { edge1: { edge_id: "edge1", display_status: "excluded",
      exclude_reason: marker, timestamp: "2026-01-01" } },
  };
  const dag = { edges: [{ edge_id: "edge1", display_status: "excluded",
    exclude_reason: marker, metadata: { privateReason: marker },
    user_decision: schema.link_decisions.edge1 },
  { edge_id: "edge2", display_status: "active_by_default", user_decision: null }] };
  const safeSchema = publicSchemaProjection(schema);
  const safeDag = publicCompiledDag(dag, schema.link_decisions);
  assert.deepEqual(safeSchema.link_decisions, { edge1: { display_status: "excluded" } });
  assert.equal(safeDag.edges[0].display_status, "excluded");
  assert.deepEqual(safeDag.edges[0].user_decision, { display_status: "excluded" });
  assert.ok(!JSON.stringify([safeSchema, safeDag]).includes(marker));
  assert.ok(!JSON.stringify([safeSchema, safeDag]).includes("exclude_reason"));
  assert.equal(schema.link_decisions.edge1.exclude_reason, marker);
});

test("final schema folder and compiled DAG bytes contain no exclusion reason", async () => {
  const reason = "PRIVATE LEGAL REASON 91";
  const schema = { schema_version: "groupings-v3", grouping_set_id: "test",
    membership_unit: "canonical_variable", groups: [],
    link_decisions: { edge1: { display_status: "excluded", exclude_reason: reason } } };
  const safeSchema = publicSchemaProjection(schema);
  const files = await writeGroupingSchemaFolder(safeSchema);
  const safeDag = publicCompiledDag({ nodes: [], edges: [{ edge_id: "edge1",
    display_status: "excluded", user_decision: schema.link_decisions.edge1 }] }, schema.link_decisions);
  const compiled = await createCompiledArtifacts({ publicationId: "test", schemaHash: "hash",
    evidenceSnapshot: "snapshot", dag: safeDag, cryptoApi: globalThis.crypto });
  const bytes = [...files.values(), compiled.dagBytes, compiled.manifestBytes];
  for (const item of bytes) {
    const text = new TextDecoder().decode(item);
    assert.ok(!text.includes(reason));
    assert.ok(!text.includes("exclude_reason"));
  }
});

test("finding exclusion reasons remain local while public status is retained", async () => {
  const reason = "PRIVATE OTHER REASON 104";
  const schema = { schema_version: "groupings-v3", grouping_set_id: "test",
    membership_unit: "canonical_variable", groups: [],
    finding_decisions: { finding1: { display_status: "excluded", reason_code: "other",
      reason_text: reason, timestamp: "2026-01-01" },
    finding2: { display_status: "excluded", reason_code: "not_relevant_to_target_population" } } };
  const safe = publicSchemaProjection(schema);
  assert.deepEqual(safe.finding_decisions, {
    finding1: { display_status: "excluded" }, finding2: { display_status: "excluded" },
  });
  const files = await writeGroupingSchemaFolder(safe);
  for (const bytes of files.values()) {
    const body = new TextDecoder().decode(bytes);
    assert.ok(!body.includes(reason));
    assert.ok(!body.includes("reason_code"));
    assert.ok(!body.includes("target_population"));
  }
});
