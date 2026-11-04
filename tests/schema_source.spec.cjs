const { test, expect } = require("./fixtures.cjs");

const viewer = `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/`;
const R2 = "https://data.epistemicinfra.org/published-schemas/";

function watchSources(page) {
  const seen = { files: new Set(), registry: new Set(), retired: new Set() };
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith(R2) && url.includes("/_registry/")) seen.registry.add(url);
    else if (url.startsWith(R2)) seen.files.add(url);
    else if (url.includes(".supabase.co/")) seen.retired.add(url);
  });
  return seen;
}

async function open(page, url) {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated && !window.__dagBuilderState?.publishedSchemaHydrating);
}

test("published schemas and registry rows load from R2", async ({ page }) => {
  const seen = watchSources(page);
  await open(page, `${viewer}?task=causes`);
  expect(seen.files.size).toBeGreaterThan(10);
  expect(seen.registry.size).toBe(1);
  expect(seen.retired.size).toBe(0);
});

test("a legacy source parameter cannot switch reads back to the retired service", async ({ page }) => {
  const seen = watchSources(page);
  await open(page, `${viewer}?task=causes&schema_source=supabase`);
  expect(seen.files.size).toBeGreaterThan(10);
  expect(seen.registry.size).toBe(1);
  expect(seen.retired.size).toBe(0);
  await page.locator('#focusGroupPicker button[data-group-id="category-sleep"]').click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => { window.__sharedText = await (await items[0].getType("text/plain")).text(); },
    } });
  });
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toHaveAttribute("aria-label", "Copied");
  expect(new URL(await page.evaluate(() => window.__sharedText)).searchParams.has("schema_source")).toBe(false);
});

test("published links preserve the current view without a source selector", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await page.locator('#focusGroupPicker button[data-group-id="category-sleep"]').click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => { window.__sharedText = await (await items[0].getType("text/plain")).text(); },
    } });
  });
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toHaveAttribute("aria-label", "Copied");
  expect(new URL(await page.evaluate(() => window.__sharedText)).searchParams.has("schema_source")).toBe(false);
});
