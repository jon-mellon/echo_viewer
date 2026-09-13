import test from 'node:test';
import assert from 'node:assert/strict';
import * as exports from '../site/dag_exports.mjs';
import { makeZip } from '../site/dag_export_zip.mjs';
import { legacyExports, legacyZip } from './fixtures/legacy_dag_exports.mjs';

const timestamp = '2026-09-09T12:00:00Z';
function fixture() {
  const links = [{ edge_id: 'iv__dv', group_a: 'iv', group_b: 'dv', direction_type: 'B_TO_A',
    is_manual: true, a_to_b_raw_link_ids: ['r1'], b_to_a_raw_link_ids: ['r2', 'r1'] }];
  const project = { iv_group_id: 'iv', dv_group_id: 'dv', groups: [
    { group_id: 'iv', label: 'Income & wealth', variable_ids: ['v1'], type: 'iv' },
    { group_id: 'dv', label: 'Tax_50%', variable_ids: ['v2'], type: 'dv' },
    { group_id: 'other', label: 'Other', variable_ids: ['v3'], notes: 'note' },
  ], links, manual_edges: [{ edge_id: 'm1', deleted: false }, { edge_id: 'm2', deleted: true }],
    grouping_exports: [], link_decisions: { iv__dv: { edge_id: 'iv__dv', display_status: 'excluded', exclude_reason: 'Reason & details' } } };
  const input = { project, visibleLinks: links,
    rawLinksById: new Map([['r1', { paper_id: '10.1234/one' }], ['r2', { paper_id: '10.1234/two' }]]),
    cacheCompatibility: { version: 'test' }, rejectedVariables: [{ variable_id: 'bad', member_variable_ids: ['bad', 'bad2'] }],
    hiddenVariableIds: ['bad', 'bad2'], selectedUoa: 'person', phase: 'build', workflowMode: 'group_review',
    seeds: { iv: new Set(['v1']), dv: new Set(['v2']) }, dagLayoutMode: 'auto' };
  const metadata = new Map([['10.1234/one', { author: [{ family: 'Smith', given: 'A' }], published: { 'date-parts': [[2020]] }, title: ['Test paper'], type: 'journal-article' }]]);
  return { input, metadata };
}

for (const scenario of ['normal', 'empty', 'bidirectional', 'missing-group', 'svg']) {
  test(`${scenario}: export text and JSON match previous output without changing inputs`, async () => {
    const { input, metadata } = fixture();
    if (scenario === 'empty') { input.visibleLinks = []; input.project.link_decisions = {}; }
    if (scenario === 'bidirectional') input.visibleLinks[0].direction_type = 'BIDIRECTIONAL';
    if (scenario === 'missing-group') input.project.groups = [];
    const svg = scenario === 'svg' ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : null;
    const before = structuredClone({ input, metadata });
    const expected = await legacyExports(input, metadata, timestamp, svg);
    const bibliography = exports.buildBibText(exports.collectAllDagDois(input), metadata);
    assert.deepEqual(bibliography, expected.bibliography);
    assert.deepEqual(exports.buildMarkdownFiles(input, bibliography, svg), expected.md);
    assert.deepEqual(exports.buildLatexFiles(input, bibliography, svg), expected.tex);
    assert.deepEqual(exports.buildWorkingMapPayload(input, timestamp), expected.working);
    assert.deepEqual(exports.buildProjectPayload(input, timestamp), expected.payload);
    assert.deepEqual({ input, metadata }, before);
  });
}

test('citation collisions follow DOI order independently of metadata arrival order', () => {
  const data = { author: [{ family: 'Smith' }], published: { 'date-parts': [[2020]] } };
  const dois = ['10.1234/first', '10.1234/second'];
  const forward = new Map(dois.map(doi => [doi, data]));
  const reverse = new Map([...forward].reverse());
  const a = exports.buildBibText(dois, forward), b = exports.buildBibText(dois, reverse);
  assert.deepEqual(a, b);
  assert.equal(a.keyMap.get(dois[0]), 'smith2020');
  assert.equal(a.keyMap.get(dois[1]), 'smith2020b');
  assert.match(a.bibText, /@misc\{dagbuilder,/);
});

test('project serialization owns its format and save timestamp', () => {
  const { input } = fixture();
  Object.assign(input.project, {
    schema_version: "obsolete-format",
    saved_at: "2000-01-01T00:00:00Z",
    selectedUoa: "stale-uoa",
    candidate_queue: [{ group_id: "derived" }],
  });
  const payload = exports.buildProjectPayload(input, timestamp);
  assert.equal(payload.schema_version, "dag-builder-project-v1");
  assert.equal(payload.saved_at, timestamp);
  assert.equal(payload.selectedUoa, input.selectedUoa);
  assert.equal(Object.hasOwn(payload, "candidate_queue"), false);
});

test('ZIP bytes match previous archive and contain the original UTF-8 file contents', async () => {
  const files = [{ name: 'dag.md', data: 'A → B\n' }, { name: 'references.bib', data: '@misc{test}' }];
  const before = structuredClone(files);
  const archive = makeZip(files);
  assert.deepEqual(archive, new Uint8Array(await legacyZip(files).arrayBuffer()));
  const view = new DataView(archive.buffer);
  let offset = 0;
  for (const file of files) {
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    assert.equal(new TextDecoder().decode(archive.slice(offset + 30, offset + 30 + nameLength)), file.name);
    const start = offset + 30 + nameLength;
    assert.equal(new TextDecoder().decode(archive.slice(start, start + length)), file.data);
    offset = start + length;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  assert.equal(view.getUint32(archive.length - 22, true), 0x06054b50);
  assert.deepEqual(files, before);
});
