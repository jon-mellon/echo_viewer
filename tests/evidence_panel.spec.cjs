const { test, expect } = require("playwright/test");
const base = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const snapshot = "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";
const publication = "c221423a-9470-4c82-8a3d-8bcf4a01ef7c";
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function completeSetup(page) {
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  expect(anchors).toHaveLength(2);
  await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
  await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
  await page.locator('#instrumentGroupPicker button[data-select-none]').click();
  await expect(page.locator('body')).not.toHaveClass(/initial-setup/);
}

for (const corrupt of [false, true]) {
  test(`mobile evidence source loading, corrupt bundle=${corrupt}`, async ({ page, context, browserName }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    if (corrupt) await page.route("**/evidence-panels/**/*.json.gz", async route => {
      if (route.request().url().endsWith("index.json.gz")) return route.continue();
      return route.fulfill({ status: 200, body: "corrupt" });
    });
    await page.goto(`${base}/?schema=${publication}&data_version=${snapshot}`);
    await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
      && document.getElementById("startupLoading")?.hidden);
    await completeSetup(page);
    await page.locator('button[data-mobile-panel="dag"]').click();
    if (!corrupt && browserName === "chromium") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 150, downloadThroughput: 200 * 1024, uploadThroughput: 100 * 1024,
      });
    }
    const requests = [];
    page.on("request", r => requests.push(r.url()));
    const started = Date.now();
    await page.evaluate(async () => {
      const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
      api.inspectDagEdge("category-academic-achievement__category-macroeconomic-context");
    });
    await page.getByRole("button", { name: /^Exclude finding / }).first().waitFor();
    await page.waitForFunction(() => !window.__dagBuilderState.pendingEdgeEvidence);
    const firstMs = Date.now() - started;
    expect(await page.getByText("Loading sources…", { exact: true }).count()).toBe(0);
    const state = await page.evaluate(async () => {
      const { dagDataSource: source } = await import("/dag_data_source.mjs?v=browser-v2");
      const s = window.__dagBuilderState;
      return { engine: Boolean(source.connection), findings: s.rawLinksById.size,
        labels: [...s.variableById.values()].map(v => v.concept_label || v.display_label),
        snapshot: s.data.snapshot.snapshot_id };
    });
    expect(state.findings).toBe(2);
    expect(state.labels.every(Boolean)).toBe(true);
    expect(state.snapshot).toBe(snapshot);
    expect(state.engine).toBe(corrupt);
    if (!corrupt) {
      expect(requests.filter(url => /duckdb|\.parquet|search-catalogs/.test(url))).toEqual([]);
      expect(requests.filter(url => /evidence-panels.*json.gz/.test(url))).toHaveLength(2);
      await page.evaluate(() => {
        const s = window.__dagBuilderState;
        window.__decisionCompiled = s.compiledDag;
        window.__decisionMembers = s.project.groups.map(g => g.variable_ids);
      });
      await page.locator('[data-edge-action="exclude"]').click();
      await page.locator("#excludeReasonInput").fill("Verify display-only exclusion");
      await page.locator("#excludeConfirmBtn").click();
      await page.locator('[data-edge-action="restore"]').waitFor();
      await page.locator('[data-edge-action="restore"]').click();
      await page.locator('[data-edge-action="exclude"]').waitFor();
      expect(await page.evaluate(() => {
        const s = window.__dagBuilderState;
        return s.compiledDag === window.__decisionCompiled
          && s.project.groups.every((g, i) => g.variable_ids === window.__decisionMembers[i])
          && !s.project.link_decisions["category-academic-achievement__category-macroeconomic-context"];
      })).toBe(true);
    }
    console.log("Mobile evidence", { corrupt, browserName, firstMs, requests: requests.length });
  });
}

test("a newer path filter supersedes a dense graph while installation is pending", async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (String(url).includes("dag_layout_worker")) this.addEventListener("message", () => {
          if (!window.__supersedeDenseGraph) return;
          window.__supersedeDenseGraph = false;
          queueMicrotask(() => {
            const input = document.getElementById("confounderPathLength");
            input.value = "1";
            input.dispatchEvent(new Event("input", { bubbles: true }));
            window.__supersededDenseGraph = true;
          });
        });
      }
    };
  });
  await page.goto(`${base}/?schema=${publication}&data_version=${snapshot}`);
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
    && window.__dagBuilderState?.project && document.getElementById("startupLoading")?.hidden);
  await completeSetup(page);
  await page.locator('button[data-mobile-panel="dag"]').click();
  const settled = () => page.evaluate(async () => (await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src)).whenDagRendered());
  await settled();
  await page.locator('.filter-dropdown > summary').click();
  for (const id of ["toggleCollidersOnly", "toggleConfoundersOnly", "toggleBottleneckedConfounders", "toggleIrrelevantConfounderLinks"]) {
    await page.locator(`#${id}`).click();
    await settled();
  }
  await page.evaluate(() => { window.__supersedeDenseGraph = true; });
  await page.locator("#confounderPathLength").fill("2");
  await page.waitForFunction(() => window.__supersededDenseGraph, null, { timeout: 30000 });
  await settled();
  const state = await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    const s = window.__dagBuilderState;
    const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
    const groups = new Set(s.project.groups.filter(g => s.componentGroupIds.has(g.group_id)
      && g.type !== "other" && g.group_id !== "other" && String(g.label || "").trim().toLowerCase() !== "other").map(g => g.group_id));
    return { length: s.confounderMaxPathLength,
      expected: s.visibleLinks.filter(e => !e.is_target_relation && groups.has(e.group_a) && groups.has(e.group_b)).map(e => e.edge_id).sort(),
      actual: api.renderedDagEdgeIds().filter(id => !id.startsWith("__study_")).sort() };
  });
  expect(state.length).toBe(1);
  expect(state.actual).toEqual(state.expected);
});
