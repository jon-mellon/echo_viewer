const { test, expect } = require("playwright/test");

const base = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const snapshotId = "0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac";

for (const route of ["/"]) {
  test(`${route} loads its snapshot through DuckDB-Wasm`, async ({ page }) => {
    test.setTimeout(60000);
    await page.addInitScript(() => {
      window.__startupStages = [];
      window.addEventListener("startupstage", event => window.__startupStages.push(event.detail));
    });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    const parquetRequests = [];
    page.on("request", request => {
      if (request.url().endsWith(".parquet")) parquetRequests.push(request.url());
    });
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.variables?.length > 3000
      && document.getElementById("startupLoading")?.hidden, null,
      { timeout: 60000 });
    const state = await page.evaluate(() => ({
      variables: window.__dagBuilderState.variables.length,
      causalLinks: window.__dagBuilderState.rawLinks.length,
      snapshotId: window.__dagBuilderState.data.snapshot.snapshot_id,
      layout: window.__dagBuilderState.data.layout.active_source,
      groupingCount: window.__dagBuilderState.data.grouping_sets[0]?.groups?.length,
      firstVariableNeighbors: window.__dagBuilderState.variables[0]?.similarity_neighbors?.length,
      incomingLinks: window.__dagBuilderState.rawLinks.filter(
        link => link.outcome_variable_id === window.__dagBuilderState.rawLinks[0]?.outcome_variable_id,
      ).length,
      outgoingLinks: window.__dagBuilderState.rawLinks.filter(
        link => link.predictor_variable_id === window.__dagBuilderState.rawLinks[0]?.predictor_variable_id,
      ).length,
      startupStages: window.__startupStages,
      loadingFinished: document.getElementById("startupLoading")?.hidden,
    }));
    expect(state.variables).toBe(3081);
    expect(state.causalLinks).toBe(1572);
    expect(state.snapshotId).toBe(snapshotId);
    expect(state.layout).toBe("llm_corrected");
    expect(state.groupingCount).toBe(101);
    expect(state.firstVariableNeighbors).toBeGreaterThan(0);
    expect(state.incomingLinks).toBeGreaterThan(0);
    expect(state.outgoingLinks).toBeGreaterThan(0);
    expect(state.startupStages).toEqual(expect.arrayContaining([
      "Loading evidence manifest…",
      "Loading grouping schema…",
      "Starting query engine…",
      "Querying variables and relationships…",
      "Preparing workspace…",
      "Rendering graph…",
    ]));
    expect(state.loadingFinished).toBe(true);
    expect([...new Set(parquetRequests)]).toHaveLength(8);
    expect(parquetRequests.every(url => url.startsWith("https://data.epistemicinfra.org/evidence/"))).toBe(true);
    expect(errors.filter(error => !/favicon/i.test(error))).toEqual([]);

    const apiStatus = await page.evaluate(async () => (await fetch("/api/dag-data")).status);
    expect(apiStatus).toBe(404);
  });
}
