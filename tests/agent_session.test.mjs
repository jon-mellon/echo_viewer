import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EchoAgentSession } from "../agent/session.mjs";
import { createEchoTools } from "../agent/tools.mjs";
import { jevRequest, jevResults } from "../site/definition_jev_core.mjs";

const baseSchema = {
  schema_version: "groupings-v3", grouping_set_id: "fixture", label: "Fixture", description: "Test",
  membership_unit: "canonical_variable", built_against: { record_signature: "fixture" },
  cache_compatibility: { record_signature: "fixture" }, rejected_variables: [],
  groups: [
    { group_id: "iv", label: "IV", variable_ids: ["i"] },
    { group_id: "dv", label: "DV", variable_ids: ["d"] },
    { group_id: "source", label: "Source", variable_ids: ["s1", "s2", "s3"] },
  ],
};
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "echo-agent-test-"));
  const session = new EchoAgentSession({ id: randomUUID(), status: "editing", revision: 0,
    sourcePublication: { id: randomUUID(), content_hash: "base" }, snapshotId: "fixture",
    baseSchema: structuredClone(baseSchema), schema: structuredClone(baseSchema),
    anchors: {}, operations: [] }, home);
  const variables = ["i", "d", "s1", "s2", "s3"].map(variable_id => ({ variable_id, canonical_variable_id: variable_id }));
  const links = [{ raw_causal_link_id: "r1", source_variable_id: "s1", target_variable_id: "i",
    paper_id: "paper", table_id: "table" }];
  session.evidence = {
    variables: async ids => variables.filter(row => ids.includes(row.variable_id)),
    rawLinks: async ids => ids ? links.filter(row => ids.includes(row.raw_causal_link_id)) : links,
  };
  return session;
}

test("local split, finding decision, graph, review, and single publication gate use shared Echo operations", async () => {
  const session = await fixture();
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  await session.split({ sourceGroupIds: ["source"], newGroupId: "new", newLabel: "New",
    residualLabels: { source: "Other source" }, newVariableIds: ["s1"] });
  assert.deepEqual(session.schema.groups.find(group => group.group_id === "new").variable_ids, ["s1"]);
  assert.deepEqual(session.schema.groups.find(group => group.group_id === "source").variable_ids, ["s2", "s3"]);
  await session.setFindingDecision({ rawLinkId: "r1", excluded: true,
    reasonCode: "not_relevant_to_target_population" });
  assert.equal(session.schema.finding_decisions.r1.reason_code, "not_relevant_to_target_population");
  const graph = await session.graph();
  assert.equal(graph.dag.nodes.length, 4);
  assert.ok(graph.view.confounders);
  const review = await session.ready();
  assert.equal(review.status, "ready");
  await assert.rejects(() => session.upsertGroup({ groupId: "x", label: "X" }), /start a new session/);
  session.record.status = "published";
  await assert.rejects(() => session.publish(), /Review and mark/);
});

test("Jev's local and browser paths share request and answer semantics", () => {
  const records = [{ id: "a", label: "A", text: "alpha" }];
  assert.equal(jevRequest(records, "alpha").model, "typesafe/jev-1.13");
  assert.deepEqual(jevResults({ answers: { v0: { type: "choice", choice: "new", confidence: 0.7 } } }, records),
    [{ id: "a", label: "A", side: "new", confidence: 0.7 }]);
});

test("MCP exposes the local workflow and a single final publication tool", () => {
  const tools = createEchoTools({ getSession: () => null, setSession: () => {} });
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes("echo_jev_full"));
  assert.ok(names.includes("echo_graph"));
  assert.ok(names.includes("echo_set_finding_decision"));
  assert.equal(names.filter(name => name === "echo_publish").length, 1);
});
