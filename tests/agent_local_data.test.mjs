import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localEvidence, sqlString } from '../agent/local_data.mjs';
import { searchVariables } from '../site/dag_search.mjs';

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
