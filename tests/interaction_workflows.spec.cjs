const { test, expect } = require("./fixtures.cjs");
const { chooseAnchor, chooseAnchors, startCreate } = require("./support/identify.cjs");
const { describeVariable, includeConcepts } = require("./support/definition.cjs");
const { chooseTask, openNav, closeNav } = require("./support/navigation.cjs");
const { readFile } = require("node:fs/promises");

const viewer = `http://127.0.0.1:${process.env.ECHO_TEST_PORT || 8767}/?task=identify`;

async function ready(page) {
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating);
}

async function selectedCatalogUrl(page) {
  return page.evaluate(async () => {
    const { searchCatalogs } = await import('/variable_search_catalog.mjs');
    const url = searchCatalogs.url(new URL(location.href).searchParams.get('data_version'));
    return url ? new URL(url, location.href).href : "";
  });
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  return anchors;
}

test("privacy policy opens without resetting the viewer", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(new URL("/", viewer).href);
  await ready(page);
  // The Privacy link is shown on the start page only.
  await expect(page.locator("#taskLanding")).toBeVisible();
  await page.evaluate(() => { window.__privacyViewerState = window.__dagBuilderState; });

  const [policy] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator(".legal-link").click(),
  ]);
  await expect(policy).toHaveURL(new URL("privacy.html", viewer).href);
  await expect(policy.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
  expect(await page.evaluate(() => window.__dagBuilderState === window.__privacyViewerState)).toBe(true);
  await policy.close();
  await expect(page.locator("#taskLanding")).toBeVisible();
  await chooseTask(page, "identify");
  await expect(page.locator(".legal-link")).toBeHidden();
});

test("selecting evidence in full screen returns to the standard layout", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  expect(anchors).toHaveLength(2);
  await chooseAnchors(page, anchors[0], anchors[1]);

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
  await startCreate(page, "iv");
  await page.locator("#definitionSourceSearch").fill("education");
  await expect(page.locator("#definitionSourceList input[data-source-id]").first()).toBeVisible();
  await page.locator("#definitionSourceSearch").fill("");
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  await page.locator("#definitionContinue").click();
  await describeVariable(page);
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  // Defining a variable never needs neighbor suggestions: the AI or an existing split supplies the concepts.
  expect(await page.evaluate(() => performance.getEntriesByName("echo:evidence:neighbors").length)).toBe(0);
  expect(await page.evaluate(() => window.__neighborQuerySizes)).toEqual([]);
  await page.locator("#definitionBack").click();
  await page.locator("#definitionDescribeBack").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("sources");
  await page.locator("#definitionContinue").click();
  await describeVariable(page);
  const variableId = await page.evaluate(() => window.__dagBuilderState.definitionDraft.eligible_variable_ids[0]);
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.step)).toBe("partition");
  await includeConcepts(page, [variableId]);
  expect(await page.evaluate(() => performance.getEntriesByName("echo:evidence:neighbors").length)).toBe(0);
  expect(await page.evaluate(() => window.__neighborQuerySizes)).toEqual([]);
  await page.locator(".definition-cancel:visible").click();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft)).toBeNull();
  await expect(page.locator("#identify-iv-input")).toBeVisible();
  const iv = await page.evaluate(() => window.__dagBuilderState.project.groups
    .find(group => group.variable_ids?.length)?.group_id);
  await chooseAnchor(page, "iv", iv);
  await startCreate(page, "dv");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.definitionDraft?.role)).toBe("dv");
  await page.locator(".definition-cancel:visible").click();
});

test("variable search catalog preloads once and serves anchor search", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const catalogRequests = [];
  page.on("request", request => {
    if (/\.json\.gz(?:\?|$)/.test(request.url())) catalogRequests.push(request.url());
  });
  await page.goto(viewer);
  await ready(page);
  // Setup preloads the catalog; focusing search must reuse it, not fetch it again.
  expect(["loading", "ready"]).toContain(await page.evaluate(() => window.__dagBuilderState.variableSearchStatus));
  await page.locator("#identify-iv-input").focus();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.variableSearchStatus)).toBe("ready");
  const catalogUrl = await selectedCatalogUrl(page);
  expect(catalogRequests.filter(url => url === catalogUrl)).toHaveLength(catalogUrl ? 1 : 0);
  await page.locator("#identify-iv-input").fill("education");
  await expect(page.locator("#identifyGroupPicker button[data-group-id]").first()).toBeVisible();
});

