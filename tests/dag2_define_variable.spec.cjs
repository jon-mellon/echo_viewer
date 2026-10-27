const { test, expect } = require("playwright/test");
const { watchBrowserErrors } = require("./browser_errors.cjs");

test("DAG2 defines a canonical variable from per-source residual slices", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page, { warnings: true });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);

  await expect(page.locator("#ivGroupPicker [data-define-side=iv]")).toBeVisible();
  await page.locator("#ivGroupPicker [data-define-side=iv]").click();
  await expect(page.locator("#definitionMethodStep")).toBeVisible();
  await expect(page.locator("#definitionChooseBrowse")).toBeVisible();
  await expect(page.locator("#definitionSourcesStep")).toBeHidden();
  await page.locator("#definitionChooseBrowse").click();
  await expect(page.locator("#definitionBrowsePanel")).toBeVisible();
  await expect(page.locator("#definitionBrowseStatus")).toContainText("Choose a source category");
  await page.locator("#definitionChangeMethod").click();
  await page.locator("#definitionChooseManual").click();
  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  await expect(page.locator("#dagWorkspaceSection")).toBeVisible();

  const usable = page.locator("#definitionSourceList input[data-source-id]");
  await expect(usable.nth(1)).toBeVisible();
  await usable.nth(0).check();
  await usable.nth(1).check();
  const sourceIds = await usable.evaluateAll(inputs => inputs.filter(input => input.checked).map(input => input.dataset.sourceId));
  const originals = await page.evaluate(sourceIds => sourceIds.map(id => {
    const group = window.__dagBuilderState.project.groups.find(candidate => candidate.group_id === id);
    return { group_id: id, label: group.label, variable_ids: [...group.variable_ids] };
  }), sourceIds);
  await page.locator("#definitionContinue").click();
  await expect(page.locator("body"), browserErrors.errors.join("\n")).toHaveClass(/defining-variable/);
  await page.locator("#definitionMethodManual").click();
  await expect(page.locator("#dagMapCanvas")).toBeVisible();
  await expect(page.locator("#dagWorkspaceSection")).toBeHidden();
  await expect.poll(() => page.locator("#dagMapCanvas").evaluate(canvas => canvas.width)).toBeGreaterThan(100);
  await expect.poll(() => page.locator("#dagMapCanvas").evaluate(canvas => canvas.height)).toBeGreaterThan(100);
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids
    .filter(id => {
      const variable = window.__dagBuilderState.variableById.get(id);
      return variable && Number.isFinite(variable.map_x) && Number.isFinite(variable.map_y);
    }).length)).toBeGreaterThan(0);

  const canonicalId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(canonicalId);
  await expect(page.locator("#definitionVariableResults .result-button").first()).toBeVisible();
  await page.locator("#definitionVariableResults .result-button").first().click();
  await expect(page.locator("#definitionSelectedVariables .definition-selected-variable")).toHaveCount(1);
  await expect(page.locator("#definitionVariableResults .result-button")).toHaveCount(0);
  await expect(page.locator("#definitionReview")).toBeEnabled();
  await page.locator("#definitionReview").click();
  await expect(page.locator("#definitionReviewVariables .definition-review-variable")).toHaveCount(1);

  await page.locator("#definitionNewLabel").fill("Browser test construct");
  await page.locator("#definitionNewDescription").evaluate(element => element.setAttribute("aria-invalid", "true"));
  await page.locator("#definitionNewDescription").fill("A browser test construct with defined source members.");
  await expect(page.locator("#definitionNewDescription")).not.toHaveAttribute("aria-invalid");
  await expect(page.locator("#definitionValidation")).toHaveText("Enter at least 20 characters for the group definition.");
  const residualInputs = page.locator("#definitionResidualLabels input[data-residual-id]");
  await expect(residualInputs).toHaveCount(2);
  await residualInputs.nth(0).fill("Browser residual one");
  await residualInputs.nth(1).fill("Browser residual two");
  await page.locator("#definitionSave").click();

  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  const result = await page.evaluate(sourceIds => {
    const state = window.__dagBuilderState;
    return {
      iv: state.project.groups.find(group => group.group_id === state.project.iv_group_id),
      residuals: sourceIds.map(id => state.project.groups.find(group => group.group_id === id)),
      history: state.undoHistory.length,
      draft: state.definitionDraft,
    };
  }, sourceIds);
  expect(result.iv.label).toBe("Browser test construct");
  expect(result.iv.variable_ids.length).toBeGreaterThan(0);
  expect(result.residuals.map(group => group.group_id)).toEqual(sourceIds);
  expect(result.residuals.every(group => group.variable_ids.length > 0)).toBe(true);
  expect(result.history).toBeGreaterThan(0);
  expect(result.draft).toBeNull();
  const splitGroupId = result.iv.group_id;

  await expect(page.locator("#editSplitIv")).toBeVisible();
  await page.locator("#editSplitIv").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit split");
  await page.locator("#definitionSelectedVariables .definition-selected-variable").first().click();
  await page.locator("#definitionVariableSearch").fill(canonicalId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await page.locator("#definitionReview").click();
  await expect(page.locator("#definitionSave")).toHaveText("Update split");
  await page.locator("#definitionNewLabel").fill("Browser test construct updated");
  await page.locator("#definitionSave").click();
  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  expect(await page.evaluate(groupId => window.__dagBuilderState.project.groups
    .find(group => group.group_id === groupId).label, splitGroupId))
    .toBe("Browser test construct updated");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.undoHistory.length),
  { timeout: 1000 }).toBeGreaterThan(0);
  await page.locator("#dag2UndoBtn").click();
  expect(await page.evaluate(groupId => window.__dagBuilderState.project.groups
    .find(group => group.group_id === groupId).label, splitGroupId)).toBe("Browser test construct");
  await page.locator("#dag2UndoBtn").click();
  const undone = await page.evaluate(({ sourceIds, originals }) => ({
    newExists: window.__dagBuilderState.project.groups.some(group => group.label === "Browser test construct"),
    restored: sourceIds.map(id => {
      const group = window.__dagBuilderState.project.groups.find(candidate => candidate.group_id === id);
      return { group_id: id, label: group.label, variable_ids: [...group.variable_ids] };
    }),
    originals,
  }), { sourceIds, originals });
  expect(undone.newExists).toBe(false);
  expect(undone.restored).toEqual(undone.originals);
  browserErrors.check();
});

