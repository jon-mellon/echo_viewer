const { test, expect } = require("playwright/test");
const { EventEmitter } = require("node:events");
const { watchBrowserErrors } = require("./browser_errors.cjs");

test("browser errors allow only recovered rate limits", () => {
  const page = new EventEmitter();
  const browserErrors = watchBrowserErrors(page);
  const url = "https://example.test/compiled/dag.json";
  page.emit("response", { url: () => url, status: () => 429 });
  page.emit("console", { type: () => "error",
    text: () => "Failed to load resource: the server responded with a status of 429 ()" });
  expect(browserErrors.check).toThrow(/HTTP 429 responses must be retried successfully/);
  page.emit("response", { url: () => url, status: () => 200 });
  browserErrors.check();
  page.emit("pageerror", new Error("Unrelated failure"));
  expect(browserErrors.check).toThrow(/Unrelated failure/);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
});

test("incident links use the canonical snapshot and retain both edge directions", async ({ page }) => {
  const parquetRequests = [];
  page.on("request", request => {
    if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag);
  // This frozen snapshot has v1..v14284, with 256 variables per shard. Use
  // identifiers across 40 shards so this retrieval test does not depend on
  // downloading every group membership from the published schema.
  const ids = Array.from({ length: 40 }, (_, index) => `v${index * 256 + 1}`);
  const result = await page.evaluate(async ids => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const links = await dagDataSource.loadIncidentRawLinks(ids);
    return { count: links.length, unique: new Set(links.map(link => link.raw_causal_link_id)).size,
      allIncident: links.every(link => ids.includes(link.source_variable_id)
        || ids.includes(link.target_variable_id)) };
  }, ids);
  expect(result.count).toBeGreaterThan(0);
  expect(result.unique).toBe(result.count);
  expect(result.allIncident).toBe(true);
  expect(parquetRequests.some(url => url.endsWith("/causal_link_occurrences.parquet"))).toBe(true);
  expect(parquetRequests.some(url => url.includes("/causal-links/by-source/")
    || url.includes("/causal-links/by-target/"))).toBe(false);
  const fallbackMatches = await page.evaluate(async ids => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const canonical = await dagDataSource.loadIncidentRawLinks(ids);
    const canonicalUrl = dagDataSource.canonicalEvidenceRelationUrl;
    try {
      dagDataSource.canonicalEvidenceRelationUrl = () => "";
      const fallback = await dagDataSource.loadIncidentRawLinks(ids);
      return canonical.map(link => link.raw_causal_link_id).sort().join("|")
        === fallback.map(link => link.raw_causal_link_id).sort().join("|");
    } finally {
      dagDataSource.canonicalEvidenceRelationUrl = canonicalUrl;
    }
  }, ids.slice(0, 8));
  expect(fallbackMatches).toBe(true);
});

test("browser-v2 supports group detail, auto layout, fullscreen and project export", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating
    && window.__dagBuilderState?.project?.groups?.some(group => group.variable_ids?.length));

  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  expect(anchors).toHaveLength(2);
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await expect(page.locator('#dvGroupPicker button[data-group-id]').first()).toBeVisible();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await expect.poll(async () => page.getByRole('link', { name: 'Open public version' }).getAttribute('href'))
    .toContain(`iv=${anchors[0]}`);
  const publicView = await page.getByRole('link', { name: 'Open public version' }).getAttribute('href');
  await page.goto(publicView, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#dagWorkspaceSection")).toBeVisible();
  await expect(page.locator("#addEdgeToggle, #addEdgeDrawer")).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window.__dagBuilderState.project, "manual_edges"))).toBe(false);

  await expect(page.locator("#dagLayoutSelect")).toHaveCount(0);
  expect(await page.evaluate(() => window.__dagBuilderState.dagLayoutMode)).toBe("auto");
  await page.locator("#fullscreenDag").click();
  await expect(page.locator("#fullscreenDag")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#fullscreenDag")).toHaveAttribute("aria-pressed", "false");

  await page.locator("#exportToggleBtn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportProject").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("dag_project.json");
  expect(await download.failure()).toBeNull();
  browserErrors.check();
});
