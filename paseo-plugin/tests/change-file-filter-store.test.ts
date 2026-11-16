import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeFileFilterStore, fileFilterContext, type FileFilterSettingsIO } from '../client/change-file-filter-store.ts';
import { observerSettings } from '../shared/settings.ts';
import { DEFAULT_TEST_RULES } from '../shared/change-file-filter.ts';

function fixture(initial: Record<string, unknown> = {}) {
  let values = { ...observerSettings.schema.parse({}), ...initial }, revision = 1, reads = 0, writes = 0;
  const io: FileFilterSettingsIO = {
    async read() { reads++; return { status: 'ready', revision: String(revision), values: structuredClone(values) }; },
    async write(input) { writes++; if (input.revision !== String(revision)) return { status: 'conflict' }; values = structuredClone(input.values); revision++; return { status: 'saved', revision: String(revision), values }; },
  };
  return { io, state: () => ({ values, revision, reads, writes }) };
}

test('settings upgrade supplies filter maps without changing existing selection and display preferences', () => {
  const previous = { selectedWorkspaceByPaseoWorkspace: { host: 'stable-workspace-id' }, diffDisplay: { fontSize: 16, wrap: true }, productionBranches: { repo: 'origin/main' } };
  const upgraded = observerSettings.schema.parse(previous);
  assert.deepEqual(upgraded.changeFileDisplayByProject, {}); assert.deepEqual(upgraded.testFileRulesByProject, {});
  assert.equal(upgraded.selectedWorkspaceByPaseoWorkspace.host, 'stable-workspace-id'); assert.equal(upgraded.diffDisplay.fontSize, 16);
});

test('project preferences default to dim, load once and remain independent across projects', async () => {
  const store = new ChangeFileFilterStore(), { io, state } = fixture({ changeFileDisplayByProject: { a: 'hide' } });
  assert.equal(store.project('a').display, 'dim');
  await Promise.all([store.load(io), store.load(io)]); await store.load(io);
  assert.equal(state().reads, 1); assert.equal(store.project('a').display, 'hide'); assert.equal(store.project('b').display, 'dim');
  await store.updateProject('a', { display: 'all' }, io);
  assert.equal(store.project('b').display, 'dim'); assert.equal(state().values.changeFileDisplayByProject.a, 'all');
});

test('late hydration retains a user display edit and hydrates untouched project rules', async () => {
  const store = new ChangeFileFilterStore(), rules = { ...DEFAULT_TEST_RULES, testPatterns: ['*.verify'] };
  const data = fixture({ changeFileDisplayByProject: { a: 'all' }, testFileRulesByProject: { a: rules } });
  const snapshot = await data.io.read(); let resolve!: (value: typeof snapshot) => void;
  let first = true;
  const io = { ...data.io, read: () => { if (!first) return data.io.read(); first = false; return new Promise<typeof snapshot>(r => { resolve = r; }); } };
  const loading = store.load(io), edit = store.updateProject('a', { display: 'hide' }, io);
  resolve(snapshot); await loading; await edit;
  assert.equal(store.project('a').display, 'hide'); assert.deepEqual(store.project('a').rules, rules);
  assert.deepEqual(data.state().values.testFileRulesByProject.a, rules);
});

test('revision retries merge unrelated changes and retain unknown settings fields', async () => {
  const store = new ChangeFileFilterStore(), data = fixture({ legacyField: { keep: true }, selectedWorkspaceByPaseoWorkspace: { host: 'original' } });
  let conflict = true;
  const io = { ...data.io, async write(input: Parameters<FileFilterSettingsIO['write']>[0]) {
    if (conflict) { conflict = false; const fresh = await data.io.read(); await data.io.write({ revision: fresh.revision!, values: { ...input.values, diffDisplay: { fontSize: 18, wrap: true } } }); return { status: 'conflict' }; }
    return data.io.write(input);
  } };
  await store.updateProject('a', { display: 'hide' }, io);
  const { values } = data.state(); assert.equal(values.diffDisplay.fontSize, 18); assert.equal(values.selectedWorkspaceByPaseoWorkspace.host, 'original'); assert.deepEqual((values as any).legacyField, { keep: true });
  assert.equal(values.changeFileDisplayByProject.a, 'hide');
});

test('edits arriving during a save converge to the latest project preference', async () => {
  const store = new ChangeFileFilterStore(), data = fixture(); await store.load(data.io);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), active = new Promise<void>(r => { started = r; });
  let first = true;
  const io = { ...data.io, async write(input: Parameters<FileFilterSettingsIO['write']>[0]) { if (first) { first = false; started(); await gate; } return data.io.write(input); } };
  const before = store.updateProject('a', { display: 'hide' }, io); await active;
  const after = store.updateProject('a', { display: 'all' }, io); release(); await Promise.all([before, after]);
  assert.equal(store.project('a').display, 'all'); assert.equal(data.state().values.changeFileDisplayByProject.a, 'all');
});

