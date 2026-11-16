// Offline browser acceptance: real unpacked extension + Echo-origin iframe,
// mocked OpenRouter and fixed Echo evidence. No paid calls or live publication.
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { capturePaper } from "../extension/capture.mjs";

const root = resolve("site"), profile = await mkdtemp(`${tmpdir()}/echo-extension-smoke-`);
const origin = "https://www.jonathanmellon.com";
const prefix = "/echo_viewer_permastaging";
const article = `<!doctype html><title>Paper fixture</title><meta name="citation_title" content="A person-level study"><meta name="citation_doi" content="10.1234/focal"><article class="main-article-body"><h1>A person-level study</h1><section id="abstract"><p>Exposure increases outcomes in adults.</p></section><h2>Methods</h2><p>We adjust for age and income.</p><p>Nonrandomized matching estimates a person-level causal effect. The analysis follows adult respondents over multiple survey waves and measures individual exposure before the outcome. The adjusted model includes the stated baseline covariates and reports uncertainty for the selected focal estimate.</p><h2>Results</h2><p>The adjusted association was positive.</p><h2>Discussion</h2><p>Observational estimates may be confounded.</p><nav>Navigation junk</nav></article>`;
const qualification = { eligible: true, reason: "Eligible", causal: true, x: "Exposure", y: "Outcome", xUnit: "person", yUnit: "person", population: "adults", design: "matching", exposureRandomized: false, usesDid: false, assignment: "Nonrandomized exposure", controls: ["age", "income"], evidenceLocation: "Abstract and methods", evidenceQuote: "Exposure increases outcomes in adults.", adjustmentQuote: "We adjust for age and income.", articleHasRandomizedComponent: false, mixedMethodsBoundary: "" };
let completions = 0, authExchanges = 0;
const errors = [];
const browserSessionFixture = `
import { EchoSessionCore } from './echo_session_core.mjs';
const schema={schema_version:'groupings-v3',grouping_set_id:'fixture',label:'Fixture',description:'',membership_unit:'canonical_variable',built_against:{record_signature:'fixture'},cache_compatibility:{record_signature:'fixture'},rejected_variables:[],groups:[{group_id:'x',label:'Exposure',variable_ids:['x1']},{group_id:'y',label:'Outcome',variable_ids:['y1']},{group_id:'k',label:'Age',variable_ids:['k1']}]};
const variables=['x1','y1','k1'].map(variable_id=>({variable_id,canonical_variable_id:variable_id,concept_label:variable_id,uoa:'person',paper_id:'10.1234/other'}));
const links=[{raw_causal_link_id:'kx',source_variable_id:'k1',target_variable_id:'x1',paper_id:'10.1234/other',table_id:'t'},{raw_causal_link_id:'ky',source_variable_id:'k1',target_variable_id:'y1',paper_id:'10.1234/focal',table_id:'t'},{raw_causal_link_id:'xy',source_variable_id:'x1',target_variable_id:'y1',paper_id:'10.1234/focal',table_id:'t'}];
export class BrowserEchoSession extends EchoSessionCore {
 static async start(options) {
  const record=options.record||{id:crypto.randomUUID(),status:'editing',revision:0,schema:structuredClone(schema),baseSchema:structuredClone(schema),sourcePublication:{id:'fixture',content_hash:'base'},snapshotId:'fixture',anchors:{},operations:[]};
  return new BrowserEchoSession(record,{...options,evidence:{variables:async ids=>variables.filter(row=>ids.includes(row.variable_id)),rawLinks:async ids=>ids?links.filter(row=>ids.includes(row.raw_causal_link_id)):links,searchVariables:async()=>[]},ownerStorage:localStorage,checkOnlyVia:true,checkAdjustment:false});
 }
 async close() {}
}`;
let context;
async function screenshotReview(page, frame, path) {
  const viewport = page.viewportSize();
  const height = await frame.locator('body').evaluate(body => body.scrollHeight);
  await page.setViewportSize({ width: viewport.width, height: height + 140 });
  await frame.evaluate(() => scrollTo(0, 0));
  await frame.locator('body').screenshot({ path });
  await page.setViewportSize(viewport);
}
try {
  context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${resolve("dist/extension")}`, `--load-extension=${resolve("dist/extension")}`] });
  await context.route("https://pmc.ncbi.nlm.nih.gov/**", route => route.fulfill({ contentType: "text/html", body: article }));
  await context.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname.replace(prefix, "");
    if (path === "/paper_browser_session.mjs") return route.fulfill({ contentType: "text/javascript", body: browserSessionFixture });
    const absolute = resolve(root, `.${path}`);
    if (!absolute.startsWith(`${root}/`)) return route.abort();
    try { await route.fulfill({ body: await readFile(absolute), contentType: ({ ".mjs": "text/javascript", ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm" })[extname(path)] || "application/octet-stream" }); }
    catch { await route.fulfill({ status: 404, body: "Missing fixture" }); }
  });
  await context.route("https://openrouter.ai/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: {
      "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" } });
    const url = new URL(route.request().url());
    const json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": origin } });
    if (url.pathname === "/auth") {
      const callback = new URL(url.searchParams.get("callback_url")); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", url.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { location: callback.href } });
    }
    if (url.pathname === "/api/v1/auth/keys") { authExchanges++; assert.equal(JSON.parse(route.request().postData()).code_challenge_method, "S256"); return json({ key: "fixture-secret-key" }); }
    if (url.pathname === "/api/v1/key") return json({ data: { limit: 5, limit_remaining: 4, limit_reset: null } });
    if (url.pathname === "/api/v1/models") return json({ data: [{ id: "openai/gpt-6-luna", supported_parameters: ["tools", "structured_outputs"] }] });
    if (url.pathname !== "/api/v1/chat/completions") return route.abort();
    completions++;
    const request = JSON.parse(route.request().postData());
    assert.equal(request.provider.allow_fallbacks, false); assert.equal(request.service_tier, undefined);
    let message;
    if (request.tools) {
      const hasToolResult = request.messages.some(row => row.role === "tool");
      message = hasToolResult ? { role: "assistant", content: "Selected precise existing person-level groups." }
        : { role: "assistant", content: null, tool_calls: [{ id: "anchor-op", type: "function", function: { name: "echo_set_anchors", arguments: '{"ivId":"x","dvId":"y"}' } }] };
    } else {
      const properties = request.response_format.json_schema.schema.properties;
      const value = properties.s ? { s: "success", v: [{ vi: "v1", a: ["person"], c: "uoa's exposure" }, { vi: "v2", a: ["person"], c: "uoa's outcome" }], l: [{ li: "l1", s: ["v1"], t: "v2", e: "present", p: "adults", d: "implied_selection_on_observables" }] }
        : properties.eligible ? qualification
          : properties.systematicallyDifferent ? { status: "unaddressed", reason: "The measured age mechanism is not addressed in this specification.", systematicallyDifferent: false, splitReason: "The two legs instantiate the same age construct.", rejectedPaths: [] }
            : { decision: "retained", reason: "The same person-level construct and adult population support this causal link.", reason_code: "", questioned_end: "", undeniable: true };
      message = { role: "assistant", content: JSON.stringify(value) };
    }
    return json({ model: "openai/gpt-6-luna", choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 } });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const articlePage = await context.newPage(); await articlePage.goto("https://pmc.ncbi.nlm.nih.gov/articles/fixture/");
  const capture = await articlePage.evaluate(capturePaper);
  await articlePage.evaluate(() => document.querySelector('h2:last-of-type').textContent = 'Limitations');
  assert.equal((await articlePage.evaluate(capturePaper)).coverage, 'partial');
  await articlePage.evaluate(() => document.querySelector('h2:last-of-type').textContent = 'Discussion');
  assert.equal(capture.title, "A person-level study"); assert.equal(capture.doi, "10.1234/focal");
  assert.equal(capture.coverage, "full"); assert.ok(!capture.articleText.includes("Navigation junk"));
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/panel.html`);
  const frame = await (await page.waitForSelector("#echo")).contentFrame();
  await frame.waitForSelector("#confirm", { state: "attached" });
  await page.evaluate(({ capture, origin }) => {
    const frame = document.getElementById("echo"), nonce = new URL(frame.src).hash.slice("#bridge=".length);
    frame.contentWindow.postMessage({ type: "echo-paper-capture-v1", nonce, capture }, origin);
  }, { capture, origin });
  await frame.locator("#title").waitFor({ state: "attached" });
  assert.equal(await frame.locator("#title").inputValue(), capture.title);
  await frame.getByText("Paper captured. Connect once", { exact: false }).waitFor();
  // PKCE navigates a real popup and returns the transient key only to the Echo iframe.
  const popupPromise = context.waitForEvent("page");
  await frame.locator("#connect").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  // Chromium extension popups can bypass context routing on their first request.
  // Reload the test-only 404 to enter the mocked same-origin authorization page.
  if (await popup.locator("h1").textContent({ timeout: 500 }).catch(() => "") === "404") await popup.reload();
  await frame.getByText("Connected · capped key checked · remembered for this Chrome session", { exact: true }).waitFor();
  assert.equal(authExchanges, 1);
  assert.equal(await frame.locator("#model").count(), 0);
  assert.equal(await frame.locator("#paper-details").getAttribute("open"), null);
  await frame.locator('input[name="claim"]').waitFor();
  assert.equal(completions, 1); // Capture/connection extracts; no claim was selected for the user.
  assert.equal(await frame.locator('input[name="claim"]').isChecked(), false);
  await page.setViewportSize({ width: 420, height: 920 });
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshotReview(page, frame, '/tmp/echo-paper-review-claims-mobile.png');
  await page.setViewportSize({width:320,height:920});
  assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({width:420,height:920});
  // The only review action is choosing a claim: qualification, setup and review follow.
  await frame.locator('input[name="claim"]').check();
  await frame.getByText("Automated review complete", { exact: false }).first().waitFor();
  assert.equal(await frame.getByText("Age · May be unaddressed", { exact: true }).count(), 1);
  assert.equal(await frame.locator("#result").getByText("The AI could not identify adjustment for Age in the captured text.", { exact: false }).count(), 1);
  assert.equal(await frame.locator("#result").getByText("x% (placeholder, not a measured result)", { exact: false }).count(), 1);
  assert.ok(await frame.getByText("These results may be incorrect or incomplete.", { exact: false }).count());
  assert.equal(completions, 6);
  await screenshotReview(page, frame, '/tmp/echo-paper-review-results-mobile.png');
  await page.setViewportSize({ width: 1280, height: 960 });
  await screenshotReview(page, frame, '/tmp/echo-paper-review-results-desktop.png');
  const records = await frame.evaluate(async () => { const { paperStore } = await import("./paper_store.mjs"); return paperStore.list(); });
  assert.equal(records.length, 1); assert.equal(records[0].phase, "complete");
  assert.equal(records[0].review.findings.ky.decision, "excluded");
  assert.equal(JSON.stringify(records).includes("fixture-secret-key"), false);
  await frame.locator("#preview").click(); await frame.locator("#publish").waitFor({ state: "visible" });
  const publicSchema = JSON.parse(await frame.locator("#public-preview").innerText());
  assert.equal(publicSchema.finding_reviews, undefined); assert.equal(publicSchema.finding_decisions.ky.reason_text, undefined);
  const before = completions;
  await page.reload();
  const reloaded = await (await page.waitForSelector("#echo")).contentFrame(); await reloaded.getByText("Connected · capped key checked · remembered for this Chrome session", { exact: true }).waitFor();
  assert.equal(completions, before);
  await reloaded.getByRole("button", { name: "Resume", exact: true }).click();
  await reloaded.getByText("Automated review complete", { exact: false }).first().waitFor();
  assert.equal(completions, before);
  assert.equal(authExchanges, 1); // Panel reload restores the connection without OAuth.
  const keyState = await worker.evaluate(async () => ({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  assert.deepEqual(keyState.local, {});
  assert.equal(keyState.session["echo-openrouter-key-v1"], "fixture-secret-key");
  await reloaded.getByText("Connection settings", {exact:true}).click();
  await reloaded.locator('#remember').check();
  await reloaded.getByText('Connected · capped key checked · remembered on this device', {exact:true}).waitFor();
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('echo-openrouter-key-v1'))['echo-openrouter-key-v1']), 'fixture-secret-key');
  await reloaded.locator('#disconnect').click();
  await reloaded.getByText('Connect once to extract claims automatically.', {exact:true}).waitFor();
  await page.waitForFunction(async () => {
    const all = await Promise.all([chrome.storage.local.get(null),chrome.storage.session.get(null)]);
    return all.every(area => !area['echo-openrouter-key-v1']);
  });
  await page.setViewportSize({ width: 390, height: 850 });
  await reloaded.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await reloaded.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "/tmp/echo-paper-extension-preview.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Passed: real extension iframe, capture, one-time PKCE, pipeline extraction, claim choice automatically runs qualification/setup/review, public projection, key restoration on reload, opt-in persistence, forget, and no key in IndexedDB.");
} finally {
  await context?.close(); await rm(profile, { recursive: true, force: true });
}