test("edge evidence renders provenance without loading map layouts", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const parquetRequests = [];
  const catalogRequests = [];
  page.on("request", request => {
    if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
    if (/\.json\.gz(?:\?|$)/.test(request.url())) catalogRequests.push(request.url());
  });
  // This checks the precomputed search-catalog path available for this snapshot.
  await page.goto(`${viewer}&schema=f22dab8b-d9a7-4047-a775-0216b31c79fc&data_version=99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0`);
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
  const catalogUrl = await selectedCatalogUrl(page);
  expect(catalogUrl).toBeTruthy();
  expect(catalogRequests.filter(url => url === catalogUrl)).toHaveLength(1);
});

test("evidence keeps available fields visible while concept labels load", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${viewer}&schema=f22dab8b-d9a7-4047-a775-0216b31c79fc&data_version=99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0`);
  await ready(page);
  await completeSetup(page);
  const edgeId = await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    // Seed evidence but not its endpoint labels: newer precomputed panels may
    // otherwise deliver both together and never enter the loading state.
    dagDataSource.loadVariableProvenance = ids => new Promise(resolve => {
      window.__releaseConceptLabels = () => resolve(ids.map(variable_id => ({ variable_id, concept_label: `Concept ${variable_id}` })));
    });
    const id = renderedDagEdgeIds().find(value => value !== "__study_design_iv_to_dv__"
      && window.__dagBuilderState.project.links.some(link => link.edge_id === value
        && (link.a_to_b_raw_link_ids?.length || link.b_to_a_raw_link_ids?.length)));
    if (id) {
      const state = window.__dagBuilderState;
      const link = state.project.links.find(item => item.edge_id === id);
      const source = state.project.groups.find(group => group.group_id === link.group_a).variable_ids[0];
      const target = state.project.groups.find(group => group.group_id === link.group_b).variable_ids[0];
      state.variableById.delete(source);
      state.variableById.delete(target);
      for (const [rawIds, from, to] of [[link.a_to_b_raw_link_ids || [], source, target], [link.b_to_a_raw_link_ids || [], target, source]]) {
        for (const rawId of rawIds) state.rawLinksById.set(rawId, { raw_causal_link_id: rawId,
          paper_id: "10.1234/test", paper_title: "Example paper", source_variable_id: from, target_variable_id: to });
      }
      inspectDagEdge(id);
    }
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

test("evidence replaces the map, the fields and list stay, and Back to map restores the graph", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(viewer);
  await ready(page);
  await completeSetup(page);
  const pane = page.locator(".dag-ws-footer");
  await expect(page.locator("#identifyFields")).toBeVisible();
  await expect(pane).toBeHidden();
  await page.evaluate(async () => {
    const { whenDagRendered, renderedDagEdgeIds, inspectDagEdge } = await import("/dag_builder.js?v=evidence-pane-v1");
    await whenDagRendered();
    inspectDagEdge(renderedDagEdgeIds().find(id => id !== "__study_design_iv_to_dv__"));
  });
  await expect(pane).toBeVisible();
  await expect(page.locator("#dagNetwork")).toBeHidden();
  await expect(page.locator("#identifyFields")).toBeVisible();
  await expect(page.locator("#closeEvidencePane")).toHaveText("Back to map", { useInnerText: true });
  await page.locator("#closeEvidencePane").click();
  await expect(page.locator("#dagNetwork")).toBeVisible();
  expect((await page.locator(".dag-network-wrapper").boundingBox()).height).toBeGreaterThan(600);
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

test("mobile definition waits for variable data before showing the concepts", async ({ page }) => {
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
  await startCreate(page, "iv");
  await page.locator('#definitionSourceList input[data-source-id]').first().check();
  await page.locator("#definitionContinue").click();
  await expect(page.locator("#definitionContinue")).toHaveText("Loading concepts…");
  await expect(page.locator("#definitionDescribeStep")).toBeHidden();
  await page.evaluate(() => window.__releaseVariableLoad());
  await expect(page.locator("#definitionDescribeStep")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.variables.length)).toBeGreaterThan(0);
});

test("project export can be imported with its anchors intact", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await chooseAnchors(page, anchors[0], anchors[1]);
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await page.locator("#copyPermalink").click();
  await expect(page.locator("#copyPermalink")).toHaveAttribute("aria-label", "Copied");
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
  await chooseAnchors(page, anchors[0], anchors[1]);
  await page.locator('[data-mobile-panel="dag"]').last().tap();
  // Fit does nothing until the graph has been drawn, so wait for it rather than racing the render.
  await page.evaluate(async () => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    await api.whenDagRendered();
  });
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
  await expect(share).toHaveAttribute("aria-label", "Copied");
  expect(await page.evaluate(() => window.__shareGestureActive)).toBe(true);
  expect(await page.evaluate(() => window.__sharedText)).toContain("iv=");
  await context.close();
});

test("mobile top bar, map and menu stay on screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto(viewer);
    await ready(page);
    await completeSetup(page);
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await expect(page.locator("#dagNetwork")).toBeVisible();
    const layout = await page.evaluate(() => {
      const bar = document.querySelector("#taskBar").getBoundingClientRect();
      const shell = document.querySelector(".dag-shell").getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth,
        barOverflow: document.querySelector("#taskBar").scrollWidth - document.querySelector("#taskBar").clientWidth,
        shellTop: shell.top, barBottom: bar.bottom, shellBottom: shell.bottom, viewport: window.innerHeight,
      };
    });
    expect(layout.page).toBeLessThanOrEqual(390);
    expect(layout.barOverflow).toBe(0);
    // The map starts under the top bar and fills the rest of the screen.
    expect(layout.shellTop).toBeGreaterThanOrEqual(layout.barBottom - 1);
    expect(layout.shellBottom).toBeGreaterThan(layout.viewport - 2);
    // The diagnostic switch and the other controls sit behind the menu button.
    await expect(page.locator(".dag-diagnostic-switch")).toBeHidden();
    await openNav(page, { tap: true });
    await expect(page.locator(".dag-diagnostic-switch")).toBeVisible();
    await expect(page.locator(".filter-dropdown-panel #toggleConfoundersOnly")).toHaveCount(0);
    await expect(page.locator("#toggleConfoundersOnly")).toHaveAttribute("aria-pressed", "true");
    await openNav(page, { tap: true });
    await page.locator("#toggleCollidersOnly").tap();
    await expect(page.locator("#toggleCollidersOnly")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#toggleConfoundersOnly")).toHaveAttribute("aria-pressed", "false");
    await openNav(page, { tap: true });
    await page.locator("#toggleConfoundersOnly").tap();
    await expect(page.locator("#toggleConfoundersOnly")).toHaveAttribute("aria-pressed", "true");
    await closeNav(page, { tap: true });
    await page.setViewportSize({ width: 320, height: 700 });
    const narrow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth,
      barOverflow: document.querySelector("#taskBar").scrollWidth - document.querySelector("#taskBar").clientWidth }));
    expect(narrow.page).toBeLessThanOrEqual(320);
    expect(narrow.barOverflow).toBe(0);
  } finally {
    await context.close();
  }
});

test("instrument diagnostics use the same mobile view switch", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto(viewer);
    await ready(page);
    const [iv, dv, instrument] = await page.evaluate(() => window.__dagBuilderState.project.groups
      .filter(group => group.variable_ids?.length).slice(0, 3).map(group => group.group_id));
    await chooseAnchor(page, "iv", iv, { tap: true });
    await chooseAnchor(page, "dv", dv, { tap: true });
    await chooseAnchor(page, "instrument", instrument, { tap: true });
    await page.locator('.mobile-panel-nav [data-mobile-panel="dag"]').tap();
    await openNav(page, { tap: true });
    await expect(page.locator("#toggleConfoundersOnly")).toBeHidden();
    await expect(page.locator("#toggleCollidersOnly")).toBeHidden();
    await expect(page.locator("#toggleExclusionViolations")).toBeVisible();
    await expect(page.locator("#toggleExclusionViolations")).toHaveAccessibleName(/Exclusion restriction violations \(\d+\)/);
    await expect(page.locator("#toggleExogeneity")).toBeVisible();
    await openNav(page, { tap: true });
    await page.locator("#toggleExogeneity").tap();
    await expect(page.locator("#toggleExogeneity")).toHaveAttribute("aria-pressed", "true");
    await openNav(page, { tap: true });
    await page.locator("#toggleExclusionViolations").tap();
    await expect(page.locator("#toggleExclusionViolations")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#toggleExogeneity")).toHaveAttribute("aria-pressed", "false");
    await openNav(page, { tap: true });
    const switchBox = await page.locator(".dag-diagnostic-switch").boundingBox();
    expect(switchBox.x).toBeGreaterThanOrEqual(0);
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close();
  }
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
  await chooseAnchors(page, anchors[0], anchors[1]);
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

for (const width of [390, 1440]) test(`Identify waits for membership loading before accepting a variable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  // Reproduce the interval between the compiled graph appearing and the full
  // published memberships arriving, without relying on network timing.
  await page.evaluate(() => { window.__dagBuilderState.publishedSchemaHydrating = true; });
  const input = page.locator("#identify-iv-input");
  await input.click();
  await input.fill("sleep");
  const picker = page.locator("#identifyGroupPicker");
  const choice = picker.locator('button[data-group-id="category-sleep"]');
  await expect(choice).toBeDisabled();
  await expect(picker).toContainText("Loading variable data before selection");
  await page.evaluate(() => { window.__dagBuilderState.publishedSchemaHydrating = false; });
  // Hydration normally rerenders the controls; an input event does the same here.
  await input.fill("slee");
  await input.fill("sleep");
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(input).toHaveValue("sleep");
  await expect.poll(() => page.evaluate(() => window.__dagBuilderState.project.iv_group_id)).toBe("category-sleep");
});

