const { test, expect } = require("./fixtures.cjs");
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
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
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
  // Initial setup uses the full viewport until both anchors are selected.
  await expect(page.locator("#dagWorkspaceSection")).toBeHidden();

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
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
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

test("OpenRouter returns to the variable picker with the current anchors", async ({ page }) => {
  await page.route("https://openrouter.ai/auth?**", async route => {
    const auth = new URL(route.request().url());
    const callback = new URL(auth.searchParams.get("callback_url"));
    callback.searchParams.set("code", "test-code");
    callback.searchParams.set("state", auth.searchParams.get("state"));
    await route.fulfill({ status: 302, headers: { location: callback.href } });
  });
  await page.route("https://openrouter.ai/api/**", async route => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const url = route.request().url();
    const body = url.endsWith("/auth/keys") ? { key: "sk-or-test" }
      : url.endsWith("/v1/key") ? { data: { limit: 5, limit_reset: null, limit_remaining: 5 } }
        : { data: { pricing: { prompt: "0.000000042", completion: "0", request: "0" } } };
    await route.fulfill({ headers, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20 && window.__dagBuilderState?.publishedSchemaHydrated);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator("#variableDefineNew").click();
  await page.locator("#definitionChooseJev").click();
  await page.locator("#definitionAiConnect").click();
  await expect(page.locator("#definitionSourcesStep")).toBeVisible();
  await expect(page.locator("#definitionTitle")).toHaveText("Define new variable");
  expect(await page.evaluate(() => [window.__dagBuilderState.definitionDraft.role, window.__dagBuilderState.project.iv_group_id, window.__dagBuilderState.project.dv_group_id])).toEqual(["candidate", ...anchors]);
});

test("a new variable can be defined through the mobile controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
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
    await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
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
    const pageLabel = await page.locator('#definitionTermPage').innerText();
    const pageCount = Number(pageLabel.match(/^1 of (\d+)$/)?.[1]);
    expect(pageCount).toBeGreaterThan(1);
    await page.locator('#definitionTermNext').tap();
    await expect(page.locator('#definitionTermPage')).toHaveText(`2 of ${pageCount}`);
    await expect(page.locator('#definitionTermItems .definition-sort-row').first())
      .not.toHaveAttribute('data-term-variable-id', allFirstId);
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
      await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
        && window.__dagBuilderState?.publishedSchemaHydrated);
      await page.locator("#ivGroupPicker [data-define-side=iv]").click();
      await page.locator("#definitionChooseJev").click();
      await expect(page.locator("#definitionAiSetupStep")).toBeVisible();
      await expect(page.locator("#definitionSourcesStep")).toBeHidden();
      await page.locator("#definitionAiConnect").click();
      await expect(page.locator("#definitionAiSetupStep")).toBeVisible();
      await expect(page.locator("#definitionAiStatus")).toContainText("Lower its limit to $5");
      await expect(page.locator("#definitionSourcesStep")).toBeHidden();
      limit = 5;
      await page.locator("#definitionAiRecheck").click();
      await expect(page.locator("#definitionSourcesStep")).toBeVisible();
      await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
      await page.locator("#definitionContinue").click();
      await expect(page.locator("#definitionPartitionStep")).toBeVisible();
      await expect(page.locator("#definitionJevPanel")).toBeVisible();
      await expect(page.locator("#definitionManualPanel")).toBeHidden();
      await page.locator("#definitionAiDescription").fill("School based measures of academic achievement");
      await expect(page.locator("#definitionAiRun")).toBeEnabled();
      await expect(page.locator("#definitionAiCost")).toContainText("Estimated test (50): $");
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
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
      await expect(page.locator("#definitionAiFullRun")).toBeVisible();
      await expect(page.locator("#definitionAiCost")).toContainText("Test usage at listed price (50): $0.000168");
      await expect(page.locator("#definitionAiCost")).toContainText("calibrated from test");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(50);
      await expect(page.locator("#definitionMapPreviewStatus")).toContainText("AI sample preview only · 50 suggested for new");
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
      expect(decisions).toBe(4);
      const firstSample = batches.flatMap(batch => batch.records);
      await page.locator("#definitionAiDescription").fill("School and college academic achievement");
      await expect(page.locator("#definitionAiPreview")).toBeHidden();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds)).toBeNull();
      await page.locator("#definitionAiRun").click();
      await expect(page.locator("#definitionAiFullRun")).toBeVisible();
      expect(batches.slice(4).flatMap(batch => batch.records)).toEqual(firstSample);
      expect(batches.slice(4, 8).every(batch => batch.description === "School and college academic achievement")).toBe(true);
      const eligibleCount = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids.length);
      await page.locator("#definitionAiFullRun").click();
      await expect(page.locator("#definitionAiReviewTools")).toBeVisible();
      await expect(page.locator("#definitionAiReviewFilter")).toHaveValue("spot");
      expect(await page.locator("#definitionAiRows .definition-ai-row").count()).toBeLessThanOrEqual(50);
      await expect(page.locator("#definitionAiApply")).toBeVisible();
      await expect(page.locator("#definitionAiCost")).toContainText("full run usage at listed price");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(eligibleCount);
      await expect(page.locator("#definitionMapPreviewStatus")).toContainText(`AI full preview only · ${eligibleCount} suggested for new`);
      await page.locator("#definitionAiReviewFilter").selectOption("all");
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
      await page.locator("#definitionAiReviewNext").click();
      await expect(page.locator("#definitionAiReviewPage")).toContainText("51–100");
      await page.locator("#definitionAiRows select").first().selectOption("leftover");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(eligibleCount - 1);
      expect(batches.slice(8).flatMap(batch => batch.records)).toHaveLength(eligibleCount - 50);
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
      await page.locator("#definitionAiApply").click();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds)).toBeNull();
      await expect(page.locator("#definitionMapPreviewStatus")).toBeHidden();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBeGreaterThan(0);
      // Applying skips the manual draft and lands on Name and review.
      await expect(page.locator("#definitionReviewStep")).toBeVisible();
      await expect(page.locator("#definitionPartitionStep")).toBeHidden();
      await expect(page.locator("#definitionNewDescription")).toHaveValue("School and college academic achievement");
      await page.locator("#definitionNewLabel").fill("School and college achievement");
      await page.locator("#definitionSave").click();
      await expect(page.locator("#definitionReviewStep")).toBeHidden();
      const savedDescription = await page.evaluate(() => {
        const state = window.__dagBuilderState;
        return state.project.groups.find(group => group.group_id === state.project.iv_group_id)?.description;
      });
      expect(savedDescription).toBe("School and college academic achievement");
      const dvButton = page.locator('#dvGroupPicker button[data-group-id]').first();
      const dvId = await dvButton.getAttribute('data-group-id');
      await dvButton.click();
      await expect.poll(() => new URL(page.url()).searchParams.get("dv")).toBe(dvId);
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
      if (decisions === 2 && failTestOnce || decisions === 7 && failFullOnce) {
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
    await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseJev").click();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionSourcesStep")).toBeVisible();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Test paused");
    await expect(page.locator("#definitionAiRun")).toContainText("Resume test (16/50 saved)");
    const failedTestBatch = requestedBatches[1];
    await page.reload({ waitUntil: "domcontentloaded" });
    // Nothing is restored on load; the saved run is offered from Define.
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);
    await expect(page.locator("#definitionPartitionStep")).toBeHidden();
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionResumeList button", { hasText: "Resume" }).click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiRun")).toContainText("Resume test (16/50 saved)");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(requestedBatches[2]).toEqual(failedTestBatch);
    expect(decisions).toBe(5);
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
    await expect(page.locator("#definitionAiCost")).toContainText(`estimated remaining full run, calibrated from test (${eligibleCount - 66})`);
    const failedBatch = requestedBatches[6];
    expect(decisions).toBe(7);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionResumeList button", { hasText: "Resume" }).click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiFullRun")).toContainText("Resume full split (16/");
    await expect(page.locator("#definitionAiFullRun")).toBeEnabled();
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiApply")).toBeVisible();
    expect(requestedBatches[7]).toEqual(failedBatch);
    expect(requestedBatches.slice(7).flat()).not.toContainEqual(requestedBatches[5][0]);
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
    await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseJev").click();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionSourcesStep")).toBeVisible();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("requesting variables 1–16 of 50");
    await expect(page.locator("#definitionAiRun")).toHaveText("Stop test (save progress)");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Stopped.");
    await expect(page.locator("#definitionAiRun")).toHaveText("Test split on 50 variables");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(decisions).toBe(5);
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
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
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
  // The viewer runs on the Cloudflare source in tests (as staging ships it): the splits list comes from the worker and
  // the publication's files from the Cloudflare address. Both sources are answered, so the test stands on either.
  await page.route("**/echo-api.epistemicinfra.org/v1/splits**", route => route.fulfill({ contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify([{ publication_id: "00000000-0000-0000-0000-000000000001", group_id: "published_new",
      split_id: "published_new", source_group_ids: [fixture.sourceId], name: "Published fixture split",
      description: "A published fixture split taken from one source category.", storage_prefix: "fixture-owner/fixture-pub",
      membership_path: fixture.membershipPath, owner_id: "someone", published_at: "2026-10-15T00:00:00Z" }]) }));
  const serveFixtureFile = route => {
    const path = new URL(route.request().url()).pathname.split("/fixture-pub/")[1];
    return fixture.files[path] === undefined ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ body: fixture.files[path], headers: { "access-control-allow-origin": "*" } });
  };
  await page.route("**/storage/v1/object/public/published-schemas/fixture-owner/fixture-pub/**", serveFixtureFile);
  await page.route("**/data.epistemicinfra.org/published-schemas/fixture-owner/fixture-pub/**", serveFixtureFile);
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

