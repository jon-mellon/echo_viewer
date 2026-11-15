import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtension, REVIEW_URLS } from "../scripts/build_extension.mjs";
import { paperReviewAllowed } from "../site/paper_review_access.mjs";
import { confirmedCapture, validateCapture, validateClaims, validateQualification } from "../site/paper_capture.mjs";
import { PaperModel, object, string } from "../site/paper_model.mjs";
import { EchoSessionCore } from "../site/echo_session_core.mjs";
import { BrowserEchoSession } from "../site/paper_browser_session.mjs";
import { fullCompileDag, dagEquals } from "../site/compiled_dag.mjs";
import { requiredIds, reviewCoverage } from "../site/paper_review_contract.mjs";
import { evaluatePaper } from "../site/paper_workflow.mjs";

const capture = { title: "Study", doi: "https://doi.org/10.1234/FOCAL", sourceUrl: "https://example.org/paper",
  abstract: "Exposure increases outcomes in adults.", articleText: "Exposure increases outcomes in adults. We adjust for age and income.",
  coverage: "full", extractionMethod: "paste", capturedAt: "2026-11-15T00:00:00Z" };
const qualification = { eligible: true, reason: "Eligible observational person-level estimate.", causal: true,
  x: "Exposure", y: "Outcome", xUnit: "person", yUnit: "person", population: "adults", design: "matching",
  exposureRandomized: false, usesDid: false, assignment: "Nonrandomized measured exposure", controls: ["age", "income"],
  evidenceLocation: "Results", evidenceQuote: "Exposure increases outcomes in adults.", adjustmentQuote: "We adjust for age and income.",
  articleHasRandomizedComponent: false, mixedMethodsBoundary: "" };

function fixtures() {
  const schema = { schema_version: "groupings-v3", grouping_set_id: "fixture", label: "Fixture", description: "",
    membership_unit: "canonical_variable", built_against: { record_signature: "fixture" }, cache_compatibility: { record_signature: "fixture" }, rejected_variables: [],
    groups: [{ group_id: "x", label: "Exposure", variable_ids: ["x1"] }, { group_id: "y", label: "Outcome", variable_ids: ["y1"] },
      { group_id: "k", label: "Age", variable_ids: ["k1", "k2"] }] };
  const variables = ["x1", "y1", "k1", "k2"].map(variable_id => ({ variable_id, canonical_variable_id: variable_id,
    concept_label: variable_id, display_label: variable_id, uoa: "person", paper_id: "10.1234/other" }));
  const links = [{ raw_causal_link_id: "kx", source_variable_id: "k1", target_variable_id: "x1", paper_id: "10.1234/other", table_id: "t" },
    { raw_causal_link_id: "ky", source_variable_id: "k1", target_variable_id: "y1", paper_id: "10.1234/focal", table_id: "t" },
    { raw_causal_link_id: "xy", source_variable_id: "x1", target_variable_id: "y1", paper_id: "10.1234/focal", table_id: "t" }];
  const evidence = { variables: async ids => variables.filter(row => ids.includes(row.variable_id)),
    rawLinks: async ids => ids ? links.filter(row => ids.includes(row.raw_causal_link_id)) : links,
    searchVariables: async () => [] };
  const record = { id: crypto.randomUUID(), status: "editing", revision: 0, schema: structuredClone(schema), baseSchema: structuredClone(schema),
    sourcePublication: { id: "fixture", content_hash: "base" }, snapshotId: "fixture", anchors: {}, operations: [] };
  const runtime = { evidence, save: async () => {}, getKey: () => "fixture-key", ownerStorage: { getItem: () => null }, checkOnlyVia: true, checkAdjustment: false };
  return { schema, variables, links, evidence, record, runtime };
}

