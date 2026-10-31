const { test, expect } = require("./fixtures.cjs");

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

test("tabs start unconfigured views at setup and reopen configured views", async ({ page }) => {
  await open(page);
  await page.locator("#taskBar .task-tab[data-task=causes]").click();
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
  await pick(page, "category-sleep").click();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");

  await page.locator("#changeDv").click();
  await page.locator("#focusInput").fill("sleep");
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
  await expect(page.locator("#focusInput")).toHaveValue("");
  await expect(pick(page, "category-income-earnings")).toBeVisible();
  await page.evaluate(() => { window.__dagBuilderState.workflowMode = "group_review"; });
  await page.locator("#taskBar .task-tab[data-task=identify]").click();
  await expect(page.locator("#setupSection")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.workflowMode)).toBe("setup");
  await page.locator("#taskBar .task-tab[data-task=causes]").click();
  await expect(page.locator("#anchorDvLabel")).toHaveText("sleep");
  await expect(page.locator("#exploreResultsBlock")).toBeVisible();
});

test("the start page leads to causes and consequences views that behave like Identify with one variable", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  await expect(page.locator("#taskLanding h1")).toHaveText("What do you want to do?");
  await expect(page.locator("#taskLanding .task-choice")).toHaveCount(3);
  await expect(page.locator("#taskReset")).toBeHidden();
  expect(page.url()).toBe(viewer);

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

test("mobile reset keeps the previous project after navigating", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await pick(page, "category-sleep").tap();
    await page.locator("#taskReset").tap();
    await page.locator("#resetHere").tap();
    await expect(page.locator("#taskLanding")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("causes_of")).toBeNull();
    await expect.poll(() => page.evaluate(async () => {
      const { listPreviousSessions } = await import("/local_schema_store.mjs");
      const sessions = await listPreviousSessions();
      return sessions.some(session => new URL(session.url).searchParams.get("causes_of") === "category-sleep");
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("echo-pending-reset-session"))).toBeNull();
  } finally {
    await context.close();
  }
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
    await expect(page.locator(".mobile-panel-nav .mobile-panel-tab:visible")).toHaveText(["Variables view", "Map view"]);
    await page.locator(".explore-row .explore-row-open").first().tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await expect(page.locator("#provenancePanel")).toBeVisible();
    await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').tap();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator("#setupSection")).toBeVisible();
    // Identify gets its own tab names back.
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="controls"]')).toHaveText("Setup view");
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="dag"]')).toHaveText("Map view");
  } finally {
    await context.close();
  }
});

test("mobile task tabs open setup when their view has no chosen variable", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await expect(page.locator("#focusSearchBlock")).toBeVisible();
    await pick(page, "category-sleep").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await expect(page.locator("#dagWorkspaceSection")).toBeVisible();

    await page.locator("#taskBar .task-tab[data-task=consequences]").tap();
    await expect(page.locator("#focusSearchBlock")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "controls");
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await page.locator("#taskBar .task-tab[data-task=consequences]").tap();
    await expect(page.locator("#focusSearchBlock")).toBeVisible();
    await pick(page, "category-age").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await page.locator("#taskBar .task-tab[data-task=causes]").tap();
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "dag");
    await expect(page.locator("#dagWorkspaceSection")).toBeVisible();

    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator("#setupSection")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "controls");
  } finally {
    await context.close();
  }
});

test("the start page preloads the search catalog and query engine", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  // Nothing has opened a task or a search, yet both arrive in the background.
  await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready"
    && performance.getEntriesByName("echo:evidence:engine").length, null, { timeout: 90000 });
});