for (const width of [390, 1440]) test(`unfinished evidence reason survives leaving the panel at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${new URL(viewer).origin}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await chooseAnchors(page, anchors[0], anchors[1]);
  const openEvidence = () => page.evaluate(async () => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    api.inspectDagEdge("category-academic-achievement__category-macroeconomic-context");
  });
  await openEvidence();
  await page.getByRole("button", { name: /^Exclude finding / }).first().click();
  const reason = page.getByRole("combobox", { name: "Finding exclusion reason" });
  const detail = page.getByRole("textbox", { name: "Other exclusion reason" });
  await reason.selectOption("other");
  await detail.fill("A reason still being written");
  await page.locator("#closeEvidencePane").click();
  await openEvidence();
  await expect(reason).toHaveValue("other");
  await expect(detail).toHaveValue("A reason still being written");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: /^Exclude finding / }).first().click();
  await expect(reason).toHaveValue("not_relevant_to_target_population");
  await reason.selectOption("other");
  await expect(detail).toHaveValue("");
});

for (const width of [390, 1440]) test(`a partially selected Identify view survives reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await page.locator("#identify-iv-input").fill("sleep");
  await page.locator('#identifyGroupPicker button[data-group-id="category-sleep"]').click();
  await expect.poll(() => new URL(page.url()).searchParams.get("iv")).toBe("category-sleep");
  await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe("setup");
  await page.reload();
  await ready(page);
  await expect(page.locator("#identify-iv-input")).toHaveValue("sleep");
  await expect(page.locator('#identifyGroupPicker[data-picker-side="dv"]')).toBeVisible();
});

