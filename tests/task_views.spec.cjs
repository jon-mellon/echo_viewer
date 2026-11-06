const { test, expect } = require("./fixtures.cjs");
const { chooseAnchor, chooseAnchors, startCreate } = require("./support/identify.cjs");
const { chooseTask, chooseDirection, chooseFocus, openNav, closeNav, showPanel } = require("./support/navigation.cjs");

const viewer = `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/`;

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

test("exploration list search matches constituent variables", async ({ page }) => {
  await open(page);
  await chooseTask(page, "causes");
  await pick(page, "category-sleep").click();
  await page.locator(".list-filter > summary").click();
  const search = page.locator(".list-filter-search");
  // The first query starts the catalog load; the active filter is reapplied when it finishes.
  await search.fill("unlikely search text");
  await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready");
  const member = await page.evaluate(async () => {
    const { variableSearchCatalog } = await import("/variable_search_catalog.mjs");
    const state = window.__dagBuilderState;
    for (const row of document.querySelectorAll("#exploreResults .explore-row")) {
      const group = state.project.groups.find(item => item.group_id === row.dataset.groupId);
      for (const id of group?.variable_ids || []) {
        const record = variableSearchCatalog.recordById.get(id);
        const text = record?.[1] || record?.[2] || record?.[3];
        if (text && !group.label.toLowerCase().includes(text.toLowerCase())) return { groupId: group.group_id, text };
      }
    }
    return null;
  });
  expect(member).not.toBeNull();
  await search.fill(member.text);
  await expect(page.locator(`#exploreResults .explore-row[data-group-id="${member.groupId}"]`)).toBeVisible();
  await search.fill("no matching variable here");
  await expect(page.locator("#exploreResults .explore-row:visible")).toHaveCount(0);
  await page.locator(".list-filter-clear").click();
  await expect(page.locator("#exploreResults .explore-row:visible").first()).toBeVisible();
});

test("tabs start unconfigured views at setup and reopen configured views", async ({ page }) => {
  await open(page);
  await chooseTask(page, "causes");
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
  await expect(page.locator("#focusInput")).toHaveValue("");
  await pick(page, "category-sleep").click();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");

  // Flipping the direction keeps the variable; the results follow it.
  await chooseDirection(page, "consequences");
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator("#exploreResultsBlock")).toBeVisible();
  await chooseTask(page, "identify");
  await expect(page.locator("#identifyFields")).toBeVisible();
  await expect(page.locator("#identify-iv-input")).toHaveValue("");
  // Exploration reopens in the direction it was last in, with its variable.
  await chooseTask(page, "causes");
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator("#exploreResultsBlock")).toBeVisible();
});

