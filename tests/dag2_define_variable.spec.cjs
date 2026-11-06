const { test, expect } = require("./fixtures.cjs");
const { chooseAnchor, chooseAnchors, startCreate, openIdentifyField, closeSchemaWorkspace, editSchemaButton, createVariableFromSchema, editVariableButton } = require("./support/identify.cjs");
const { watchBrowserErrors } = require("./browser_errors.cjs");
const { describeVariable, startAiSplit, includeConcepts } = require("./support/definition.cjs");
const { chooseTask, chooseFocus } = require("./support/navigation.cjs");

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

  await expect(page.locator("#identify-iv-input")).toBeVisible();
  await startCreate(page, "iv");
  // Creating starts by choosing the sources; the name and definition come next.
  await expect(page.locator("#definitionSourcesStep")).toBeVisible();
  await expect(page.locator("#definitionDescribeStep")).toBeHidden();
  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  // Initial setup uses the full viewport until both anchors are selected.
  await expect(page.locator("#dagWorkspaceSection")).toBeHidden();
  await expect(page.locator("#definitionContinue")).toBeDisabled();

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
  await expect(page.locator("#definitionDescribeStep")).toBeVisible();
  await page.locator("#definitionNewLabel").fill("Browser test construct");
  await page.locator("#definitionNewDescription").fill("too short");
  await page.locator("#definitionDescribeNext").click();
  await expect(page.locator("#definitionValidation")).toHaveText("Write a definition of at least 20 characters.");
  await expect(page.locator("#definitionNewDescription")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#definitionDescribeStep")).toBeVisible();
  await page.locator("#definitionNewDescription").fill("A browser test construct with defined source members.");
  await expect(page.locator("#definitionNewDescription")).not.toHaveAttribute("aria-invalid");
  await page.locator("#definitionDescribeNext").click();
  await expect(page.locator("body"), browserErrors.errors.join("\n")).toHaveClass(/defining-variable/);
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await expect(page.locator("#definitionJevPanel")).toBeVisible();
  await expect(page.locator("#definitionIncludedPanel")).toBeVisible();
  await expect(page.locator("#definitionSave")).toBeDisabled();
  await expect(page.locator("#definitionSaveHint")).toHaveText("Include at least one concept to save: use the AI suggestions or an existing split.");
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids
    .filter(id => {
      const variable = window.__dagBuilderState.variableById.get(id);
      return variable && Number.isFinite(variable.map_x) && Number.isFinite(variable.map_y);
    }).length)).toBeGreaterThan(0);

  const canonicalId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await includeConcepts(page, [canonicalId]);
  await expect(page.locator("#definitionSelectedVariables .definition-included-row")).toHaveCount(1);
  await expect(page.locator("#definitionSelectedTitle")).toHaveText("Included concepts (1)");
  await expect(page.locator("#definitionSave")).toBeEnabled();

  // Leftovers keep their source's name unless renamed.
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

  // A custom variable is edited with the pencil in its picker row.
  await closeSchemaWorkspace(page);
  await openIdentifyField(page, "iv");
  await expect(editVariableButton(page, "Browser test construct")).toBeVisible();
  await editVariableButton(page, "Browser test construct").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit “Browser test construct”");
  await expect(page.locator("#definitionSave")).toHaveText("Save changes");
  // Editing keeps the concepts already included; the AI is the way to change them.
  await expect(page.locator("#definitionSelectedVariables .definition-included-row")).toHaveCount(1);
  // Back to name: rename, and the steps lead straight back to the concepts.
  await page.locator("#definitionBack").click();
  await page.locator("#definitionNewLabel").fill("Browser test construct updated");
  await page.locator("#definitionDescribeNext").click();
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await page.locator("#definitionSave").click();
  await expect(page.locator("body")).not.toHaveClass(/defining-variable/);
  expect(await page.evaluate(groupId => window.__dagBuilderState.project.groups
    .find(group => group.group_id === groupId).label, splitGroupId))
    .toBe("Browser test construct updated");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.undoHistory.length),
  { timeout: 1000 }).toBeGreaterThan(0);
  await page.locator("#undoBtn").click();
  expect(await page.evaluate(groupId => window.__dagBuilderState.project.groups
    .find(group => group.group_id === groupId).label, splitGroupId)).toBe("Browser test construct");
  await page.locator("#undoBtn").click();
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await expect(editSchemaButton(page)).toBeVisible();

  await createVariableFromSchema(page);
  await expect(page.locator("#definitionTitle")).toHaveText("Create a variable");
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.role)).toBe("candidate");
  const source = page.locator("#definitionSourceList input[data-source-id]").nth(2);
  await source.check();
  await page.locator("#definitionContinue").click();
  await describeVariable(page, { label: "Browser list variable", description: "A browser list variable with selected source members." });
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await includeConcepts(page, [variableId]);
  await page.locator("#definitionResidualLabels input").fill("Browser list residual");
  await page.locator("#definitionSave").click();
  await expect(editSchemaButton(page)).toBeVisible();
  const splitId = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.label === "Browser list variable")?.group_id);
  expect(splitId).toBeTruthy();
  // A custom variable is edited with the pencil in its picker row.
  await closeSchemaWorkspace(page);
  await openIdentifyField(page, "iv");
  await editVariableButton(page, "Browser list variable").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit “Browser list variable”");
  await page.locator(".definition-cancel:visible").first().click();

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(editSchemaButton(page)).toBeVisible();
  await createVariableFromSchema(page);
  await expect(page.locator("#definitionTitle")).toHaveText("Create a variable");
  await page.locator(".definition-cancel:visible").first().click();
  await closeSchemaWorkspace(page);
  await openIdentifyField(page, "iv");
  await editVariableButton(page, "Browser list variable").click();
  await expect(page.locator("#definitionTitle")).toHaveText("Edit “Browser list variable”");
  await page.locator(".definition-cancel:visible").first().click();
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await createVariableFromSchema(page);
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await describeVariable(page);
  await page.locator("#definitionAiConnect").click();
  // The saved draft comes back on the concepts step, where the connection was made.
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await expect(page.locator("#definitionTitle")).toHaveText("Create a variable");
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await page.locator('.mobile-panel-tab[data-mobile-panel="controls"]').click();
  await createVariableFromSchema(page);
  await expect(page.locator("#definitionTitle")).toBeInViewport();
  await expect(page.locator("#groupingPanel")).toBeHidden();

  const sourceRow = page.locator("#definitionSourceList .definition-source-row").nth(2);
  await sourceRow.click({ position: { x: 30, y: 20 } });
  await expect(sourceRow.locator("input")).toBeChecked();
  await expect(page.locator("#definitionContinue")).toBeInViewport();
  await page.locator("#definitionContinue").click();
  await describeVariable(page, { label: "Mobile browser variable", description: "A mobile browser variable with selected source members." });
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  await expect(page.locator("#definitionTitle")).toBeInViewport();

  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await includeConcepts(page, [variableId]);
  await page.locator("#definitionResidualLabels input").fill("Mobile browser residual");
  await page.locator("#definitionSave").click();
  await expect(page.locator("#definitionBlock")).toBeHidden();
  expect(await page.evaluate(() => window.__dagBuilderState.project.groups
    .some(group => group.label === "Mobile browser variable"))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
      await startCreate(page, "iv");
      // The map is shown while defining only in the narrower layout.
      await startAiSplit(page, { label: "School and college achievement", description: "School and college academic achievement" });
      await page.locator("#definitionAiConnect").click();
      await expect(page.locator("#definitionJevPanel")).toBeVisible();
      await expect(page.locator("#definitionAiLimitText")).toContainText("Lower its limit to $5");
      await expect(page.locator("#definitionAiRun")).toBeDisabled();
      limit = 5;
      await page.locator("#definitionAiRecheck").click();
      await expect(page.locator("#definitionAiRun")).toBeEnabled();
      await page.locator("#definitionAiDescription").fill("School based measures of academic achievement");
      await expect(page.locator("#definitionAiRun")).toBeEnabled();
      await expect(page.locator("#definitionAiCost")).toContainText("Estimated test (50): $");
      await expect(page.locator("#definitionAiCost")).toContainText("estimated remaining full run");
      await page.locator("#definitionAiRun").click();
      await expect(page.locator("#definitionAiPreview")).toBeVisible();
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
      await expect(page.locator("#definitionAiFullRun")).toBeVisible();
      await expect(page.locator("#definitionAiCost")).toContainText("Test usage at listed price (50): $0.000168");
      await expect(page.locator("#definitionAiCost")).toContainText("calibrated from test");
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
      await expect(page.locator("#definitionAiPreview")).toBeVisible();
      await expect(page.locator("#definitionAiApply")).toBeHidden();
      expect(decisions).toBe(4);
      const firstSample = batches.flatMap(batch => batch.records);
      await page.locator("#definitionAiDescription").fill("School and college academic achievement");
      await expect(page.locator("#definitionAiPreview")).toBeHidden();
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
      await page.locator("#definitionAiReviewFilter").selectOption("all");
      await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
      await page.locator("#definitionAiReviewNext").click();
      await expect(page.locator("#definitionAiReviewPage")).toContainText("51–100");
      await page.locator("#definitionAiRows .definition-ai-row").first().locator("button[data-ai-side=leftover]").click();
      expect(batches.slice(8).flatMap(batch => batch.records)).toHaveLength(eligibleCount - 50);
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
      await page.locator("#definitionAiApply").click();
      expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBeGreaterThan(0);
      // The name and definition were written first, so applying leaves only Save.
      await expect(page.locator("#definitionSave")).toBeEnabled();
      await page.locator("#definitionSave").click();
      await expect(page.locator("#definitionBlock")).toBeHidden();
      const savedDescription = await page.evaluate(() => {
        const state = window.__dagBuilderState;
        return state.project.groups.find(group => group.group_id === state.project.iv_group_id)?.description;
      });
      expect(savedDescription).toBe("School and college academic achievement");
      await openIdentifyField(page, "dv");
      const dvButton = page.locator('#identifyGroupPicker button[data-group-id]').first();
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
      await openIdentifyField(page, "iv");
      await expect(editVariableButton(page, "School and college achievement")).toBeVisible();
      await editVariableButton(page, "School and college achievement").click();
      await expect(page.locator("#definitionTitle")).toHaveText("Edit “School and college achievement”");
      await expect(page.locator("#definitionIncludedPanel")).toBeVisible();
      // The Included list shows the first 300 and leaves the rest to its filter.
      await expect(page.locator("#definitionSelectedVariables .definition-included-row")).toHaveCount(300);
      await page.locator("#definitionBack").click();
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
    await startCreate(page, "iv");
    await startAiSplit(page, { label: "School and college achievement", description: "School and college academic achievement" });
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Test paused");
    await expect(page.locator("#definitionAiRun")).toContainText("Resume the sample (16 of 50 done)");
    const failedTestBatch = requestedBatches[1];
    await page.reload({ waitUntil: "domcontentloaded" });
    // Nothing is restored on load; the saved run is offered from Define.
    await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);
    await expect(page.locator("#definitionPartitionStep")).toBeHidden();
    await startCreate(page, "iv");
    await page.locator("#definitionResumeList button", { hasText: "Resume" }).click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiRun")).toContainText("Resume the sample (16 of 50 done)");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(requestedBatches[2]).toEqual(failedTestBatch);
    expect(decisions).toBe(5);
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Full run paused");
    await expect(page.locator("#definitionAiFullRun")).toContainText("16 of");
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
    await startCreate(page, "iv");
    await page.locator("#definitionResumeList button", { hasText: "Resume" }).click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionAiFullRun")).toContainText("Resume (16 of");
    await expect(page.locator("#definitionAiFullRun")).toBeEnabled();
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiApply")).toBeVisible();
    expect(requestedBatches[7]).toEqual(failedBatch);
    expect(requestedBatches.slice(7).flat()).not.toContainEqual(requestedBatches[5][0]);
    // The description is tucked away while suggestions exist; discarding them brings it back for editing.
    await page.locator("#definitionAiDiscard").click();
    await expect(page.locator("#definitionAiPreview")).toBeHidden();
    await page.locator("#definitionAiDescription").fill("School measures only");
    await expect(page.locator("#definitionAiRun")).toContainText("Classify a sample of");
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
        await new Promise(resolve => setTimeout(resolve, 3000));
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
    await startCreate(page, "iv");
    await startAiSplit(page, { label: "School and college achievement", description: "School and college academic achievement" });
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await expect(page.locator("#definitionAiRun")).toBeEnabled();
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("requesting variables 1–16 of 50");
    await expect(page.locator("#definitionAiRun")).toHaveText("Stop (progress is saved)");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Stopped.");
    await expect(page.locator("#definitionAiRun")).toHaveText("Classify a sample of 50");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiFullRun")).toBeVisible();
    expect(decisions).toBe(5);
  } finally {
    await context.close();
  }
});