test("Variables list definition and split editing are reachable on desktop and mobile", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await expect(page.locator("#variableDefineNew")).toBeVisible();

  await page.locator("#variableDefineNew").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Define new variable");
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.role)).toBe("candidate");
  await page.locator("#definitionChooseManual").click();
  const source = page.locator("#definitionSourceList input[data-source-id]").nth(2);
  await source.check();
  await page.locator("#definitionContinue").click();
  await page.locator("#definitionMethodManual").click();
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(variableId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await page.locator("#definitionReview").click();
  await page.locator("#definitionNewLabel").fill("Browser list variable");
  await page.locator("#definitionNewDescription").fill("A browser list variable with selected source members.");
  await page.locator("#definitionResidualLabels input").fill("Browser list residual");
  await page.locator("#definitionSave").click();
  await expect(page.locator("#variableDefineNew")).toBeVisible();
  const splitId = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.label === "Browser list variable")?.group_id);
  expect(splitId).toBeTruthy();
  const splitRow = page.locator(`#variablePanelList details[data-group-id="${splitId}"]`);
  await splitRow.locator("summary").click();
  await splitRow.getByRole("button", { name: "Edit split" }).click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit split");
  await page.locator("#definitionCancel").click();

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator("#variableDefineNew")).toBeVisible();
  await page.locator("#variableDefineNew").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Define new variable");
  await page.locator("#definitionCancel").click();
  await splitRow.getByRole("button", { name: "Edit split" }).click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit split");
  await page.locator("#definitionCancel").click();
});

