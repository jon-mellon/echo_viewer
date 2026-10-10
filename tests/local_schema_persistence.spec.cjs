const { test, expect } = require("playwright/test");

test("the root starts fresh and Previous Sessions restores a committed local schema", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?new=1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
    && document.getElementById("startupLoading")?.hidden);
  const { localUrl, movedVariable, targetGroup, decidedEdge } = await page.evaluate(async () => {
    const state = window.__dagBuilderState;
    const { buildPermalink } = await import("/dag_permalink.mjs");
    const { commitLocalSchema } = await import("/local_schema_store.mjs");
    const schema = structuredClone(state.data.grouping_sets[0]);
    schema.groups[0].label = "Local persistence test group";
    const movedVariable = schema.groups[0].variable_ids.find(id =>
      !schema.groups[1].variable_ids.includes(id));
    if (!movedVariable) throw new Error("Expected a variable that can be reassigned.");
    schema.groups[0].variable_ids = schema.groups[0].variable_ids.filter(id => id !== movedVariable);
    schema.groups[1].variable_ids.push(movedVariable);
    const decidedEdge = state.data.compiled_dag.edges.find(edge =>
      ![schema.groups[0].group_id, schema.groups[1].group_id]
        .includes(edge.group_a) && ![schema.groups[0].group_id, schema.groups[1].group_id]
        .includes(edge.group_b))?.edge_id;
    if (!decidedEdge) throw new Error("Expected an unaffected edge for the decision check.");
    schema.link_decisions = { ...(schema.link_decisions || {}),
      [decidedEdge]: { display_status: "excluded", exclude_reason: "private local reason" } };
    const id = crypto.randomUUID();
    const url = buildPermalink({ location: window.location, state,
      schemaUrl: "", dataVersion: state.data.snapshot.snapshot_id,
      publishedSchemaId: state.data.publication_source.publication_id,
      localSchemaId: id });
    await commitLocalSchema({ id, schema, url,
      basePublicationId: state.data.publication_source.publication_id,
      basePublicationHash: state.data.publication_source.content_hash });
    return { localUrl: url, movedVariable, targetGroup: schema.groups[1].group_id, decidedEdge };
  });
  await page.goto(localUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("startupLoading")?.hidden);
  const loaded = await page.evaluate(decidedEdge => ({
    label: window.__dagBuilderState.data.grouping_sets[0].groups[0].label,
    groups: window.__dagBuilderState.data.grouping_sets[0].groups,
    decision: window.__dagBuilderState.project.link_decisions[decidedEdge],
    compiledDecision: window.__dagBuilderState.compiledDag.edges
      .find(edge => edge.edge_id === decidedEdge)?.user_decision,
    localId: new URL(location.href).searchParams.get("local_schema"),
  }), decidedEdge);
  expect(loaded.label).toBe("Local persistence test group");
  expect(loaded.groups.find(group => group.group_id === targetGroup).variable_ids).toContain(movedVariable);
  expect(loaded.groups[0].variable_ids).not.toContain(movedVariable);
  expect(loaded.decision.exclude_reason).toBe("private local reason");
  expect(loaded.compiledDecision?.display_status).toBe("excluded");
  expect(loaded.localId).toBe(new URL(localUrl).searchParams.get("local_schema"));
  const savedSessionId = await page.evaluate(() => history.state.echoSessionId);
  expect(localUrl).not.toContain("Local persistence test group");
  expect(localUrl).not.toContain("private local reason");
  const freshContext = await page.context().browser().newContext();
  const freshPage = await freshContext.newPage();
  await freshPage.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await freshPage.goto(localUrl, { waitUntil: "domcontentloaded" });
  await expect(freshPage.getByRole("heading", { name: "Local schema unavailable" })).toBeVisible();
  await freshContext.close();
  await page.goto("http://127.0.0.1:8767/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.getElementById("startupLoading")?.hidden);
  expect(new URL(page.url()).searchParams.get("local_schema")).toBeNull();
  await page.getByRole("button", { name: "Previous Sessions" }).click();
  await page.locator(".previous-session-entry").filter({ hasText: "Local draft" }).first().click();
  await page.waitForFunction(() => document.getElementById("startupLoading")?.hidden);
  expect(new URL(page.url()).searchParams.get("local_schema")).toBe(loaded.localId);
  expect(await page.evaluate(() => history.state.echoSessionId)).toBe(savedSessionId);
});

