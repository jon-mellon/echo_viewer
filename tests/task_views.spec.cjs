const { test, expect } = require("playwright/test");

const viewer = "http://127.0.0.1:8767/";

async function open(page, url = viewer) {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
}

const pick = (page, groupId) => page.locator(`#focusGroupPicker button[data-group-id="${groupId}"]`);
const renderedEdges = page => page.evaluate(async () => {
  const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
  await api.whenDagRendered();
  return api.renderedDagEdgeIds().filter(id => id !== "__study_design_iv_to_dv__").length;
});

test("the start page leads to causes and consequences views that behave like Identify with one variable", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  await expect(page.locator("#taskLanding h1")).toHaveText("What do you want to do?");
  await expect(page.locator("#taskLanding .task-choice")).toHaveCount(3);
  await expect(page.locator("#taskReset")).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe("home");

  // The same picker as Identify, offering the one anchor.
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#focusInput")).toHaveAttribute("placeholder", "Search group or constituent variable");
  await expect(pick(page, "category-sleep")).toHaveText("Use as Dep var");
  await expect(page.locator("#dagNetwork")).toBeVisible();
  await pick(page, "category-sleep").click();

  // The same anchor bar, with a single row.
  await expect(page.locator("#anchorBar")).toBeVisible();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");
  await expect(page.locator("#anchorDvLabel").locator("xpath=ancestor::div[contains(@class,'anchor-row')]")).toBeVisible();
  await expect(page.locator("#anchorIvLabel").locator("xpath=ancestor::div[contains(@class,'anchor-row')]")).toBeHidden();
  // The list stands on its own: no summary sentence, hint line or per-row extra action.
  await expect(page.locator("#exploreSummary")).toBeHidden();
  await expect(page.locator("#exploreHint")).toHaveCount(0);
  await expect(page.locator(".explore-row-refocus")).toHaveCount(0);
  await expect(page.locator(".explore-row button")).toHaveCount(await page.locator(".explore-row").count());
  const direct = await page.locator('.explore-row[data-distance="1"]').count();
  expect(direct).toBeGreaterThan(0);
  await expect(page.locator('.explore-row[data-distance="2"]')).toHaveCount(0);
  // The graph draws exactly the links in the list.
  expect(await renderedEdges(page)).toBe(direct);
  await expect(page.locator("#dagViewTitle")).toHaveText("Causes of sleep");

  // Clicking a row shows the evidence for its link, as clicking that link would.
  const row = page.locator('.explore-row[data-distance="1"]').first();
  const edgeId = await row.getAttribute("data-edge-id");
  await row.locator(".explore-row-open").click();
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  await expect(page.locator("#edgeInspector")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
  await expect.poll(() => new URL(page.url()).searchParams.get("selected_edge")).toBe(edgeId);
  await expect(row.locator(".explore-row-open")).toHaveAttribute("aria-pressed", "true");
  // Evidence takes over the left panel and Close brings the list back.
  await expect(page.locator("#exploreView")).toBeHidden();
  await page.locator("#closeEvidencePane").click();
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#provenancePanel")).toBeHidden();

  // Distance and minimum papers use the usual Filters controls.
  await page.locator(".filter-dropdown > summary").click();
  await expect(page.locator("#confounderPathLengthLabel")).toHaveText("Distance");
  await expect(page.locator("#toggleConfoundersOnly")).toBeHidden();
  await expect(page.locator("#toggleSparseEdges")).toBeVisible();
  await page.locator("#confounderPathLength").fill("2");
  await expect(page.locator('.explore-row[data-distance="2"]').first()).toBeVisible();
  await expect(page.locator('.explore-row[data-distance="2"] .explore-row-path').first()).toContainText("via ");
  const withTwoSteps = await page.locator(".explore-row").count();
  expect(await renderedEdges(page)).toBe(withTwoSteps);
  await page.locator("#minimumEdgePapers").fill("10");
  await expect.poll(() => page.locator(".explore-row").count()).toBeLessThan(withTwoSteps);
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_min_papers")).toBe("10");
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_depth")).toBe("2");

  // Consequences keeps a separate variable and settings; Identify is untouched underneath.
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
  await expect(pick(page, "category-income-earnings")).toHaveText("Use as Ind var");
  await pick(page, "category-income-earnings").click();
  await expect(page.locator("#anchorIvLabel")).toHaveText("income/earnings");
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect(page.locator("#exploreSummary")).toBeHidden();
  await expect(page.locator("#confounderPathLength")).toHaveValue("1");
  await page.locator("#taskBar .task-tab[data-task=identify]").click();
  await expect(page.locator("#exploreView")).toBeHidden();
  await expect(page.locator("#setupSection")).toBeVisible();
  await expect(page.locator("#confounderPathLength")).toHaveValue("1");
  await page.locator("#taskBar .task-tab[data-task=causes]").click();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");
  await expect(page.locator("#confounderPathLength")).toHaveValue("2");
  await expect(page.locator("#minimumEdgePapers")).toHaveValue("10");

  // Change reopens the picker with the current variable kept until another is chosen.
  await page.locator("#changeDv").click();
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");
  await page.locator("#focusPickerCancel").click();
  await expect(page.locator("#exploreResultsBlock")).toBeVisible();

  // Choosing a different variable is done the usual way: Change, then the picker.
  const target = "category-age";
  await page.locator("#changeDv").click();
  await pick(page, target).click();
  await expect(page.locator("#anchorDvLabel")).toHaveText("age");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.explore.causes.focusId)).toBe(target);

  // The address carries the new variable before we reload, or the reload would restore the old one.
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_of")).toBe(target);
  await expect.poll(() => new URL(page.url()).searchParams.get("effects_of")).toBe("category-income-earnings");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#confounderPathLength")).toHaveValue("2");
  await expect(page.locator("#minimumEdgePapers")).toHaveValue("10");
  expect(await page.evaluate(() => window.__dagBuilderState.explore.causes.focusId)).toBe(target);
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await expect(page.locator("#anchorIvLabel")).toHaveText("income/earnings");
});

