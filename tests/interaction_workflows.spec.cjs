const { test, expect } = require("playwright/test");
const { readFile } = require("node:fs/promises");

const viewer = "http://127.0.0.1:8767/";

async function ready(page) {
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
}

test("password gate rejects an incorrect entry and unlocks with the preview password", async ({ page }) => {
  await page.goto(viewer);
  await expect(page.locator("#passwordGate")).toBeVisible();
  await page.locator("#passwordGateInput").fill("incorrect");
  await page.locator("#passwordGateForm button[type=submit]").click();
  await expect(page.locator("#passwordGateError")).toBeVisible();
  await page.locator("#passwordGateInput").fill("12345");
  await expect(page.locator("#passwordGateError")).toBeHidden();
  await page.locator("#passwordGateForm button[type=submit]").click();
  await expect(page.locator("#passwordGate")).toBeHidden();
  await ready(page);
});

test("definition navigation returns through both Back steps and Cancel", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const loadNeighbors = dagDataSource.loadNeighbors.bind(dagDataSource);
    window.__neighborQuerySizes = [];
    dagDataSource.loadNeighbors = ids => {
      window.__neighborQuerySizes.push(ids.length);
      return loadNeighbors(ids);
    };
  });
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionSourceSearch").fill("education");
  await expect(page.locator("#definitionSourceList input[data-source-id]").first()).toBeVisible();
  await page.locator("#definitionSourceSearch").fill("");
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  // Opening a source only needs map records; neighbor suggestions are fetched
  // for selected variables when the person starts defining the new group.
  expect(await page.evaluate(() => performance.getEntriesByName("echo:evidence:neighbors").length)).toBe(0);
  expect(await page.evaluate(() => window.__neighborQuerySizes)).toEqual([]);
  await page.locator("#definitionBack").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("sources");
  await page.locator("#definitionContinue").click();
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(variableId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await expect.poll(() => page.evaluate(() => {
    const variables = performance.getEntriesByName("echo:evidence:variables").at(-1);
    const neighbors = performance.getEntriesByName("echo:evidence:neighbors").at(-1);
    return Boolean(variables && neighbors && neighbors.startTime >= variables.startTime + variables.duration);
  })).toBe(true);
  expect(await page.evaluate(() => window.__neighborQuerySizes)).toEqual([1]);
  await page.locator("#definitionReview").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("review");
  await page.locator("#definitionReviewBack").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  if (await page.locator("#definitionAddNeighbors").isEnabled()) {
    await page.locator("#definitionAddNeighbors").click();
  }
  await page.locator("#definitionCancel").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft)).toBeNull();
  await expect(page.locator("#ivGroupPicker")).toBeVisible();
  const iv = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.variable_ids?.length)?.group_id);
  await page.locator(`#ivGroupPicker button[data-group-id="${iv}"]`).click();
  await page.locator('#dvGroupPicker button[data-define-side="dv"]').click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.role)).toBe("dv");
  await page.locator("#definitionCancel").click();
});

test("variable search catalog starts loading when anchor search gets focus", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const catalogRequests = [];
  page.on("request", request => {
    if (request.url().includes("variable-search-catalog.json")) catalogRequests.push(request.url());
  });
  await page.goto(viewer);
  await ready(page);
  expect(await page.evaluate(() => window.__dagBuilderState.variableSearchStatus)).toBe("idle");
  await page.locator("#ivInput").focus();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.variableSearchStatus)).toBe("ready");
  expect(catalogRequests).toHaveLength(1);
  await page.locator("#ivInput").fill("education");
  await expect(page.locator("#ivGroupPicker button[data-group-id]").first()).toBeVisible();
});

test("map context menu changes a definition selection and closes with Escape", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await page.locator("#definitionVariableSearch").fill(variableId);
  await page.locator("#definitionVariableResults .result-button").first().click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.selectedVariableIds.size)).toBeGreaterThan(0);
  await page.locator("#dagMapCanvas").click({ button: "right", position: { x: 450, y: 360 }, timeout: 5_000 });
  await expect(page.locator("#dagMapContextMenu")).toBeVisible();
  await page.locator('#dagMapContextMenu button[data-definition-action="remove"]').click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(0);
  await page.locator("#dagMapCanvas").click({ button: "right", position: { x: 450, y: 360 }, timeout: 5_000 });
  await page.locator('#dagMapContextMenu button[data-definition-action="add"]').click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft.new_variable_ids.length)).toBe(1);
  await page.locator("#dagMapCanvas").click({ button: "right", position: { x: 450, y: 360 }, timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator("#dagMapContextMenu")).toBeHidden();
});

