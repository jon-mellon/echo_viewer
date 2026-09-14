import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../site/dag_builder.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/dag_builder.js*', route => route.fulfill({ contentType: 'text/javascript',
    body: source + '\nwindow.exportTest = { exportMd, exportTex, exportBib, exportProject, exportWorkingMap, exportReusableGroupingSet };' }));
  let releaseMetadata;
  const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  await page.route('https://api.crossref.org/works/**', async route => {
    requestStarted();
    await metadataGate;
    const doi = decodeURIComponent(new URL(route.request().url()).pathname.slice('/works/'.length));
    if (doi === '10.1234/missing') await route.fulfill({ status: 404, body: '{}' });
    else await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: {
      type: 'journal-article', title: ['Fixture citation'], author: [{ family: 'Smith' }],
      published: { 'date-parts': [[2020]] },
    } }) });
  });
  await page.goto(`${process.env.DAG_VIEWER_URL || 'http://127.0.0.1:8767'}/`);
  await page.waitForFunction(() => window.__dagBuilderState?.project?.groups.length > 10);
  await page.evaluate(() => {
    const s = window.__dagBuilderState;
    // Synthetic, isolated export state; no user storage is changed.
    s.project.groups = [
      { group_id: 'iv', label: 'Before export', type: 'iv', variable_ids: ['v1'] },
      { group_id: 'dv', label: 'Outcome', type: 'dv', variable_ids: ['v2'] },
      { group_id: 'other', label: 'Other', variable_ids: ['v3'] },
    ];
    s.project.iv_group_id = 'iv'; s.project.dv_group_id = 'dv';
    s.project.manual_edges = []; s.project.link_decisions = {}; s.project.rejected_variables = [];
    s.project.links = [{ edge_id: 'iv__dv', group_a: 'iv', group_b: 'dv', direction_type: 'A_TO_B',
      a_to_b_raw_link_ids: ['r1', 'r2'], b_to_a_raw_link_ids: [], is_manual: false }];
    s.visibleLinks = s.project.links;
    s.rawLinksById = new Map([['r1', { paper_id: '10.1234/found' }], ['r2', { paper_id: '10.1234/missing' }]]);
    s.linkLookup = new Map([['v1->v2', ['r1', 'r2']]]);
    s.uoaFilterEnabled = false;
  });

  function unzipStored(bytes) {
    const entries = new Map();
    for (let offset = 0; bytes.readUInt32LE(offset) === 0x04034b50;) {
      const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26);
      const start = offset + 30 + nameLength;
      entries.set(bytes.subarray(offset + 30, start).toString(), bytes.subarray(start, start + length).toString());
      offset = start + length;
    }
    return entries;
  }
  async function downloaded(event, name) {
    const download = await event;
    assert.equal(download.suggestedFilename(), name);
    assert.equal(await download.failure(), null);
    return readFile(await download.path());
  }

  const firstDownload = page.waitForEvent('download');
  const pending = page.evaluate(() => exportTest.exportMd());
  await started;
  await page.evaluate(() => { window.__dagBuilderState.project.groups[0].label = 'After export'; });
  releaseMetadata();
  await pending;
  const md = unzipStored(await downloaded(firstDownload, 'causal_map.zip'));
  assert.match(md.get('dag.md'), /Before export/);
  assert.doesNotMatch(md.get('dag.md'), /After export/);
  assert.match(md.get('references.bib'), /Could not fetch: 10\.1234\/missing/);
  assert.equal(await page.locator('#exportMd').isDisabled(), false);

  const texDownload = page.waitForEvent('download');
  await page.evaluate(() => exportTest.exportTex());
  const tex = unzipStored(await downloaded(texDownload, 'causal_map_latex.zip'));
  assert.match(tex.get('dag.tex'), /After export/);
  assert.ok(tex.has('references.bib'));
  const bibDownload = page.waitForEvent('download');
  await page.evaluate(() => exportTest.exportBib());
  assert.match((await downloaded(bibDownload, 'references.bib')).toString(), /@article\{dagbuilder,/);

  for (const [method, name, schema] of [
    ['exportProject', 'dag_project.json', 'dag-builder-project-v1'],
    ['exportWorkingMap', 'working_causal_map.json', 'working-causal-map-v1'],
    ['exportReusableGroupingSet', 'grouping_set.json', 'groupings-v3'],
  ]) {
    const event = page.waitForEvent('download');
    await page.evaluate(method => exportTest[method](), method);
    const payload = JSON.parse((await downloaded(event, name)).toString());
    assert.equal(payload.schema_version, schema);
    assert.ok(payload.groups.length > 0);
  }
  assert.deepEqual(errors, []);
  console.log('All six export downloads passed, including missing metadata and edits during an in-flight export.');
} finally {
  await browser.close();
}