test("the start page leads to causes and consequences views that behave like Identify with one variable", async ({ page }) => {
  await open(page);
  // The start page asks what to do, and explains both choices.
  await expect(page.locator("#taskLanding")).toBeVisible();
  await expect(page.locator("#taskLanding h1")).toHaveText("What would you like to do?");
  await expect(page.locator("#taskLanding .task-choice")).toHaveCount(2);
  // The covered workspace must not remain available to keyboard or assistive technology.
  await expect(page.locator(".dag-shell")).toBeHidden();
  await expect(page.locator("#taskLanding .task-choice").nth(0)).toContainText("Find threats to inference");
  await expect(page.locator("#taskLanding .task-choice").nth(1)).toContainText("Explore a variable");
  await expect(page.locator("#taskLanding .task-choice-example")).toHaveCount(2);
  await expect(page.locator("#taskReset")).toBeHidden();
  await expect(page.locator("#exploreView")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("causes_of")).toBeNull();

  // Exploring opens the picker for its variable.
  await page.locator("#taskLanding .task-choice[data-task=explore]").click();
  await expect(page.locator("#taskLanding")).toBeHidden();
  await expect(page.locator(".dag-shell")).toBeVisible();
  await expect(page.locator("#taskMenuValue")).toHaveText("Exploration");
  await expect(page.locator("#focusInput")).toHaveValue("");
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#focusInput")).toHaveAttribute("placeholder", "Search variable or underlying concept");
  await expect(pick(page, "category-sleep")).toContainText("sleep");
  await page.locator("#focusInput").fill("zzzzzzunmatched");
  await expect(page.locator("#focusGroupPicker")).toContainText(/No match(es found yet|ing variables)/);
  await page.locator('#focusGroupPicker button[data-clear-focus-search]').click();
  await expect(page.locator("#focusInput")).toHaveValue("");
  await page.locator("#focusInput").fill("sleep");
  await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready");
  await expect(pick(page, "category-age")).toHaveAttribute("aria-label", /matches .*sleep/i);
  await expect(page.locator("#exploreGraphHint")).toBeVisible();
  await pick(page, "category-sleep").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();

  // The chosen variable stays in the Variable field; the old anchor bar is not shown.
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator("#anchorBar")).toBeHidden();
  await expect(page.locator("#focusInputLabel")).toHaveText("Variable");
  await expect(page.locator("#focusSearchBlock")).toHaveClass(/is-selected/);
  await expect(page.locator("#identifyBrowserIntro")).toHaveText("Variables on map");
  await expect(page.locator("#exploreResults .explore-group")).toHaveCount(1);
  await expect(page.locator("#exploreResults input[type=checkbox]")).toHaveCount(0);
  await expect(page.locator("#variableReviewTools .list-filter")).toBeVisible();
  await page.locator("#editVariableSchema").click();
  await expect(page.locator("#customVariablesView")).toBeVisible();
  await page.locator("#customVariablesClose").click();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
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
  await expect(page.locator("#exploreDirection button[data-direction=causes]")).toHaveAttribute("aria-pressed", "true");

  // Saved exclusions from the old checkbox UI must not silently hide branches.
  await page.evaluate(() => {
    window.__dagBuilderState.explore.causes.excluded = [...document.querySelectorAll("#exploreResults .explore-row")]
      .map(row => row.dataset.groupId);
  });
  await chooseDirection(page, "consequences");
  await chooseDirection(page, "causes");
  expect(await renderedEdges(page)).toBe(direct);

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
  // Evidence replaces the map, the list stays, and Back to map restores the graph.
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#dagNetwork")).toBeHidden();
  await expect(page.locator("#closeEvidencePane")).toHaveText("Back to map", { useInnerText: true });
  await page.locator("#closeEvidencePane").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();
  await expect(page.locator("#provenancePanel")).toBeHidden();

  // Distance and minimum papers live in the list's funnel menu; the graph header has no Filters menu.
  await expect(page.locator(".dag-ws-controls > .filter-dropdown")).toBeHidden();
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-search").fill("no matching variable here");
  await expect(page.locator("#exploreResults .explore-row:visible")).toHaveCount(0);
  await expect(page.locator("#exploreResults .list-filter-empty")).toBeVisible();
  await page.locator(".list-filter-clear").click();
  await expect(page.locator("#exploreResults .explore-row:visible")).toHaveCount(direct);
  await page.locator(".list-filter-distance").fill("2");
  await expect(page.locator('.explore-row[data-distance="2"]').first()).toBeVisible();
  await expect(page.locator('.explore-row[data-distance="2"] .explore-row-path').first()).toContainText("via ");
  const withTwoSteps = await page.locator(".explore-row").count();
  expect(await renderedEdges(page)).toBe(withTwoSteps);
  await page.locator(".list-filter-papers").fill("10");
  await expect.poll(() => page.locator(".explore-row").count()).toBeLessThan(withTwoSteps);
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_min_papers")).toBe("10");
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_depth")).toBe("2");

  // Flipping to Consequences keeps the variable and the list settings; Identify is untouched underneath.
  await chooseDirection(page, "consequences");
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect(page.locator("#exploreSummary")).toBeHidden();
  await expect(page.locator(".list-filter-distance")).toHaveValue("2");
  await chooseTask(page, "identify");
  await expect(page.locator("#identifyFields")).toBeVisible();
  await expect(page.locator("#confounderPathLength")).toHaveValue("1");
  await chooseTask(page, "causes");
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator("#confounderPathLength")).toHaveValue("2");
  await expect(page.locator("#minimumEdgePapers")).toHaveValue("10");

  // Clicking the field reopens the picker; Cancel keeps the current variable.
  await page.locator("#focusInput").click();
  await expect(page.locator("#focusGroupPicker")).toBeVisible();
  await expect(page.locator("#focusPickerCancel")).toBeVisible();
  await page.locator("#focusPickerCancel").click();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await expect(page.locator("#exploreResultsBlock")).toBeVisible();

  // Choosing a different variable is done the same way.
  const target = "category-age";
  await page.locator("#focusInput").click();
  await pick(page, target).click();
  await expect(page.locator("#focusInput")).toHaveValue("age");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.explore.causes.focusId)).toBe(target);

  // The address carries the new variable before we reload, or the reload would restore the old one.
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_of")).toBe(target);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#confounderPathLength")).toHaveValue("2");
  await expect(page.locator("#minimumEdgePapers")).toHaveValue("10");
  expect(await page.evaluate(() => window.__dagBuilderState.explore.causes.focusId)).toBe(target);
});

