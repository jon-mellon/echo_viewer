const { test, expect } = require("playwright/test");

test("DAG2 defines a canonical variable from per-source residual slices", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) errors.push(message.text()); });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("dag2-test-initialized")) {
      localStorage.clear();
      sessionStorage.setItem("dag2-test-initialized", "1");
    }
  });
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 20);

  await expect(page.locator("#ivGroupPicker [data-define-side=iv]")).toBeVisible();
  await page.locator("#ivGroupPicker [data-define-side=iv]").click();
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
  await expect(page.locator("body")).toHaveClass(/defining-variable/);
  await expect(page.locator("#dagMapCanvas")).toBeVisible();
  await expect(page.locator("#dagWorkspaceSection")).toBeHidden();
  await expect.poll(() => page.locator("#dagMapCanvas").evaluate(canvas => canvas.width)).toBeGreaterThan(100);
  await expect.poll(() => page.locator("#dagMapCanvas").evaluate(canvas => canvas.height)).toBeGreaterThan(100);

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
  const storedHistory = await page.evaluate(() => Math.max(0, ...Object.values(localStorage)
    .map(value => { try { return JSON.parse(value).undoHistory?.length || 0; } catch { return 0; } })));
  expect(storedHistory).toBeGreaterThan(0);
  const keysBeforeReload = await page.evaluate(() => Object.keys(localStorage));
  const savedProject = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keysBeforeReload[0]);
  expect(savedProject.schema_version).toBe("dag-builder-project-v1");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups?.length > 0);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(keysBeforeReload);
  const restoredState = await page.evaluate(() => ({ projectId: window.__dagBuilderState.project.project_id,
    history: window.__dagBuilderState.undoHistory.length }));
  expect(restoredState.projectId, errors.join("\n")).toBe(savedProject.project_id);
  expect(restoredState.history).toBeGreaterThan(0);
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
  expect(errors.filter(error => !/favicon|Range request .* did not return a partial response/i.test(error))).toEqual([]);
});
