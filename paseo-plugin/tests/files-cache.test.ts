import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/backend/config.ts';
import { ObservationCache } from '../server/backend/cache.ts';
import { FilesTreeState } from '../client/files-tree-store.ts';
import { WorkspaceActivityIndex } from '../server/backend/workspace-activity.ts';
import { Git } from '../server/backend/git.ts';
import { execFileSync } from 'node:child_process';

test('cache cleanup preserves shared owners, fences late results and survives reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-files-cache-')), configFile = join(root, 'project.json');
  await writeFile(configFile, JSON.stringify({ sourceRoot: root, stateRoot: join(root, 'state') }));
  const config = loadConfig(configFile), cache = new ObservationCache(config);
  const a = { id: 'a', state: 'active', instanceId: 'one', repositories: [{ worktreePath: '/shared' }] }, b = { id: 'b', state: 'active', repositories: [{ worktreePath: '/shared' }] };
  try {
    cache.reconcileWorkspaces([a,b]);
    await cache.read('shared', 'v1', async () => ({ repoPath: '/shared' }), true, true, { workspaceId: 'a', repoPath: '/shared' });
    await cache.read('shared', 'v1', async () => ({}), true, true, { workspaceId: 'b', repoPath: '/shared' });
    await cache.read('a', 'v1', async () => ({ workspaceId: 'a' }), true, true, { workspaceId: 'a' });
    let resolveLate!: (data: any) => void;
    const late = cache.read('late', 'v1', () => new Promise(resolve => { resolveLate = resolve; }), true, true, { workspaceId: 'a' });
    cache.evictWorkspace('a'); resolveLate({ workspaceId: 'a' }); await late;
    assert.equal(cache.retained('a'), undefined); assert.equal(cache.retained('late'), undefined); assert.ok(cache.retained('shared'));
    cache.reconcileWorkspaces([b]); await cache.close();
    const persisted = JSON.parse(await readFile(cache.path, 'utf8')); assert.deepEqual(persisted.entries.map((entry: any[]) => entry[0]), ['shared']);
    const reopened = new ObservationCache(config); assert.ok(reopened.retained('shared')); reopened.reconcileWorkspaces([]); assert.equal(reopened.status().memory.entries, 0); await reopened.close();
  } finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
});

test('new Workspace instance rejects old snapshots; invalid roster is not deletion evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-files-instance-')), configFile = join(root, 'project.json');
  await writeFile(configFile, JSON.stringify({ sourceRoot: root })); const cache = new ObservationCache(loadConfig(configFile));
  try {
    cache.reconcileWorkspaces([{ id: 'a', instanceId: 'old', state: 'active' }]);
    await cache.read('old', 'v1', async () => ({ workspaceId: 'a' }), true, true, { workspaceId: 'a' });
    cache.reconcileWorkspaces([{ id: 'a', state: 'record_invalid' }]); assert.ok(cache.retained('old'));
    cache.reconcileWorkspaces([{ id: 'a', instanceId: 'new', state: 'active' }]); assert.equal(cache.retained('old'), undefined);
  } finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed file refresh preserves visible contents, selection and scroll; retired requests stay retired', async () => {
  const state = new FilesTreeState('test', 'a');
  const page = { workspaceId: 'a', instance: 'one', path: '', version: 'v1', entries: [{ path: 'untracked', name: 'untracked', kind: 'file', size: 1, modifiedAt: 1, version: 'v1', protected: false, repository: false }] };
  await state.load('', async () => page); state.selected.add('untracked'); state.scroll = 123;
  await state.load('', async () => { throw new Error('offline'); });
  assert.equal(state.pages.get('')?.entries.length, 1); assert.ok(state.selected.has('untracked')); assert.equal(state.scroll, 123);
  let finish!: (page: any) => void; const pending = state.load('', () => new Promise(resolve => { finish = resolve; }));
  state.clear(); finish(page); await pending; assert.equal(state.pages.size, 0);
});