test('save failures retain the usable optimistic value and can be retried', async () => {
  const store = new ChangeFileFilterStore(), data = fixture();
  await store.updateProject('a', { display: 'hide' }, { ...data.io, write: async () => { throw Error('offline'); } });
  assert.equal(store.project('a').display, 'hide'); assert.equal(store.project('a').error, 'settings_save_failed');
  await store.retry('a', data.io); assert.equal(store.project('a').error, ''); assert.equal(data.state().values.changeFileDisplayByProject.a, 'hide');
});

test('retrying an initial read failure reloads saved preferences without writing temporary defaults',async()=>{
  const store=new ChangeFileFilterStore(),rules={...DEFAULT_TEST_RULES,testPatterns:['*.verify']},data=fixture({changeFileDisplayByProject:{a:'hide'},testFileRulesByProject:{a:rules}});
  store.project('a');await store.load({...data.io,read:async()=>{throw Error('offline');}});
  assert.equal(store.project('a').error,'settings_read_failed');assert.equal(store.project('a').display,'dim');
  await store.retry('a',data.io);assert.equal(data.state().writes,0);assert.equal(store.project('a').display,'hide');assert.deepEqual(store.project('a').rules,rules);
});

test('an edit after failed initial hydration recovers untouched saved fields',async()=>{
  const store=new ChangeFileFilterStore(),rules={...DEFAULT_TEST_RULES,testPatterns:['*.verify']},data=fixture({testFileRulesByProject:{a:rules}});
  store.project('a');await store.load({...data.io,read:async()=>{throw Error('offline');}});
  await store.updateProject('a',{display:'hide'},data.io);
  assert.equal(store.project('a').display,'hide');assert.deepEqual(store.project('a').rules,rules);assert.deepEqual(data.state().values.testFileRulesByProject.a,rules);
});

test('invalid patterns retain the last valid query while unrelated note filters remain usable', () => {
  const store = new ChangeFileFilterStore();
  store.updateSession('one', { include: 'internal/**', matchMode: 'glob' });
  store.updateSession('one', { include: 'internal/**oops', noteFilter: 'has' });
  assert.equal(store.session('one').include, 'internal/**oops'); assert.equal(store.session('one').applied.include, 'internal/**'); assert.equal(store.session('one').noteFilter, 'has'); assert.ok(store.session('one').errors.include);
  store.updateSession('one', { include: 'src/**' }); assert.deepEqual(store.session('one').errors, {}); assert.equal(store.session('one').applied.include, 'src/**');
});

test('session queries isolate projects, Workspaces, repositories, commits and fixed comparisons', () => {
  const base = { projectConfig: 'a', workspaceId: 'main', repoPath: 'one', scope: 'working' };
  const scopes = [base, { ...base, projectConfig: 'b' }, { ...base, workspaceId: 'other' }, { ...base, repoPath: 'two' }, { ...base, scope: 'commit', commitSha: 'first' }, { ...base, scope: 'commit', commitSha: 'second' }];
  assert.equal(new Set(scopes.map(fileFilterContext)).size, scopes.length);
  const comparison = { fromRef: 'main', toRef: 'feature', fromSha: 'a', toSha: 'b', leftSha: 'a', mergeBase: null, mode: 'endpoints' as const };
  const compare = { ...base, scope: 'compare', comparison };
  assert.equal(fileFilterContext(compare), fileFilterContext({ ...compare, workspaceInstance: 'instance', comparison: { ...comparison, fromRef: 'a', toRef: 'b' } }));
  assert.notEqual(fileFilterContext(compare), fileFilterContext({ ...compare, comparison: { ...comparison, toSha: 'c' } }));
  const store = new ChangeFileFilterStore(); store.updateSession(fileFilterContext(base), { include: 'only-here' });
  assert.equal(store.session(fileFilterContext(scopes[1])).include, ''); store.resetSession(fileFilterContext(base)); assert.equal(store.session(fileFilterContext(base)).include, '');
});

test('invalid persisted project rules fall back conservatively and report the problem', async () => {
  const store = new ChangeFileFilterStore(), { io } = fixture({ testFileRulesByProject: { a: { ...DEFAULT_TEST_RULES, testPatterns: ['**invalid'] } } });
  await store.load(io); assert.deepEqual(store.project('a').rules, DEFAULT_TEST_RULES); assert.equal(store.project('a').error, 'invalid_saved_rules');
});