test("a published split appears after source selection and opens for review", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto(`http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated);

  // The published split workflow only needs source concept metadata. Keep this
  // case independent of the remote evidence snapshot so it exercises the UI.
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    dagDataSource.loadVariableMetadata = async ids => ids.map(id => ({
      variable_id: id, index: parseInt(id.slice(1, 9), 16),
      display_label: id, concept_label: id, map_x: parseInt(id.slice(1, 9), 16), map_y: parseInt(id.slice(9, 17), 16),
    }));
  });
  await startCreate(page, "iv");
  const sourceId = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.variable_ids?.length >= 2 && group.variable_ids.length <= 20)?.group_id);
  expect(sourceId).toBeTruthy();

  // Publish a fixture split carved from that source category.
  const fixture = await page.evaluate(async sourceId => {
    const { writeGroupingSchemaFolder } = await import("./grouping_schema_writer.mjs");
    const { GROUPING_FORMAT_VERSION, GROUPING_MEMBERSHIP_UNIT } = await import("./app_contracts.mjs");
    const source = window.__dagBuilderState.project.groups.find(group => group.group_id === sourceId);
    const group = { group_id: "published_new", label: "Published fixture split",
      description: "A published fixture split taken from one source category.", source: "user_split",
      provenance: { operation: "split_categories", source_group_ids: [source.group_id],
        source_group_by_variable: Object.fromEntries(source.variable_ids.map(id => [id, source.group_id])) },
      variable_ids: source.variable_ids.slice(0, 1) };
    const files = await writeGroupingSchemaFolder({ schema_version: GROUPING_FORMAT_VERSION,
      membership_unit: GROUPING_MEMBERSHIP_UNIT, grouping_set_id: "fixture", label: "Fixture", groups: [group] });
    const text = Object.fromEntries([...files].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
    return { sourceId, sourceLabel: source.label,
      membershipPath: JSON.parse(text["manifest.json"]).group_membership_files.published_new, files: text };
  }, sourceId);
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const ownerToken = `${ownerId}.${"a".repeat(64)}`;
  await page.evaluate(token => localStorage.setItem("echo-owner-token", token), ownerToken);
  await page.route("**/echo-api.epistemicinfra.org/v1/owners/publications", route => {
    expect(route.request().headers()["x-owner-token"]).toBe(ownerToken);
    return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify([{ id: "00000000-0000-4000-8000-000000000002", owner_id: ownerId,
        storage_prefix: "fixture-owner/fixture-pub", created_at: "2026-10-15T00:00:00Z" }]) });
  });
  const serveFixtureFile = route => {
    const path = new URL(route.request().url()).pathname.split("/fixture-pub/")[1];
    return fixture.files[path] === undefined ? route.fulfill({ status: 404, body: "" })
      : route.fulfill({ body: fixture.files[path], headers: { "access-control-allow-origin": "*" } });
  };
  await page.route("**/data.epistemicinfra.org/published-schemas/fixture-owner/fixture-pub/**", serveFixtureFile);
  await page.locator(`#definitionSourceList input[data-source-id="${sourceId}"]`).check();
  await expect(page.locator("#definitionBrowsePanel")).toBeVisible();
  await expect(page.locator("#definitionBrowseResults .definition-browse-card")).toHaveCount(1);
  await expect(page.locator("#definitionBrowseJump")).toHaveText("View 1 previous split");
  await page.locator("#definitionBrowseJump").click();
  await expect(page.locator("#definitionBrowseResults button[data-split-index]")).toBeFocused();
  // A different exact set has no published split, but the browse area remains findable.
  const otherId = await page.evaluate(id => window.__dagBuilderState.project.groups
    .find(group => group.group_id !== id && group.variable_ids?.length >= 2)?.group_id, sourceId);
  await page.locator(`#definitionSourceList input[data-source-id="${otherId}"]`).check();
  await expect(page.locator("#definitionBrowsePanel")).toBeVisible();
  await expect(page.locator("#definitionBrowseStatus")).toContainText("You have no previous splits");
  await expect(page.locator("#definitionBrowseJump")).toHaveText("No previous splits found");
  await page.locator(`#definitionSourceList input[data-source-id="${otherId}"]`).uncheck();
  await expect(page.locator("#definitionBrowseResults .definition-browse-card")).toHaveCount(1);
  await page.locator("#definitionBrowseResults button[data-split-index]").click();

  await expect(page.locator("#definitionPartitionStep")
    .or(page.locator("#definitionBrowseStatus", { hasText: "Could not" }))).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#definitionBrowseStatus")).not.toContainText("Could not");
  // The saved split opens directly for review, without the AI workflow.
  await expect(page.locator("#definitionNewLabel")).toHaveValue("Published fixture split");
  await expect(page.locator("#definitionNewDescription")).toHaveValue("A published fixture split taken from one source category.");
  await expect(page.locator("#definitionJevPanel")).toBeHidden();
  await expect(page.locator("body")).toHaveClass(/defining-variable/);
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  // The split supplied the concepts too, so there is nothing left to choose: just save.
  await expect(page.locator("#definitionSave")).toBeEnabled();
  await page.locator("#definitionSave").click();

  await expect(page.locator("#definitionBlock")).toBeHidden();
  const groups = await page.evaluate(() => window.__dagBuilderState.project.groups
    .map(group => ({ group_id: group.group_id, label: group.label, description: group.description })));
  expect(groups.find(group => group.label === "Published fixture split")?.description)
    .toBe("A published fixture split taken from one source category.");
  expect(groups.find(group => group.group_id === fixture.sourceId)?.label).toBe(fixture.sourceLabel);
});