test("definition source search matches constituent variables, not only category names", async ({ page }) => {
  const fs = require("node:fs"), zlib = require("node:zlib");
  const { PRODUCTION_EVIDENCE_MANIFEST } = await import("../site/dag_data_config.mjs");
  const snapshot = PRODUCTION_EVIDENCE_MANIFEST.match(/browser-v2\/([0-9a-f]{64})\//)[1];
  const catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(`site/search-catalogs/${snapshot}.json.gz`)));
  const labelOf = new Map(catalog.records.map(row => [row[0], row[1] || row[2]]));
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);
  await page.waitForFunction(() => window.__dagBuilderState.publishedSchemaHydrated && !window.__dagBuilderState.publishedSchemaHydrating);
  // Pick a variable whose own label is not part of its category's name.
  const target = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 5)
    .map(group => ({ id: group.group_id, label: group.label, variableId: group.variable_ids[Math.min(3, group.variable_ids.length - 1)] })));
  const pick = target.find(item => {
    const text = labelOf.get(item.variableId);
    return text && text.length > 12 && !item.label.toLowerCase().includes(text.toLowerCase());
  });
  expect(pick, JSON.stringify(target.map(t => [t.label, t.variableId, labelOf.get(t.variableId)]))).toBeTruthy();
  const query = labelOf.get(pick.variableId);
  await page.locator("#ivGroupPicker [data-define-side=iv]").click();
  await page.locator("#definitionChooseManual").click();
  await page.locator("#definitionSourceSearch").fill(query);
  const row = page.locator(`#definitionSourceList input[data-source-id="${pick.id}"]`);
  await expect(row).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator("#definitionSourceList .setup-group-variable-match").first()).toContainText("Matched:");
});

