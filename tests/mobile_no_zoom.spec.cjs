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
  await expect(page.locator("#definitionWorkspace")).toBeVisible();
  await expect(page.locator(".dag-left-panel")).toBeHidden();
  await check("schema page");
  await page.locator("#customVariablesCreate").tap();
  await check("create a variable");
  await page.locator(".definition-cancel:visible").first().tap();
  await page.locator("#customVariablesClose").tap();
  await expect(page.locator(".dag-left-panel")).toBeVisible();

  await page.goto(`${base}/?task=causes`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState.publishedSchemaHydrated);
  await check("causes");
  await page.goto(`${base}/?task=consequences`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState.publishedSchemaHydrated);
  await check("consequences");

  expect([...new Set(problems)]).toEqual([]);
  await context.close();
});

test("no phone screen widens the page, even in a much wider font, and iOS text inflation is off", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${base}/?task=identify&layout_debug=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20 && window.__dagBuilderState.publishedSchemaHydrated);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("-webkit-text-size-adjust")
    || getComputedStyle(document.documentElement).getPropertyValue("text-size-adjust"))).toBe("100%");
  // The device font decides how wide text is; a monospace font is wider than any a phone ships, so a layout that
  // survives it cannot be widened by a real one.
  await page.addStyleTag({ content: "*:not(svg):not(svg *) { font-family: 'Courier New', monospace !important; letter-spacing: 0.04em !important; }" });
  await page.evaluate(async () => {
    const state = window.__dagBuilderState;
    const source = state.project.groups.find(g => g.variable_ids?.length >= 40 && g.variable_ids.length <= 200);
    const { commitLocalSchema } = await import("/local_schema_store.mjs");
    await commitLocalSchema({ id: "wide-fixture", url: location.href, schema: { groups: [{ group_id: "wide-1", label: "Innovation", source: "user_split",
      description: "Innovation, invention, patenting, creative problem-solving, new products and the generation of novel ideas in organisations.",
      provenance: { operation: "split_categories", split_id: "wide-1-s", source_group_ids: [source.group_id],
        source_group_by_variable: Object.fromEntries(source.variable_ids.map(id => [id, source.group_id])) },
      variable_ids: source.variable_ids.slice(0, 20) }] } });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated);
  await page.addStyleTag({ content: "*:not(svg):not(svg *) { font-family: 'Courier New', monospace !important; letter-spacing: 0.04em !important; }" });
  const over = async () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const problems = [];
  const check = async screen => { const extra = await over(); if (extra > 0) problems.push(`${screen}: ${extra}px wider than the screen`); };
  await page.locator("#identify-iv-input").tap();
  await check("variable picker");
  await page.getByRole("button", { name: "Review definition of Innovation" }).tap();
  await expect(page.locator("#definitionConceptsTitle")).toHaveText("Review saved variable");
  await check("review saved variable");
  await expect(page.locator(".layout-debug")).toContainText("zoom");
  expect(problems).toEqual([]);
  await context.close();
});
