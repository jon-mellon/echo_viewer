import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as visibility from '../site/variable_visibility.mjs';
import * as ops from '../site/dag_project.mjs';
import { aggregateGroupLinks, linkKey } from '../site/dag_link_aggregation.mjs';
import { legacyAggregate, legacyGroupOperation } from './fixtures/legacy_dag_project.mjs';

const timestamp = '2026-09-09T12:00:00.000Z';

test('an editable split preserves IDs and returns deselected variables to their source residual', () => {
  const project = ops.createProject({ projectId: 'test', groupingSetId: 'schema' });
  project.groups = [
    { group_id: 'a', label: 'A', variable_ids: ['a1', 'a2'] },
    { group_id: 'b', label: 'B', variable_ids: ['b1', 'b2'] },
  ];
  const split = ops.splitCategories(project, {
    sourceGroupIds: ['a', 'b'], newGroupId: 'new', newLabel: 'New',
    residualLabels: { a: 'Other A', b: 'Other B' }, newVariableIds: ['a1', 'b1'],
    timestamp, role: 'iv', splitId: 'split-1',
  });
  const context = ops.editableSplitContext(split, 'a');
  assert.equal(context?.newGroup.group_id, 'new');
  assert.deepEqual(context?.residuals.map(group => group.group_id), ['a', 'b']);
  const edited = ops.updateSplitCategories(split, {
    sourceGroupIds: ['a', 'b'], newGroupId: 'new', newLabel: 'Updated',
    residualLabels: { a: 'Rest A', b: 'Rest B' }, newVariableIds: ['a2', 'b1'],
    timestamp: '2026-09-09T13:00:00.000Z', role: 'iv', splitId: 'split-1',
  });
  assert.deepEqual(edited.groups.find(group => group.group_id === 'new').variable_ids, ['a2', 'b1']);
  assert.deepEqual(edited.groups.find(group => group.group_id === 'a').variable_ids, ['a1']);
  assert.deepEqual(edited.groups.find(group => group.group_id === 'b').variable_ids, ['b2']);
  assert.equal(edited.groups.find(group => group.group_id === 'new').label, 'Updated');
  assert.equal(edited.decisions.at(-1).type, 'split_categories_updated');
});

test('a split without reconstructable provenance is not editable', () => {
  const project = ops.createProject({ projectId: 'test', groupingSetId: 'schema' });
  project.groups = [
    { group_id: 'a', variable_ids: ['a1'], provenance: { operation: 'split_categories', split_id: 'old' } },
    { group_id: 'new', source: 'user_split', variable_ids: ['n1'],
      provenance: { operation: 'split_categories', split_id: 'old', source_group_ids: ['a'] } },
  ];
  assert.equal(ops.editableSplitContext(project, 'a'), null);
});