test("a new variable can be defined through the mobile controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('.mobile-panel-tab[data-mobile-panel="controls"]').click();
  await page.locator("#variableDefineNew").click();
  await expect(page.locator("#definitionTitle")).toBeInViewport();
  await expect(page.locator("#groupingPanel")).toBeHidden();

  await page.locator("#definitionChooseManual").click();

  const sourceRow = page.locator("#definitionSourceList .definition-source-row").nth(2);
  await sourceRow.click({ position: { x: 30, y: 20 } });
  await expect(sourceRow.locator("input")).toBeChecked();
  await expect(page.locator("#definitionContinue")).toBeInViewport();
  await page.locator("#definitionContinue").click();
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await page.locator("#definitionMethodManual").click();
  await expect(page.locator("#definitionTitle")).toBeInViewport();

  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(variableId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await page.locator("#definitionReview").click();
  await expect(page.locator("#definitionReviewStep")).toBeVisible();
  await expect(page.locator("#definitionTitle")).toBeInViewport();
  await page.locator("#definitionNewLabel").fill("Mobile browser variable");
  await page.locator("#definitionNewDescription").fill("A mobile browser variable with selected source members.");
  await page.locator("#definitionResidualLabels input").fill("Mobile browser residual");
  await page.locator("#definitionSave").click();
  await expect(page.locator("#definitionBlock")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.project.groups
    .some(group => group.label === "Mobile browser variable"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile spatial editor adds and removes a variable with a tap", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.setItem("echo-viewer-password-accepted", "yes");
    });
    await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated
      && !window.__dagBuilderState?.publishedSchemaHydrating);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseManual").click();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await page.locator("#definitionMethodManual").click();
    await page.locator('.mobile-panel-tab[data-mobile-panel="variables"]').click();
    await expect(page.locator("#dagMapCanvas")).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(() => page.locator("#dagMapLabels .map-label").count()).toBeGreaterThan(0);
    const target = await page.evaluate(() => {
      const state = window.__dagBuilderState;
      const canvas = document.querySelector("#dagMapCanvas");
      const rect = canvas.getBoundingClientRect();
      const eligible = new Set(state.definitionDraft.eligible_variable_ids);
      return (state.map._visibleClusterReps || []).filter(item => eligible.has(item.variable_id)
        && item.is_cluster_rep && Number.isFinite(item.map_x) && Number.isFinite(item.map_y))
        .map(variable => ({
          id: variable.variable_id,
          x: rect.left + variable.map_x * state.map.transform.scale + state.map.transform.tx,
          y: rect.top + variable.map_y * state.map.transform.scale + state.map.transform.ty,
        }))
        .find(point => point.x > rect.left + 30 && point.x < rect.right - 30
          && point.y > rect.top + 100 && point.y < rect.bottom - 30
          && document.elementFromPoint(point.x, point.y) === canvas) || null;
    });
    expect(target).toBeTruthy();
    await page.touchscreen.tap(target.x, target.y);
    await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(1);
    const tappedId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids[0]);
    await page.touchscreen.tap(target.x, target.y);
    await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
    const drawAroundTarget = async () => {
      await page.mouse.move(target.x - 15, target.y - 15);
      await page.mouse.down();
      await page.mouse.move(target.x + 15, target.y - 15);
      await page.mouse.move(target.x + 15, target.y + 15);
      await page.mouse.move(target.x - 15, target.y + 15);
      await page.mouse.move(target.x - 15, target.y - 15);
      await page.mouse.up();
    };
    await page.locator("#dagBrushMode").click();
    await drawAroundTarget();
    await expect.poll(() => page.evaluate(id => window.__dagBuilderState.definitionDraft.new_variable_ids.includes(id), tappedId)).toBe(true);
    await page.locator("#dagEraseMode").click();
    await drawAroundTarget();
    await expect.poll(() => page.evaluate(id => window.__dagBuilderState.definitionDraft.new_variable_ids.includes(id), tappedId)).toBe(false);
    await page.locator('.mobile-panel-tab[data-mobile-panel="controls"]').click();
    await expect(page.locator('#definitionTermChips button[data-term="unreviewed"]')).toContainText('Unreviewed ·');
    await expect(page.locator('#definitionTermItems .definition-sort-row')).toHaveCount(20);
    const firstRow = page.locator('#definitionTermItems .definition-sort-row').first();
    const firstId = await firstRow.getAttribute('data-term-variable-id');
    await firstRow.locator('button[data-side="new"]').tap();
    await expect.poll(() => page.evaluate(id => window.__dagBuilderState.definitionDraft.new_variable_ids.includes(id), firstId)).toBe(true);
    await page.locator('#definitionTermChips button[data-term="all"]').tap();
    const allFirstRow = page.locator('#definitionTermItems .definition-sort-row').first();
    const allFirstId = await allFirstRow.getAttribute('data-term-variable-id');
    await allFirstRow.locator('button[data-side="leftover"]').tap();
    await expect.poll(() => page.evaluate(id => window.__dagBuilderState.definitionDraft.new_variable_ids.includes(id), allFirstId)).toBe(false);
    await page.locator('#definitionTermNext').tap();
    await expect(page.locator('#definitionTermPage')).toHaveText('2 of 16');
    if (await page.locator('#definitionSelectedVariables .definition-selected-variable').count()) {
      await page.locator('#definitionSelectedVariables .definition-selected-variable').first().tap();
    }
    await page.locator('#definitionTermChips button[data-term="knowledge"]').click();
    const count = await page.locator('#definitionTermItems .definition-sort-row').count();
    expect(count).toBe(20);
    await page.locator('#definitionTermToNew').click();
    await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(count);
    await page.locator('#definitionUndoBatch').click();
    await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
  } finally {
    await context.close();
  }
});

