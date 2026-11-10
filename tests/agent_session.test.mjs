import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EchoAgentSession } from "../agent/session.mjs";
import { confounderKey } from "../site/confounder_status.mjs";
import { createEchoTools } from "../agent/tools.mjs";
import { jevRequest, jevResults } from "../site/definition_jev_core.mjs";
import { publicationPermalink } from "../site/published_schema_loader.mjs";
import { writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";
import { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } from "../site/app_contracts.mjs";

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
    newDescription: "Source member selected for this test split.",
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
  await assert.rejects(() => session.publish({ maxPathLength: 0 }), /path length/);
  session.record.status = "published";
  await assert.rejects(() => session.publish(), /Review and mark/);
});

test("Jev's local and browser paths share request and answer semantics", () => {
  const records = [{ id: "a", label: "A", text: "alpha" }];
  assert.equal(jevRequest(records, "alpha").model, "typesafe/jev-1.13");
  assert.deepEqual(jevResults({ answers: { v0: { type: "choice", choice: "new", confidence: 0.7 } } }, records),
    [{ id: "a", label: "A", side: "new", confidence: 0.7 }]);
});

test("agent checks approved published splits before Jev and can apply a selected split", async () => {
  const session = await fixture();
  const published = { group_id: "published", label: "School outcomes",
    description: "Outcomes measured in formal education.", source: "user_split",
    provenance: { operation: "split_categories", source_group_ids: ["source"] },
    variable_ids: ["s1"] };
  const files = await writeGroupingSchemaFolder({ schema_version: GROUPING_FORMAT_VERSION,
    membership_unit: GROUPING_MEMBERSHIP_UNIT, grouping_set_id: "fixture", label: "Fixture",
    groups: [published] });
  const row = { publication_id: "publication", group_id: "published", split_id: "split-published",
    source_group_ids: ["source"], name: published.label, description: published.description,
    storage_prefix: "owner/publication", membership_path: "memberships/published.tsv",
    owner_id: "other", published_at: "2026-10-15T00:00:00Z" };
  session.browseSplits = async () => [row];
  session.publishedSplitFetch = async url => {
    const path = new URL(url).pathname.split("/published-schemas/owner/publication/")[1];
    return new Response(files.get(path), { status: files.has(path) ? 200 : 404 });
  };
  const tools = createEchoTools({ getSession: () => session, setSession: () => {} });
  const browse = tools.find(tool => tool.name === "echo_browse_published_splits");
  assert.deepEqual(await browse.run({ sourceGroupIds: ["source"] }), [row]);
  const testTool = tools.find(tool => tool.name === "echo_jev_test");
  const gate = await testTool.run({ sourceGroupIds: ["source"], description: "Educational outcomes" });
  assert.equal(gate.phase, "published_lookup");
  assert.deepEqual(gate.candidates, [row]);
  const estimate = tools.find(tool => tool.name === "echo_jev_estimate");
  assert.equal((await estimate.run({ sourceGroupIds: ["source"],
    description: "Educational outcomes" })).phase, "published_lookup");
  const apply = tools.find(tool => tool.name === "echo_apply_published_split");
  await apply.run({ sourceGroupIds: ["source"], publicationId: "publication", groupId: "published",
    newGroupId: "school", residualLabels: { source: "Other source" } });
  assert.deepEqual(session.schema.groups.find(group => group.group_id === "school").variable_ids, ["s1"]);
  assert.equal(session.schema.groups.find(group => group.group_id === "school").description, published.description);
  assert.deepEqual(session.schema.groups.find(group => group.group_id === "source").variable_ids, ["s2", "s3"]);
});

test("retained finding reviews and every confounder status keep local open reasons", async () => {
  const session = await fixture();
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  await session.setFindingDecision({ rawLinkId: "r1", excluded: false,
    reasonText: "Same construct and target population." });
  assert.equal(session.schema.finding_reviews.r1.reason_text, "Same construct and target population.");
  await session.setConfounderStatus({ groupId: "source", status: "explicitly_controlled",
    text: "The stated specification includes this covariate." });
  assert.equal(Object.values(session.schema.confounder_statuses)[0].text,
    "The stated specification includes this covariate.");
  await session.setFindingDecision({ rawLinkId: "r1", excluded: true, reasonCode: "concept_miscategorized",
    reasonText: "The measured entity is the teacher." });
  assert.equal(session.schema.finding_reviews.r1, undefined);
});