test("the start page opens Threats to inference from the keyboard, is skipped by task links, and a reload stays in the task", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  await expect(page.locator("#taskLanding .task-choice[data-task=identify]")).toContainText("Find threats to inference");
  // Both choices can be reached and chosen without a mouse.
  await page.locator("#taskLanding .task-choice[data-task=identify]").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#taskLanding .task-choice[data-task=explore]")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#taskLanding")).toBeHidden();
  await expect(page.locator("#taskMenuValue")).toHaveText("Threats to inference");
  await expect(page.locator("#identifyFields")).toBeVisible();
  await expect(page.locator("#identify-iv-input")).toHaveValue("");
  expect(await page.evaluate(() => window.__dagBuilderState.task)).toBe("identify");
  // The choice is in the address, so a reload goes back into it rather than to the start page.
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe("identify");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#taskLanding")).toBeHidden();
  await expect(page.locator("#identifyFields")).toBeVisible();
  // A link that names a task skips the start page.
  await page.goto(`${viewer}?task=causes`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#taskLanding")).toBeHidden();
  await expect(page.locator("#exploreView")).toBeVisible();
});

test("the graph puts the chosen variable in the middle with its causes and consequences around it", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  await page.locator(".explore-row").first().waitFor();
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-distance").fill("2");
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
  await chooseTask(page, "identify");
  await expect(page.locator("#closeEvidencePane")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBeNull();
  await chooseTask(page, "causes");
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
});

