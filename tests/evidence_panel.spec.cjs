const { test, expect } = require("playwright/test");
const base = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const snapshot = "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";
const publication = "c221423a-9470-4c82-8a3d-8bcf4a01ef7c";
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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
