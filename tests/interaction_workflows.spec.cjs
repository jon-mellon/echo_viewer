const { test, expect } = require("playwright/test");
const { readFile } = require("node:fs/promises");

const viewer = "http://127.0.0.1:8767/";

async function ready(page) {
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
}

async function completeSetup(page) {
  const anchors = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const link = state.project.links.find(item => (item.a_to_b_raw_link_ids?.length || item.b_to_a_raw_link_ids?.length)
      && state.project.groups.some(group => group.group_id === item.group_a && group.variable_ids?.length)
      && state.project.groups.some(group => group.group_id === item.group_b && group.variable_ids?.length));
    return link ? [link.group_a, link.group_b] : state.project.groups
      .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id);
  });
  expect(anchors).toHaveLength(2);
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await expect(page.locator('#instrumentGroupPicker button[data-select-none]')).toBeVisible();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await expect(page.locator('body')).not.toHaveClass(/initial-setup/);
  return anchors;
}

test("privacy policy opens without resetting the viewer", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
  await page.evaluate(() => { window.__privacyViewerState = window.__dagBuilderState; });

  const [policy] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator(".legal-link").click(),
  ]);
  await expect(policy).toHaveURL(`${viewer}privacy.html`);
  await expect(policy.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState === window.__privacyViewerState)).toBe(true);
  await policy.close();
  await expect(page.locator("#dagWorkspaceSection")).toBeVisible();
});

test("selecting evidence in full screen returns to the standard layout", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  expect(anchors).toHaveLength(2);
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();

  await page.locator("#fullscreenDag").click();
  await expect(page.locator("#fullscreenDag")).toHaveAttribute("aria-pressed", "true");
  const edgeId = await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    const id = renderedDagEdgeIds().find(value => value !== "__study_design_iv_to_dv__");
    inspectDagEdge(id);
    return id;
  });
  expect(edgeId).toBeTruthy();
  await expect(page.locator("#fullscreenDag")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#edgeInspector")).toBeVisible();
});

test("selecting a definition variable in full screen keeps the editor open", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionChooseManual").click();
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await page.locator("#definitionMethodManual").click();
  await expect(page.locator("#dagMapCanvas")).toBeVisible();
  await page.locator("#fullscreenVariableMap").click();
  await expect(page.locator("#fullscreenVariableMap")).toHaveAttribute("aria-pressed", "true");
  // The map keeps fitting itself for a moment after full screen starts, and a slow runner can take a click before
  // its hit-testing is ready. Aim again from the map's current transform until a click lands.
  const aim = () => page.evaluate(() => {
    const state = window.__dagBuilderState;
    const rect = state.map.canvas.getBoundingClientRect();
    const { scale, tx, ty } = state.map.transform;
    const eligible = new Set(state.definitionDraft.eligible_variable_ids);
    for (const variable of state.variableById.values()) {
      if (!eligible.has(variable.variable_id)) continue;
      const x = variable.map_x * scale + tx;
      const y = variable.map_y * scale + ty;
      if (Number.isFinite(x) && Number.isFinite(y)
        && x > 30 && y > 100 && x < rect.width - 30 && y < rect.height - 30) {
        return { id: variable.variable_id, x: rect.left + x, y: rect.top + y };
      }
    }
    return null;
  });
  let landed = false;
  for (let attempt = 0; attempt < 5 && !landed; attempt++) {
    await page.waitForTimeout(attempt ? 600 : 100);
    const point = await aim();
    expect(point).toBeTruthy();
    await page.mouse.click(point.x, point.y);
    landed = await expect.poll(() => page.evaluate(id =>
      window.__dagBuilderState.definitionDraft.new_variable_ids.includes(id), point.id), { timeout: 3000 })
      .toBe(true).then(() => true, () => false);
  }
  expect(landed).toBe(true);
  await expect(page.locator("#fullscreenVariableMap")).toHaveAttribute("aria-pressed", "true");
});

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
  await page.locator("#definitionChooseManual").click();
  await page.locator("#definitionSourceSearch").fill("education");
  await expect(page.locator("#definitionSourceList input[data-source-id]").first()).toBeVisible();
  await page.locator("#definitionSourceSearch").fill("");
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  await page.locator("#definitionMethodManual").click();
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
    if (/\/search-catalogs\/[^/]+\.json\.gz(?:\?|$)/.test(request.url())) catalogRequests.push(request.url());
  });
  await page.goto(viewer);
  await ready(page);
  expect(await page.evaluate(() => window.__dagBuilderState.variableSearchStatus)).toBe("idle");
  await page.locator("#ivInput").focus();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.variableSearchStatus)).toBe("ready");
  const hasStaticCatalog = await page.evaluate(async () => {
    const { SNAPSHOT_SEARCH_CATALOGS } = await import('/variable_search_catalog.mjs');
    return Boolean(SNAPSHOT_SEARCH_CATALOGS[new URL(location.href).searchParams.get('data_version')]);
  });
  expect(catalogRequests).toHaveLength(hasStaticCatalog ? 1 : 0);
  await page.locator("#ivInput").fill("education");
  await expect(page.locator("#ivGroupPicker button[data-group-id]").first()).toBeVisible();
});