test("the Identify variable list follows the diagnostic toolbar", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated);
  await chooseAnchors(page, "category-sleep", "category-income-earnings");
  await expect(page.locator("#exploreResults .identify-kind")).toHaveCount(0);
  for (const [button, field] of [["toggleConfoundersOnly", "confounderGroupIds"], ["toggleCollidersOnly", "colliderGroupIds"]]) {
    await page.locator(`#${button}`).click();
    await expect(page.locator(`#${button}`)).toHaveAttribute("aria-pressed", "true");
    const result = await page.evaluate(field => {
      const state = window.__dagBuilderState;
      const actual = [...document.querySelectorAll("#exploreResults .explore-row[data-group-id]")].map(row => row.dataset.groupId).sort();
      const expected = state.project.groups.filter(group => state[field].has(group.group_id)
        && group.variable_ids?.length && group.type !== "other" && group.group_id !== "category-other")
        .map(group => group.group_id).sort();
      return { actual, expected };
    }, field);
    expect(result.actual).toEqual(result.expected);
  }
});

test("choosing a cause confirms the selection until its picker is reopened", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated);
  const option = page.locator("#identifyGroupPicker button[data-group-id]").first();
  const groupId = await option.getAttribute("data-group-id");
  await option.click();
  const cause = page.locator('.identify-field[data-side="iv"]');
  await expect(cause.locator(".identify-selection-status")).toBeVisible();
  await expect(cause).toHaveClass(/is-selected/);
  await page.locator("#identify-iv-input").click();
  await expect(cause.locator(".identify-selection-status")).toBeHidden();
  await expect(cause).not.toHaveClass(/is-selected/);
  await page.locator("#identify-iv-input").press("Escape");
  await expect(cause.locator(".identify-selection-status")).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState.project.iv_group_id)).toBe(groupId);
});

