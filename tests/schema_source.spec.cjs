const { test, expect } = require("./fixtures.cjs");

const viewer = "http://127.0.0.1:8767/";
const CLOUDFLARE = "https://data.epistemicinfra.org/published-schemas/";
const SUPABASE_STORAGE = "/storage/v1/object/public/published-schemas/";

// Counts published-schema requests by where they went. (Tests answer the Cloudflare address with Supabase's copy
// of the same file, standing in for the mirror; see tests/support/supabase_cache.cjs.)
function watchSources(page) {
  const seen = { cloudflare: new Set(), supabase: new Set() };
  page.on("request", request => {
    const url = request.url();
    if (url.startsWith(CLOUDFLARE)) seen.cloudflare.add(url);
    else if (url.includes(SUPABASE_STORAGE)) seen.supabase.add(url);
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

test("by default published schema files are read from Supabase and never from Cloudflare", async ({ page }) => {
  const seen = watchSources(page);
  await open(page, `${viewer}?task=causes`);
  expect(seen.supabase.size).toBeGreaterThan(10);
  expect(seen.cloudflare.size).toBe(0);
});

test("?schema_source=cloudflare reads the same files from Cloudflare and keeps the choice in links", async ({ page }) => {
  const seen = watchSources(page);
  await open(page, `${viewer}?task=causes&schema_source=cloudflare`);
  expect(seen.cloudflare.size).toBeGreaterThan(10);
  expect(seen.supabase.size).toBe(0);
  // The viewer works from it: choose a variable and read its causes.
  await page.locator('#focusGroupPicker button[data-group-id="category-sleep"]').click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  expect(await page.locator(".explore-row").count()).toBeGreaterThan(10);
  // The page's own address and the links it makes keep naming the source.
  await expect.poll(() => new URL(page.url()).searchParams.get("schema_source")).toBe("cloudflare");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => { window.__sharedText = await (await items[0].getType("text/plain")).text(); },
    } });
  });
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toContainText("Copied");
  const link = await page.evaluate(() => window.__sharedText);
  expect(new URL(link).searchParams.get("schema_source")).toBe("cloudflare");
  // Evidence opens from it too, and nothing was fetched from Supabase storage along the way.
  await page.locator(".explore-row .explore-row-open").first().click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  expect(seen.supabase.size).toBe(0);
});

test("a page that names no source makes links that name none", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await page.locator('#focusGroupPicker button[data-group-id="category-sleep"]').click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has("schema_source")).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => { window.__sharedText = await (await items[0].getType("text/plain")).text(); },
    } });
  });
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toContainText("Copied");
  expect(new URL(await page.evaluate(() => window.__sharedText)).searchParams.has("schema_source")).toBe(false);
});