test("Reset warns and offers to continue, open a new tab, or reset this tab", async ({ page, context }) => {
  await open(page, `${viewer}?task=causes`);
  await expect(page.locator("#exploreView")).toBeVisible();
  await pick(page, "category-sleep").click();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");

  await page.locator("#taskReset").click();
  const dialog = page.locator("#resetDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button")).toHaveText([
    "Continue working on this project", "Open new project in a new tab", "Reset in current tab"]);
  await dialog.getByRole("button", { name: "Continue working on this project" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");

  await page.locator("#taskReset").click();
  const [tab] = await Promise.all([context.waitForEvent("page"),
    dialog.getByRole("button", { name: "Open new project in a new tab" }).click()]);
  await tab.waitForLoadState("domcontentloaded");
  const fresh = new URL(tab.url());
  expect([...fresh.searchParams.keys()].filter(key => !["schema", "data_version"].includes(key))).toEqual([]);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
  await tab.close();

  await page.locator("#taskReset").click();
  await dialog.getByRole("button", { name: "Reset in current tab" }).click();
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#taskLanding")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("causes_of")).toBeNull();
  await chooseTask(page, "causes");
  await expect(page.locator("#focusSearchBlock")).toBeVisible();
});

test("mobile reset keeps the previous project after navigating", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    // A slow phone reaches Reset before start-up has finished; the reset must wait for it, not fail.
    await page.context().newCDPSession(page).then(cdp => cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 }));
    await open(page, `${viewer}?task=causes`);
    await pick(page, "category-sleep").tap();
    await openNav(page, { tap: true });
    await page.locator("#taskReset").tap();
    await page.locator("#resetHere").tap();
    await expect(page.locator("#taskLanding")).toBeVisible({ timeout: 60000 });
    await expect(page.locator("#resetError")).toBeHidden();
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
      tabs: document.getElementById("taskBar").scrollWidth - document.getElementById("taskBar").clientWidth }));
    expect(sizes.page).toBeLessThanOrEqual(375);
    expect(sizes.tabs).toBe(0);
    await expect(page.locator(".mobile-panel-nav .mobile-panel-tab:visible")).toHaveText(["Variables view", "Map view"]);
    await page.locator(".explore-row .explore-row-open").first().tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await expect(page.locator("#provenancePanel")).toBeVisible();
    await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').tap();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    await chooseTask(page, "identify", { tap: true });
    await expect(page.locator("#identifyFields")).toBeVisible();
    // Identification names its tabs the same way as Exploration.
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="controls"]')).toHaveText("Variables view");
    await expect(page.locator('.mobile-panel-nav [data-mobile-panel="dag"]')).toHaveText("Map view");
  } finally {
    await context.close();
  }
});

test("on a phone Exploration opens its picker first, keeps its variable when flipped, and Identify returns to setup", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await expect(page.locator("#focusSearchBlock")).toBeVisible();
    await pick(page, "category-sleep").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await expect(page.locator("#dagWorkspaceSection")).toBeVisible();

    // Flipping the direction keeps the variable, so the map stays in view.
    await chooseDirection(page, "consequences", { tap: true });
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "dag");
    await expect(page.locator("#dagWorkspaceSection")).toBeVisible();
    await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').tap();
    await expect(page.locator("#focusInput")).toHaveValue("sleep");

    await chooseTask(page, "identify", { tap: true });
    await expect(page.locator("#identifyFields")).toBeVisible();
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

test("mobile home stays on one document while evidence warms in the background", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-home-loads",
      String(Number(sessionStorage.getItem("echo-home-loads") || 0) + 1)));
    await open(page);
    await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated);
    await expect(page.locator("#taskLanding")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.evaluate(() => sessionStorage.getItem("echo-home-loads"))).toBe("1");
    await page.waitForFunction(() => performance.getEntriesByName("echo:evidence:engine").length > 0);
    expect(new URL(page.url()).pathname).toBe("/");
    expect(await page.evaluate(() => sessionStorage.getItem("echo-home-loads"))).toBe("1");
    await expect(page.locator("#startupLoading")).toBeHidden();
    await expect(page.locator("#taskLanding")).toBeVisible();
    await chooseTask(page, "causes", { tap: true });
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
  await chooseTask(page, "causes");
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
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-distance").fill("2");
  await page.locator(".list-filter-distance").fill("1");
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
  await page.evaluate(() => {
    const original = window.vis.Network.prototype.fit;
    window.vis.Network.prototype.fit = function (...args) {
      const result = original.apply(this, args);
      window.__emptyResultNetwork = this;
      return result;
    };
  });
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-papers").fill("99999");
  await expect(page.locator(".explore-row")).toHaveCount(0);
  await expect(page.locator("#exploreSummary")).toBeVisible();
  await expect(page.locator("#exploreSummary")).toContainText("No causes of sleep were found at this distance and paper count");
  await expect.poll(() => page.evaluate(() => window.__emptyResultNetwork?.getScale() ?? Infinity)).toBeLessThanOrEqual(2.5);
  await page.locator(".list-filter-papers").fill("2");
  await expect(page.locator(".explore-row").first()).toBeVisible();
  await expect(page.locator("#exploreSummary")).toBeHidden();
});