test("Label 50 more appends to the list, sorts new first, and Name and review skips the manual draft", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const batches = [];
  let failSecondRoundOnce = true;
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
      const body = request.postDataJSON();
      batches.push(body.state.records);
      if (batches.length === 6 && failSecondRoundOnce) {
        failSecondRoundOnce = false;
        return route.fulfill({ status: 503, headers, contentType: "application/json",
          body: JSON.stringify({ error: { message: "Temporary failure" } }) });
      }
      // Alternate sides so the list has both new and leftover rows.
      const answers = Object.fromEntries(Object.keys(body.questions).map((id, index) => [id,
        { type: "choice", choice: index % 2 ? "leftover" : "new", probabilities: { new: 0.9, leftover: 0.9 } }]));
      return route.fulfill({ headers, contentType: "application/json",
        body: JSON.stringify({ answers, usage: { input_tokens: 1000 } }) });
    }
    throw new Error(`Unexpected OpenRouter request: ${request.url()}`);
  });
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto("http://127.0.0.1:8767/?task=identify", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
      && window.__dagBuilderState?.publishedSchemaHydrated);
    await page.locator("#ivGroupPicker [data-define-side=iv]").click();
    await page.locator("#definitionChooseJev").click();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionSourcesStep")).toBeVisible();
    await page.locator("#definitionSourceList .definition-source-row").filter({ hasText: "academic achievement" }).first().click();
    await page.locator("#definitionContinue").click();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
    await expect(page.locator("#definitionAiMore")).toHaveText("Label 50 more");
    // Name and review needs every variable labeled, not just the first rounds.
    await expect(page.locator("#definitionAiApply")).toBeHidden();
    const firstRound = batches.flat();
    expect(firstRound).toHaveLength(50);

    // An interrupted round keeps its ids; resuming retries the failed batch.
    await page.locator("#definitionAiMore").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Labeling paused");
    await expect(page.locator("#definitionAiMore")).toContainText("Resume labeling (16/50 saved)");
    const failedBatch = batches[5];
    await page.locator("#definitionAiMore").click();
    await expect(page.locator("#definitionAiReviewPage")).toContainText("1–50 of 100");
    expect(batches[6]).toEqual(failedBatch);
    const secondRound = [...batches.slice(4, 5), ...batches.slice(6)].flat();
    expect(secondRound).toHaveLength(50);
    // The second round labels different variables, not a repeat of the first.
    const firstLabels = new Set(firstRound.map(record => record.label + record.text));
    expect(secondRound.some(record => firstLabels.has(record.label + record.text))).toBe(false);
    // New variables are listed ahead of leftover ones across pages.
    const sides = async () => page.locator("#definitionAiRows select").evaluateAll(selects => selects.map(select => select.value));
    expect((await sides()).every(side => side === "new")).toBe(true);
    await page.locator("#definitionAiReviewNext").click();
    expect((await sides()).every(side => side === "leftover")).toBe(true);
    expect(await page.evaluate(() => window.__dagBuilderState.definitionAiPreviewIds?.size)).toBe(50);

    await expect(page.locator("#definitionAiApply")).toBeHidden();

    // Finishing the full split labels the rest, appends nothing twice, and unlocks Name and review.
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiApply")).toBeVisible({ timeout: 90000 });
    await expect(page.locator("#definitionAiMore")).toBeHidden();
    const eligibleCount = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids.length);
    // Every variable is requested once, plus the one batch that failed and was retried.
    expect(batches.flat()).toHaveLength(eligibleCount + batches[5].length);
    await page.locator("#definitionAiApply").click();
    await expect(page.locator("#definitionReviewStep")).toBeVisible();
    await expect(page.locator("#definitionPartitionStep")).toBeHidden();
    expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBeGreaterThan(50);
    await expect(page.locator("#definitionNewDescription")).toHaveValue("School and college academic achievement");
  } finally {
    await context.close();
  }
});