for (const device of [
  { name: "mobile", context: { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true } },
  { name: "desktop", context: { viewport: { width: 1280, height: 900 } } },
]) {
  test(`${device.name} Jev split tests a fixed sample before the full run`, async ({ browser }) => {
    const context = await browser.newContext(device.context);
    const page = await context.newPage();
    let limit = 6;
    let decisions = 0;
    const batches = [];
    await page.route("https://openrouter.ai/auth?**", async route => {
      const authUrl = new URL(route.request().url());
      const callback = new URL(authUrl.searchParams.get("callback_url"));
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("state", authUrl.searchParams.get("state"));
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    });
    await page.route("https://openrouter.ai/api/**", async route => {
      const request = route.request();
      const headers = { "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (request.url().endsWith("/auth/keys")) {
        return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ key: "sk-or-test" }) });
      }
      if (request.url().endsWith("/v1/key")) {
        return route.fulfill({ headers, contentType: "application/json",
          body: JSON.stringify({ data: { limit, limit_reset: null, limit_remaining: limit } }) });
      }
      if (request.url().endsWith("/v1/model/typesafe/jev-1.13")) {
        return route.fulfill({ headers, contentType: "application/json",
          body: JSON.stringify({ data: { pricing: { prompt: "0.000000042", completion: "0", request: "0" } } }) });
      }
      if (request.url().endsWith("/alpha/decisions")) {
        decisions += 1;
        const body = request.postDataJSON();
        batches.push({ description: body.state.target_definition, records: body.state.records });
        expect(body.model).toBe("typesafe/jev-1.13");
        expect(Object.values(body.questions)[0].instructions).toContain("not a separately defined opposite concept");
        expect(Object.values(body.questions)[0].criteria.leftover).toContain("uncertain matches");
        const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id,
          { type: "choice", choice: "new", probabilities: { new: 0.9, leftover: 0.1 } }]));
        return route.fulfill({ headers, contentType: "application/json",
          body: JSON.stringify({ answers, usage: { input_tokens: 1000, output_tokens: 0 } }) });
      }
      throw new Error(`Unexpected OpenRouter request: ${request.url()}`);
    });
    try {
      await page.addInitScript(() => {
        sessionStorage.setItem("echo-viewer-password-accepted", "yes");
      });
      await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
        && window.__dagBuilderState?.publishedSchemaHydrated);
      await page.locator("#ivGroupPicker [data-define-side=iv]").click();
      await page.locator("#definitionChooseJev").click();
      await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
      await page.locator("#definitionContinue").click();
      await expect(page.locator("#definitionPartitionStep")).toBeVisible();
      await expect(page.locator("#definitionJevPanel")).toBeVisible();
      await expect(page.locator("#definitionManualPanel")).toBeHidden();
      await page.locator("#definitionAiDescription").fill("School based measures of academic achievement");
      await page.locator("#definitionAiConnect").click();
      await expect(page.locator("#definitionPartitionStep")).toBeVisible();
      await expect(page.locator("#definitionAiDescription")).toHaveValue("School based measures of academic achievement");
      await expect(page.locator("#definitionAiStatus")).toContainText("Lower its limit to $5");
      await expect(page.locator("#definitionAiRun")).toBeDisabled();
      limit = 5;
      await page.locator("#definitionAiRecheck").click();
      await expect(page.locator("#definitionAiRun")).toBeEnabled();
      await expect(page.locator("#definitionAiCost")).toContainText("Estimated test (24): $");
      await expect(page.locator("#definitionAiCost")).toContainText("estimated remaining full run");
      async function mapImage() {
        if (device.name === "mobile") await page.locator('.mobile-panel-tab[data-mobile-panel="variables"]').click();
        await expect(page.locator("#dagMapCanvas")).toBeVisible();
        const image = await page.locator("#dagMapCanvas").screenshot();
        if (device.name === "mobile") await page.locator('.mobile-panel-tab[data-mobile-panel="controls"]').click();
        return image;
      }
      const mapBeforeTest = await mapImage();
      await page.locator("#definitionAiRun").click();
      await expect(page.locator("#definitionAiPreview")).toBeVisible();
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(24);
      await expect(page.locator("#definitionAiFullRun")).toBeVisible();
      await expect(page.locator("#definitionAiCost")).toContainText("Test usage at listed price (24): $0.000084");
      await expect(page.locator("#definitionAiCost")).toContainText("calibrated from test");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(24);
      await expect(page.locator("#definitionMapPreviewStatus")).toContainText("AI sample preview only · 24 suggested for new");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
      expect(await mapImage()).not.toEqual(mapBeforeTest);
      await page.locator("#definitionMethodManual").click();
      await expect(page.locator("#definitionJevPanel")).toBeHidden();
      await expect(page.locator("#definitionManualPanel")).toBeVisible();
      await expect(page.locator("#definitionMapPreviewStatus")).toBeHidden();
      await page.locator("#definitionMethodJev").click();
      await expect(page.locator("#definitionAiPreview")).toBeVisible();
      await expect(page.locator("#definitionMapPreviewStatus")).toBeVisible();
      await expect(page.locator("#definitionAiApply")).toBeHidden();
      expect(decisions).toBe(2);
      const firstSample = batches.flatMap(batch => batch.records);
      await page.locator("#definitionAiDescription").fill("School and college academic achievement");
      await expect(page.locator("#definitionAiPreview")).toBeHidden();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds)).toBeNull();
      await page.locator("#definitionAiRun").click();
      await expect(page.locator("#definitionAiFullRun")).toBeVisible();
      expect(batches.slice(2).flatMap(batch => batch.records)).toEqual(firstSample);
      expect(batches.slice(2, 4).every(batch => batch.description === "School and college academic achievement")).toBe(true);
      const eligibleCount = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids.length);
      await page.locator("#definitionAiFullRun").click();
      await expect(page.locator("#definitionAiReviewTools")).toBeVisible();
      await expect(page.locator("#definitionAiReviewFilter")).toHaveValue("spot");
      expect(await page.locator("#definitionAiRows .definition-ai-row").count()).toBeLessThanOrEqual(40);
      await expect(page.locator("#definitionAiApply")).toBeVisible();
      await expect(page.locator("#definitionAiCost")).toContainText("full run usage at listed price");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(eligibleCount);
      await expect(page.locator("#definitionMapPreviewStatus")).toContainText(`AI full preview only · ${eligibleCount} suggested for new`);
      await page.locator("#definitionAiReviewFilter").selectOption("all");
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(40);
      await page.locator("#definitionAiReviewNext").click();
      await expect(page.locator("#definitionAiReviewPage")).toContainText("41–80");
      await page.locator("#definitionAiRows select").first().selectOption("leftover");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(eligibleCount - 1);
      await page.locator("#definitionAiRows select").first().selectOption("new");
      expect(batches.slice(4).flatMap(batch => batch.records)).toHaveLength(eligibleCount - 24);
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
      await page.locator("#definitionAiApply").click();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds)).toBeNull();
      await expect(page.locator("#definitionMapPreviewStatus")).toBeHidden();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBeGreaterThan(0);
      await expect(page.locator("#definitionSelectedVariables .definition-selected-variable")).toHaveCount(40);
      await expect(page.locator('#definitionTermChips button[data-term="all"]')).toHaveAttribute("aria-pressed", "true");
      await page.locator('#definitionTermItems button[data-side="leftover"]').first().click();
      await page.locator("#definitionReview").click();
      await expect(page.locator("#definitionNewDescription")).toHaveValue("School and college academic achievement");
      await page.locator("#definitionNewLabel").fill("School and college achievement");
      await page.locator("#definitionSave").click();
      await expect(page.locator("#definitionReviewStep")).toBeHidden();
      const savedDescription = await page.evaluate(() => {
        const state = window.__dagBuilderState;
        return state.project.groups.find(group => group.group_id === state.project.iv_group_id)?.description;
      });
      expect(savedDescription).toBe("School and college academic achievement");
      await page.locator('#dvGroupPicker button[data-group-id="category-income"]').click();
      await expect.poll(() => new URL(page.url()).searchParams.get("dv")).toBe("category-income");
      const localSchemaId = new URL(page.url()).searchParams.get("local_schema");
      expect(localSchemaId).toBeTruthy();
      expect(new URL(page.url()).searchParams.get("iv")).toBe(await page.evaluate(() => window.__dagBuilderState.project.iv_group_id));
      const storedSplit = await page.evaluate(async id => {
        const { loadLocalSchema } = await import("/local_schema_store.mjs");
        const record = await loadLocalSchema(id);
        return record?.schema?.groups.find(group => group.label === "School and college achievement");
      }, localSchemaId);
      expect(storedSplit?.description).toBe(savedDescription);
      expect(storedSplit?.provenance?.operation).toBe("split_categories");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => page.evaluate(() => window.__dagBuilderState?.project?.iv_group_id))
        .toBe(storedSplit.group_id);
      await expect(page.locator("#editSplitIv")).toBeVisible();
      await page.locator("#editSplitIv").click();
      await expect(page.locator("#definitionTitle")).toHaveText("Edit split");
      await expect(page.locator("#definitionManualPanel")).toBeVisible();
      await expect(page.locator("#definitionSelectedVariables .definition-selected-variable")).toHaveCount(40);
      await page.locator("#definitionReview").click();
      await expect(page.locator("#definitionNewDescription")).toHaveValue(savedDescription);
    } finally {
      await context.close();
    }
  });
}