test("capture binds edits to a new hash, normalizes DOI, and rejects unsupported URLs", async () => {
  const a = await confirmedCapture(capture), b = await confirmedCapture({ ...capture, title: "Changed" });
  assert.notEqual(a.captureHash, b.captureHash);
  assert.equal(a.capture.doi, "10.1234/focal");
  assert.throws(() => validateCapture({ ...capture, sourceUrl: "javascript:alert(1)" }), /HTTP/);
  await assert.rejects(() => confirmedCapture({ ...capture, abstract: "" }), /actual abstract/);
});
test("claims must quote the actual abstract and qualification rejects missing or unsupported evidence", () => {
  assert.throws(() => validateClaims([{ id: "a", text: "Claim", sourceSentences: ["Fabricated"] }], capture.abstract), /exact sentence/);
  assert.equal(validateClaims([{ id: "a", text: "Claim", sourceSentences: [capture.abstract] }], capture.abstract).length, 1);
  validateQualification(qualification, capture);
  assert.throws(() => validateQualification(qualification, { ...capture, coverage: "partial" }), /complete/);
  assert.throws(() => validateQualification({ ...qualification, exposureRandomized: true }, capture), /nonrandomized/);
  assert.throws(() => validateQualification({ ...qualification, evidenceQuote: "invented" }, capture), /exactly/);
});
test("model checkpoints uncertain calls before billing, does not replay them, and never persists keys", async () => {
  const run = { id: "a", model: "fixture/model", capture, selectedClaim: {}, calls: [] }, saves = [];
  let requests = 0;
  const model = new PaperModel({ run, getKey: () => "secret-key", save: async () => saves.push(structuredClone(run)),
    request: async path => { if (path === "/api/v1/key") return { data: { limit: 5, limit_remaining: 5, limit_reset: null } };
      requests++; assert.ok(saves.at(-1).pending); throw new Error("timeout"); } });
  await assert.rejects(() => model.structured("test", "Task", {}, object({ value: string })), /may have been billed/);
  await assert.rejects(() => model.structured("test", "Task", {}, object({ value: string })), /uncertain/);
  assert.equal(requests, 1);
  assert.equal(JSON.stringify(saves).includes("secret-key"), false);
});
test("a durable model receipt prevents repeat billing after interruption before applying the response", async () => {
  const run = { id: "a", model: "fixture/model", capture, selectedClaim: {} };
  let requests = 0, sent;
  const request = async (path, key, options) => {
    if (path === "/api/v1/key") return { data: { limit: 5, limit_remaining: 5, limit_reset: null } };
    requests++; sent = JSON.parse(options.body);
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"value":"accepted"}' } }], usage: { prompt_tokens: 7, cost: 0.01 } };
  };
  const model = new PaperModel({ run, getKey: () => "secret-key", save: async () => {}, request });
  const a = await model.structured("test", "Task", {}, object({ value: string }));
  const restored = new PaperModel({ run: structuredClone(run), getKey: () => "secret-key", save: async () => {}, request });
  assert.deepEqual(await restored.structured("test", "Task", {}, object({ value: string })), a);
  assert.equal(requests, 1); assert.equal(sent.provider.allow_fallbacks, false);
  assert.equal(JSON.stringify(sent).includes("flex"), false); assert.equal(run.calls[0].cachedRead, null);
});
test("browser incremental compilation preserves full MCP graph semantics after anchors, split, and finding decisions", async () => {
  const { record, runtime, links, schema } = fixtures();
  const browser = new BrowserEchoSession(record, runtime);
  browser.compiled = fullCompileDag({ schema, rawLinks: links }); browser.compiledSchema = structuredClone(schema);
  browser.source = { loadIncidentRawLinks: async ids => links.filter(row => ids.includes(row.source_variable_id) || ids.includes(row.target_variable_id)),
    loadRawLinksByIds: runtime.evidence.rawLinks };
  await browser.setAnchors({ ivId: "x", dvId: "y" });
  await browser.split({ sourceGroupIds: ["k"], newGroupId: "n", newLabel: "New age", newDescription: "Selected age concept in the source population.", residualLabels: { k: "Other age" }, newVariableIds: ["k1"] });
  await browser.setFindingDecision({ rawLinkId: "ky", excluded: true, reasonCode: "other", reasonText: "Focal paper is not independent evidence." });
  const actual = await browser.compile();
  const expected = fullCompileDag({ schema: browser.schema, project: browser.project, rawLinks: links });
  assert.equal(dagEquals(actual, expected, { ignorePaperCounts: true }), true);
  const core = new EchoSessionCore(structuredClone(browser.record), runtime);
  const [a, b] = await Promise.all([browser.graph({ maxPathLength: 1 }), core.graph({ maxPathLength: 1 })]);
  assert.deepEqual(a.view.confounders.confounderIds, b.view.confounders.confounderIds);
  assert.deepEqual((await browser.diff()).contentHash, (await core.diff()).contentHash);
});
test("five independent papers excludes duplicates, focal DOI and unknown DOI", () => {
  const dois = ["focal", "", "one", "one", "two", "three", "four", "five", "six"];
  const link = { findings: dois.map((paper_doi, index) => ({ raw_link_id: String(index), paper_doi })) };
  const decisions = Object.fromEntries(dois.map((_, index) => [String(index), { decision: "retained", undeniable: true }]));
  assert.equal(requiredIds(link, decisions, "focal").length, 8);
});
test("accepted operation IDs and anchor selection are saved atomically and are not applied twice", async () => {
  const { record, runtime } = fixtures(), saved = [];
  runtime.save = async value => saved.push(structuredClone(value));
  runtime.operationId = "anchor-selection";
  const session = new EchoSessionCore(record, runtime);
  await session.setAnchors({ ivId: "x", dvId: "y" });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].anchors, { ivId: "x", dvId: "y", instrumentId: null });
  assert.equal(saved[0].operations[0].operationId, "anchor-selection");
  await session.setAnchors({ ivId: "x", dvId: "y" });
  assert.equal(session.record.revision, 1); assert.equal(saved.length, 1);
});
test("a full fixture review excludes the focal paper, validates coverage and remains private", async () => {
  const { record, runtime } = fixtures(), session = new EchoSessionCore(record, runtime);
  await session.setAnchors({ ivId: "x", dvId: "y" });
  const confirmed = await confirmedCapture(capture);
  const run = { id: "r", ...confirmed, model: "fixture/model", qualification, selectedClaim: { id: "c", text: capture.abstract }, setupDone: true };
  const model = { run, save: async () => {}, signal: new AbortController().signal,
    structured: async name => name.startsWith("Assessing")
      ? { status: "unaddressed", reason: "This age mechanism is not controlled in the model.", systematicallyDifferent: false, splitReason: "Same measured age construct on both legs.", rejectedPaths: [] }
      : { decision: "retained", reason: "The endpoint definitions and population support this link.", reason_code: "", questioned_end: "", undeniable: true } };
  const outcome = await evaluatePaper(model, session);
  assert.equal(run.phase, "complete");
  assert.equal(outcome.review.findings.ky.decision, "excluded");
  assert.equal(outcome.review.findings.xy.decision, "excluded");
  assert.equal(session.status, "editing"); assert.equal(run.published, undefined);
  assert.doesNotThrow(() => reviewCoverage([run.queue], run.review, {}, run.capture.doi));
});
test("a substantive split request cannot be represented as a completed review", async () => {
  const { record, runtime } = fixtures(), session = new EchoSessionCore(record, runtime);
  await session.setAnchors({ ivId: "x", dvId: "y" });
  const run = { ...(await confirmedCapture(capture)), model: "fixture", qualification, setupDone: true };
  const model = { run, save: async () => {}, structured: async () => ({ status: "unaddressed", reason: "Different actors", systematicallyDifferent: true, splitReason: "Adult and parental age need separate meanings.", rejectedPaths: [] }) };
  await assert.rejects(() => evaluatePaper(model, session), /split is required/);
  assert.equal(run.phase, "split_required"); assert.equal(run.outcome, undefined);
});
test("extension has only user-initiated capture privileges; no API host access or external-message commands", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "sidePanel"]);
  assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.externally_connectable, undefined);
  const source = await readFile(new URL("../extension/panel.mjs", import.meta.url), "utf8");
  assert.match(source, /event.origin !== origin/); assert.match(source, /event.data.nonce !== nonce/);
});
test("only staging extension packages can be built, including the default build", async () => {
  const root = await mkdtemp(join(tmpdir(), "echo-extension-build-"));
  try {
    await assert.rejects(buildExtension({ staging: false, destination: join(root, "production") }), /Production paper review is disabled/);
    for (const options of [{ staging: true }, {}]) {
      const destination = join(root, options.staging ? "staging" : "default");
      await buildExtension({ ...options, destination });
      const url = REVIEW_URLS.staging;
      assert.equal(await readFile(join(destination, "config.mjs"), "utf8"), `export const REVIEW_URL = ${JSON.stringify(url)};\n`);
      const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
      assert.ok(manifest.content_security_policy.extension_pages.includes(`frame-src ${new URL(url).origin};`));
      assert.equal(manifest.name.includes("Staging"), true);
      assert.equal(manifest.host_permissions, undefined);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("copied review pages cannot start on production or unrelated paths and origins", () => {
  const allowed = href => paperReviewAllowed({ href });
  assert.equal(allowed(REVIEW_URLS.staging), true);
  assert.equal(allowed("https://www.jonathanmellon.com/echo_viewer_staging/paper-auth.html"), true);
  assert.equal(allowed("http://127.0.0.1:8767/paper-review.html"), true);
  for (const url of ["https://echo.epistemicinfra.org/paper-review.html", "https://echo.epistemicinfra.org/echo_viewer_staging/paper-review.html",
    "https://www.jonathanmellon.com/paper-review.html", "https://www.jonathanmellon.com/echo_viewer_staging-fake/paper-review.html",
    "https://evil.example/echo_viewer_staging/paper-review.html"]) assert.equal(allowed(url), false, url);
  assert.equal(paperReviewAllowed(null), false);
});