test("add a saved variable to the schema without selecting an analysis role", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto(`http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated);
  const before = await page.evaluate(async () => {
    const state = window.__dagBuilderState;
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    dagDataSource.loadVariableMetadata = async ids => { await new Promise(resolve => setTimeout(resolve, 300)); return ids.map(id => ({ variable_id: id,
      index: parseInt(id.slice(1, 9), 16), display_label: id, concept_label: id,
      map_x: parseInt(id.slice(1, 9), 16), map_y: parseInt(id.slice(9, 17), 16) })); };
    const source = state.project.groups.find(group => group.variable_ids?.length >= 2 && group.variable_ids.length <= 20);
    const { commitLocalSchema } = await import("/local_schema_store.mjs");
    const group = { group_id: "saved-variable-fixture", label: "Saved test variable",
      description: "A saved test variable with a clear definition.", source: "user_split",
      provenance: { operation: "split_categories", split_id: "saved-split-fixture", source_group_ids: [source.group_id],
        source_group_by_variable: Object.fromEntries(source.variable_ids.map(id => [id, source.group_id])) },
      variable_ids: [source.variable_ids[0]] };
    const alternative = { ...group, group_id: "alternative-fixture", label: "Alternative saved variable",
      provenance: { ...group.provenance, split_id: "alternative-split" } };
    await commitLocalSchema({ id: "saved-fixture", schema: { groups: [group, alternative] }, url: location.href });
    return { source: source.label, iv: state.project.iv_group_id, dv: state.project.dv_group_id,
      instrument: state.project.instrument_group_id, focus: state.focusedGroupId, phase: state.phase };
  });
  await page.locator("#schemaMenu summary").click();
  await page.locator("#openCustomVariables").click();
  await expect(page.locator("#customVariablesView")).toBeVisible();
  const saved = page.locator(".custom-variables-previous");
  await expect(saved).toContainText("Saved test variable");
  // Saved variables lead the page; the schema's own list follows.
  expect(await page.locator("#customVariablesTable h2").allTextContents()).toEqual(["Saved elsewhere", "In this schema"]);
  await expect(saved).toContainText(before.source);
  await saved.getByRole("button", { name: "Add Saved test variable to schema" }).click();
  await expect(page.locator("#definitionSavedLoading")).toBeVisible();
  await expect(page.locator("#definitionDescribeStep")).toBeHidden();
  await expect(page.locator("#definitionSourcesStep")).toBeHidden();
  await expect(page.locator("#definitionJevPanel")).toBeHidden();
  await expect(page.locator("#definitionConceptsTitle")).toHaveText("Review saved variable");
  await expect(page.locator("#definitionJevPanel")).toBeHidden();
  await expect(page.locator("#definitionResidualLabels input")).toHaveCount(0);
  await expect(page.locator("#definitionSave")).toHaveText("Add to schema");
  await page.locator("#definitionSave").click();
  await expect(page.locator("#customVariablesView")).toBeVisible();
  await expect(page.locator("#customVariablesStatus")).toContainText("Saved test variable");
  const after = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    return { iv: state.project.iv_group_id, dv: state.project.dv_group_id,
      instrument: state.project.instrument_group_id, focus: state.focusedGroupId, phase: state.phase,
      origin: state.project.groups.find(group => group.label === "Saved test variable")?.provenance?.reused_from_split_id };
  });
  expect(after).toEqual({ iv: before.iv, dv: before.dv, instrument: before.instrument,
    focus: before.focus, phase: before.phase, origin: "saved-split-fixture" });

  // An overlapping saved definition is available when replacing this role's split.
  await page.locator("#customVariablesClose").click();
  const selectedId = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.label === "Saved test variable").group_id);
  await chooseAnchor(page, "iv", "category-sleep");
  await chooseAnchor(page, "dv", selectedId);
  await openIdentifyField(page, "dv");
  await page.getByRole("button", { name: "Review and add Alternative saved variable" }).click();
  await expect(page.locator("#definitionSave")).toHaveText("Replace and use as outcome");
  await expect(page.locator("#definitionConceptsIntro")).toContainText('This replaces “Saved test variable”');
  await page.locator(".definition-cancel:visible").first().click();
  expect(await page.evaluate(() => window.__dagBuilderState.project.dv_group_id)).toBe(selectedId);
  await openIdentifyField(page, "dv");
  await page.getByRole("button", { name: "Review and add Alternative saved variable" }).click();
  await expect(page.locator("#definitionSave")).toBeEnabled();
  await page.locator("#definitionSave").click();
  await expect(page.locator("#definitionBlock")).toBeHidden();
  const replaced = await page.evaluate(() => {
    const project = window.__dagBuilderState.project;
    return { outcome: project.groups.find(group => group.group_id === project.dv_group_id)?.label,
      oldExists: project.groups.some(group => group.label === "Saved test variable"),
      memberships: project.groups.flatMap(group => group.variable_ids) };
  });
  expect(replaced.outcome).toBe("Alternative saved variable");
  expect(replaced.oldExists).toBe(false);
  expect(new Set(replaced.memberships).size).toBe(replaced.memberships.length);
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
  await startCreate(page, "iv");
  await page.locator("#definitionSourceSearch").fill(query);
  const row = page.locator(`#definitionSourceList input[data-source-id="${pick.id}"]`);
  await expect(row).toHaveCount(1, { timeout: 60000 });
  await expect(page.locator("#definitionSourceList .setup-group-variable-match").first()).toContainText("Matched:");
});