test("the graph puts the chosen variable in the middle with its causes and consequences around it", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  await page.locator(".explore-row").first().waitFor();
  await page.locator(".filter-dropdown > summary").click();
  await page.locator("#confounderPathLength").fill("2");
  await expect(page.locator('.explore-row[data-distance="2"]').first()).toBeVisible();
  const layout = await page.evaluate(async () => {
    const s = window.__dagBuilderState;
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    await api.whenDagRendered();
    const { computeFocusLayout } = await import("/dag_layout.mjs");
    const groups = s.project.groups.filter(g => s.componentGroupIds.has(g.group_id));
    const out = computeFocusLayout({ groups, links: s.visibleLinks, width: 1000, height: 700, focus: s.exploreLayout });
    const focus = out.positions.get(s.exploreLayout.id);
    const others = [...out.positions].filter(([id]) => id !== s.exploreLayout.id).map(([id, p]) => ({ id, x: p.x, d: new Map(s.exploreLayout.distance).get(id) }));
    return { focus, left: others.filter(o => o.x < 0).length, right: others.filter(o => o.x > 0).length,
      onFocusColumn: others.filter(o => o.x === 0).length,
      ringsOutward: [1, 2].map(d => Math.min(...others.filter(o => o.d === d).map(o => Math.abs(o.x)))) };
  });
  expect(layout.focus).toMatchObject({ x: 0, y: 0 });
  // Both sides are used, and nothing else sits in the focus's column.
  expect(layout.left).toBeGreaterThan(0);
  expect(layout.right).toBeGreaterThan(0);
  expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(Math.max(6, layout.left));
  expect(layout.onFocusColumn).toBe(0);
  // Each step of distance starts further from the centre.
  expect(layout.ringsOutward[1]).toBeGreaterThan(layout.ringsOutward[0]);
});

