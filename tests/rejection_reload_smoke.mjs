import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const source = await readFile(new URL("../site/dag_builder.js", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/dag_builder.js*", route => route.fulfill({
    contentType: "text/javascript",
    body: source + "\nwindow.rejectionTest = { clusterRep, visibleClusterReps, ensureGlobalVoronoiCells, drawMapPoints, fitMap, canvasWidth, canvasHeight, worldToScreen, projectStorageKey };",
  }));
  await page.goto((process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767") + "/");
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups.length > 10);
  const target = await page.evaluate(() => {
    const s = window.__dagBuilderState;
    const schema = s.data.grouping_sets.find(g => g.grouping_set_id === s.data.default_grouping_set_id);
    const entry = schema.rejected_variables.find(e => s.variableById.has(e.variable_id));
    if (!entry) throw new Error("Fixture needs a schema-rejected variable present in the layout");
    const id = rejectionTest.clusterRep(entry.variable_id);
    return { id, schemaId: schema.grouping_set_id };
  });

  async function inspect() {
    return page.evaluate(({ id, schemaId }) => {
      const s = window.__dagBuilderState, t = rejectionTest;
      const schema = s.data.grouping_sets.find(g => g.grouping_set_id === schemaId);
      t.fitMap([id]);
      const variable = s.variableById.get(id);
      const point = t.worldToScreen(variable.map_x, variable.map_y);
      // Observe arcs from the actual point renderer on a real browser canvas.
      const ctx = document.createElement("canvas").getContext("2d");
      const arc = ctx.arc.bind(ctx);
      let drawn = false;
      ctx.arc = (x, y, ...args) => {
        if (Math.abs(x - point.x) < 0.001 && Math.abs(y - point.y) < 0.001) drawn = true;
        arc(x, y, ...args);
      };
      t.drawMapPoints(ctx, t.canvasWidth(), t.canvasHeight());
      return {
        schemaStillRejects: schema.rejected_variables.some(e => t.clusterRep(e.variable_id) === id),
        rejected: s.project.rejected_variables.some(e => t.clusterRep(e.variable_id) === id),
        visible: t.visibleClusterReps().some(v => v.variable_id === id),
        cell: t.ensureGlobalVoronoiCells().has(id),
        drawn,
        savedOverride: JSON.parse(localStorage.getItem(t.projectStorageKey()))?.restored_variable_ids?.includes(id) || false,
      };
    }, target);
  }

  const before = await inspect();
  assert.equal(before.schemaStillRejects, true);
  assert.equal(before.rejected, true);
  assert.equal(before.visible, false);
  assert.equal(before.cell, false);
  // Use the real Restore button, which triggers rendering and autosave.
  await page.locator('#rejectedVariablesList [data-variable-id="' + target.id + '"] button[data-action="restore"]').click();
  const expected = { schemaStillRejects: true, rejected: false, visible: true, cell: true, drawn: true, savedOverride: true };
  assert.deepEqual(await inspect(), expected);
  await page.reload();
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups.length > 10);
  assert.deepEqual(await inspect(), expected);
  assert.deepEqual(errors, []);
  const saved = await page.evaluate(() => localStorage.getItem(rejectionTest.projectStorageKey()));
  const snapshot = () => page.evaluate(() => {
    const s = window.__dagBuilderState;
    return {
      groups: s.project.groups, rejected: s.project.rejected_variables,
      overrides: s.project.restored_variable_ids, selectedUoa: s.selectedUoa,
      uoaFilterEnabled: s.uoaFilterEnabled, phase: s.phase, workflowMode: s.workflowMode,
      changingAnchorSide: s.changingAnchorSide, variableLayoutSource: s.variableLayoutSource,
      dagLayoutMode: s.dagLayoutMode, seeds: { iv: [...s.seeds.iv], dv: [...s.seeds.dv] },
    };
  });
  const restoredState = await snapshot();
  // Change a setting so completion cannot be mistaken for the pre-import state.
  await page.evaluate(() => { window.__dagBuilderState.phase = "import-test-pending"; });
  await page.locator("#projectImport").setInputFiles({
    name: "saved-project.json", mimeType: "application/json", buffer: Buffer.from(saved),
  });
  await page.waitForFunction(() => window.__dagBuilderState.phase !== "import-test-pending");
  assert.deepEqual(await snapshot(), restoredState);
  assert.deepEqual(await inspect(), expected);
  assert.deepEqual(errors, []);
  console.log("Browser verified: importing autosaved project produces the same settings, schema groups and rejection overrides as reload.");
  console.log("Browser verified: schema rejection → Restore button → autosave → page reload → schema reapplied; point and Voronoi cell remain visible.");
} finally {
  await browser.close();
}
