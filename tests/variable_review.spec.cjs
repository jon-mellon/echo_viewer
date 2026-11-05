const { test, expect } = require("./fixtures.cjs");
const base = `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}`;

async function setup(page, { indirect = false, instrument = false } = {}) {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${base}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20 && window.__dagBuilderState.publishedSchemaHydrated);
  await page.evaluate(({ indirect, instrument }) => {
    const s = window.__dagBuilderState;
    const original = s.project.groups.filter(group => group.variable_ids?.length && group.type !== "other").slice(0, 5);
    const labels = ["Exposure", "Outcome", "Candidate", "Mediator", "Instrument"];
    const ids = ["x", "y", "c", "m", "z"];
    s.project.groups = original.map((group, index) => ({ ...group, group_id: ids[index], label: labels[index], type: index === 0 ? "iv" : index === 1 ? "dv" : null }));
    const link = (a, b) => ({ edge_id: `${a}-${b}`, group_a: a, group_b: b, direction_type: "A_TO_B", display_status: "active",
      a_to_b_raw_link_ids: [], b_to_a_raw_link_ids: [], a_to_b_paper_table_keys: [], b_to_a_paper_table_keys: [] });
    s.project.links = instrument ? [link("z", "c"), link("c", "y"), link("x", "y")]
      : [link("c", "m"), link("m", "x"), ...(indirect ? [link("m", "y")] : [link("c", "y")]), link("x", "y")];
    s.project.iv_group_id = "x"; s.project.dv_group_id = "y"; s.project.instrument_group_id = instrument ? "z" : null;
    s.project.confounder_statuses = {}; s.project.exclusion_statuses = {};
    s.confounderMaxPathLength = 3; s.exclusionMaxPathLength = 3; s.excludeBottleneckedConfounders = false; s.excludeSparseEdges = false;
    s.showConfoundersOnly = !instrument; s.showCollidersOnly = false; s.showExclusionViolations = instrument; s.showExogeneity = false;
    s.identifyExclusion = null;
  }, { indirect, instrument });
  // Refresh controls after seeding the small deterministic study graph.
  await page.locator(instrument ? "#toggleExclusionViolations" : "#toggleConfoundersOnly").dispatchEvent("click");
  await page.locator("#identify-iv-input").focus();
  await page.locator("#identify-iv-input").press("Escape");
  await expect(page.locator('.variable-disposition[data-group-id="c"]')).toBeVisible();
}

test("one review list replaces tickboxes and the separate status panel; schema exports are study independent", async ({ page }) => {
  await setup(page);
  await expect(page.locator("#exploreResults input[type=checkbox]")).toHaveCount(0);
  await expect(page.locator("#confounderConfig")).toBeHidden();
  const menu = page.locator('.variable-disposition[data-group-id="c"]');
  await menu.selectOption("not_in_minimal_adjustment_set");
  await expect(menu).toHaveValue("not_in_minimal_adjustment_set");
  const ids = await page.evaluate(() => [...window.__dagBuilderState.confounderGroupIds]);
  expect(ids).toContain("c");
  await page.locator("#editVariableSchema").click();
  await expect(page.locator("#customVariablesTitle")).toHaveText("Edit variable schema");
  await expect(page.locator("#customVariablesTable")).toContainText("Candidate");
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportVariableSchema").click()]);
  const fs = require("node:fs");
  const schema = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(schema.confounder_statuses).toBeUndefined();
  expect(schema.groups.find(group => group.group_id === "c")).toBeTruthy();
  await page.locator("#customVariablesClose").click();
  await expect(menu).toHaveValue("not_in_minimal_adjustment_set");
});

