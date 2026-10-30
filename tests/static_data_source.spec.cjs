const { test, expect } = require("playwright/test");

const base = process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767";
const snapshotId = "99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0";

for (const corrupt of ["none", "map", "neighbors", "incidents"]) {
  test(`definition data equals canonical coordinates and metadata, corrupt=${corrupt}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    if (corrupt !== "none") await page.route(`**/variable-${corrupt === "map" ? "maps" : corrupt}/**/*.json.gz`, async route => {
      if (route.request().url().endsWith("index.json.gz")) return route.continue();
      return route.fulfill({ status: 200, body: "corrupt" });
    });
    await page.goto(`${base}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`);
    await page.waitForFunction(() => window.__dagBuilderState?.project
      && window.__dagBuilderState.publishedSchemaHydrated
      && document.getElementById("startupLoading")?.hidden);
    const result = await page.evaluate(async () => {
      const { dagDataSource: source } = await import("/dag_data_source.mjs?v=browser-v2");
      const ids = window.__dagBuilderState.project.groups.find(g => g.group_id === "category-academic-achievement").variable_ids;
      await source.prewarmVariableMap();
      const map = await source.loadVariableMetadata(ids, "", { mapOnly: true });
      const engineAfterMap = Boolean(source.connection);
      const neighborIds = ids.slice(0, 2);
      const fastNeighbors = await source.loadNeighbors(neighborIds);
      const engineAfterNeighbors = Boolean(source.connection);
      const incidentIds = ids.slice(0, 40);
      const fastIncidents = await source.loadIncidentRawLinks(incidentIds);
      const engineAfterIncidents = Boolean(source.connection);
      const full = await source.loadVariableMetadata(ids);
      const { variableNeighborCatalog } = await import("/variable_neighbor_catalog.mjs");
      const bindings = variableNeighborCatalog.bindings;
      let expectedNeighbors;
      try {
        variableNeighborCatalog.bindings = {};
        expectedNeighbors = await source.loadNeighbors(neighborIds);
      } finally { variableNeighborCatalog.bindings = bindings; }
      const expectedIncidents = await source.queryBrowserIncidentLinks(incidentIds);
      const normalizedIncidents = rows => JSON.stringify([...rows].sort((a, b) => a.raw_causal_link_id.localeCompare(b.raw_causal_link_id)));
      const expected = full.map(({ field_preview_json, metadata_blob_json, ...row }) => row);
      map[0].concept_label = "mutated view copy";
      const second = await source.loadVariableMetadata(ids, "", { mapOnly: true });
      return { count: second.length, engineAfterMap, engineAfterNeighbors, engineAfterIncidents,
        incidentsMatch: fastIncidents.length > 0 && normalizedIncidents(fastIncidents) === normalizedIncidents(expectedIncidents),
        neighborsMatch: fastNeighbors.length === 24 && JSON.stringify(fastNeighbors) === JSON.stringify(expectedNeighbors),
        matches: JSON.stringify(second) === JSON.stringify(expected) };
    });
    expect(result.count).toBe(1775);
    expect(result.matches).toBe(true);
    expect(result.engineAfterMap).toBe(corrupt === "map");
    expect(result.engineAfterNeighbors).toBe(corrupt === "map" || corrupt === "neighbors");
    expect(result.neighborsMatch).toBe(true);
    expect(result.engineAfterIncidents).toBe(corrupt !== "none");
    expect(result.incidentsMatch).toBe(true);
  });
}

for (const rejectBuffer of [false, true]) {
  test(`cold findings prefetch preserves evidence with rejected buffer=${rejectBuffer}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
    await page.goto(`${base}/?schema=c221423a-9470-4c82-8a3d-8bcf4a01ef7c&data_version=f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b&task=identify`);
    await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
      && document.getElementById("startupLoading")?.hidden);
    const result = await page.evaluate(async rejectBuffer => {
      const { dagDataSource: source } = await import("/dag_data_source.mjs?v=browser-v2");
      const download = source.downloadEvidenceFiles.bind(source);
      source.downloadEvidenceFiles = () => {
        if (rejectBuffer) source.manifest.identity.legacy_relation_integrity.causal_link_occurrences.sha256 = "0".repeat(64);
        return download();
      };
      const edge = window.__dagBuilderState.project.links.find(e => e.a_to_b_raw_link_ids?.length);
      const ids = edge.a_to_b_raw_link_ids.slice(0, 5);
      const rows = await source.loadRawLinksByIds(ids);
      const url = source.canonicalEvidenceRelationUrl("causal_link_occurrences");
      const registered = source.parquetFile(url) !== url;
      const expected = await source.connection.query(`SELECT * FROM read_parquet('${url}')
        WHERE raw_causal_link_id IN (${ids.map(id => `'${id.replaceAll("'", "''")}'`).join(",")})`);
      const normalize = values => JSON.stringify(values.sort((a, b) => a.raw_causal_link_id.localeCompare(b.raw_causal_link_id)),
        (_, value) => typeof value === "bigint" ? Number(value) : value);
      const labels = await source.loadVariableProvenance(rows.flatMap(r => [r.source_variable_id, r.target_variable_id]));
      return { registered, count: rows.length, matches: normalize(rows) === normalize(expected.toArray().map(r => r.toJSON())),
        hasLabels: labels.length > 0 && labels.every(r => r.concept_label || r.display_label) };
    }, rejectBuffer);
    expect(result.registered).toBe(!rejectBuffer);
    expect(result.count).toBeGreaterThan(0);
    expect(result.matches).toBe(true);
    expect(result.hasLabels).toBe(true);
  });
}