test("every view can show the same variables and links as a table, with the same controls", async ({ page }) => {
  await open(page, `${viewer}?task=causes`);
  await pick(page, "category-sleep").click();
  const direct = await renderedEdges(page);
  await expect(page.locator(".dag-view-switch")).toBeVisible();
  await expect(page.locator("#dagViewGraph")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".dag-overlay-controls #copyPermalink")).toBeVisible();

  await page.locator("#dagViewTable").click();
  await expect(page.locator("#dagTable")).toBeVisible();
  await expect(page.locator("#dagNetwork")).toBeHidden();
  await expect(page.locator("#dagViewTable")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => new URL(page.url()).searchParams.get("dag_view")).toBe("table");
  // One list of variables, with the same links the graph drew.
  await expect(page.locator("#dagPathsTable caption")).toContainText("Causes of sleep");
  await expect(page.locator("#dagPathsTable tbody tr.dag-table-section")).toHaveCount(1);
  await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)")).toHaveCount(direct);
  // The filters stay where they were, and drive the table.
  await expect(page.locator(".list-filter > summary")).toBeVisible();
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-papers").fill("20");
  await expect.poll(() => page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").count()).toBeLessThan(direct);
  await page.locator(".list-filter-papers").fill("2");
  await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)")).toHaveCount(direct);

  // Definitions and evidence open from the table as they do from the graph.
  // Each row is a variable; its link opens the evidence for that link.
  const arrow = page.locator("#dagPathsTable .dag-table-link[data-edge-id]").first();
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Variable", "Link", "Papers", "Concepts"]);
  await expect(page.locator("#dagPathsTable").getByText("Evidence", { exact: true })).toHaveCount(0);
  const edgeId = await arrow.getAttribute("data-edge-id");
  await arrow.click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  await expect(page.locator("#edgeInspector")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
  await expect(page.locator(`#dagPathsTable .dag-table-link[data-edge-id="${edgeId}"]`)).toHaveAttribute("aria-pressed", "true");
  await page.locator("#closeEvidencePane").click();
  await page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").nth(1).getByRole("button").first().click();
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await expect(page.locator("#dagViewTable")).toBeVisible();
  await page.locator("#dagViewTable").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dagTable")).toBeVisible();
  await expect(page.locator("#dagViewTable")).toBeFocused();
  await page.locator("#dagPathsTable thead button").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dagPathsTable thead th[aria-sort=ascending], #dagPathsTable thead th[aria-sort=descending]")).toHaveCount(1);
  await expect(page.locator("#dagPathsTable thead button").first()).toBeFocused();
  // Identify shows each confounder with its path to the cause and its path to the outcome, and a status to set.
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Variable", "Path to cause", "Path to outcome", /^Papers/, "Concepts", "Status"]);
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
  await chooseTask(page, "consequences");
  await expect(page.locator("#focusInput")).toHaveValue("sleep");
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
    // The Graph and Table switch is in the top bar's menu and fits inside the screen.
    await openNav(page, { tap: true });
    const box = await page.locator(".dag-view-switch").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    await page.locator("#dagViewTable").tap();
    await closeNav(page, { tap: true });
    await expect(page.locator("#dagTable")).toBeVisible();
    await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").first()).toBeVisible();
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
      table: document.getElementById("dagTable").scrollWidth - document.getElementById("dagTable").clientWidth }));
    expect(overflow.page).toBeLessThanOrEqual(375);
    expect(overflow.table).toBe(0);
    // Every evidence button is on screen, and the table scrolls rather than the page.
    const rowButtons = page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").first().getByRole("button");
    for (let index = 0, count = await rowButtons.count(); index < count; index++) {
      // Looked up afresh: a late data load may rebuild the table between buttons.
      await expect(rowButtons.nth(index)).toBeVisible();
      const rect = await rowButtons.nth(index).boundingBox();
      expect(rect.x + rect.width).toBeLessThanOrEqual(375);
      expect(rect.height).toBeGreaterThanOrEqual(24); // WCAG 2.2 minimum target size
    }
    // Explore's filters sit in the variable list's funnel menu, one tab over.
    await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').tap();
    await page.locator(".list-filter > summary").tap();
    await expect(page.locator(".list-filter-papers")).toBeVisible();
    await page.locator(".list-filter-papers").fill("20");
    await expect.poll(() => page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").count()).toBeLessThan(10);
    await page.locator(".list-filter-papers").fill("2");
    await page.locator(".list-filter > summary").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    const arrow = page.locator("#dagPathsTable .dag-table-link[data-edge-id]").first();
    const edgeId = await arrow.getAttribute("data-edge-id");
    await arrow.tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await expect(page.locator("#provenancePanel")).toBeVisible();
    expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
    await page.locator("#closeEvidencePane").tap();
    // A variable's definition opens from the table too.
    await page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").nth(1).getByRole("button").first().tap();
    await expect(page.locator("#closeEvidencePane")).toBeVisible();
    await page.locator("#closeEvidencePane").tap();
    await openNav(page, { tap: true });
    await page.locator("#dagViewGraph").tap();
    await closeNav(page, { tap: true });
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
  await page.locator(".list-filter > summary").click();
  await page.locator(".list-filter-papers").fill("1");
  await page.locator(".list-filter-distance").fill("4");
  await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").first()).toBeVisible();
  const { rendered, total } = await page.evaluate(() => ({
    rendered: document.querySelectorAll("#dagPathsTable tbody tr:not(.dag-table-section)").length,
    total: Number(document.querySelector("#dagPathsTable").dataset.pathCount) }));
  expect(rendered).toBeLessThanOrEqual(200);
  expect(rendered).toBe(Math.min(total, 200));
  if (total > 200) {
    await page.locator(".dag-table-more button").first().click();
    await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)")).toHaveCount(Math.min(total, 400));
  }
});