test('schema refresh retains schema and local rejections and hides their current duplicate representatives', () => {
  const project = ops.createProject({ projectId: 'test', groupingSetId: 'schema' });
  project.rejected_variables = [{ variable_id: 'local', member_variable_ids: [] }];
  const schema = { grouping_set_id: 'schema', groups: [],
    rejected_variables: [{ variable_id: 'old', member_variable_ids: ['old'] }] };
  const refreshed = ops.replaceSchemaGroups(project, schema);
  assert.deepEqual(refreshed.rejected_variables.map(e => e.variable_id), ['old', 'local']);
  assert.equal(project.rejected_variables.length, 1);
  const source = readFileSync(new URL('../site/dag_builder.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    visibility,
    state: { project: refreshed, clusterOf: new Map([['old', 'new']]),
      clusterMembers: new Map([['new', ['new', 'old']]]), variables: [
      { variable_id: 'new', is_cluster_rep: true },
      { variable_id: 'old', is_cluster_rep: false },
      { variable_id: 'local', is_cluster_rep: true },
      { variable_id: 'visible', is_cluster_rep: true },
    ] },
    clusterMemberIds: id => ['old', 'new'].includes(id) ? ['new', 'old'] : [id],
  });
  for (const name of ['rejectedVariableEntries', 'rejectedVariableIdSet', 'isRejectedVariable', 'visibleVariables', 'visibleClusterReps']) {
    const start = source.indexOf('function ' + name + '(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
  }
  assert.equal(context.isRejectedVariable('new'), true);
  assert.equal(context.visibleClusterReps().map(v => v.variable_id).join(','), 'visible');
  context.state.project.rejected_variables = [];
  assert.equal(context.visibleClusterReps().length, 3);
});
function fixture() {
  const project = ops.createProject({ projectId: 'test', groupingSetId: 'schema' });
  project.groups = [
    { group_id: 'z', label: 'IV', type: 'iv', variable_ids: ['v1', 'v1dup'], seed_variable_ids: ['v1'] },
    { group_id: 'a', label: 'DV', type: 'dv', variable_ids: ['v2'] },
    { group_id: 'c', label: 'Other', variable_ids: ['v3'] },
    { group_id: 'empty', label: 'Empty', variable_ids: [] },
  ];
  project.iv_group_id = 'z'; project.dv_group_id = 'a';
  const linkLookup = new Map([
    [linkKey('v1', 'v2'), ['r1', 'r1']], [linkKey('v2', 'v1'), ['r2']],
    [linkKey('v1dup', 'v2'), ['r1']], [linkKey('v3', 'v2'), ['r3']],
  ]);
  const rawLinksById = new Map([
    ['r1', { paper_id: 'p1', within_table_occurrence_id: 't1' }],
    ['r2', { paper_id: 'p1', within_table_occurrence_id: 't1' }], ['r3', {}],
  ]);
  return { project, linkLookup, rawLinksById };
}

test('aggregation preserves exact legacy direction, provenance, manual and decision semantics', () => {
  for (const scenario of ['mapping', 'manual', 'deleted', 'no-evidence', 'missing-anchor']) {
    const input = fixture();
    input.project.manual_edges.push({ edge_id: 'm1', source_group_id: 'c', target_group_id: 'a', direction: 'bidirectional', deleted: scenario === 'deleted' });
    input.project.link_decisions.a__c = { display_status: 'excluded', exclude_reason: 'test' };
    if (scenario === 'manual' || scenario === 'no-evidence') input.linkLookup.clear();
    if (scenario === 'no-evidence') input.project.manual_edges = [];
    if (scenario === 'missing-anchor') input.project.iv_group_id = 'missing';
    const before = structuredClone(input);
    const links = aggregateGroupLinks(input);
    assert.deepEqual(links, legacyAggregate(input), scenario);
    assert.deepEqual(input, before);
    assert.deepEqual(aggregateGroupLinks({ ...input, project: { ...input.project, groups: [...input.project.groups].reverse() } }), links);
    assert.ok(links.every(link => link.group_a !== 'empty' && link.group_b !== 'empty'));
    if (scenario === 'no-evidence') {
      assert.equal(links.length, 1);
      assert.equal(links[0].edge_id, 'z__a');
      assert.equal(links[0].direction_type, 'A_TO_B');
    }
  }
});

test('sparse link aggregation scales with evidence rather than group cross-products', () => {
  const groups = Array.from({ length: 100 }, (_, groupIndex) => ({
    group_id: `g${String(groupIndex).padStart(3, '0')}`,
    variable_ids: Array.from({ length: 30 }, (_, variableIndex) => `v${groupIndex}_${variableIndex}`),
  }));
  const linkLookup = new Map();
  const rawLinksById = new Map();
  for (let index = 0; index < 1500; index += 1) {
    const sourceGroup = index % groups.length;
    const targetGroup = (sourceGroup + 1 + (index % 17)) % groups.length;
    const source = groups[sourceGroup].variable_ids[index % 30];
    const target = groups[targetGroup].variable_ids[(index * 7) % 30];
    const rawId = `r${index}`;
    const key = linkKey(source, target);
    if (!linkLookup.has(key)) linkLookup.set(key, []);
    linkLookup.get(key).push(rawId);
    rawLinksById.set(rawId, { paper_id: `p${index % 20}`, within_table_occurrence_id: `t${index}` });
  }
  const project = { groups, iv_group_id: groups[0].group_id, dv_group_id: groups[1].group_id,
    manual_edges: [], link_decisions: {} };
  const started = performance.now();
  const links = aggregateGroupLinks({ project, linkLookup, rawLinksById });
  const elapsed = performance.now() - started;
  assert.ok(links.length > 0);
  assert.ok(elapsed < 500, `sparse aggregation took ${elapsed.toFixed(1)} ms`);
});

test('duplicate cluster transfer has one owner and updates derived evidence', () => {
  const input = fixture(), before = structuredClone(input.project);
  const next = ops.addMembers(input.project, 'c', ['v1', 'v1dup'], timestamp);
  assert.deepEqual(input.project, before);
  for (const id of ['v1', 'v1dup']) assert.deepEqual(next.groups.filter(g => g.variable_ids.includes(id)).map(g => g.group_id), ['c']);
  const edge = aggregateGroupLinks({ ...input, project: next }).find(link => link.edge_id === 'a__c');
  assert.deepEqual(edge.b_to_a_raw_link_ids, ['r3', 'r1']);
  const removed = ops.removeMembers(next, 'c', ['v1', 'v1dup'], timestamp);
  assert.deepEqual(removed.groups.find(g => g.group_id === 'c').variable_ids, ['v3']);
  assert.strictEqual(ops.addMembers(input.project, 'missing', ['v1'], timestamp), input.project);
});

test('anchor promotion matches legacy including invalid and opposite-anchor choices', () => {
  for (const [side, id] of [['iv', 'c'], ['dv', 'z'], ['invalid', 'c'], ['iv', 'missing'], ['iv', 'z']]) {
    const { project } = fixture(), before = structuredClone(project);
    assert.deepEqual(ops.promoteAnchor(project, side, id, timestamp), legacyGroupOperation(project, 'promoteGroupToAnchor', [side, id], timestamp).project);
    assert.deepEqual(project, before);
  }
});

test('normalization matches legacy first-owner policy without mutating inputs', () => {
  const { project } = fixture();
  project.groups[2].variable_ids.push('v1dup');
  project.rejected_variables = [{ variable_id: 'v1dup' }];
  const clusterOf = new Map([['v1dup', 'v1']]);
  const clusterMembers = new Map([['v1', ['v1', 'v1dup']]]);
  const before = structuredClone(project);
  assert.deepEqual(ops.normalizeDuplicateAssignments(project, clusterOf, clusterMembers),
    legacyGroupOperation(project, 'normalizeProjectDuplicateAssignments', [], timestamp, clusterOf, clusterMembers).project);
  assert.deepEqual(project, before);
});

test('schema imports preserve carve-outs, source deduplication and causal inclusion', () => {
  const input = fixture();
  const schema = { grouping_set_id: 's', groups: [
    { group_id: 'one', variable_ids: ['v1', 'v4'] },
    { group_id: 'two', variable_ids: ['v5'] },
    { group_id: 'three', variable_ids: ['v2'] },
  ] };
  input.linkLookup.set(linkKey('v4', 'v2'), ['r4']);
  const before = structuredClone({ ...input, schema });
  const actual = ops.importSchemaGroups(input.project, schema, input.linkLookup, timestamp);
  const expected = legacyGroupOperation(input.project, 'applyActiveGroupingSet', [schema], timestamp, undefined, undefined, input.linkLookup);
  assert.deepEqual(actual.project, expected.project);
  assert.deepEqual(actual.loadedGroupIds, expected.result);
  assert.deepEqual(actual.loadedGroupIds, ['schema_one']);
  assert.equal(actual.project.carve_outs.length, 2);
  assert.deepEqual(ops.importSchemaGroups(actual.project, schema, input.linkLookup, timestamp).loadedGroupIds, []);
  assert.deepEqual({ ...input, schema }, before);
});

test('snapshots restore membership and decisions, without deprecated group status', () => {
  const { project } = fixture();
  const snapshot = ops.snapshotProject(project, 'build');
  let next = ops.addMembers(project, 'c', ['v1', 'v1dup'], timestamp);
  next = ops.setLinkDecision(next, 'a__c', { display_status: 'hidden' });
  const restored = ops.restoreSnapshot(next, snapshot);
  assert.deepEqual(restored.project, { ...project, restored_variable_ids: [] });
  assert.equal(restored.phase, 'build');
  assert.deepEqual(ops.setLinkDecision(next, 'a__c', null).link_decisions, {});
  const legacy = JSON.parse(snapshot); legacy.groups[0].status = 'rejected';
  assert.equal('status' in ops.restoreSnapshot(next, JSON.stringify(legacy)).project.groups[0], false);
});

test('schema replacement preserves anchor source IDs and drops stale assignments', () => {
  const { project } = fixture();
  project.groups[0].source_group_id = 'iv-source';
  const schema = { grouping_set_id: 'latest', groups: [{ group_id: 'iv-source', variable_ids: ['new'], status: 'draft' }] };
  const before = structuredClone({ project, schema });
  const next = ops.replaceSchemaGroups(project, schema);
  assert.equal(next.iv_group_id, 'iv-source'); assert.equal(next.dv_group_id, 'g_dv');
  assert.deepEqual(next.groups[0].variable_ids, ['new']);
  assert.equal('status' in next.groups[0], false);
  assert.deepEqual({ project, schema }, before);
});

test('category splitting retains one source ID per leftover and moves reviewed manual records', () => {
  const { project } = fixture();
  project.groups[2].variable_ids.push('v4');
  project.manual_edges = [{ edge_id: 'm1', source_group_id: 'c', target_group_id: 'a' }];
  const next = ops.splitCategories(project, {
    sourceGroupIds: ['z', 'c'], newGroupId: 'new', newLabel: 'New construct',
    residualLabels: { z: 'Other IV', c: 'Other category' },
    newVariableIds: ['v1', 'v3'], timestamp, role: 'iv',
    manualEdgeDispositions: { m1: 'move' },
  });
  assert.deepEqual(next.groups.find(group => group.group_id === 'z').variable_ids, ['v1dup']);
  assert.equal(next.groups.find(group => group.group_id === 'z').type, null);
  assert.deepEqual(next.groups.find(group => group.group_id === 'c').variable_ids, ['v4']);
  assert.equal(next.groups.find(group => group.group_id === 'c').type, undefined);
  assert.equal(next.groups.find(group => group.group_id === 'new').type, 'iv');
  assert.deepEqual(next.groups.find(group => group.group_id === 'new').variable_ids, ['v1', 'v3']);
  assert.equal(next.iv_group_id, 'new');
  assert.equal(next.manual_edges[0].source_group_id, 'new');
  assert.equal(next.decisions.at(-1).type, 'split_categories');
  assert.throws(() => ops.splitCategories(project, {
    sourceGroupIds: ['c'], newGroupId: 'bad', newLabel: 'Bad',
    residualLabels: { c: 'Empty' }, newVariableIds: ['v3', 'v4'], timestamp, role: 'dv',
  }), /cannot be empty/);
});

test('membership conflicts, protected seeds and removal metadata retain their rules', () => {
  const { project } = fixture();
  const group = { group_id: 'new', variable_ids: ['v1', 'v3'] };
  assert.deepEqual(ops.membershipConflicts(project.groups, group), [{ groupId: 'z', variableId: 'v1' }, { groupId: 'c', variableId: 'v3' }]);
  assert.deepEqual([...ops.protectedSeedIds(project.groups[0], { iv: new Set(['v1dup']) })], ['v1dup']);
  assert.deepEqual([...ops.protectedSeedIds(project.groups[0], {})], ['v1']);
  const result = ops.removeMembersEverywhere(project, ['v1', 'v1dup', 'v3']);
  assert.deepEqual(result.previousGroupIds, ['z', 'c']);
  assert.equal(result.project.groups[0].variable_ids.length, 0);
});

test('manual deletion is immutable and removes only manual evidence', () => {
  const input = fixture();
  const edge = { edge_id: 'm', source_group_id: 'c', target_group_id: 'a', direction: 'bidirectional', deleted: false };
  const next = ops.appendManualEdge(input.project, edge);
  const deleted = ops.deleteManualEdge(next, 'm');
  assert.equal(next.manual_edges[0].deleted, false);
  assert.equal(deleted.manual_edges[0].deleted, true);
  const aggregated = aggregateGroupLinks({ ...input, project: deleted }).find(link => link.edge_id === 'a__c');
  assert.equal(aggregated.is_manual, false);
  assert.equal(aggregated.direction_type, 'B_TO_A');
});