test('commit activity retains shared owners and fences a late result from a replaced Workspace instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-files-activity-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'file'), 'activity'); git('add', 'file'); git('commit', '-qm', 'activity');
  const configPath = join(root, 'project.json'); await writeFile(configPath, JSON.stringify({ sourceRoot: root }));
  await symlink(root, join(root, 'second-repository-alias'), 'dir');
  const config = loadConfig(configPath), repositories = [{ worktreePath: root }, { worktreePath: join(root, 'second-repository-alias') }];
  const a = { id: 'a', instanceId: 'one', state: 'active', repositories }, b = { id: 'b', instanceId: 'one', state: 'active', repositories };
  let activity = new WorkspaceActivityIndex(config);
  const waitScan = async (id: string) => { for (let i = 0; i < 300 && activity.status(id).state === 'running'; i++) await new Promise(r => setTimeout(r, 10)); assert.equal(activity.status(id).state, 'complete'); };
  const originalRun = Git.prototype.run;
  let release: (() => void) | undefined;
  try {
    activity.reconcileWorkspaces([a, b]); activity.start('shared', [a, b]); await waitScan('shared');
    const timestamp = activity.summary(a).latestCommitAt; assert.ok(timestamp);
    activity.reconcileWorkspaces([b]); assert.equal(activity.summary(b).latestCommitAt, timestamp);
    activity.reconcileWorkspaces([{ id: 'b', state: 'record_invalid' }]); assert.equal(activity.summary(b).latestCommitAt, timestamp);
    await activity.close(); activity = new WorkspaceActivityIndex(config); activity.reconcileWorkspaces([b]);
    assert.equal(activity.summary(b).latestCommitAt, timestamp, 'surviving shared owner persists');

    const replacement = { ...b, instanceId: 'two' };
    activity.reconcileWorkspaces([replacement]); assert.equal(activity.summary(replacement).latestCommitAt, null);
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    Git.prototype.run = async function(...args: Parameters<Git['run']>) { entered(); await blocked; return originalRun.apply(this, args); };
    activity.start('late', [replacement]); await ready;
    const newest = { ...b, instanceId: 'three' }; activity.reconcileWorkspaces([newest]); release!(); await waitScan('late');
    assert.equal(activity.summary(newest).latestCommitAt, null, 'late HEAD cannot repopulate a new instance');
    await activity.close(); activity = new WorkspaceActivityIndex(config); activity.reconcileWorkspaces([newest]);
    assert.equal(activity.summary(newest).latestCommitAt, null, 'retired result stays absent after reopening');
  } finally { release?.(); Git.prototype.run = originalRun; await activity.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed changes update cached trees immediately and fence an older directory response', async () => {
  const state = new FilesTreeState('immediate-change', 'a');
  const entry = { path: 'deleted', name: 'deleted', kind: 'file' as const, size: 1, modifiedAt: 1, version: 'v1', protected: false, repository: false };
  const page = { workspaceId: 'a', instance: 'one', path: '', version: 'v1', entries: [entry] };
  await state.load('', async () => structuredClone(page)); state.selected.add('deleted'); state.scroll = 123;
  const unsubscribe = state.subscribe(() => {});
  let release!: (value: any) => void;
  const old = state.load('', () => new Promise(resolve => { release = resolve; }));
  const calls: any[] = [];
  const rpc = async (input: any) => { calls.push(input); if (input.action === 'list') return { ...page, version: 'v2', entries: [] }; if (input.action === 'versions') return { versions: { '': 'v2' } }; return { workspaceId: 'a', instance: 'one', entries: [], freshness: 'fresh', observedAt: '', issues: [] }; };
  state.changed({ workspaceId: 'a', instance: 'one', paths: ['deleted'], removed: ['deleted'] }, rpc);
  assert.equal(state.pages.get('')?.entries.length, 0, 'confirmed deletion disappears before another directory request');
  assert.equal(state.selected.size, 0); assert.equal(state.scroll, 123);
  release(structuredClone(page)); await old;
  assert.equal(state.pages.get('')?.entries.length, 0, 'a pre-delete request cannot restore the deleted row');
  await state.validate(rpc);
  assert.ok(calls.some(input => input.action === 'list' && input.fresh === true)); assert.equal(state.pages.get('')?.version, 'v2');
  state.changed({ workspaceId: 'a', instance: 'replacement', paths: ['deleted'] }, rpc);
  assert.equal(state.pages.get('')?.version, 'v2');
  unsubscribe();
});

test('fresh reads wait past an older producer and use the post-mutation fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-files-fresh-')), configFile = join(root, 'project.json');
  await writeFile(configFile, JSON.stringify({ sourceRoot: root })); const cache = new ObservationCache(loadConfig(configFile));
  try {
    let release!: (value: any) => void;
    const old = cache.read('directory', 'before', () => new Promise(resolve => { release = resolve; }), true, true);
    let produced = 0;
    const fresh = cache.read('directory', 'after', async () => { produced++; return { version: 'after', entries: [] }; }, true, true);
    release({ version: 'before', entries: ['removed'] }); await old;
    assert.equal((await fresh).version, 'after'); assert.equal(produced, 1); assert.equal(cache.retained('directory')?.version, 'after');
  } finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
});