for (const route of ["/"]) {
  test(`${route} loads compiled startup and retrieves browser-v2 evidence shards`, async ({ page }) => {
    // Original baseline was 60000 ms; this is a runner timeout, not a performance gate.
    test.setTimeout(78000);
    await page.addInitScript(() => {
      sessionStorage.setItem("echo-viewer-password-accepted", "yes");
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
    // This test exercises the legacy contiguous-ID snapshot and its v1 fixtures.
    await page.goto(`${base}${route}?schema=f22dab8b-d9a7-4047-a775-0216b31c79fc&data_version=${snapshotId}&task=identify`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
      && document.getElementById("startupLoading")?.hidden, null,
      { timeout: 78000 });
    await expect(page.locator("#schemaPublicationBadge")).toHaveText("Public schema", { timeout: 78000 });
    await page.evaluate(async () => {
      const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
      await dagDataSource.ensureEvidenceConnection();
    });
    const state = await page.evaluate(async () => {
      const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
      const [variables, provenance, neighbors, links] = await Promise.all([
        dagDataSource.loadVariableMetadata(["v1"]),
        dagDataSource.loadVariableProvenance(["v1"]),
        dagDataSource.loadNeighbors(["v1"]),
        dagDataSource.loadIncidentRawLinks(["v1"]),
      ]);
      return {
      variables, provenance, neighbors, links,
      shardBoundaries: ["v1", "v256", "v257", "v14284", "v14285"]
        .map(id => dagDataSource.browserShardIds([id])),
      snapshotId: window.__dagBuilderState.data.snapshot.snapshot_id,
      groupingCount: window.__dagBuilderState.data.grouping_sets[0]?.groups?.length,
      startupStages: window.__startupStages,
      loadingFinished: document.getElementById("startupLoading")?.hidden,
      engineStarts: performance.getEntriesByName("echo:evidence:engine").length,
      publicationLoads: performance.getEntriesByName("echo:evidence:publication").length,
    }});
    expect(state.variables).toHaveLength(1);
    expect(state.variables[0].variable_id).toBe("v1");
    expect(state.provenance).toEqual([{
      variable_id: "v1",
      concept_label: state.variables[0].concept_label,
      display_label: state.variables[0].display_label,
    }]);
    expect(Number.isFinite(state.variables[0].map_x)).toBe(true);
    expect(Number.isFinite(state.variables[0].map_y)).toBe(true);
    expect(state.neighbors.length).toBeGreaterThan(0);
    expect(state.shardBoundaries).toEqual([[0], [0], [1], [55], []]);
    expect(new Set(state.links.map(link => link.raw_causal_link_id)).size).toBe(state.links.length);
    expect(state.links.every(link => link.source_variable_id === "v1"
      || link.target_variable_id === "v1")).toBe(true);
    expect(state.snapshotId).toBe(snapshotId);
    expect(state.groupingCount).toBe(103);
    expect(state.startupStages).toEqual(expect.arrayContaining([
      "Loading published schema and compiled DAG…",
      "Preparing workspace…",
      "Rendering graph…",
    ]));
    expect(state.loadingFinished).toBe(true);
    expect(state.engineStarts).toBe(1);
    expect(state.publicationLoads).toBe(1);
    const uniqueParquetRequests = [...new Set(parquetRequests)];
    expect(uniqueParquetRequests.some(url => url.includes("/lookup/variable-shards.parquet"))).toBe(false);
    expect(uniqueParquetRequests.some(url => url.includes("/variables/shard-"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/neighbors/shard-"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.endsWith("/causal_link_occurrences.parquet"))).toBe(true);
    expect(uniqueParquetRequests.some(url => url.includes("/causal-links/by-source/shard-"))).toBe(false);
    expect(uniqueParquetRequests.some(url => url.includes("/causal-links/by-target/shard-"))).toBe(false);
    expect(uniqueParquetRequests.some(url => url.endsWith("/build_metadata.parquet"))).toBe(false);
    expect(uniqueParquetRequests.some(url => url.endsWith("/variable_layouts.parquet"))).toBe(true);
    expect(errors.filter(error => !/favicon/i.test(error))).toEqual([]);

    const apiStatus = await page.evaluate(async () => (await fetch("/api/dag-data")).status);
    expect(apiStatus).toBe(404);
  });
}

test("content-ID layouts resolve shards through the variable_id lookup", async ({ page }) => {
  test.setTimeout(78000);
  const publication = "c221423a-9470-4c82-8a3d-8bcf4a01ef7c";
  const contentSnapshot = "f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b";
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/?schema=${publication}&data_version=${contentSnapshot}&task=identify`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && window.__dagBuilderState?.publishedSchemaHydrated
    && document.getElementById("startupLoading")?.hidden, null, { timeout: 78000 });
  const state = await page.evaluate(async () => {
    const { dagDataSource } = await import("/dag_data_source.mjs?v=browser-v2");
    const parquetBefore = performance.getEntriesByType("resource").filter(e => e.name.includes(".parquet")).length;
    const labelStart = performance.now();
    const [firstLabels, repeatedLabels] = await Promise.all([
      dagDataSource.loadVariableProvenance(["v00a8a27ccc9fd830"]),
      dagDataSource.loadVariableProvenance(["v00a8a27ccc9fd830"]),
    ]);
    const firstLabelMs = performance.now() - labelStart;
    const cachedStart = performance.now();
    const cachedLabels = await dagDataSource.loadVariableProvenance(["v00a8a27ccc9fd830"]);
    const cachedLabelMs = performance.now() - cachedStart;
    const labelsWithoutEngine = !dagDataSource.connection;
    const labelParquetRequests = performance.getEntriesByType("resource").filter(e => e.name.includes(".parquet")).length - parquetBefore;
    await dagDataSource.ensureEvidenceConnection({ variableIds: [], prewarmMapFiles: true });
    const emptyLookup = dagDataSource.shardByVariableId?.size || 0;
    const ids = ["v00008ca8c17b2a4b", "v00a8a27ccc9fd830", "vffffe44b8b970692", "v1"];
    await Promise.all([
      dagDataSource.ensureEvidenceConnection({ variableIds: ids.slice(0, 2) }),
      dagDataSource.ensureEvidenceConnection({ variableIds: ids.slice(1) }),
    ]);
    const partialLookup = dagDataSource.shardByVariableId.size;
    const partialShards = ids.map(id => dagDataSource.browserShardIds([id]));
    const requested = window.__dagBuilderState.project.groups.find(g => g.variable_ids.length >= 40).variable_ids.slice(0, 40);
    const full = await dagDataSource.loadVariableMetadata(requested);
    const light = await dagDataSource.loadVariableMetadata(requested, "", { mapOnly: true });
    const expectedLight = full.map(({ field_preview_json, metadata_blob_json, ...row }) => row);
    const projectionMatches = full.length === 40 && JSON.stringify(light) === JSON.stringify(expectedLight);
    await dagDataSource.ensureEvidenceConnection();
    return {
      firstLabels, repeatedLabels, cachedLabels, firstLabelMs, cachedLabelMs, labelsWithoutEngine, labelParquetRequests,
      emptyLookup, partialLookup, partialShards, projectionMatches,
      completeLookup: dagDataSource.shardLookupComplete,
      fullLookup: dagDataSource.shardByVariableId.size,
      prefetchedFiles: dagDataSource.localParquetFiles.size,
      shards: ["v00008ca8c17b2a4b", "v00a8a27ccc9fd830", "vffffe44b8b970692", "v1"]
        .map(id => dagDataSource.browserShardIds([id])),
      provenance: await dagDataSource.loadVariableProvenance(["v00a8a27ccc9fd830"]),
    };
  });
  expect(state.labelsWithoutEngine).toBe(true);
  expect(state.labelParquetRequests).toBe(0);
  expect(state.firstLabels).toEqual(state.repeatedLabels);
  expect(state.firstLabels).toEqual(state.cachedLabels);
  console.log("Concept label timings (ms)", { first: state.firstLabelMs, cached: state.cachedLabelMs });
  expect(state.emptyLookup).toBe(0);
  expect(state.partialLookup).toBe(3);
  expect(state.partialShards).toEqual([[0], [1], [382], []]);
  expect(state.completeLookup).toBe(true);
  expect(state.fullLookup).toBe(97818);
  expect(state.prefetchedFiles).toBe(3);
  expect(state.projectionMatches).toBe(true);
  expect(state.shards).toEqual([[0], [1], [382], []]);
  expect(state.provenance).toEqual([expect.objectContaining({
    variable_id: "v00a8a27ccc9fd830", concept_label: "uoa's emergency department use" })]);
  expect(errors).toEqual([]);
});
