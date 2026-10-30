const { test, expect } = require("playwright/test");

const viewer = "http://127.0.0.1:8767/";

async function open(page, url = viewer) {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
}

test("the start page leads to causes and consequences views that keep their own state", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  await expect(page.locator("#taskLanding h1")).toHaveText("What do you want to do?");
  await expect(page.locator("#taskLanding .task-choice")).toHaveCount(3);
  await expect(page.locator("#taskReset")).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe("home");

  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#exploreTitle")).toHaveText("Causes of a variable");
  await expect(page.locator("#taskReset")).toBeVisible();
  await expect(page.locator("#explorePicker")).toBeVisible();
  await page.locator('.explore-pick[data-group-id="category-sleep"]').click();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("sleep");
  await expect(page.locator("#exploreSummary")).toContainText("cause sleep within 1 step");
  const direct = await page.locator('.explore-row[data-distance="1"]').count();
  expect(direct).toBeGreaterThan(0);
  await expect(page.locator('.explore-row[data-distance="2"]')).toHaveCount(0);

  await page.locator('#exploreDepth button[data-depth="2"]').click();
  await expect(page.locator('.explore-row[data-distance="2"]').first()).toBeVisible();
  await expect(page.locator('.explore-row[data-distance="2"] .explore-row-path').first()).toContainText("via ");
  const withTwoSteps = await page.locator(".explore-row").count();
  await page.locator("#exploreMinPapers").selectOption("10");
  expect(await page.locator(".explore-row").count()).toBeLessThan(withTwoSteps);
  await expect.poll(() => new URL(page.url()).searchParams.get("causes_min_papers")).toBe("10");

  // Consequences keep a separate focus; identification is untouched underneath.
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await expect(page.locator("#exploreTitle")).toHaveText("Consequences of a variable");
  await expect(page.locator("#explorePicker")).toBeVisible();
  await page.locator('.explore-pick[data-group-id="category-income-earnings"]').click();
  await expect(page.locator("#exploreSummary")).toContainText("are caused by income/earnings");
  await page.locator("#taskBar .task-tab[data-task=identify]").click();
  await expect(page.locator("#exploreView")).toBeHidden();
  await expect(page.locator("#setupSection")).toBeVisible();
  await page.locator("#taskBar .task-tab[data-task=causes]").click();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("sleep");
  await expect(page.locator('#exploreDepth button[data-depth="2"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#exploreMinPapers")).toHaveValue("10");

  // Clicking a result explores that variable instead.
  const first = page.locator(".explore-row").first();
  const label = await first.locator(".explore-row-label").textContent();
  const groupId = await first.getAttribute("data-group-id");
  await first.locator(".explore-row-label").click();
  await expect(page.locator("#exploreFocusLabel")).toHaveText(label);

  await expect.poll(() => new URL(page.url()).searchParams.get("causes_of")).toBe(groupId);
  expect(new URL(page.url()).searchParams.get("effects_of")).toBe("category-income-earnings");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#exploreView")).toBeVisible();
  await expect(page.locator("#exploreFocusLabel")).toHaveText(label);
  await page.locator("#taskBar .task-tab[data-task=consequences]").click();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("income/earnings");
});

test("Reset warns and offers to continue, open a new tab, or reset this tab", async ({ page, context }) => {
  await open(page, `${viewer}?task=causes`);
  await expect(page.locator("#exploreView")).toBeVisible();
  await page.locator('.explore-pick[data-group-id="category-sleep"]').click();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("sleep");

  await page.locator("#taskReset").click();
  const dialog = page.locator("#resetDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button")).toHaveText([
    "Continue working on this project", "Open new project in a new tab", "Reset in current tab"]);
  await dialog.getByRole("button", { name: "Continue working on this project" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("sleep");

  await page.locator("#taskReset").click();
  const [tab] = await Promise.all([context.waitForEvent("page"),
    dialog.getByRole("button", { name: "Open new project in a new tab" }).click()]);
  await tab.waitForLoadState("domcontentloaded");
  const fresh = new URL(tab.url());
  expect([...fresh.searchParams.keys()].filter(key => !["schema", "data_version"].includes(key))).toEqual([]);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#exploreFocusLabel")).toHaveText("sleep");
  await tab.close();

  await page.locator("#taskReset").click();
  await dialog.getByRole("button", { name: "Reset in current tab" }).click();
  await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
    && document.getElementById("startupLoading")?.hidden);
  await expect(page.locator("#taskLanding")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("causes_of")).toBeNull();
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await expect(page.locator("#explorePicker")).toBeVisible();
});

test("on a phone the task bar fits and the views stay within the screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await open(page, `${viewer}?task=consequences`);
    await page.locator('.explore-pick[data-group-id="category-sleep"]').tap();
    await expect(page.locator(".explore-row").first()).toBeVisible();
    const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
      tabs: document.querySelector(".task-tabs").scrollWidth - document.querySelector(".task-tabs").clientWidth }));
    expect(sizes.page).toBeLessThanOrEqual(375);
    expect(sizes.tabs).toBe(0);
    await expect(page.locator(".mobile-panel-nav")).toBeHidden();
    await page.locator("#taskBar .task-tab[data-task=identify]").tap();
    await expect(page.locator(".mobile-panel-nav")).toBeHidden(); // initial setup hides it until anchors are chosen
    await expect(page.locator("#setupSection")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the start page preloads the search catalog, then paper support", async ({ page }) => {
  await open(page);
  await expect(page.locator("#taskLanding")).toBeVisible();
  // Nothing has opened a task or a search, yet both arrive in the background.
  await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready"
    && performance.getEntriesByName("echo:evidence:engine").length
    && window.__dagBuilderState.edgeSupportById.size > 1000, null, { timeout: 90000 });
  await page.locator("#taskLanding .task-choice[data-task=causes]").click();
  await page.locator('.explore-pick[data-group-id="category-sleep"]').click();
  // No "Counting the papers…" wait once support is preloaded.
  await expect(page.locator(".explore-row").first()).toBeVisible({ timeout: 1000 });
});