test("map context menu changes a definition selection and closes with Escape", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionChooseManual").click();
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  await page.locator("#definitionMethodManual").click();
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
  await completeSetup(page);
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
  const catalogRequests = [];
  page.on("request", request => {
    if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
    if (/\/search-catalogs\/[^/]+\.json\.gz(?:\?|$)/.test(request.url())) catalogRequests.push(request.url());
  });
  // This checks the precomputed search-catalog path available for this snapshot.
  await page.goto(`${viewer}?schema=f22dab8b-d9a7-4047-a775-0216b31c79fc&data_version=99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0`);
  await ready(page);
  await completeSetup(page);
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
  await expect(page.locator("#provenancePanel .concept-loading")).toHaveCount(0);
  expect(parquetRequests.some(url => url.endsWith("/variable_layouts.parquet"))).toBe(false);
  expect(catalogRequests).toHaveLength(1);
});

test("evidence keeps available fields visible while concept labels load", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
  const edgeId = await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    const original = dagDataSource.loadVariableProvenance.bind(dagDataSource);
    dagDataSource.loadVariableProvenance = ids => new Promise(resolve => {
      window.__releaseConceptLabels = async () => resolve(await original(ids));
    });
    const id = renderedDagEdgeIds().find(value => value !== "__study_design_iv_to_dv__"
      && window.__dagBuilderState.project.links.some(link => link.edge_id === value
        && (link.a_to_b_raw_link_ids?.length || link.b_to_a_raw_link_ids?.length)));
    if (id) inspectDagEdge(id);
    return id;
  });
  expect(edgeId).toBeTruthy();
  await expect(page.locator("#provenancePanel .concept-loading").first()).toBeVisible();
  const loadingRow = page.locator("#provenancePanel tbody tr").filter({ has: page.locator(".concept-loading") }).first();
  await expect(loadingRow.locator("td").first()).not.toBeEmpty();
  await expect(loadingRow.locator("td").nth(2)).not.toBeEmpty();
  await expect(loadingRow.locator(".concept-loading .inline-spinner").first()).toBeVisible();
  expect((await page.locator("#provenancePanel .concept-loading").allTextContents())
    .every(text => text.trim() === "Loading…")).toBe(true);
  await page.evaluate(() => window.__releaseConceptLabels());
  await expect(page.locator("#provenancePanel .concept-loading")).toHaveCount(0);
});

