import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

try {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=DAG Builder");
  await page.waitForFunction(() => window.__dagBuilderState?.variables?.length > 3000);

  const loaded = await page.evaluate(() => ({
    variables: window.__dagBuilderState.variables.length,
    links: window.__dagBuilderState.rawLinks.length,
    warnings: window.__dagBuilderState.data?.data_warnings?.length || 0,
  }));
  assert.equal(loaded.variables > 3000, true, `Expected >3000 variables, got ${loaded.variables}`);
  // The matched abstract cache currently contains 1,572 eligible raw links.
  // Keep a floor high enough to catch a truncated or failed causal-link load.
  assert.equal(loaded.links > 1500, true, `Expected >1500 links, got ${loaded.links}`);
  assert.equal(loaded.warnings, 0, `Expected no warnings, got ${loaded.warnings}`);

  await page.locator("#uoaChips .uoa-chip").first().click();
  await page.waitForSelector("#uoaFilterBar:not([hidden])");

  await page.locator("#dvInput").fill("health");
  await page.waitForSelector("#dvResults .result-button");

  await page.locator('[data-mode="dag_review"]').click();
  await page.waitForSelector("#dagWorkspaceSection");

  const seriousErrors = consoleErrors.filter((text) => !/favicon|Failed to load resource/i.test(text));
  assert.deepEqual(seriousErrors, []);
} finally {
  await browser.close();
}
