import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

// Exercise the runtime module in an isolated browser, exposing helpers only in this test.
const source = await readFile(new URL("../site/dag_builder.js", import.meta.url), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => {
    errors.push(error.message);
    console.error(`Browser page error: ${error.message}`);
  });
  page.on("dialog", dialog => dialog.accept());
  await page.route("**/dag_builder.js*", route => route.fulfill({
    contentType: "text/javascript",
    body: source + `\nwindow.groupTest = { renderAll, dagGroups, addVariableToGroup,
      flagVariableLowQuality, beginTargetGroup, restoreProjectLocally, saveProjectLocally,
      takeSnapshot, applySnapshot, exportReusableGroupingSet };`,
  }));
  await page.goto(`${process.env.DAG_VIEWER_URL || "http://127.0.0.1:8767"}/`);
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups.length > 10);
  await page.locator('[data-mode="group_review"]').click();
  assert.equal(await page.locator('#rejectGroup, #postponeGroup, #groupFilterTabs, option[value="status"]').count(), 0);
  assert.ok(await page.evaluate(() => window.__dagBuilderState.project.groups.every(g => !('status' in g))));

  // Recreate all legacy statuses in local storage. Restoration strips metadata and
  // keeps every nonempty definition eligible for the DAG, including old exclusions.
  const legacy = await page.evaluate(() => {
    const s = window.__dagBuilderState;
    const groups = s.project.groups.filter(g => g.variable_ids.length).slice(0, 4);
    groups.forEach((g, i) => { g.status = ['accepted', 'draft', 'rejected', 'postponed'][i]; });
    groupTest.saveProjectLocally();
    groupTest.restoreProjectLocally();
    groupTest.renderAll();
    return { ids: groups.map(g => g.group_id), dagIds: groupTest.dagGroups().map(g => g.group_id),
      hasStatus: s.project.groups.some(g => 'status' in g) };
  });
  assert.equal(legacy.hasStatus, false);
  assert.ok(legacy.ids.every(id => legacy.dagIds.includes(id)));

  // Restoration now reapplies schema/setup rules just like page startup.
  await page.locator('[data-mode="group_review"]').click();
  await page.locator('#createGroupBtn').click();
  await page.locator('#groupLabelInput').fill('Immediate group test');
  await page.locator('#groupNotesInput').fill('Saved without acceptance');
  assert.equal(await page.locator('#useGroupAsAnchor').isVisible(), false);
  const membership = await page.evaluate(() => {
    const s = window.__dagBuilderState;
    const group = s.project.groups.find(g => g.group_id === s.activeGroupId);
    // Use a source variable with a real mapping so immediate edge aggregation is tested.
    const link = s.rawLinks.find(l => s.project.groups.some(g => g.variable_ids.includes(l.source_variable_id))
      && s.project.groups.some(g => g.variable_ids.includes(l.target_variable_id)));
    const variableId = link.source_variable_id;
    const before = groupTest.takeSnapshot();
    groupTest.addVariableToGroup(group, variableId);
    const after = groupTest.takeSnapshot();
    groupTest.renderAll();
    const included = groupTest.dagGroups().some(g => g.group_id === group.group_id);
    const hasEdge = s.project.links.some(l => [l.group_a, l.group_b].includes(group.group_id));
    groupTest.applySnapshot(before);
    const undone = !groupTest.dagGroups().some(g => g.group_id === group.group_id);
    groupTest.applySnapshot(after);
    groupTest.renderAll();
    return { id: group.group_id, variableId, included, hasEdge, undone,
      owners: s.project.groups.filter(g => g.variable_ids.includes(variableId)).length };
  });
  assert.equal(membership.included, true);
  assert.equal(membership.hasEdge, true);
  assert.equal(membership.undone, true);
  assert.equal(membership.owners, 1);
  assert.equal(await page.locator(`#manualSource option[value="${membership.id}"]`).count(), 1);
  await page.locator('#cancelGroupEdit').click();
  assert.ok(await page.evaluate(id => groupTest.dagGroups().some(g => g.group_id === id), membership.id));

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => groupTest.exportReusableGroupingSet());
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.ok(exported.groups.some(g => g.group_id === membership.id));
  assert.ok(exported.groups.every(g => !('status' in g)));

  await page.evaluate(id => {
    groupTest.flagVariableLowQuality(id);
    groupTest.renderAll();
  }, membership.variableId);
  assert.equal(await page.locator('#rejectedVariablesPanel').isVisible(), true);
  await page.locator(`#rejectedVariablesList [data-variable-id="${membership.variableId}"] button[data-action="restore"]`).click();
  assert.ok(await page.evaluate(id => !window.__dagBuilderState.project.rejected_variables.some(e => e.variable_id === id), membership.variableId));

  // New target definitions are ordinary groups immediately; choosing an anchor is
  // a separate role selection and must still advance setup correctly.
  await page.evaluate(id => {
    const s = window.__dagBuilderState;
    s.workflowMode = 'setup';
    s.phase = 'select_dv';
    s.changingAnchorSide = 'dv';
    s.seeds.dv = new Set([id]);
    groupTest.beginTargetGroup('dv');
  }, membership.variableId);
  assert.equal(await page.locator('#useGroupAsAnchor').innerText(), 'Use as DV');
  await page.locator('#useGroupAsAnchor').click();
  assert.ok(await page.evaluate(() => {
    const s = window.__dagBuilderState;
    const g = s.project.groups.find(g => g.group_id === s.project.dv_group_id);
    return g?.type === 'dv' && g.variable_ids.length && !('status' in g) && s.phase === 'build';
  }));
  assert.deepEqual(errors, []);
  console.log('Group editing: legacy statuses, immediate edges, undo, export, variable restoration and anchor selection passed.');
} finally {
  await browser.close();
}