test("Classify 50 more appends to the list, sorts new first, and applying leaves only Save", async ({ browser }) => {
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
    await startCreate(page, "iv");
    await startAiSplit(page, { label: "School and college achievement", description: "School and college academic achievement" });
    await page.locator("#definitionAiConnect").click();
    await expect(page.locator("#definitionPartitionStep")).toBeVisible();
    await page.locator("#definitionAiDescription").fill("School and college academic achievement");
    await page.locator("#definitionAiRun").click();
    await expect(page.locator("#definitionAiRows .definition-ai-row")).toHaveCount(50);
    await expect(page.locator("#definitionAiMore")).toHaveText("Classify 50 more");
    // Applying needs every variable classified, not just the first rounds.
    await expect(page.locator("#definitionAiApply")).toBeHidden();
    const firstRound = batches.flat();
    expect(firstRound).toHaveLength(50);

    // An interrupted round keeps its ids; resuming retries the failed batch.
    await page.locator("#definitionAiMore").click();
    await expect(page.locator("#definitionAiStatus")).toContainText("Labeling paused");
    await expect(page.locator("#definitionAiMore")).toContainText("Resume (16 of 50 done)");
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
    const sides = async () => page.locator("#definitionAiRows .definition-ai-row").evaluateAll(rows =>
      rows.map(row => row.querySelector("button[aria-pressed=true]")?.dataset.aiSide));
    expect((await sides()).every(side => side === "new")).toBe(true);
    await page.locator("#definitionAiReviewNext").click();
    expect((await sides()).every(side => side === "leftover")).toBe(true);

    await expect(page.locator("#definitionAiApply")).toBeHidden();

    // Finishing the full split labels the rest, appends nothing twice, and unlocks applying.
    await page.locator("#definitionAiFullRun").click();
    await expect(page.locator("#definitionAiApply")).toBeVisible({ timeout: 90000 });
    await expect(page.locator("#definitionAiMore")).toBeHidden();
    const eligibleCount = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids.length);
    // Every variable is requested once, plus the one batch that failed and was retried.
    expect(batches.flat()).toHaveLength(eligibleCount + batches[5].length);
    await page.locator("#definitionAiApply").click();
    // The name and definition were written first, so applying leaves only Save.
    await expect(page.locator("#definitionSave")).toBeEnabled();
    expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBeGreaterThan(50);
    expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.new_description)).toBe("School and college academic achievement");
  } finally {
    await context.close();
  }
});