test("evidence replaces the desktop sidebar and closing it restores navigation", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
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

test("Map tab returns from mobile evidence to the DAG", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
  await page.locator('button[data-mobile-panel="dag"]').click();
  await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    inspectDagEdge(renderedDagEdgeIds().find(id => id !== "__study_design_iv_to_dv__"));
  });
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  await expect(page.locator(".dag-network-wrapper")).toBeHidden();

  const closeBox = await page.locator("#closeEvidencePane").boundingBox();
  expect(closeBox.x).toBeGreaterThanOrEqual(0);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(390);
  await page.locator("#closeEvidencePane").click();
  await expect(page.locator(".dag-network-wrapper")).toBeVisible();
  await page.evaluate(async () => {
    const { renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    inspectDagEdge(renderedDagEdgeIds().find(id => id !== "__study_design_iv_to_dv__"));
  });
  await expect(page.locator("#closeEvidencePane")).toBeVisible();

  await page.locator('button[data-mobile-panel="dag"]').click();
  await expect(page.locator("#closeEvidencePane")).toBeHidden();
  await expect(page.locator(".dag-network-wrapper")).toBeVisible();
  await expect(page.locator(".dag-ws-footer")).toBeHidden();
  await expect(page.locator('button[data-mobile-panel="dag"]')).toHaveAttribute("aria-pressed", "true");
});

test("mobile evidence tables reopen at their left edge", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
  await page.locator('button[data-mobile-panel="dag"]').click();
  const openEvidence = () => page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    inspectDagEdge(renderedDagEdgeIds().find(id => id !== "__study_design_iv_to_dv__"
      && window.__dagBuilderState.project.links.some(link => link.edge_id === id
        && (link.a_to_b_raw_link_ids?.length || link.b_to_a_raw_link_ids?.length))));
  });
  await openEvidence();
  const panel = page.locator("#provenancePanel");
  const table = panel.locator("table").first();
  // This exercises live evidence retrieval; allow slower CI data fetches while
  // still requiring the table to render before testing scroll behavior.
  await expect(table).toBeVisible({ timeout: 60_000 });
  const initial = await panel.evaluate(node => ({ scroll: node.scrollLeft,
    left: node.getBoundingClientRect().left, tableLeft: node.querySelector("table").getBoundingClientRect().left }));
  expect(initial.scroll).toBe(0);
  expect(initial.tableLeft).toBeGreaterThanOrEqual(initial.left);
  await panel.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  expect(await panel.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  await page.locator("#closeEvidencePane").click();
  await openEvidence();
  await expect(table).toBeVisible();
  expect(await panel.evaluate(node => node.scrollLeft)).toBe(0);
});

test("pinching the mobile variable map zooms the map without selecting a variable", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(viewer);
  await ready(page);
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionChooseManual").click();
  await expect(page.locator('#definitionSourceList input[data-source-id]').first()).toBeVisible();
  await page.locator('#definitionSourceList input[data-source-id]').first().check();
  await page.locator('#definitionContinue').click();
  await page.locator('button[data-mobile-panel="variables"]').click();
  await expect(page.locator('button[data-mobile-panel="dag"]')).toBeHidden();
  await expect(page.locator('.mobile-panel-nav .mobile-panel-tab:visible')).toHaveCount(2);
  const canvas = page.locator('#dagMapCanvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(node => node.width)).toBeGreaterThan(100);
  expect(await canvas.evaluate(node => getComputedStyle(node).touchAction)).toBe('none');

  const box = await canvas.boundingBox();
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const before = await page.evaluate(() => window.__dagBuilderState.map.transform.scale);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const point = (x, id) => ({ x, y: centerY, id });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [point(centerX - 30, 1)],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [point(centerX - 30, 1), point(centerX + 30, 2)],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [point(centerX - 65, 1), point(centerX + 65, 2)],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.map.transform.scale)).toBeGreaterThan(before);
  expect(await page.evaluate(() => window.__dagBuilderState.selectedVariableIds.size)).toBe(0);
});

