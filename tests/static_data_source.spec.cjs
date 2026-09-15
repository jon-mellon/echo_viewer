const { test, expect } = require("playwright/test");

const base = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const snapshotId = "0cbb5b3bf27fbcde88e82cf5d810b8ad6c2cfbe9fdfea1b60be8f1e500a9b4ac";

for (const route of ["/"]) {
  test(`${route} loads compiled startup and retrieves browser-v2 evidence shards`, async ({ page }) => {
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
    await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
      && document.getElementById("startupLoading")?.hidden, null,
      { timeout: 60000 });
    const state = await page.evaluate(async () => {
      const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
      const [variables, neighbors, links] = await Promise.all([
        dagDataSource.loadVariableMetadata(["v000236"]),
        dagDataSource.loadNeighbors(["v000236"]),
        dagDataSource.loadIncidentRawLinks(["v000236"]),
      ]);
      return {
      variables, neighbors, links,
      snapshotId: window.__dagBuilderState.data.snapshot.snapshot_id,
      groupingCount: window.__dagBuilderState.data.grouping_sets[0]?.groups?.length,
      startupStages: window.__startupStages,
      loadingFinished: document.getElementById("startupLoading")?.hidden,
    }});
    expect(state.variables).toHaveLength(1);
    expect(state.variables[0].variable_id).toBe("v000236");
    expect(state.neighbors.length).toBeGreaterThan(0);
    expect(new Set(state.links.map(link => link.raw_causal_link_id)).size).toBe(state.links.length);
    expect(state.links.every(link => link.source_variable_id === "v000236"
      || link.target_variable_id === "v000236")).toBe(true);
    expect(state.snapshotId).toBe(snapshotId);
    expect(state.groupingCount).toBe(101);
    expect(state.startupStages).toEqual(expect.arrayContaining([
      "Loading published schema and compiled DAG…",
      "Preparing workspace…",
      "Rendering graph…",
    ]));
    expect(state.loadingFinished).toBe(true);
    const uniqueParquetRequests = [...new Set(parquetRequests)];
    expect(uniqueParquetRequests.some(url => url.includes("/lookup/variable-shards.parquet"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/variables/shard-"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/neighbors/shard-"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/causal-links/by-source/shard-"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/causal-links/by-target/shard-"))).toBe(true);
    expect(uniqueParquetRequests.every(url => url.includes("/evidence/layouts/browser-v2/"))).toBe(true);
    expect(errors.filter(error => !/favicon/i.test(error))).toEqual([]);

    const apiStatus = await page.evaluate(async () => (await fetch("/api/dag-data")).status);
    expect(apiStatus).toBe(404);
  });
}
