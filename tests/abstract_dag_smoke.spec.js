const { test, expect } = require("playwright/test");

test("abstract extraction DAG data loads and basic controls work", async ({ page }) => {
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toContainText("DAG Builder");

  await page.waitForFunction(() => window.__dagBuilderState?.variables?.length > 3000);
  const loaded = await page.evaluate(() => ({
    variables: window.__dagBuilderState.variables.length,
    links: window.__dagBuilderState.rawLinks.length,
    warnings: window.__dagBuilderState.data?.data_warnings?.length || 0,
  }));
  expect(loaded.variables).toBeGreaterThan(3000);
  // The matched abstract cache currently contains 1,572 eligible raw links.
  // Keep a floor high enough to catch a truncated or failed causal-link load.
  expect(loaded.links).toBeGreaterThan(1500);
  expect(loaded.warnings).toBe(0);

  await expect(page.locator("#uoaFilterBar, #uoaSearchBlock")).toHaveCount(0);

  await page.locator("#dvInput").fill("health");
  await expect(page.locator("#dvResults .result-button").first()).toBeVisible();

  await page.locator('[data-mode="dag_review"]').click();
  await expect(page.locator("#dagWorkspaceSection")).toBeVisible();

  const seriousErrors = consoleErrors.filter((text) => !/favicon|Failed to load resource/i.test(text));
  expect(seriousErrors).toEqual([]);
});