test("Causes offers Define a variable and the new variable becomes the focus without changing the anchors", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page, { warnings: true });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/?task=causes", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);

  const define = page.locator("#focusGroupPicker [data-define-focus]");
  await expect(define).toBeVisible();
  const anchorsBefore = await page.evaluate(() => {
    const { iv_group_id, dv_group_id } = window.__dagBuilderState.project;
    return { iv_group_id, dv_group_id };
  });
  await define.click();
  await page.locator("#definitionChooseManual").click();
  const usable = page.locator("#definitionSourceList input[data-source-id]");
  await expect(usable.nth(0)).toBeVisible();
  await usable.nth(0).check();
  await page.locator("#definitionContinue").click();
  await expect(page.locator("body"), browserErrors.errors.join("\n")).toHaveClass(/defining-variable/);
  await page.locator("#definitionMethodManual").click();
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(variableId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await page.locator("#definitionReview").click();
  await page.locator("#definitionNewLabel").fill("Browser focus construct");
  await page.locator("#definitionNewDescription").fill("A browser test construct defined from the causes view.");
  const residuals = page.locator("#definitionResidualLabels input[data-residual-id]");
  for (let i = 0; i < await residuals.count(); i++) await residuals.nth(i).fill(`Browser residual ${i}`);
  await page.locator("#definitionSave").click();

  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  const result = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const group = state.project.groups.find(candidate => candidate.label === "Browser focus construct");
    return { task: state.task, groupId: group?.group_id, anchors: { iv_group_id: state.project.iv_group_id,
      dv_group_id: state.project.dv_group_id }, title: document.querySelector("#dagViewTitle")?.textContent };
  });
  expect(result.task).toBe("causes");
  expect(result.anchors).toEqual(anchorsBefore);
  expect(result.title).toContain("Browser focus construct");
  expect(browserErrors.errors).toEqual([]);
});

test("a saved AI split is not restored on load; Define offers it in Causes and resumes it", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const ready = () => page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated);
  await page.goto("http://127.0.0.1:8767/?task=causes", { waitUntil: "domcontentloaded" });
  await ready();
  await page.evaluate(async () => {
    const { saveJevRun } = await import("/definition_jev_checkpoint.mjs");
    const group = window.__dagBuilderState.project.groups.find(candidate => candidate.variable_ids?.length > 3);
    await saveJevRun({ id: "seeded-run", sampleIds: [], createdAt: Date.now(), draft: {
      role: "iv", step: "partition", source_group_ids: [group.group_id],
      source_snapshot: [{ group_id: group.group_id, label: group.label, variable_ids: [...group.variable_ids] }],
      eligible_variable_ids: [...group.variable_ids], new_variable_ids: [], new_label: "", new_description: "",
      residual_labels: {}, reviewed_variable_ids: [], ai_description: "Seeded saved split" } });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready();
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft)).toBeNull();
  await expect(page.locator("#definitionMapPreviewStatus")).toBeHidden();

  await page.locator("#focusGroupPicker [data-define-focus]").click();
  const row = page.locator("#definitionResumeList .definition-resume-row");
  await expect(row).toContainText("Seeded saved split");
  await row.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  expect(await page.evaluate(() => {
    const draft = window.__dagBuilderState.definitionDraft;
    return { step: draft.step, role: draft.role, description: draft.ai_description };
  })).toEqual({ step: "partition", role: "candidate", description: "Seeded saved split" });
  await page.evaluate(async () => (await import("/definition_jev_checkpoint.mjs")).deleteJevRun("seeded-run"));
});