test("confounder and exclusion statuses reject values the UI does not offer", async () => {
  const session = await fixture();
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  await assert.rejects(session.setConfounderStatus({ groupId: "source", status: "explicitly_controled" }), /Unknown confounder status/);
  await assert.rejects(session.setExclusionStatus({ groupId: "source", status: "explicitly_controlled" }), /instrument/);
  await session.setConfounderStatus({ groupId: "source", status: "causes_y_only_via_x" });
  assert.equal(Object.values(session.schema.confounder_statuses)[0].status, "causes_y_only_via_x");
});

test("exclusion statuses are keyed by instrument, IV, DV and group", async () => {
  const session = await fixture();
  session.schema.groups.push({ group_id: "inst", label: "Instrument", variable_ids: [] });
  await session.setAnchors({ ivId: "iv", dvId: "dv", instrumentId: "inst" });
  await assert.rejects(session.setExclusionStatus({ groupId: "source", status: "bogus" }), /Unknown exclusion status/);
  await session.setExclusionStatus({ groupId: "source", status: "variable_only_via_x", text: "Mediated." });
  assert.deepEqual(session.schema.exclusion_statuses[JSON.stringify(["inst", "iv", "dv", "source"])],
    { status: "variable_only_via_x", text: "Mediated." });
});

test("publication permalink selects the reviewed X-Y graph", () => {
  const state = { project: { ...baseSchema, iv_group_id: "iv", dv_group_id: "dv" },
    data: { snapshot: { snapshot_id: "fixture" } }, workflowMode: "dag",
    confounderMaxPathLength: 1, showConfoundersOnly: true };
  const url = new URL(publicationPermalink("publication-1", undefined, state));
  assert.equal(url.searchParams.get("schema"), "publication-1");
  assert.equal(url.searchParams.get("iv"), "iv");
  assert.equal(url.searchParams.get("dv"), "dv");
  assert.equal(url.searchParams.get("path"), "1");
});

test("MCP exposes the local workflow and a single final publication tool", () => {
  const tools = createEchoTools({ getSession: () => null, setSession: () => {} });
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes("echo_jev_full"));
  assert.ok(names.includes("echo_graph"));
  assert.ok(names.includes("echo_set_finding_decision"));
  assert.equal(names.filter(name => name === "echo_publish").length, 1);
});

test("the catch-all category is never returned as a confounder or graph node", async () => {
  const session = await fixture();
  session.schema.groups = [
    { group_id: "iv", label: "IV", variable_ids: ["i"] },
    { group_id: "dv", label: "DV", variable_ids: ["d"] },
    { group_id: "source", label: "Source", variable_ids: ["s1"] },
    { group_id: "category-other", label: "Other", variable_ids: ["s2"] },
  ];
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  session.evidence.rawLinks = async () => [
    { raw_causal_link_id: "a", source_variable_id: "s1", target_variable_id: "i", paper_id: "p", table_id: "t" },
    { raw_causal_link_id: "b", source_variable_id: "s1", target_variable_id: "d", paper_id: "p", table_id: "t" },
    { raw_causal_link_id: "c", source_variable_id: "s2", target_variable_id: "i", paper_id: "p", table_id: "t" },
    { raw_causal_link_id: "e", source_variable_id: "s2", target_variable_id: "d", paper_id: "p", table_id: "t" }];
  const graph = await session.graph({ showConfoundersOnly: true });
  assert.deepEqual(graph.view.confounders.confounderIds, ["source"]);
  assert.ok(graph.dag.nodes.every(node => node.group_id !== "category-other"));
  assert.ok(graph.dag.edges.every(edge => edge.group_a !== "category-other" && edge.group_b !== "category-other"));
});