test("mobile home stays on one document and a clean URL through schema hydration", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-home-loads",
      String(Number(sessionStorage.getItem("echo-home-loads") || 0) + 1)));
    await open(page);
    await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated);
    await expect(page.locator("#taskLanding")).toBeVisible();
    expect(page.url()).toBe(viewer);
    expect(await page.evaluate(() => sessionStorage.getItem("echo-home-loads"))).toBe("1");
    expect(await page.evaluate(() => performance.getEntriesByName("echo:evidence:engine").length)).toBe(0);
    await page.locator("#taskLanding .task-choice[data-task=causes]").tap();
    await expect(page.locator("#exploreView")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("paper counts come from the DAG: results are immediate and no findings are counted or downloaded", async ({ page }) => {
  const findings = [];
  page.on("request", request => {
    if (/\/causal_link_occurrences\.parquet/.test(request.url())) findings.push(request.url());
  });
  await open(page);
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await pick(page, "category-sleep").click();
  // No waiting on anything: the numbers are already on the links.
  await expect(page.locator(".explore-row").first()).toBeVisible({ timeout: 1500 });
  await expect(page.locator("#exploreSummary")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.edgeSupportById.size)).toBe(0);
  await page.waitForTimeout(2000);
  expect(findings).toEqual([]);
});

test("links an edit left without paper keys are counted from their own findings only", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  await expect(page.locator(".explore-row").first()).toBeVisible();
  const before = await page.locator(".explore-row").count();
  const target = await page.locator(".explore-row").first().getAttribute("data-edge-id");
  // What a local edit does to an edge: replace the links with a copy that has no paper keys on one.
  await page.evaluate(edgeId => {
    const s = window.__dagBuilderState;
    s.project.links = s.project.links.map(link => {
      if (link.edge_id !== edgeId) return link;
      const { a_to_b_paper_table_keys, b_to_a_paper_table_keys, distinct_paper_count, ...rest } = link;
      return rest;
    });
  }, target);
  await page.locator(".filter-dropdown > summary").click();
  await page.locator("#confounderPathLength").fill("2");
  await page.locator("#confounderPathLength").fill("1");
  // It is counted exactly, so the same variables are listed, from a handful of findings rather than all of them.
  // (Whether the findings are fetched or were already in memory depends on what had loaded, so only the outcome is checked.)
  await expect(page.locator(".explore-row")).toHaveCount(before);
  await expect(page.locator("#exploreSummary")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.edgeSupportById.size)).toBeLessThan(2000);
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