test("in Identify each row is a confounder with its paths, a status, and links that open evidence", async ({ page }) => {
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await expect(page.locator("#diagnosticOverlapKey")).toBeVisible();
  await page.locator("#dagViewTable").click();
  await expect(page.locator("#diagnosticOverlapKey")).toBeHidden();
  await expect(page.locator("#dagPathsTable thead th")).toHaveText(["Variable", "Path to cause", "Path to outcome", "Papers", "Concepts", "Status"]);
  // One row per confounder, in one section, each with its shortest path to the cause and to the outcome.
  const rows = page.locator("#dagPathsTable tbody tr:not(.dag-table-section)");
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(page.locator("#dagPathsTable tbody tr.dag-table-section")).toHaveCount(1);
  const row = rows.first();
  const causeLinks = row.locator("td.dag-table-routes").nth(0).locator(".dag-table-link[data-edge-id]");
  const outcomeLinks = row.locator("td.dag-table-routes").nth(1).locator(".dag-table-link[data-edge-id]");
  expect(await causeLinks.count() + await outcomeLinks.count()).toBeGreaterThan(0);
  // Further paths sit behind "+N more", and the toggle shows and hides them.
  const more = page.locator("#dagPathsTable .dag-table-more-routes").first();
  if (await more.count()) {
    const before = await more.locator("xpath=ancestor::td").locator(".dag-table-route").count();
    await more.click();
    expect(await page.locator("#dagPathsTable .dag-table-more-routes[aria-expanded=true]").first()
      .locator("xpath=ancestor::td").locator(".dag-table-route").count()).toBeGreaterThan(before);
    await page.locator("#dagPathsTable .dag-table-more-routes[aria-expanded=true]").first().click();
  }
  // A status is chosen from a menu in the row.
  const status = row.locator("select.dag-table-status");
  await expect(status).toHaveValue("unaddressed");
  const options = await status.locator("option").evaluateAll(list => list.map(option => option.value));
  expect(options.length).toBeGreaterThan(1);
  await status.selectOption(options.find(value => value !== "unaddressed" && value !== "other"));
  await expect(status).not.toHaveValue("unaddressed");
  // The links are the only way into evidence: there is no separate column.
  await expect(page.locator("#dagPathsTable").getByText("Evidence", { exact: true })).toHaveCount(0);
  const arrow = (await causeLinks.count() ? causeLinks : outcomeLinks).first();
  const edgeId = await arrow.getAttribute("data-edge-id");
  await arrow.click();
  await expect(page.locator("#provenancePanel")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.selectedEdgeId)).toBe(edgeId);
  await expect(page.locator(`#dagPathsTable .dag-table-link[data-edge-id="${edgeId}"]`).first()).toHaveAttribute("aria-pressed", "true");
  // The view switches are hidden while evidence is open; closing it brings them back, and switching restores the graph.
  await page.locator("#closeEvidencePane").click();
  await page.locator("#dagViewGraph").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();
  await expect(page.locator("#diagnosticOverlapKey")).toBeVisible();
  // The study arrow must not carry over when the same schema is explored from one focal variable.
  for (const [task, focus] of [["causes", "category-sleep"], ["consequences", "category-income-earnings"]]) {
    await chooseTask(page, task);
    await chooseFocus(page, focus);
    await page.locator("#dagViewGraph").click();
    expect(await renderedEdges(page)).toBeGreaterThan(0);
    const hasStudyArrow = await page.evaluate(async () => {
      const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
      return api.renderedDagEdgeIds().includes("__study_design_iv_to_dv__");
    });
    expect(hasStudyArrow).toBe(false);
    await page.locator("#dagViewTable").click();
    await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").first()).toBeVisible();
    await expect(page.locator("#dagStudyTable")).toHaveCount(0);
  }
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await page.locator("details.filter-dropdown:visible > summary").click();
  const drawnLinks = () => page.evaluate(async () => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    await api.whenDagRendered();
    return window.__dagBuilderState.visibleLinks.filter(link => !link.is_target_relation).map(link => link.edge_id).sort();
  });
  const tabled = () => page.evaluate(() => [...document.querySelectorAll("#dagPathsTable :is(.dag-table-arrow, .dag-table-link)[data-edge-id], #dagOtherLinksTable :is(.dag-table-arrow, .dag-table-link)[data-edge-id]")]
    .map(arrow => arrow.dataset.edgeId).filter((id, index, all) => all.indexOf(id) === index).sort());
  // Showing only path links, every drawn link is on some path.
  const pathOnly = page.locator("#toggleIrrelevantConfounderLinks");
  if ((await pathOnly.getAttribute("aria-pressed")) !== "true") await pathOnly.click();
  await page.locator("#dagViewTable").click();
  await expect(page.locator("#dagPathsTable tbody tr:not(.dag-table-section)").first()).toBeVisible();
  // The table is built a screenful at a time, so wait for the last rows.
  const drawnNow = await drawnLinks();
  await expect.poll(tabled).toEqual(drawnNow);
  await expect(page.locator("#dagOtherLinksTable")).toHaveCount(0);
  // With "Path links only" off the graph also draws links no confounder path uses; the table lists them after the paths.
  // Choosing the Table view closed the Filters dropdown; reopen it for the toggle.
  if (!(await page.locator("details.filter-dropdown:visible").evaluate(element => element.open))) await page.locator("details.filter-dropdown:visible > summary").click();
  await pathOnly.click();
  await expect(pathOnly).toHaveAttribute("aria-pressed", "false");
  const all = await drawnLinks();
  await expect(page.locator("#dagOtherLinksTable")).toBeVisible();
  // Every drawn link is either on a listed path or in the other-links table (shown 200 at a time).
  const onPaths = await page.evaluate(() => new Set([...document.querySelectorAll("#dagPathsTable :is(.dag-table-arrow, .dag-table-link)[data-edge-id]")]
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

test("on a phone, Identify opens on its fields even when another view was left on its Graph tab", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=causes`);
    await pick(page, "category-sleep").tap();
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await expect(page.locator("#dagNetwork")).toBeVisible();
    await chooseTask(page, "identify", { tap: true });
    // Not a blank screen: the Cause field is shown, and choosing Identification again changes nothing.
    await expect(page.locator("#identify-iv-input")).toBeVisible();
    await expect(page.locator("body")).toHaveAttribute("data-mobile-panel", "controls");
    await chooseTask(page, "identify", { tap: true });
    await expect(page.locator("#identify-iv-input")).toBeVisible();
    // The same from Consequences, and the other views still open on their own panels afterwards.
    await chooseTask(page, "consequences", { tap: true });
    await chooseFocus(page, "category-income-earnings", { tap: true });
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await chooseTask(page, "identify", { tap: true });
    await expect(page.locator("#identify-iv-input")).toBeVisible();
    await chooseTask(page, "causes", { tap: true });
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

test.describe("mobile Identify picker dismissal", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const staleOutcome of [false, true]) test(`cancels an unconfigured outcome and reopens it (stale ID: ${staleOutcome})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`);
    await page.waitForFunction(() => window.__dagBuilderState.publishedSchemaHydrated);
    const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
      .filter(group => group.variable_ids?.length).slice(0, 2)
      .map(group => ({ id: group.group_id, label: group.label })));
    await chooseAnchor(page, "iv", anchors[0].id, { tap: true });
    // A saved role can reference a group no longer present in this schema.
    if (staleOutcome) {
      await page.evaluate(() => { window.__dagBuilderState.project.dv_group_id = "missing-outcome"; });
      await page.locator("#identify-dv-input").tap();
    }
    const picker = page.locator("#identifyGroupPicker");
    await expect(picker).toBeVisible();
    await expect(picker).toContainText("Choose outcome");
    const before = await page.evaluate(() => ({ iv: window.__dagBuilderState.project.iv_group_id,
      dv: window.__dagBuilderState.project.dv_group_id }));
    await picker.getByRole("button", { name: "Cancel", exact: true }).tap();
    await expect(picker).toBeHidden();
    await expect(page.locator("#identify-dv-input")).toHaveValue("");
    expect(await page.evaluate(() => ({ iv: window.__dagBuilderState.project.iv_group_id,
      dv: window.__dagBuilderState.project.dv_group_id }))).toEqual(before);

    // Focusing the empty field explicitly opens it again; Escape closes it even
    // though the outcome still needs to be chosen. A later render stays closed.
    await page.locator("#identify-dv-input").tap();
    await expect(picker).toBeVisible();
    await page.locator("#identify-dv-input").fill("sleep");
    await page.locator("#identify-dv-input").press("Escape");
    await expect(picker).toBeHidden();
    await expect(page.locator("#identify-dv-input")).toHaveValue("");
    await page.setViewportSize({ width: 400, height: 844 });
    await expect(picker).toBeHidden();
    await chooseAnchor(page, "dv", anchors[1].id, { tap: true });
    await expect(page.locator("#identify-dv-input")).toHaveValue(anchors[1].label);
  });
});


test("mobile save status wraps instead of truncating", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page);
    const status = page.locator("#localSaveStatus");
    await status.evaluate(el => { el.textContent = "Previous view not saved — Could not save this view because the browser storage is unavailable."; });
    await expect(status).toBeVisible();
    const dimensions = await status.evaluate(el => ({ height: el.clientHeight, lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      width: el.clientWidth, scrollWidth: el.scrollWidth, whiteSpace: getComputedStyle(el).whiteSpace }));
    expect(dimensions.whiteSpace).toBe("normal");
    expect(dimensions.height).toBeGreaterThan(dimensions.lineHeight);
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  } finally { await context.close(); }
});