test("exclusion reason survives an evidence inspector refresh", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const edgeId = await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    const id = renderedDagEdgeIds().find(value => value !== "__study_design_iv_to_dv__");
    inspectDagEdge(id);
    return id;
  });
  expect(edgeId).toBeTruthy();
  await page.locator('#edgeInspector button[data-edge-action="exclude"]').click();
  await page.locator("#excludeReasonInput").fill("Check evidence before excluding");
  await page.evaluate(async id => {
    const { inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    inspectDagEdge(id);
  }, edgeId);
  await expect(page.locator("#excludeReasonRow")).toBeVisible();
  await expect(page.locator("#excludeReasonInput")).toHaveValue("Check evidence before excluding");
  await page.locator("#excludeConfirmBtn").click();
  await expect.poll(() => page.evaluate(id =>
    window.__dagBuilderState.project.link_decisions[id]?.display_status, edgeId)).toBe("excluded");
});

test("edge evidence renders provenance without loading map layouts", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const parquetRequests = [];
  page.on("request", request => {
    if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
  });
  await page.goto(viewer);
  await ready(page);
  const edgeId = await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    const id = renderedDagEdgeIds().find(value => value !== "__study_design_iv_to_dv__"
      && window.__dagBuilderState.project.links.some(link => link.edge_id === value
        && (link.a_to_b_raw_link_ids?.length || link.b_to_a_raw_link_ids?.length)));
    if (id) inspectDagEdge(id);
    return id;
  });
  expect(edgeId).toBeTruthy();
  await expect(page.locator("#provenancePanel tbody tr").first()).toBeVisible();
  expect(parquetRequests.some(url => url.endsWith("/variable_layouts.parquet"))).toBe(false);
  expect(parquetRequests.some(url => url.includes("/variables/shard-"))).toBe(true);
});

test("evidence replaces the desktop sidebar and closing it restores navigation", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(viewer);
  await ready(page);
  const pane = page.locator(".dag-ws-footer");
  await expect(page.locator(".panel-header")).toBeVisible();
  await expect(pane).toBeHidden();
  await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    inspectDagEdge(renderedDagEdgeIds().find(id => id !== "__study_design_iv_to_dv__"));
  });
  await expect(pane).toBeVisible();
  await expect(page.locator(".panel-header")).toBeHidden();
  expect(await pane.evaluate(node => node.parentElement.className)).toContain("dag-left-panel");
  expect((await page.locator(".dag-network-wrapper").boundingBox()).height).toBeGreaterThan(600);
  await page.locator("#closeEvidencePane").click();
  await expect(page.locator(".panel-header")).toBeVisible();
  await expect(pane).toBeHidden();

  await page.setViewportSize({ width: 390, height: 800 });
  await expect.poll(() => pane.evaluate(node => node.parentElement.id)).toBe("dagWorkspaceSection");
  await expect(pane).toBeHidden();
});

test("project export can be imported with its anchors intact", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator("#exportToggleBtn").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportProject").click();
  const download = await downloadPromise;
  const payload = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(payload.iv_group_id).toBe(anchors[0]);
  expect(payload.dv_group_id).toBe(anchors[1]);
  await page.locator("#projectImport").setInputFiles({
    name: "dag_project.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect.poll(() => page.evaluate(() => [window.__dagBuilderState.project.iv_group_id,
    window.__dagBuilderState.project.dv_group_id])).toEqual(anchors);
  await expect(page.locator("#dagWorkspaceSection")).toBeVisible();
});

test("Share view copies the selected public permalink", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: viewer });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator("#copyPermalink").click();
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.searchParams.get("iv")).toBe(anchors[0]);
  expect(copied.searchParams.get("dv")).toBe(anchors[1]);
  await expect(page.locator("#copyPermalink")).toContainText("Copied");
});

test("bibliography, Markdown, and LaTeX export controls produce downloads", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.route("https://api.crossref.org/**", route => route.fulfill({ status: 404, body: "" }));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator("#exportToggleBtn").click();
  for (const [button, filename] of [
    ["#exportBib", "references.bib"],
    ["#exportMd", "causal_map.zip"],
    ["#exportTex", "causal_map_latex.zip"],
  ]) {
    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await page.locator(button).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
  }
});