test("every view can show the same variables and links as a table, with the same controls", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  const direct = await renderedEdges(page);
  await expect(page.locator(".dag-view-switch")).toBeVisible();
  await expect(page.locator("#dagViewGraph")).toHaveAttribute("aria-pressed", "true");
  const switchBox = await page.locator(".dag-view-switch").boundingBox();
  const copyBox = await page.locator("#copyPermalink").boundingBox();
  expect(switchBox.x).toBeGreaterThan(copyBox.x);

  await page.locator("#dagViewTable").click();
  await expect(page.locator("#dagTable")).toBeVisible();
  await expect(page.locator("#dagNetwork")).toBeHidden();
  await expect(page.locator("#dagViewTable")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => new URL(page.url()).searchParams.get("dag_view")).toBe("table");
  // The same links the graph drew, plus the focal variable among the variables.
  await expect(page.locator("#dagPathsTable tbody tr")).toHaveCount(direct);
  await expect(page.locator('#dagVariablesTable tr[data-group-id="category-sleep"] td').nth(1)).toHaveText("Focus");
  // The filters stay where they were, and drive the table.
  await expect(page.locator(".filter-dropdown > summary")).toBeVisible();
  await expect(page.locator("#dagSvgZoomIn")).toBeHidden();
  await page.locator(".filter-dropdown > summary").click();
  await page.locator("#minimumEdgePapers").fill("20");
  await expect.poll(() => page.locator("#dagPathsTable tbody tr").count()).toBeLessThan(direct);
  await page.locator("#minimumEdgePapers").fill("2");
  await expect(page.locator("#dagPathsTable tbody tr")).toHaveCount(direct);

  // Definitions and evidence open from the table as they do from the graph.
  // Each row is a path; its arrows open the evidence for that link.
  const arrow = page.locator("#dagPathsTable .dag-table-arrow").first();
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Path", "Papers"]);
  await expect(page.locator("#dagPathsTable").getByText("Evidence", { exact: true })).toHaveCount(0);
  const edgeId = await arrow.getAttribute("data-edge-id");
  await arrow.click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  await expect(page.locator("#edgeInspector")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
  await expect(page.locator(`#dagPathsTable .dag-table-arrow[data-edge-id="${edgeId}"]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator("#closeEvidencePane").click();
  await page.locator("#dagVariablesTable tbody tr").nth(1).getByRole("button").first().click();
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.selectedEvidenceGroupId)).toBeTruthy();

  // The choice survives a reload through the permalink, and switching back restores the graph.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#dagTable")).toBeVisible();
  await page.locator("#dagViewGraph").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();
  await expect(page.locator("#dagTable")).toBeHidden();
  expect(await renderedEdges(page)).toBe(direct);
  await expect.poll(() => new URL(page.url()).searchParams.get("dag_view")).toBeNull();
});

test("the table also covers Identify and works from the keyboard", async ({ page }) => {
  await open(page, `${viewer}?task=identify`);
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  const anchors = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const link = state.project.links.find(item => (item.a_to_b_raw_link_ids?.length || item.b_to_a_raw_link_ids?.length)
      && state.project.groups.some(group => group.group_id === item.group_a && group.variable_ids?.length)
      && state.project.groups.some(group => group.group_id === item.group_b && group.variable_ids?.length));
    return [link.group_a, link.group_b];
  });
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await expect(page.locator("#dagViewTable")).toBeVisible();
  await page.locator("#dagViewTable").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dagTable")).toBeVisible();
  await expect(page.locator("#dagViewTable")).toBeFocused();
  await page.locator("#dagVariablesTable thead button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dagVariablesTable thead th[aria-sort=descending]")).toHaveCount(1);
  await expect(page.locator("#dagVariablesTable thead button").first()).toBeFocused();
  // Identify shows each confounder as a path to the Ind var and a path to the Dep var.
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Confounder", "Route"]);
});

const shownGraph = async page => {
  await expect(page.locator("#dagNetwork")).toBeVisible();
  await expect(page.locator("#dagTable")).toBeHidden();
  await expect(page.locator("#dagViewGraph")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#dagViewTable")).toHaveAttribute("aria-pressed", "false");
};

test("the graph is the default view everywhere, whatever was chosen before", async ({ page }) => {
  for (const task of ["causes", "consequences"]) {
    await open(page, `${viewer}?task=${task}`);
    await pick(page, "category-sleep").click();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    await shownGraph(page);
    expect(await page.evaluate(() => window.__dagBuilderState.dagDisplay)).toBe("graph");
    expect(new URL(page.url()).searchParams.has("dag_view")).toBe(false);
  }
  // The table is chosen per link, not remembered by the browser: a fresh page opens on the graph.
  await page.locator("#dagViewTable").click();
  await expect(page.locator("#dagTable")).toBeVisible();
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  await shownGraph(page);
  // Switching between tasks keeps the chosen view, and Reset in the current tab returns to the graph.
  await page.locator("#dagViewTable").click();
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await pick(page, "category-income-earnings").click();
  await expect(page.locator("#dagTable")).toBeVisible();
  await expect(page.locator("#dagPathsTable tbody tr").first()).toBeVisible();
});

test("on a phone the table fits the screen and its controls can be tapped", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await pick(page, "category-sleep").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await shownGraph(page);
    // The switch is the first control, so it never scrolls out of reach.
    const box = await page.locator(".dag-view-switch").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await page.locator("#dagViewTable").tap();
    await expect(page.locator("#dagTable")).toBeVisible();
    await expect(page.locator("#dagPathsTable tbody tr").first()).toBeVisible();
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
      table: document.getElementById("dagTable").scrollWidth - document.getElementById("dagTable").clientWidth }));
    expect(overflow.page).toBeLessThanOrEqual(375);
    expect(overflow.table).toBe(0);
    // Every evidence button is on screen, and the table scrolls rather than the page.
    const rowButtons = page.locator("#dagPathsTable tbody tr").first().getByRole("button");
    for (let index = 0, count = await rowButtons.count(); index < count; index++) {
      // Looked up afresh: a late data load may rebuild the table between buttons.
      await expect(rowButtons.nth(index)).toBeVisible();
      const rect = await rowButtons.nth(index).boundingBox();
      expect(rect.x + rect.width).toBeLessThanOrEqual(375);
      expect(rect.height).toBeGreaterThanOrEqual(24); // WCAG 2.2 minimum target size
    }
    await page.locator(".filter-dropdown > summary").tap();
    await expect(page.locator("#minimumEdgePapers")).toBeVisible();
    await page.locator("#minimumEdgePapers").fill("20");
    await expect.poll(() => page.locator("#dagPathsTable tbody tr").count()).toBeLessThan(10);
    await page.locator("#minimumEdgePapers").fill("2");
    await page.locator(".filter-dropdown > summary").tap();
    const arrow = page.locator("#dagPathsTable .dag-table-arrow").first();
    const edgeId = await arrow.getAttribute("data-edge-id");
    await arrow.tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await expect(page.locator("#provenancePanel")).toBeVisible();
    expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
    await page.locator("#closeEvidencePane").tap();
    // A variable's definition opens from the table too.
    await page.locator("#dagVariablesTable tbody tr").nth(1).getByRole("button").first().tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await page.locator("#closeEvidencePane").tap();
    await page.locator("#dagViewGraph").tap();
    await shownGraph(page);
    await expect.poll(() => page.evaluate(async () => {
      const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
      await api.whenDagRendered();
      return api.renderedDagEdgeIds().length;
    })).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("a table of a graph with hundreds of links stays small and quick", async ({ page }) => {
  await open(page, `${viewer}?task=consequences`);
  await pick(page, "category-income-earnings").click();
  await page.locator("#dagViewTable").click();
  await page.locator(".filter-dropdown > summary").click();
  await page.locator("#minimumEdgePapers").fill("1");
  await page.locator("#confounderPathLength").fill("4");
  await expect(page.locator("#dagPathsTable tbody tr").first()).toBeVisible();
  const { rendered, total } = await page.evaluate(() => ({
    rendered: document.querySelectorAll("#dagPathsTable tbody tr").length,
    total: Number(/\((\d+)\)/.exec(document.querySelector("#dagPathsTable caption").textContent)[1]) }));
  expect(rendered).toBeLessThanOrEqual(200);
  expect(rendered).toBe(Math.min(total, 200));
  if (total > 200) {
    await page.locator(".dag-table-more button").first().click();
    await expect(page.locator("#dagPathsTable tbody tr")).toHaveCount(Math.min(total, 400));
  }
});

test("in Identify each row is a confounder path with an arrow per link that opens its evidence", async ({ page }) => {
  await open(page, `${viewer}?task=identify`);
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  // An Ind var and Dep var that share a cause one link away.
  const anchors = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const drawn = new Set(state.project.groups.filter(group => group.variable_ids?.length && group.type !== "other").map(group => group.group_id));
    const effects = new Map();
    for (const link of state.project.links) {
      if (link.is_target_relation || !drawn.has(link.group_a) || !drawn.has(link.group_b)) continue;
      const pairs = link.direction_type === "BIDIRECTIONAL" ? [[link.group_a, link.group_b], [link.group_b, link.group_a]]
        : link.direction_type === "B_TO_A" ? [[link.group_b, link.group_a]] : [[link.group_a, link.group_b]];
      for (const [cause, effect] of pairs) effects.set(cause, [...(effects.get(cause) || []), effect]);
    }
    for (const [cause, targets] of effects) {
      const [iv, dv] = [...new Set(targets)].filter(id => id !== cause);
      if (iv && dv) return [iv, dv];
    }
    return null;
  });
  expect(anchors).not.toBeNull();
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await page.locator("#dagViewTable").click();
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Confounder", "Route"]);
  const rows = page.locator("#dagPathsTable tbody tr");
  expect(await rows.count()).toBeGreaterThan(0);
  // A confounder's paths sit together: its name is one cell spanning all of its rows.
  const confounder = await rows.first().getAttribute("data-row-id");
  const own = page.locator(`#dagPathsTable tbody tr[data-row-id="${confounder}"]`);
  await expect(page.locator(`#dagPathsTable th.dag-table-candidate [data-group-id="${confounder}"]`)).toHaveCount(1);
  await expect(page.locator(`#dagPathsTable th.dag-table-candidate`).first()).toHaveAttribute("rowspan", String(await own.count()));
  const order = await rows.evaluateAll(trs => trs.map(tr => tr.dataset.rowId));
  expect(order.filter(id => id === confounder).length).toBe(await own.count());
  expect(order.indexOf(confounder)).toBe(order.lastIndexOf(confounder) - (await own.count()) + 1);
  const routeRows = await own.evaluateAll(trs => trs.map(tr => ({
    route: tr.querySelector(".dag-table-route-label")?.textContent.trim(),
    end: tr.querySelector(".dag-table-path .dag-table-node:last-of-type")?.dataset.groupId,
  })));
  expect([...new Set(routeRows.map(item => item.route))]).toEqual(["To Ind var", "To Dep var"]);
  expect(routeRows.every(item => item.end === anchors[item.route === "To Ind var" ? 0 : 1])).toBe(true);
  const row = rows.first();
  await expect(row.locator("td")).toHaveCount(1);
  for (const cell of await own.locator("td").all()) {
    expect(await cell.locator(".dag-table-arrow").count()).toBeGreaterThan(0);
    // Each path starts at the confounder and ends at an anchor.
    await expect(cell.locator(".dag-table-node").first()).toHaveAttribute("data-group-id", /.+/);
  }
  // The arrows are the only way into evidence: there is no separate column.
  await expect(page.locator("#dagPathsTable").getByText("Evidence", { exact: true })).toHaveCount(0);
  const arrow = row.locator("td").first().locator(".dag-table-arrow").last();
  const edgeId = await arrow.getAttribute("data-edge-id");
  await arrow.click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
  await expect(arrow).toHaveAttribute("aria-pressed", "true");
  // Switching back restores the graph.
  await page.locator("#dagViewGraph").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();
});

test("links the view implies beyond the paths are listed too, as many as the graph draws", async ({ page }) => {
  await open(page, `${viewer}?task=identify`);
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  const anchors = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const drawn = new Set(state.project.groups.filter(group => group.variable_ids?.length && group.type !== "other").map(group => group.group_id));
    const effects = new Map();
    for (const link of state.project.links) {
      if (link.is_target_relation || !drawn.has(link.group_a) || !drawn.has(link.group_b)) continue;
      const pairs = link.direction_type === "BIDIRECTIONAL" ? [[link.group_a, link.group_b], [link.group_b, link.group_a]]
        : link.direction_type === "B_TO_A" ? [[link.group_b, link.group_a]] : [[link.group_a, link.group_b]];
      for (const [cause, effect] of pairs) effects.set(cause, [...(effects.get(cause) || []), effect]);
    }
    for (const [cause, targets] of effects) {
      const [iv, dv] = [...new Set(targets)].filter(id => id !== cause);
      if (iv && dv) return [iv, dv];
    }
    return null;
  });
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await page.locator(".filter-dropdown > summary").click();
  const drawnLinks = () => page.evaluate(async () => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    await api.whenDagRendered();
    return window.__dagBuilderState.visibleLinks.filter(link => !link.is_target_relation).map(link => link.edge_id).sort();
  });
  const tabled = () => page.evaluate(() => [...document.querySelectorAll("#dagPathsTable .dag-table-arrow[data-edge-id], #dagOtherLinksTable .dag-table-arrow[data-edge-id]")]
    .map(arrow => arrow.dataset.edgeId).filter((id, index, all) => all.indexOf(id) === index).sort());
  // Showing only path links, every drawn link is on some path.
  const pathOnly = page.locator("#toggleIrrelevantConfounderLinks");
  if ((await pathOnly.getAttribute("aria-pressed")) !== "true") await pathOnly.click();
  await page.locator("#dagViewTable").click();
  expect(await tabled()).toEqual(await drawnLinks());
  await expect(page.locator("#dagOtherLinksTable")).toHaveCount(0);
  // With "Path links only" off the graph also draws links no confounder path uses; the table lists them after the paths.
  await pathOnly.click();
  await expect(pathOnly).toHaveAttribute("aria-pressed", "false");
  const all = await drawnLinks();
  await expect(page.locator("#dagOtherLinksTable")).toBeVisible();
  // Every drawn link is either on a listed path or in the other-links table (shown 200 at a time).
  const onPaths = await page.evaluate(() => new Set([...document.querySelectorAll("#dagPathsTable .dag-table-arrow[data-edge-id]")]
    .map(arrow => arrow.dataset.edgeId)).size);
  const listedOthers = Number(/\((\d+)\)/.exec(await page.locator("#dagOtherLinksTable caption").textContent())[1]);
  expect(onPaths + listedOthers).toBe(all.length);
  const others = await page.locator("#dagOtherLinksTable tbody tr").count();
  expect(others).toBe(Math.min(listedOthers, 200));
  expect((await tabled()).every(id => all.includes(id))).toBe(true);
  expect(await page.locator("#dagPathsTable").evaluate(table => table.compareDocumentPosition(document.getElementById("dagOtherLinksTable")) & Node.DOCUMENT_POSITION_FOLLOWING)).toBeTruthy();
  // Their arrows open evidence like any other.
  const arrow = page.locator("#dagOtherLinksTable .dag-table-arrow").first();
  const edgeId = await arrow.getAttribute("data-edge-id");
  await arrow.click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
});