test("'Affects outcome only via cause' fades the variable and leaves the graph alone", async ({ page }) => {
  await setup(page);
  const baseline = await page.evaluate(() => JSON.stringify(window.__dagBuilderState.project.links));
  const menu = page.locator('.variable-disposition[data-group-id="c"]');
  await menu.selectOption("causes_y_only_via_x");
  // No preview or confirmation: it is recorded at once and the variable stays in the main list, faded.
  await expect(page.locator("#variableReviewDialog")).toBeHidden();
  await expect(menu).toHaveValue("causes_y_only_via_x");
  await expect(page.locator('.variable-review-row[data-group-id="c"]')).toHaveClass(/is-accounted/);
  await expect(page.locator('[data-section="rejected"]')).toHaveCount(0);
  const graph = await page.evaluate(() => window.__dagBuilderState.studyGraph);
  expect(graph.links.some(link => link.edge_id === "c-y")).toBe(true);
  expect(graph.links.some(link => link.is_user_claim)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(window.__dagBuilderState.project.links))).toBe(baseline);
  expect(await page.evaluate(() => window.__dagBuilderState.confounderGroupIds.has("c"))).toBe(true);
  await menu.selectOption("unaddressed");
  await expect(page.locator('.variable-review-row[data-group-id="c"]')).not.toHaveClass(/is-accounted/);
});

test("whole-variable removal requires a private reason and can be undone by choosing another disposition", async ({ page }) => {
  await setup(page, { indirect: true });
  const menu = page.locator('.variable-disposition[data-group-id="c"]');
  const dialog = page.locator("#variableReviewDialog");
  await menu.selectOption("removed_other");
  await dialog.getByRole("button", { name: "Confirm decision" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "Reason for removing this variable" }).fill("This variable is outside this study population.");
  await dialog.getByRole("button", { name: "Confirm decision" }).click();
  await expect(page.locator('[data-section="rejected"]')).toContainText("Private note:");
  expect(await page.evaluate(() => window.__dagBuilderState.studyGraph.groups.some(group => group.group_id === "c"))).toBe(false);
  await menu.selectOption("unaddressed");
  expect(await page.evaluate(() => window.__dagBuilderState.studyGraph.groups.some(group => group.group_id === "c"))).toBe(true);
  await page.locator("#toggleCollidersOnly").click();
  await expect(page.locator("#exploreResults .variable-disposition")).toHaveCount(0);
  await expect(page.locator("#exploreResults input[type=checkbox]")).toHaveCount(0);
});

test("exclusion decisions are scoped to the instrument; controlled violations warn and the via-cause options fade", async ({ page }) => {
  await setup(page, { instrument: true });
  const menu = page.locator('.variable-disposition[data-group-id="c"]');
  await menu.selectOption("explicitly_controlled");
  await expect(page.locator(".review-warning")).toHaveAttribute("title", "Controlling for exclusion restriction violations can induce post treatment bias.");
  const keys = await page.evaluate(() => Object.keys(window.__dagBuilderState.project.exclusion_statuses));
  expect(keys).toEqual([JSON.stringify(["z", "x", "y", "c"])]);
  await menu.selectOption("instrument_only_via_x");
  await expect(page.locator("#variableReviewDialog")).toBeHidden();
  await expect(page.locator(".review-warning")).toHaveCount(0);
  await expect(page.locator('.variable-review-row[data-group-id="c"]')).toHaveClass(/is-accounted/);
  await expect(page.locator('[data-section="rejected"]')).toHaveCount(0);
  await page.locator("#dagViewTable").click();
  await expect(page.locator('#dagTable select[data-group-id="c"]')).toHaveValue("instrument_only_via_x");
  await expect(page.locator("#dagTable")).not.toContainText("Rejected candidates");
});

test("on a touch screen every field is at least 16px, so iOS does not zoom the page when one is focused", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${base}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20 && window.__dagBuilderState.publishedSchemaHydrated);
  await page.locator('[data-mobile-panel="controls"]').last().tap();
  await expect(page.locator("#identify-iv-input")).toBeVisible();
  const small = await page.evaluate(() => [...document.querySelectorAll("input, select, textarea")]
    .filter(el => !["checkbox", "radio", "range", "file", "hidden"].includes(el.type) && el.offsetParent)
    .map(el => ({ id: el.id || el.className, size: parseFloat(getComputedStyle(el).fontSize) }))
    .filter(item => item.size < 16));
  expect(small).toEqual([]);
  await context.close();
});