test("Exploration creates a variable from its picker, which becomes the focus without changing the anchors", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page, { warnings: true });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
  });
  await page.goto("http://127.0.0.1:8767/?task=causes", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20
    && window.__dagBuilderState.publishedSchemaHydrated && !window.__dagBuilderState.publishedSchemaHydrating);

  const anchorsBefore = await page.evaluate(() => {
    const { iv_group_id, dv_group_id } = window.__dagBuilderState.project;
    return { iv_group_id, dv_group_id };
  });
  await page.locator(".custom-create:visible").first().click();
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await describeVariable(page, { label: "Browser focus construct", description: "A browser test construct defined from the exploration view." });
  await expect(page.locator("#definitionPartitionStep")).toBeVisible();
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await includeConcepts(page, [variableId]);
  await page.locator("#definitionSave").click();

  // Saving makes the new variable the focus; it is not an anchor.
  await expect(page.locator("#definitionBlock")).toBeHidden();
  await expect(page.locator("#focusInput")).toHaveValue("Browser focus construct");
  const result = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    return { task: state.task, anchors: { iv_group_id: state.project.iv_group_id, dv_group_id: state.project.dv_group_id } };
  });
  expect(result.task).toBe("causes");
  expect(result.anchors).toEqual(anchorsBefore);
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

  await page.locator(".custom-create:visible").first().click();
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