test("Jev test and full split resume saved batches after failure and reload", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let decisions = 0;
  let failTestOnce = true;
  let failFullOnce = true;
  const requestedBatches = [];
  await page.route("https://openrouter.ai/auth?**", async route => {
    const authUrl = new URL(route.request().url());
    const callback = new URL(authUrl.searchParams.get("callback_url"));
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", authUrl.searchParams.get("state"));
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.route("https://openrouter.ai/api/**", async route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.url().endsWith("/auth/keys")) {
      return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ key: "sk-or-test" }) });
    }
    if (request.url().endsWith("/v1/key")) {
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ data: { limit: 5, limit_reset: null, limit_remaining: 5 } }) });
    }
    if (request.url().endsWith("/v1/model/typesafe/jev-1.13")) {
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ data: { pricing: { prompt: "0.000000042", completion: "0", request: "0" } } }) });
    }
    if (request.url().endsWith("/alpha/decisions")) {
      decisions += 1;
      const body = request.postDataJSON();
      requestedBatches.push(body.state.records);
      if (decisions === 2 && failTestOnce || decisions === 5 && failFullOnce) {
        if (decisions === 2) failTestOnce = false;
        else failFullOnce = false;
        return route.fulfill({ status: 503, headers, contentType: "application/json",
          body: JSON.stringify({ error: { message: "Temporary failure" } }) });
      }
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id,
        { type: "choice", choice: "new", probabilities: { new: 0.9, leftover: 0.1 } }]));
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ answers, usage: { input_tokens: 1000 } }) });
    }
    throw new Error(`Unexpected OpenRouter request: ${request.url()}`);
  });
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseJev").click();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Test paused");
    await expect(page.locator("#definitionAiRun")).toContainText("Resume test (16/24 saved)");
    const failedTestBatch = requestedBatches[1];
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await expect(page.locator("#definitionAiRun")).toContainText("Resume test (16/24 saved)");
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(requestedBatches[2]).toEqual(failedTestBatch);
    expect(decisions).toBe(3);
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Full run paused");
    await expect(page.locator("#definitionAiFullRun")).toContainText("16/");
    const storage = await page.evaluate(async () => {
      const { openLocalDatabase } = await import("/local_schema_store.mjs");
      const db = await openLocalDatabase();
      return { name: db.name, stores: [...db.objectStoreNames] };
    });
    expect(storage.name).toBe("echo-local-schemas");
    expect(storage.stores).toContain("jev_runs");
    expect(storage.stores).toContain("jev_batches");
    const eligibleCount = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids.length);
    await expect(page.locator("#definitionAiCost")).toContainText(`estimated remaining full run, calibrated from test (${eligibleCount - 40})`);
    const failedBatch = requestedBatches[4];
    expect(decisions).toBe(5);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await expect(page.locator("#definitionAiFullRun")).toContainText("Resume full split (16/");
    await expect(page.locator("#definitionAiRun")).toBeDisabled();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiFullRun")).toBeEnabled();
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiApply")).toBeVisible();
    expect(requestedBatches[5]).toEqual(failedBatch);
    expect(requestedBatches.slice(5).flat()).not.toContainEqual(requestedBatches[3][0]);
    await page.locator("#definitionAiDescription").fill("School measures only");
    await expect(page.locator("#definitionAiPreview")).toBeHidden();
    await expect(page.locator("#definitionAiRun")).toContainText("Test split on");
  } finally {
    await context.close();
  }
});

