// Hidden state machines (see docs/state-machine-audit.md). Passing tests pin behaviour that was probed and found sound.
// `test.fail` marks a confirmed defect: it passes while the defect exists and fails, prompting its removal, once it is fixed.
const { test, expect } = require("./fixtures.cjs");
const { chooseAnchors } = require("./support/identify.cjs");

const PORT = process.env.ECHO_TEST_PORT || 8767;
const origin = `http://127.0.0.1:${PORT}`;
const url = `${origin}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`;
const EDGE = "category-academic-achievement__category-macroeconomic-context";

// The data host only allows the standard test origin; on another port, fetch on the page's behalf and add CORS headers.
async function allowDataHost(context) {
  if (String(PORT) === "8767") return;
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-expose-headers": "Accept-Ranges,Content-Length,Content-Range,ETag" };
  await context.route(/^https:\/\/[^/]*(epistemicinfra\.org|r2\.dev|cloudflarestorage\.com)\//, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (!["GET", "HEAD"].includes(request.method())) return route.fallback();
    const response = await route.fetch({ headers: { ...request.headers(), origin: "http://127.0.0.1:8767" } });
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
}
async function open(browser, context) {
  context ||= await browser.newContext();
  await allowDataHost(context);
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  return page;
}
const ready = page => page.waitForFunction(() => {
  const s = window.__dagBuilderState;
  return s?.compiledDag && !s.compiledDagUpdating && s.publishedSchemaHydrated && !s.publishedSchemaHydrating
    && document.getElementById("startupLoading")?.hidden;
}, null, { timeout: 120000 });
const inspect = (page, edge) => page.evaluate(async id => {
  const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
  api.inspectDagEdge(id);
}, edge);
async function excludeFirstClaim(page) {
  await inspect(page, EDGE);
  await page.getByRole("button", { name: /^Exclude claim / }).first().click();
  await page.locator(".finding-reason-tr button").first().click();
}
async function pickAnchors(page) {
  const ids = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(g => g.variable_ids?.length).slice(0, 2).map(g => g.group_id));
  await chooseAnchors(page, ids[0], ids[1]);
}
const saveState = page => page.evaluate(() => ({
  status: document.getElementById("localSaveStatus")?.textContent,
  retryShown: !document.getElementById("retryLocalSave")?.hidden,
  copyShown: !document.getElementById("saveIndependentCopy")?.hidden,
  localId: new URL(location.href).searchParams.get("local_schema"),
  publishDisabled: document.getElementById("publishSchema")?.disabled,
  claims: Object.keys(window.__dagBuilderState.project.finding_decisions || {}).length,
}));

test("a save that fails and is retried leaves nothing unsaved, so publishing is available again", async ({ browser }) => {
  test.fail(true, "Retry save does not refresh the Publish control (dag_builder.js retryLocalSave), so it stays disabled as 'unsaved'.");
  const page = await open(browser);
  await page.goto(url); await ready(page); await pickAnchors(page);
  await page.evaluate(() => {
    window.__realTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      if (mode === "readwrite" && [].concat(stores).includes("schemas")) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      return window.__realTransaction.call(this, stores, mode, ...rest);
    };
  });
  await excludeFirstClaim(page);
  await expect.poll(async () => (await saveState(page)).retryShown).toBe(true);
  expect((await saveState(page)).publishDisabled).toBe(true);
  // Let background evidence work finish so no unrelated render refreshes the control during the check.
  await page.waitForFunction(() => !window.__dagBuilderState.compiledDagUpdating && !window.__dagBuilderState.pendingEdgeEvidence);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { IDBDatabase.prototype.transaction = window.__realTransaction; });
  await page.locator("#retryLocalSave").click();
  await expect.poll(async () => (await saveState(page)).localId).not.toBeNull();
  await expect(page.locator("#retryLocalSave")).toBeHidden();
  // Nothing is unsaved now, so Publish should be available. It only recovers when an unrelated render refreshes it.
  await page.waitForTimeout(500);
  expect((await saveState(page)).publishDisabled).toBe(false);
});