test("each task keeps the evidence that was open in it", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  const row = page.locator('.explore-row[data-distance="1"]').first();
  const edgeId = await row.getAttribute("data-edge-id");
  await row.locator(".explore-row-open").click();
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  await page.locator("#taskBar .task-tab[data-task=identify]").click();
  await expect(page.locator("#closeEvidencePane")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBeNull();
  await page.locator("#taskBar .task-tab[data-task=causes]").click();
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
});

test("Reset warns and offers to continue, open a new tab, or reset this tab", async ({ page, context }) => {
  await open(page, `${viewer}?task=causes`);
  await expect(page.locator("#exploreView")).toBeVisible();
  await pick(page, "category-sleep").click();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");

  await page.locator("#taskReset").click();
  const dialog = page.locator("#resetDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button")).toHaveText([
    "Continue working on this project", "Open new project in a new tab", "Reset in current tab"]);
  await dialog.getByRole("button", { name: "Continue working on this project" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");

  await page.locator("#taskReset").click();
  const [tab] = await Promise.all([context.waitForEvent("page"),
    dialog.getByRole("button", { name: "Open new project in a new tab" }).click()]);
  await tab.waitForLoadState("domcontentloaded");
  const fresh = new URL(tab.url());
  expect([...fresh.searchParams.keys()].filter(key => !["schema", "data_version"].includes(key))).toEqual([]);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");
  await tab.close();

  await page.locator("#taskReset").click();
  await dialog.getByRole("button", { name: "Reset in current tab" }).click();
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#taskLanding")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("causes_of")).toBeNull();
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
});

test("on a phone the list and graph are tabs, and a tapped variable shows its evidence", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=consequences`);
    await pick(page, "category-sleep").tap();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
      tabs: document.querySelector(".task-tabs").scrollWidth - document.querySelector(".task-tabs").clientWidth }));
    expect(sizes.page).toBeLessThanOrEqual(375);
    expect(sizes.tabs).toBe(0);
    await expect(page.locator(".mobile-panel-nav .mobile-panel-tab:visible")).toHaveText(["List", "Graph"]);
    await page.locator(".explore-row .explore-row-open").first().tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await expect(page.locator("#provenancePanel")).toBeVisible();
    await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').tap();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator("#setupSection")).toBeVisible();
    // Identify gets its own tab names back.
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="controls"]')).toHaveText("Setup");
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="dag"]')).toHaveText("Map");
  } finally {
    await context.close();
  }
});

test("the start page preloads the search catalog, then paper support", async ({ page }) => {
  // Counting papers scans every finding; that must be one verified download, not many range requests.
  const findings = [];
  page.on("request", request => {
    if (/\/causal_link_occurrences\.parquet/.test(request.url())) findings.push({ range: request.headers().range || null });
  });
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  // Nothing has opened a task or a search, yet both arrive in the background.
  await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready"
    && performance.getEntriesByName("echo:evidence:engine").length
    && window.__dagBuilderState.edgeSupportById.size > 1000, null, { timeout: 90000 });
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await pick(page, "category-sleep").click();
  // No "Counting the papers…" wait once support is preloaded.
  await expect(page.locator(".explore-row").first()).toBeVisible({ timeout: 1000 });
  expect(findings).toEqual([{ range: null }]);
});

test("a notice appears only when there is nothing to list, and goes away with results", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect(page.locator("#exploreSummary")).toBeHidden();
  await page.locator(".filter-dropdown > summary").click();
  await page.locator("#minimumEdgePapers").fill("99999");
  await expect(page.locator(".explore-row")).toHaveCount(0);
  await expect(page.locator("#exploreSummary")).toBeVisible();
  await expect(page.locator("#exploreSummary")).toContainText("Nothing causes sleep at this distance and paper count");
  await page.locator("#minimumEdgePapers").fill("2");
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect(page.locator("#exploreSummary")).toBeHidden();
});