test("a stalled Jev batch can be stopped and retried", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  let decisions = 0;
  await page.route("https://openrouter.ai/auth?**", async route => {
    const authUrl = new URL(route.request().url());
    const callback = new URL(authUrl.searchParams.get("callback_url"));
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", authUrl.searchParams.get("state"));
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.route("https://openrouter.ai/api/**", async route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.url().endsWith("/auth/keys")) {
      return route.fulfill({ headers, contentType: "application/json", body: JSON.stringify({ key: "sk-or-test" }) });
    }
    if (request.url().endsWith("/v1/key")) {
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ data: { limit: 5, limit_reset: null, limit_remaining: 5 } }) });
    }
    if (request.url().endsWith("/v1/model/typesafe/jev-1.13")) {
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ data: { pricing: { prompt: "0.000000042", completion: "0", request: "0" } } }) });
    }
    if (request.url().endsWith("/alpha/decisions")) {
      decisions += 1;
      if (decisions === 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        try { await route.abort("timedout"); } catch { /* The user already stopped the request. */ }
        return;
      }
      const body = request.postDataJSON();
      const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id,
        { type: "choice", choice: "new", probabilities: { new: 0.9, leftover: 0.1 } }]));
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ answers, usage: { input_tokens: 1000 } }) });
    }
    throw new Error(`Unexpected OpenRouter request: ${request.url()}`);
  });
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseJev").click();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("requesting variables 1–16 of 24");
    await expect(page.locator("#definitionAiRun")).toHaveText("Stop test (save progress)");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Stopped.");
    await expect(page.locator("#definitionAiRun")).toHaveText("Test split on 24 variables");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(decisions).toBe(3);
  } finally {
    await context.close();
  }
});

