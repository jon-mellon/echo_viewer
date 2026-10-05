const { test, expect } = require("playwright/test");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
});

test("incident links use the canonical snapshot and retain both edge directions", async ({ page }) => {
  const parquetRequests = [];
  page.on("request", request => {
    if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
    && window.__dagBuilderState?.project?.groups?.some(group => group.variable_ids?.length > 40));
  const result = await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const group = window.__dagBuilderState.project.groups.find(item => item.variable_ids?.length > 40);
    const ids = group.variable_ids.slice(0, 40);
    const links = await dagDataSource.loadIncidentRawLinks(ids);
    return { count: links.length, unique: new Set(links.map(link => link.raw_causal_link_id)).size,
      allIncident: links.every(link => ids.includes(link.source_variable_id)
        || ids.includes(link.target_variable_id)) };
  });
  expect(result.count).toBeGreaterThan(0);
  expect(result.unique).toBe(result.count);
  expect(result.allIncident).toBe(true);
  expect(parquetRequests.some(url => url.endsWith("/causal_link_occurrences.parquet"))).toBe(true);
  expect(parquetRequests.some(url => url.includes("/causal-links/by-source/")
    || url.includes("/causal-links/by-target/"))).toBe(false);
  const fallbackMatches = await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const ids = window.__dagBuilderState.project.groups.find(item => item.variable_ids?.length > 40)
      .variable_ids.slice(0, 8);
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
  });
  expect(fallbackMatches).toBe(true);
});

test("browser-v2 supports group detail, layout controls, fullscreen and project export", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
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

  for (const mode of ["hierarchical", "organic", "auto"]) {
    await page.locator("#dagLayoutSelect").selectOption(mode);
    await expect.poll(() => page.evaluate(() => window.__dagBuilderState.dagLayoutMode)).toBe(mode);
  }
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
  expect(errors.filter(error => !/favicon|Range request .* did not return a partial response/i.test(error))).toEqual([]);
});
