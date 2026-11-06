// iOS Safari zooms the whole page when a field under 16px takes focus, and never zooms back out. A phone is
// then left magnified with the top bar off screen. This walks the screens a phone reaches and fails on any
// field under 16px (hidden ones included: they appear later) or on anything that widens the page.
const { test, expect } = require("./fixtures.cjs");
const { chooseAnchors } = require("./support/identify.cjs");
const base = `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}`;

const SMALL_FIELDS = () => [...document.querySelectorAll("input, select, textarea, [contenteditable='true'], [contenteditable='']")]
  .filter(el => !["checkbox", "radio", "range", "file", "hidden"].includes(el.type))
  .map(el => ({ field: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).trim().split(/\s+/)[0] || ""}`,
    size: parseFloat(getComputedStyle(el).fontSize) }))
  .filter(item => item.size < 16);

test("no field on any phone screen is small enough to make iOS zoom the page", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const problems = [];
  const check = async screen => {
    for (const item of await page.evaluate(SMALL_FIELDS)) problems.push(`${screen}: ${item.field} is ${item.size}px`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 0) problems.push(`${screen}: the page is ${wide}px wider than the screen`);
  };
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);
  await check("start page");

  await page.goto(`${base}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState.publishedSchemaHydrated);
  await check("identify, nothing chosen");
  await page.locator("#identify-iv-input").tap();
  await check("variable picker");
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(g => g.variable_ids?.length).slice(0, 2).map(g => g.group_id));
  await chooseAnchors(page, anchors[0], anchors[1], { tap: true });
  await check("map");
  await page.locator('[data-mobile-panel="controls"]').last().tap();
  await check("variable list");
  await page.locator("details.filter-dropdown summary").first().tap();
  await check("filters");
  await page.locator(".variable-disposition").first().selectOption("removed_other");
  await check("removal reason");
  await page.locator("#variableReviewDialog").getByRole("button", { name: "Cancel" }).click();
  await page.locator("#editVariableSchema").tap();
  await check("schema page");
  await page.locator("#customVariablesCreate").tap();
  await check("create a variable");
  await page.locator(".definition-cancel:visible").first().tap();
  await page.locator("#customVariablesClose").tap();

  await page.goto(`${base}/?task=causes`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState.publishedSchemaHydrated);
  await check("causes");
  await page.goto(`${base}/?task=consequences`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState.publishedSchemaHydrated);
  await check("consequences");

  expect([...new Set(problems)]).toEqual([]);
  await context.close();
});