test("a published split is reviewed on the map and used without a naming step", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page, { warnings: true });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);

  await page.locator("#ivGroupPicker [data-define-side=iv]").click();
  await page.locator("#definitionChooseBrowse").click();
  const sourceId = await page.locator("#definitionSourceList input[data-source-id]").first().getAttribute("data-source-id");

  // Publish a fixture split carved from that source category.
  const fixture = await page.evaluate(async sourceId => {
    const { writeGroupingSchemaFolder } = await import("./grouping_schema_writer.mjs");
    const { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } = await import("./app_contracts.mjs");
    const source = window.__dagBuilderState.project.groups.find(group => group.group_id === sourceId);
    const group = { group_id: "published_new", label: "Published fixture split",
      description: "A published fixture split taken from one source category.", source: "user_split",
      provenance: { operation: "split_categories", source_group_ids: [source.group_id] },
      variable_ids: source.variable_ids.slice(0, 1) };
    const files = await writeGroupingSchemaFolder({ schema_version: GROUPING_FORMAT_VERSION,
      membership_unit: GROUPING_MEMBERSHIP_UNIT, grouping_set_id: "fixture", label: "Fixture", groups: [group] });
    const text = Object.fromEntries([...files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
    return { sourceId, sourceLabel: source.label,
      membershipPath: JSON.parse(text["manifest.json"]).group_membership_files.published_new, files: text };
  }, sourceId);
  await page.route("**/rest/v1/published_split_index**", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify([{ publication_id: "00000000-0000-0000-0000-000000000001", group_id: "published_new",
      split_id: "published_new", source_group_ids: [fixture.sourceId], name: "Published fixture split",
      description: "A published fixture split taken from one source category.", storage_prefix: "fixture-owner/fixture-pub",
      membership_path: fixture.membershipPath, owner_id: "someone", published_at: "2026-10-15T00:00:00Z" }]) }));
  await page.route("**/storage/v1/object/public/published-schemas/fixture-owner/fixture-pub/**", route => {
    const path = new URL(route.request().url()).pathname.split("/fixture-pub/")[1];
    return fixture.files[path] === undefined ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ body: fixture.files[path] });
  });
  await page.locator(`#definitionSourceList input[data-source-id="${sourceId}"]`).check();
  await expect(page.locator("#definitionBrowseResults .definition-browse-card")).toHaveCount(1);
  await page.locator("#definitionBrowseResults button[data-split-index]").click();

  await expect(page.locator("#definitionPartitionStep")
    .or(page.locator("#definitionBrowseStatus", { hasText: "Could not" }))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#definitionBrowseStatus")).not.toContainText("Could not");
  await expect(page.locator("body"), browserErrors.errors.join("\n")).toHaveClass(/defining-variable/);
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await expect(page.locator("#definitionReview")).toHaveText("Use split");
  await expect(page.locator("#definitionReview")).toBeEnabled();
  await page.locator("#definitionReview").click();

  await expect(page.locator("#definitionBlock")).toBeHidden();
  const groups = await page.evaluate(() => window.__dagBuilderState.project.groups
    .map(group => ({ group_id: group.group_id, label: group.label, description: group.description })));
  expect(groups.find(group => group.label === "Published fixture split")?.description)
    .toBe("A published fixture split taken from one source category.");
  expect(groups.find(group => group.group_id === fixture.sourceId)?.label).toBe(fixture.sourceLabel);
  browserErrors.check();
});