async function routedFixture() {
  const session = await fixture();
  session.schema.groups.push({ group_id: "mid", label: "Mid", variable_ids: ["m"] }, { group_id: "ctl", label: "Ctl", variable_ids: ["c"] });
  const variables = ["i", "d", "s1", "m", "c"].map(variable_id => ({ variable_id, canonical_variable_id: variable_id }));
  const link = (id, source, target) => ({ raw_causal_link_id: id, source_variable_id: source, target_variable_id: target,
    paper_id: `paper-${id}`, table_id: "table" });
  // source → iv, source → mid → dv, iv → dv, and source → ctl → iv with ctl → dv.
  const links = [link("r1", "s1", "i"), link("r2", "s1", "m"), link("r3", "m", "d"), link("r4", "i", "d"),
    link("r5", "s1", "c"), link("r6", "c", "i"), link("r7", "c", "d")];
  session.evidence = {
    variables: async ids => variables.filter(row => ids.includes(row.variable_id)),
    rawLinks: async ids => ids ? links.filter(row => ids.includes(row.raw_causal_link_id)) : links,
  };
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  return session;
}
async function withEnv(name, value, run) {
  const previous = process.env[name];
  process.env[name] = value;
  try { await run(); } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
}

test("ECHO_CHECK_ONLY_VIA requires rejecting each other route and explaining", async () => {
  const session = await routedFixture();
  const claim = { groupId: "source", status: "causes_y_only_via_x" };
  await session.setConfounderStatus(claim);
  session.schema.confounder_statuses = {};
  await withEnv("ECHO_CHECK_ONLY_VIA", "1", async () => {
    await assert.rejects(session.setConfounderStatus(claim), /source → mid → dv/);
    await assert.rejects(session.setConfounderStatus({ ...claim, rejectedPaths: ["mid"], text: "x" }), /ctl/);
    await assert.rejects(session.setConfounderStatus({ ...claim, rejectedPaths: ["mid", "ctl", "ghost"], text: "x" }), /does not hold: "ghost"/);
    await assert.rejects(session.setConfounderStatus({ ...claim, rejectedPaths: ["mid", "ctl"] }), /text is empty/);
    await session.setConfounderStatus({ ...claim, rejectedPaths: ["mid", "ctl"], text: "Both links are mis-grouped." });
    assert.equal(Object.values(session.schema.confounder_statuses)[0].status, "causes_y_only_via_x");
    await session.setConfounderStatus({ groupId: "source", status: "explicitly_controlled" });
    await assert.rejects(session.setConfounderStatus({ groupId: "mid", status: "causes_y_only_via_x", rejectedPaths: ["x"] }), /does not hold|only through/);
  });
});

test("ECHO_CHECK_ADJUSTMENT requires an explanation while open backdoor routes exist", async () => {
  const session = await routedFixture();
  const claim = { groupId: "source", status: "not_in_minimal_adjustment_set" };
  await session.setConfounderStatus(claim);
  await withEnv("ECHO_CHECK_ADJUSTMENT", "1", async () => {
    await assert.rejects(session.setConfounderStatus(claim), /open backdoor route.*iv ← source → mid → dv.*Adjusted for now: none/s);
    // Controlling ctl and mid closes every route through source, so no explanation is needed.
    await session.setConfounderStatus({ groupId: "ctl", status: "explicitly_controlled" });
    await assert.rejects(session.setConfounderStatus(claim), /iv ← source → mid → dv/);
    await session.setConfounderStatus({ groupId: "mid", status: "accounted_for_by_design" });
    await session.setConfounderStatus(claim);
    // An explanation clears an open route.
    await session.setConfounderStatus({ groupId: "mid", status: "unaddressed" });
    await session.setConfounderStatus({ ...claim, text: "mid is blocked by the study design." });
    assert.equal(session.schema.confounder_statuses[confounderKey("iv", "dv", "source")].text, "mid is blocked by the study design.");
  });
  // Off by default and for other statuses.
  await session.setConfounderStatus(claim);
});


test("definition-overlap dispositions survive agent status recording and schema validation", async () => {
  const { validateGroupingSchema } = await import("../site/data_validation.mjs");
  const session = await fixture();
  await session.setAnchors({ ivId: "iv", dvId: "dv" });
  for (const status of ["subsumed_into_iv_definition", "subsumed_into_dv_definition"]) {
    await session.setConfounderStatus({ groupId: "source", status,
      text: "The candidate and measured endpoint represent the same construct as duplicate nodes; no distinct external path is supported." });
    assert.equal(Object.values(session.schema.confounder_statuses)[0].status, status);
    validateGroupingSchema(session.schema);
  }
});