test("on a phone, Identify opens on its setup even when another view was left on its Graph tab", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await pick(page, "category-sleep").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await expect(page.locator("#dagNetwork")).toBeVisible();
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    // Not a blank screen: the setup is shown, and tapping Identify again changes nothing.
    await expect(page.locator("#ivGroupPicker")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "controls");
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator("#ivGroupPicker")).toBeVisible();
    // The same from Consequences, and the other views still open on their own panels afterwards.
    await page.locator("#taskBar .task-tab[data-task=consequences]").tap();
    await pick(page, "category-income-earnings").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator("#ivGroupPicker")).toBeVisible();
    await page.locator("#taskBar .task-tab[data-task=causes]").tap();
    await expect(page.locator("#exploreView")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the table never prints stray text, and shows the choose-a-variable hint alone before anything is chosen", async ({ page }) => {
  await open(page, `${viewer}?task=consequences`);
  await page.locator("#dagViewTable").click();
  await expect(page.locator("#exploreGraphHint")).toBeVisible();
  await expect(page.locator("#dagTable")).toBeHidden();
  expect(await page.locator("#dagTable").evaluate(node => node.textContent)).not.toContain("null");
  await pick(page, "category-income-earnings").click();
  await expect(page.locator("#dagPathsTable tbody tr").first()).toBeVisible();
  await expect(page.locator("#exploreGraphHint")).toBeHidden();
  await expect(page.locator("#dagTable")).toBeVisible();
  for (const text of ["null", "undefined", "NaN", "[object"]) {
    expect(await page.locator("#dagTable").evaluate(node => node.textContent)).not.toContain(text);
  }
});
