import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// A reload restores all schema groups before diagnostic filters are applied.
// Test that path in an isolated context; a small filtered graph misses stalls.
const project = JSON.parse(await readFile(new URL(
  "./acceptance/artifacts/playwright-2026-08-31/project-fixture.json", import.meta.url,
), "utf8"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  // Expose render state only in this isolated test; a populated project alone
  // does not prove its visible nodes reached the network.
  await page.route('**/dag_builder.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: await response.text()
      + '\nwindow.__dagRenderTest = () => ({ expected: dagVisibleGroups().map(g => g.group_id), nodes: dagNetworkController.getNodes()?.get() || [], edges: dagNetworkController.getEdges()?.get() || [] });' });
  });
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(`Browser page error: ${error.message}`);
  });
  await page.goto(`${process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767"}/`);
  await page.waitForFunction(() => window.__dagBuilderState?.variables.length > 3000);
  await page.evaluate((fixture) => {
    const state = window.__dagBuilderState;
    const signature = [state.data.generated_at,
      state.projectStorageVariableCount ?? state.variables.length,
      state.data.default_grouping_set_id || "none"].join(":");
    localStorage.setItem(`dag-builder-project-v2:${signature}`, JSON.stringify({
      ...fixture, selectedUoa: "__person__", uoaFilterEnabled: true,
      phase: "build", workflowMode: "dag_review",
    }));
  }, project);
  const started = performance.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => window.__dagBuilderState?.visibleLinks.length > 400,
      null, { timeout: 10000 });
  } catch (error) {
    console.error("Refresh state:", await page.evaluate(() => ({
      variables: window.__dagBuilderState?.variables?.length,
      groups: window.__dagBuilderState?.project?.groups?.length,
      links: window.__dagBuilderState?.visibleLinks?.length,
      body: document.body.innerText.slice(0, 300),
    })));
    throw error;
  }
  await page.waitForFunction(() => window.__dagRenderTest().nodes.length > 0,
    null, { timeout: 10000 });
  const assertRenderedNodes = async () => {
    await page.waitForFunction(() => {
      const rendered = window.__dagRenderTest();
      const actual = rendered.nodes.filter(node => !String(node.id).startsWith('__route__'))
        .map(node => node.id).sort().join('|');
      return actual === rendered.expected.slice().sort().join('|');
    }, null, { timeout: 10000 });
    const rendered = await page.evaluate(() => window.__dagRenderTest());
    const visible = rendered.nodes.filter(node => !String(node.id).startsWith('__route__'));
    assert.ok(visible.length > 0, 'DAG must contain visible nodes');
    assert.ok(visible.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), 'visible nodes have finite positions');
    assert.deepEqual(visible.map(node => node.id).sort(), rendered.expected.sort());
    const ids = new Set(rendered.nodes.map(node => node.id));
    assert.ok(rendered.edges.every(edge => ids.has(edge.from) && ids.has(edge.to)), 'all rendered edge endpoints exist');
    console.log(`Verified ${visible.length} visible DAG nodes and ${rendered.edges.length} edge segments.`);
  };
  await assertRenderedNodes();
  for (const mode of ['hierarchical', 'organic', 'auto']) {
    await page.locator('#dagLayoutSelect').selectOption(mode);
    assert.equal(await page.evaluate(() => window.__dagBuilderState.dagLayoutMode), mode);
    await assertRenderedNodes();
  }
  const assignments = await page.evaluate(() => {
    const state = window.__dagBuilderState;
    const schema = state.data.grouping_sets.find((set) => set.grouping_set_id === state.data.default_grouping_set_id);
    return {
      schemaCount: schema.groups.length,
      projectCount: state.project.groups.length,
      esteem: ["v000407", "v001930", "v001938"].map((id) =>
        state.project.groups.filter((group) => group.variable_ids.includes(id)).map((group) => group.label)),
    };
  });
  assert.equal(assignments.projectCount, assignments.schemaCount);
  assert.deepEqual(assignments.esteem, Array.from({ length: 3 }, () => ["subjective well-being"]));
  console.log("Latest schema replaces stale cached self-esteem assignments.");
  // A real interaction verifies that the main thread is responsive after restore.
  await page.locator("#toggleConfoundersOnly").click({ timeout: 5000 });
  assert.ok(await page.locator("#toggleConfoundersOnly").getAttribute("aria-pressed") === "true");
  await assertRenderedNodes();
  assert.equal(await page.locator('[data-mode="dag_review"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__dagBuilderState.workflowMode), "group_review");
  await page.locator('#groupList button[data-action="open"]').first().click();
  assert.equal(await page.locator('#dagWorkspaceSection').isVisible(), false);
  await page.locator('#cancelGroupEdit').click();
  assert.equal(await page.locator('#dagWorkspaceSection').isVisible(), true);
  await page.locator('#fullscreenDag').click();
  assert.equal(await page.locator('#fullscreenDag').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#fullscreenDag').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
  console.log(`Saved full project refreshed and accepted input in ${Math.round(performance.now() - started)} ms.`);
} finally {
  await browser.close();
}
