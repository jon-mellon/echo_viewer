import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadSchemaFolder, localEvidence, sqlString } from '../agent/local_data.mjs';
import { searchVariables } from '../site/dag_search.mjs';
import { canonicalFolderHash, writeGroupingSchemaFolder } from '../site/grouping_schema_writer.mjs';
import { loadGroupingSchemaFolder } from '../site/grouping_schema_loader.mjs';
import { pathToFileURL } from 'node:url';

test('referenced memberships are verified and materialized for offline loading', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-agent-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const schema = { schema_version: 'groupings-v3', grouping_set_id: 'test', label: 'Test',
    membership_unit: 'canonical_variable', groups: [{ group_id: 'g', label: 'Group', variable_ids: ['v1'] }] };
  const files = await writeGroupingSchemaFolder(schema);
  const hash = await canonicalFolderHash(files);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  const membershipPath = manifest.group_membership_files.g;
  const base = 'https://example.org/storage/v1/object/public/published-schemas/new/';
  const reference = 'https://example.org/storage/v1/object/public/published-schemas/old/memberships/g.tsv';
  manifest.group_membership_references = { g: reference };
  const fetchImpl = async url => {
    const path = String(url) === reference ? membershipPath : String(url).slice(base.length);
    return files.has(path) ? new Response(files.get(path)) : new Response(null, { status: 404 });
  };
  await downloadSchemaFolder(base, manifest, dir, hash, fetchImpl);
  const localFetch = async url => new Response(await readFile(new URL(url)));
  const loaded = await loadGroupingSchemaFolder(pathToFileURL(`${dir}/`).href, localFetch);
  assert.deepEqual(loaded.groups[0].variable_ids, ['v1']);
  assert.equal(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')).group_membership_references, undefined);
  await assert.rejects(downloadSchemaFolder(base, { ...manifest, group_membership_references: { g: 'https://evil.example/file' } }, dir, hash, fetchImpl), /Invalid published membership reference/);
  await assert.rejects(downloadSchemaFolder(base, manifest, dir, '0'.repeat(64), fetchImpl), /hash mismatch/);
});

test('local evidence search preserves viewer ranking and findings respect the requested limit', async t => {
  try { execFileSync('duckdb', ['-version']); } catch { return t.skip('duckdb CLI unavailable'); }
  const dir = await mkdtemp(join(tmpdir(), 'echo-agent-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'canonical'));
  const vars = join(dir, 'canonical', 'variable_occurrences.parquet');
  const links = join(dir, 'canonical', 'causal_link_occurrences.parquet');
  execFileSync('duckdb', ['-c', `COPY (SELECT * FROM (VALUES
    ('v1', 1, 'education policy', 'policy', 'policy', 'paper', 'person'),
    ('v2', 2, 'education', 'education', 'school', 'paper', 'person'),
    ('v3', 3, 'other', 'other', 'education', 'paper', 'person')
    ) AS v(variable_id, index, display_label, concept_label, raw_variable_text, paper_id, uoa)) TO ${sqlString(vars)} (FORMAT PARQUET);
    COPY (SELECT 'r' || i AS raw_causal_link_id FROM range(12) t(i)) TO ${sqlString(links)} (FORMAT PARQUET);`]);
  const evidence = localEvidence(dir);
  const all = await evidence.variables(['v1', 'v2', 'v3']);
  for (const query of ['education', 'education policy', 'school', "'", '']) {
    const expected = searchVariables(query, { variables: all, selectedUoa: null, uoaFilterEnabled: false }, 2);
    assert.deepEqual(await evidence.searchVariables(query, 2), expected);
  }
  assert.equal((await evidence.rawLinks(null, 3)).length, 3);
  assert.equal((await evidence.rawLinks()).length, 12);
});