test("mobile definition waits for variable data before opening the map", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(viewer);
  await ready(page);
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const load = dagDataSource.loadVariableMetadata.bind(dagDataSource);
    const gate = new Promise(resolve => { window.__releaseVariableLoad = resolve; });
    dagDataSource.loadVariableMetadata = async (...args) => { await gate; return load(...args); };
  });
  await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
  await page.locator("#definitionChooseManual").click();
  await page.locator('#definitionSourceList input[data-source-id]').first().check();
  await page.locator("#definitionContinue").click();
  await expect(page.locator("#definitionContinue")).toHaveText("Loading selected variables…");
  await expect(page.locator('button[data-mobile-panel="variables"]')).toBeHidden();
  await page.evaluate(() => window.__releaseVariableLoad());
  await expect(page.locator('button[data-mobile-panel="variables"]')).toBeVisible();
  await page.locator('button[data-mobile-panel="variables"]').click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.variables.length)).toBeGreaterThan(0);
  await expect(page.locator('#variableAssignmentCounts')).not.toHaveText(/0 assigned\s*0 unassigned/);
});

test("project export can be imported with its anchors intact", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
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
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toContainText("Copied");
  const copied = new URL(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.searchParams.get("iv")).toBe(anchors[0]);
  expect(copied.searchParams.get("dv")).toBe(anchors[1]);
});

test("mobile map controls accept taps and sharing falls back when clipboard access fails", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
  });
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await page.locator('[data-mobile-panel="dag"]').last().tap();
  const fit = page.locator("#dagSvgFit");
  await fit.scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    const original = window.vis.Network.prototype.moveTo;
    window.vis.Network.prototype.moveTo = function (...args) {
      const result = original.apply(this, args);
      window.__fitNetwork = this;
      return result;
    };
  });
  await fit.tap();
  await expect.poll(() => page.evaluate(() => Boolean(window.__fitNetwork))).toBe(true);
  const fitResult = await page.evaluate(() => {
    const net = window.__fitNetwork, rect = document.querySelector('#dagNetwork').getBoundingClientRect();
    return net.body.nodeIndices.map(id => {
      const point = String(id).startsWith('__route__') ? net.getPositions([id])[id] : null;
      const box = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y }
        : net.getBoundingBox(id);
      const a = net.canvasToDOM({ x: box.left, y: box.top });
      const b = net.canvasToDOM({ x: box.right, y: box.bottom });
      return { id, a, b, width: rect.width, height: rect.height };
    }).filter(({a,b,width,height}) => !(a.x >= -1 && a.y >= -1 && b.x <= width + 1 && b.y <= height + 1));
  });
  expect(fitResult).toEqual([]);
  const share = page.locator("#copyPermalink");
  await share.scrollIntoViewIfNeeded();
  page.once("dialog", dialog => {
    expect(dialog.message()).toContain("Copy this permalink");
    expect(dialog.defaultValue()).toContain("iv=");
    return dialog.dismiss();
  });
  await share.tap();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async items => { window.__shareGestureActive = navigator.userActivation.isActive;
        window.__sharedText = await (await items[0].getType("text/plain")).text(); },
    } });
  });
  await share.tap();
  await expect(share).toContainText("Copied");
  expect(await page.evaluate(() => window.__shareGestureActive)).toBe(true);
  expect(await page.evaluate(() => window.__sharedText)).toContain("iv=");
  await context.close();
});

test("bibliography, Markdown, and LaTeX export controls produce downloads", async ({ page }) => {
  // The combined graph can cite hundreds of papers. Enrichment is deliberately
  // rate-limited to five Crossref requests per second and is reused by exports.
  test.setTimeout(600_000);
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.route("https://api.crossref.org/**", route => route.fulfill({ status: 404, body: "" }));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await page.locator("#exportToggleBtn").click();
  for (const [button, filename] of [
    ["#exportBib", "references.bib"],
    ["#exportMd", "causal_map.zip"],
    ["#exportTex", "causal_map_latex.zip"],
  ]) {
    const downloadPromise = page.waitForEvent("download", { timeout: 300_000 });
    await page.locator(button).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(filename);
    expect(await download.failure()).toBeNull();
  }
});