test("previous local splits can be reused without changing the active schema first", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.some(group => group.variable_ids?.length >= 2)
    && window.__dagBuilderState.publishedSchemaHydrated);
  const fixture = await page.evaluate(async () => {
    const state = window.__dagBuilderState;
    const source = state.project.groups.find(group => group.variable_ids?.length >= 2 && group.variable_ids.length <= 20);
    const { commitLocalSchema } = await import("/local_schema_store.mjs");
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    dagDataSource.loadVariableMetadata = async ids => ids.map(id => ({ variable_id: id,
      index: parseInt(id.slice(1, 9), 16), display_label: id, concept_label: id,
      map_x: parseInt(id.slice(1, 9), 16), map_y: parseInt(id.slice(9, 17), 16) }));
    await commitLocalSchema({ id: "previous-split-test", schema: { groups: [{ group_id: "previous-split-test-group",
      label: "Previous local construct", description: "A construct saved in an earlier local draft.", source: "user_split",
      provenance: { operation: "split_categories", split_id: "previous-split-test-id", source_group_ids: [source.group_id],
        source_group_by_variable: Object.fromEntries(source.variable_ids.map(id => [id, source.group_id])) },
      variable_ids: [source.variable_ids[0]] }] }, url: location.href });
    return { sourceId: source.group_id, sourceLabel: source.label, before: state.project.groups.length };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated);
  await page.waitForFunction(id => window.__dagBuilderState?.project?.groups?.find(g => g.group_id === id)?.variable_ids?.length >= 2, fixture.sourceId, { timeout: 15000 });
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    dagDataSource.loadVariableMetadata = async ids => ids.map(id => ({ variable_id: id,
      index: parseInt(id.slice(1, 9), 16), display_label: id, concept_label: id,
      map_x: parseInt(id.slice(1, 9), 16), map_y: parseInt(id.slice(9, 17), 16) }));
  });
  await expect(page.getByRole("button", { name: "Review and add Previous local construct" })).toBeVisible();
  await page.getByRole("button", { name: "Review and add Previous local construct" }).click();
  await expect(page.locator("#definitionNewLabel")).toHaveValue("Previous local construct");
  expect(await page.evaluate(() => window.__dagBuilderState.project.groups.length)).toBe(fixture.before);
  expect(await page.evaluate(() => window.__dagBuilderState.definitionDraft.source_group_ids)).toEqual([fixture.sourceId]);
});