test("a revision conflict offers an independent copy that restores saving and publishing", async ({ browser }) => {
  const a = await open(browser);
  await a.goto(url); await ready(a); await pickAnchors(a);
  await excludeFirstClaim(a);
  await expect.poll(async () => (await saveState(a)).localId).not.toBeNull();
  const draftUrl = a.url();
  const b = await open(browser, a.context());
  await b.goto(draftUrl); await ready(b);
  await inspect(b, EDGE);
  await b.getByRole("button", { name: /^Restore claim / }).first().click();
  await expect.poll(async () => (await saveState(b)).claims).toBe(0);
  await b.waitForTimeout(800);
  // Tab A still holds the old revision.
  await inspect(a, EDGE);
  await a.getByRole("button", { name: /^Exclude claim / }).first().click();
  await a.locator(".finding-reason-tr button").first().click();
  await expect.poll(async () => (await saveState(a)).copyShown).toBe(true);
  await a.locator("#saveIndependentCopy").click();
  await expect.poll(async () => (await saveState(a)).localId).not.toBe(new URL(draftUrl).searchParams.get("local_schema"));
  const after = await saveState(a);
  expect(after.retryShown).toBe(false);
  expect(after.copyShown).toBe(false);
  expect(after.publishDisabled).toBe(false);
});

test("Retry save is not offered when the revision conflict can only be resolved by a copy", async ({ browser }) => {
  test.fail(true, "Retry reuses the stale revision, so it fails every time; the conflict message still shows both buttons.");
  const a = await open(browser);
  await a.goto(url); await ready(a); await pickAnchors(a);
  await excludeFirstClaim(a);
  await expect.poll(async () => (await saveState(a)).localId).not.toBeNull();
  const b = await open(browser, a.context());
  await b.goto(a.url()); await ready(b);
  await inspect(b, EDGE);
  await b.getByRole("button", { name: /^Restore claim / }).first().click();
  await b.waitForTimeout(800);
  await inspect(a, EDGE);
  await a.getByRole("button", { name: /^Exclude claim / }).first().click();
  await a.locator(".finding-reason-tr button").first().click();
  await expect.poll(async () => (await saveState(a)).copyShown).toBe(true);
  expect((await saveState(a)).retryShown).toBe(false);
});

test("a failed startup offers a way out of the error screen", async ({ browser }) => {
  test.fail(true, "Only a missing local schema gets 'Start new view'; every other startup error leaves a page with no controls.");
  const page = await open(browser);
  await page.route(/layouts\/browser-v2\/[0-9a-f]{64}\/manifest\.json|published-schemas\/_registry/, route => route.abort("failed"));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Echo could not open this view" })).toBeVisible({ timeout: 60000 });
  await expect(page.locator("a, button")).not.toHaveCount(0);
});

test("a link to a task or focus variable that no longer exists does not blame the cause and outcome", async ({ browser }) => {
  test.fail(true, "An unknown task or a stale explore focus shows 'Permalink cause or outcome is absent from the referenced schema.'");
  const page = await open(browser);
  await page.goto(`${url}&p=1&mode=dag&task=causes&causes_of=missing-group`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Echo could not open this view" })).toBeVisible({ timeout: 90000 });
  await expect(page.locator("main")).not.toContainText("cause or outcome is absent");
});

test("selecting a second edge while the first edge's evidence is still loading ends on the second edge", async ({ browser }) => {
  const page = await open(browser);
  await page.goto(url); await ready(page); await pickAnchors(page);
  const edges = await page.evaluate(() => window.__dagBuilderState.project.links
    .filter(l => l.a_to_b_raw_link_ids?.length || l.b_to_a_raw_link_ids?.length).map(l => l.edge_id));
  expect(edges.length).toBeGreaterThan(1);
  const [first, second] = [edges[0], edges[edges.length - 1]];
  let seen = 0;
  await page.route(/\/evidence-panels\/|causal_link_occurrences|\/variable-incidents\//, async route => {
    if (seen++ < 3) await new Promise(resolve => setTimeout(resolve, 2500));
    await route.fallback();
  });
  await page.evaluate(async ([a, b]) => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    api.inspectDagEdge(a);
    await new Promise(resolve => setTimeout(resolve, 300));
    api.inspectDagEdge(b);
  }, [first, second]);
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.pendingEdgeEvidence), { timeout: 30000 }).toBe(false);
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(second);
  await expect(page.locator("#provenancePanel .concept-loading")).toHaveCount(0);
  await expect(page.locator("#provenancePanel tbody tr").first()).toBeVisible();
});

test("a stale OAuth callback is ignored without contacting the provider", async ({ browser }) => {
  const page = await open(browser);
  const calls = [];
  await page.route("https://openrouter.ai/**", route => { calls.push(route.request().url()); return route.abort(); });
  await page.goto(`${url}&code=replayed&state=not-mine`, { waitUntil: "domcontentloaded" });
  await ready(page);
  expect(calls).toEqual([]);
  expect(new URL(page.url()).searchParams.has("code")).toBe(false);
});