test("stale editor revisions fail without losing the in-memory draft", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?new=1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.data?.publication_source
    && window.__dagBuilderState?.publishedSchemaHydrated
    && document.getElementById("startupLoading")?.hidden);
  const result = await page.evaluate(async () => {
    const { commitLocalSchema, loadLocalSchema } = await import("/local_schema_store.mjs");
    const { createPersistentViewer } = await import("/persistent_viewer.mjs");
    const live = window.__dagBuilderState;
    const publication = live.data.publication_source;
    const schema = { schema_version: "groupings-v3", grouping_set_id: "test",
      membership_unit: "canonical_variable", groups: [{ group_id: "one", label: "Before", variable_ids: ["v1"] }] };
    const id = crypto.randomUUID();
    const url = `${location.origin}/?p=1&mode=setup&schema=${publication.publication_id}&local_schema=${id}`;
    const initial = await commitLocalSchema({ id, schema, url,
      basePublicationId: publication.publication_id });
    const state = { project: { groups: structuredClone(schema.groups), iv_group_id: "", dv_group_id: "" },
      data: { snapshot: live.data.snapshot, publication_source: publication },
      workflowMode: "setup", phase: "select_iv", compiledDag: null, definitionDraft: null };
    const controller = createPersistentViewer({ state,
      getSchema: () => ({ ...schema, groups: structuredClone(state.project.groups) }) });
    controller.setLoadedRecord(initial);
    controller.start();
    controller.beginEditor();
    state.project.groups[0].label = "Uncommitted edit";
    await commitLocalSchema({ id, expectedRevision: 1,
      schema: { ...schema, groups: [{ ...schema.groups[0], label: "Other tab" }] }, url,
      basePublicationId: publication.publication_id });
    let failed = false;
    try { await controller.finishEditor(); } catch { failed = true; }
    const keptDraft = state.project.groups[0].label;
    const stillOpen = controller.editorOpen;
    controller.discardEditor();
    const afterDiscard = state.project.groups[0].label;
    controller.beginEditor();
    state.project.groups[0].label = "Independent edit";
    try { await controller.finishEditor(); } catch {}
    const copy = await controller.saveIndependentCopy();
    const original = await loadLocalSchema(id);
    return { failed, keptDraft, stillOpen, afterDiscard,
      copiedLabel: copy.schema.groups[0].label,
      independent: copy.id !== id,
      originalLabel: original.schema.groups[0].label };
  });
  expect(result).toEqual({ failed: true, keptDraft: "Uncommitted edit",
    stillOpen: true, afterDiscard: "Before", copiedLabel: "Independent edit",
    independent: true, originalLabel: "Other tab" });
});

test("an older write cannot replace a newer URL for the same previous session", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?new=1", { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const { mirrorSessionUrl, listPreviousSessions } = await import("/local_schema_store.mjs");
    const id = crypto.randomUUID();
    const sequence = Date.now() + 10000;
    await mirrorSessionUrl(id, `${location.origin}/?p=1&newer=1`, sequence);
    await mirrorSessionUrl(id, `${location.origin}/?p=1&older=1`, sequence - 1);
    return (await listPreviousSessions()).find(record => record.id === id)?.url;
  });
  expect(result).toContain("newer=1");
});

test("importing a local draft creates an independent schema ID", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?new=1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.data?.publication_source
    && window.__dagBuilderState?.publishedSchemaHydrated
    && document.getElementById("startupLoading")?.hidden);
  const result = await page.evaluate(async () => {
    const { makeDraftExport, importDraftPayload } = await import("/draft_exchange.mjs");
    const { loadLocalSchema } = await import("/local_schema_store.mjs");
    const { buildPermalink } = await import("/dag_permalink.mjs");
    const state = window.__dagBuilderState;
    const basePublicationId = state.data.publication_source.publication_id;
    const schema = structuredClone(state.data.grouping_sets[0]);
    schema.link_decisions = { test_edge: { display_status: "excluded",
      exclude_reason: "private imported reason" } };
    const url = buildPermalink({ location: window.location, state, schemaUrl: "",
      dataVersion: state.data.snapshot.snapshot_id, publishedSchemaId: basePublicationId });
    const draft = makeDraftExport({ schema, url, basePublicationId });
    const first = await importDraftPayload(draft);
    const second = await importDraftPayload(draft);
    const firstRecord = await loadLocalSchema(new URL(first).searchParams.get("local_schema"));
    return { first, second, reason: firstRecord.schema.link_decisions.test_edge.exclude_reason };
  });
  expect(new URL(result.first).searchParams.get("local_schema"))
    .not.toBe(new URL(result.second).searchParams.get("local_schema"));
  expect(result.reason).toBe("private imported reason");
  expect(result.first).not.toContain("private imported reason");
});

test("the default published compiled graph contains no private exclusion reason", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("echo-viewer-password-accepted", "yes"));
  await page.goto("http://127.0.0.1:8767/?new=1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.data?.compiled_dag);
  const leaked = await page.evaluate(() => window.__dagBuilderState.data.compiled_dag.edges
    .filter(edge => edge.exclude_reason != null || edge.user_decision?.exclude_reason != null).length);
  expect(leaked).toBe(0);
});