for (const width of [390, 1440]) test(`schema workspace survives reload at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await chooseAnchors(page, anchors[0], anchors[1]);
  if (width < 840) await page.locator('.mobile-panel-nav [data-mobile-panel="controls"]').click();
  await page.locator("#editVariableSchema").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("workspace")).toBe("schema");
  await page.reload();
  await ready(page);
  await expect(page.locator("#customVariablesView")).toBeVisible();
  await page.locator("#customVariablesClose").click();
  await expect.poll(() => new URL(page.url()).searchParams.has("workspace")).toBe(false);
});

test("mobile reload returns to the open evidence pane", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${new URL(viewer).origin}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await chooseAnchors(page, anchors[0], anchors[1]);
  const edge = "category-academic-achievement__category-macroeconomic-context";
  await page.evaluate(async id => {
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    api.inspectDagEdge(id);
  }, edge);
  await expect.poll(() => new URL(page.url()).searchParams.get("selected_edge")).toBe(edge);
  await page.reload();
  await ready(page);
  await expect(page.locator("#closeEvidencePane")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Exclude finding / }).first()).toBeVisible();
});

test("reload warns before discarding an unfinished variable definition", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  await startCreate(page, "iv");
  await page.locator("#definitionSourceList input[data-source-id]").first().check();
  const selectedSource = page.locator("#definitionSourceList input[data-source-id]").first();
  const dialogPromise = page.waitForEvent("dialog");
  const reloadPromise = page.reload({ timeout: 3000 }).catch(() => {});
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reloadPromise;
  await expect(selectedSource).toBeChecked();
});

test("a save finishing after navigation keeps the newer view in the address", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const result = await page.evaluate(async () => {
    const { createPersistentViewer } = await import("/persistent_viewer.mjs");
    const live = window.__dagBuilderState;
    const schema = { schema_version: "groupings-v3", grouping_set_id: "test", membership_unit: "canonical_variable",
      groups: [{ group_id: "a", label: "A", variable_ids: ["v1"] }] };
    const state = { project: { groups: schema.groups, iv_group_id: "", dv_group_id: "" },
      data: live.data, task: "causes", explore: { causes: { focusId: "a", depth: 1, minPapers: 2 },
        consequences: { focusId: "a", depth: 1, minPapers: 2 } }, workflowMode: "setup", definitionDraft: null };
    let release;
    const controller = createPersistentViewer({ state, getSchema: () => structuredClone(schema),
      saveSchema: ({ id }) => new Promise(resolve => { release = () => resolve({ id, revision: 1 }); }) });
    controller.start();
    schema.groups[0].label = "Edited";
    const saving = controller.commitDecision();
    state.task = "consequences";
    controller.viewerChanged();
    release();
    await saving;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { task: new URL(location.href).searchParams.get("task"), local: new URL(location.href).searchParams.has("local_schema") };
  });
  expect(result).toEqual({ task: "consequences", local: true });
});

test("an old source loading failure cannot replace the new draft's in-flight load", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const sourceId = await page.evaluate(async () => {
    const state = window.__dagBuilderState;
    const group = state.project.groups.find(g => g.variable_ids?.some(id => !state.variableById.has(id)));
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    window.__sourceLoads = [];
    dagDataSource.loadVariableMetadata = () => new Promise((resolve, reject) => window.__sourceLoads.push({ resolve, reject }));
    return group.group_id;
  });
  await startCreate(page, "iv");
  const source = page.locator(`#definitionSourceList input[data-source-id="${sourceId}"]`);
  await source.check();
  await expect.poll(() => page.evaluate(() => window.__sourceLoads.length)).toBe(1);
  await page.locator(".definition-cancel:visible").first().click();
  await startCreate(page, "iv");
  await source.check();
  await expect.poll(() => page.evaluate(() => window.__sourceLoads.length)).toBe(2);
  await page.evaluate(() => window.__sourceLoads[0].reject(new Error("old load failed")));
  await page.locator("#definitionContinue").click();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__sourceLoads.length)).toBe(2);
  await page.evaluate(() => window.__sourceLoads[1].resolve([]));
});

