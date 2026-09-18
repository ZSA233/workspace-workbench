import test from 'node:test';
import assert from 'node:assert/strict';
import { versionDelta, shouldRefreshVersionedQuery } from '../client/version-invalidation.ts';

test('a repository edit refreshes its active detail and changes without refreshing the roster or another workspace', () => {
  const before = { instanceId: 'same', revision: 10, rosterRevision: 2,
    tokens: { 'workspace:a': 'a:1', 'workspace:b': 'b:1', '/repo/a#working': '1', '/repo/b#working': '1' },
    workspaceVersions: { a: 1, b: 1 }, repositoryVersions: { '/repo/a': 1, '/repo/b': 1 } };
  const after = { ...before, revision: 11, tokens: { ...before.tokens, 'workspace:a': 'a:2', '/repo/a#working': '2' },
    workspaceVersions: { a: 2, b: 1 }, repositoryVersions: { '/repo/a': 2, '/repo/b': 1 } };
  const delta = versionDelta(before, after);
  const refresh = (key: unknown[], validationKey?: string) => shouldRefreshVersionedQuery('project', delta,
    ['workspace-workbench', 'project', ...key], { ok: true, result: { observation: { validationKey } } }, true);
  assert.equal(refresh(['workspace-list']), false);
  assert.equal(refresh(['workspace-detail', 'a'], 'workspace:a'), true);
  assert.equal(refresh(['workspace-detail', 'b'], 'workspace:b'), false);
  assert.equal(refresh(['repository-changes', 'a', 'repo'], '/repo/a#working'), true);
  assert.equal(refresh(['repository-changes', 'b', 'repo'], '/repo/b#working'), false);
  assert.equal(refresh(['review', ['a']]), true);
  assert.equal(refresh(['review', ['b']]), false);
  assert.equal(shouldRefreshVersionedQuery('project', delta, ['workspace-workbench', 'project', 'workspace-detail', 'a'], undefined, false), false);
});

test('roster mutation refreshes the list without invalidating unchanged repository snapshots', () => {
  const before = { instanceId: 'same', revision: 4, rosterRevision: 1, tokens: { 'workspace:a': 'a:1' } };
  const delta = versionDelta(before, { ...before, revision: 5, rosterRevision: 2 });
  const query = (kind: string) => shouldRefreshVersionedQuery('project', delta, ['workspace-workbench', 'project', kind, 'a'], undefined, true);
  assert.equal(query('workspace-list'), true);
  assert.equal(query('workspace-detail'), false);
});