for (const mode of ["publish", "share"]) test(`a ${mode} finishing after another edit remains unpublished`, async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const result = await page.evaluate(async mode => {
    const { createPublicationController } = await import("/dag_publication.mjs");
    const { workingSchemaHashes } = await import("/dag_publication_core.mjs");
    let schema = { schema_version: "groupings-v3", grouping_set_id: "test", membership_unit: "canonical_variable",
      groups: [{ group_id: "a", label: "Before", variable_ids: ["v1"] }] };
    const originalHash = (await workingSchemaHashes(schema, crypto))[0];
    let publication = null, release, started;
    const publishing = new Promise(resolve => { started = resolve; });
    const elements = { publish: document.createElement("button"), status: document.createElement("div"),
      badge: document.createElement("span"), menuButton: document.createElement("button"), confirmation: null };
    const controller = createPublicationController({ elements, getWorkingSchema: () => structuredClone(schema),
      getPublicationState: () => publication, setPublicationState: value => { publication = value; },
      getPermalinkState: () => window.__dagBuilderState, saveWorkingState: () => {},
      windowApi: { location, confirm: () => true },
      publishSchema: () => { started(); return new Promise(resolve => { release = () => resolve({
        publicationId: "11111111-1111-4111-8111-111111111111", contentHash: originalHash, reused: false, fileCount: 1 }); }); } });
    controller.initialize();
    const pending = mode === "share" ? controller.publicPermalink() : controller.publish();
    await publishing;
    schema.groups[0].label = "Edited during upload";
    controller.workingCopyChanged();
    await new Promise(resolve => setTimeout(resolve, 400));
    release();
    const value = await pending;
    await new Promise(resolve => setTimeout(resolve, 400));
    return { badge: elements.badge.textContent, publishHidden: elements.publish.hidden, shared: mode === "share" && Boolean(value) };
  }, mode);
  expect(result).toEqual({ badge: "Unpublished changes", publishHidden: false, shared: false });
});

test("publication stops if the schema changes while its graph is being prepared", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(viewer);
  await ready(page);
  const result = await page.evaluate(async () => {
    const { createPublicationController } = await import("/dag_publication.mjs");
    let schema = { schema_version: "groupings-v3", grouping_set_id: "test", membership_unit: "canonical_variable",
      groups: [{ group_id: "a", label: "Before", variable_ids: ["v1"] }] };
    let release, started, published = false;
    const preparing = new Promise(resolve => { started = resolve; });
    const elements = { publish: document.createElement("button"), status: document.createElement("div"),
      badge: document.createElement("span"), menuButton: document.createElement("button"), confirmation: null };
    const controller = createPublicationController({ elements, getWorkingSchema: () => structuredClone(schema),
      getPublicationState: () => null, setPublicationState: () => {}, getPermalinkState: () => window.__dagBuilderState,
      saveWorkingState: () => {}, windowApi: { location, confirm: () => true },
      getCompileInput: () => { started(); return new Promise(resolve => { release = () => resolve({}); }); },
      publishSchema: async () => { published = true; throw new Error("unexpected publication"); } });
    controller.initialize();
    const pending = controller.publish();
    await preparing;
    schema.groups[0].label = "Changed during preparation";
    controller.workingCopyChanged();
    release();
    await pending;
    return { published, status: elements.status.textContent };
  });
  expect(result.published).toBe(false);
  expect(result.status).toMatch(/changed.*prepar/i);
});

for (const width of [390, 1440]) test(`failed evidence loading is reported at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto(`${new URL(viewer).origin}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`);
  await ready(page);
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  await chooseAnchors(page, anchors[0], anchors[1]);
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    window.__loadPanelEvidence = dagDataSource.loadPanelEvidence.bind(dagDataSource);
    dagDataSource.loadPanelEvidence = async () => { throw new Error("simulated evidence failure"); };
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    api.inspectDagEdge("category-academic-achievement__category-macroeconomic-context");
  });
  await expect(page.getByText("Evidence could not be loaded. Try again.")).toBeVisible();
  await expect(page.locator("#provenancePanel")).not.toContainText("No evidence records for this direction.");
  await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    dagDataSource.loadPanelEvidence = window.__loadPanelEvidence;
  });
  await page.getByRole("button", { name: "Retry evidence loading" }).click();
  await expect(page.getByRole("button", { name: /^Exclude finding / }).first()).toBeVisible();
});

for (const width of [390, 1440]) test(`the picker reports when saved variables could not be searched at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
    localStorage.setItem("echo-owner-token", `00000000-0000-4000-8000-000000000001.${"a".repeat(64)}`);
  });
  await page.route("**/v1/owners/publications", route => route.fulfill({ status: 500,
    headers: { "access-control-allow-origin": "*" }, body: "unavailable" }));
  await page.goto(viewer);
  await ready(page);
  await page.locator("#identify-iv-input").fill("unmatched saved name");
  const warning = page.getByText("Some saved variables could not be searched.", { exact: true });
  await expect(warning).toBeVisible();
  await page.unroute("**/v1/owners/publications");
  await page.route("**/v1/owners/publications", route => route.fulfill({ status: 200,
    headers: { "access-control-allow-origin": "*" }, contentType: "application/json", body: "[]" }));
  await page.getByRole("button", { name: "Retry saved variables" }).click();
  await expect(warning).toBeHidden();
});
