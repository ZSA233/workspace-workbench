import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
import { ObservationScheduler } from '../server/backend/observation-scheduler.ts';
import { RepositoryStatus } from '../server/backend/repository-status.ts';
import { FileDecorationsService } from '../server/backend/file-decorations.ts';
import { Git } from '../server/backend/git.ts';
import { fileRequest } from '../shared/files.ts';
import { gitMark, directoryGitMark, emptyGitCounts, type FileDecorations } from '../shared/file-decorations.ts';
import { FilesTreeState } from '../client/files-tree-store.ts';
import { fileTreeIcon, fileGitDescription, fileGitPalette, fileGitColor } from '../client/files-decoration-display.ts';
import { iconShapes } from '../client/icon-shapes.ts';
import { createHash } from 'node:crypto';
import { hash } from '../server/backend/storage.ts';
const git = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const put = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function init(path: string) {
  await mkdir(path, { recursive: true }); git(path, 'init', '-q'); git(path, 'config', 'user.name', 'Fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid');
  for (const name of ['clean.txt', 'mod.txt', 'staged.txt', 'tracked.tmp', 'rmignored.txt', 'cached.txt', 'gone/old.txt', 'before/rename.txt', 'type.txt', 'conflicts/file.txt']) await put(join(path, name), 'original content of '+name+'\n');
  git(path, 'add', '.'); git(path, 'commit', '-qm', 'initial');
}
async function fixture(names = ['repo'], internalState = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-decorations-')));
  for (const name of names) await init(join(root, name));
  const config = join(root, 'project.json');
  const stateRoot = join(root, internalState ? names[0] + '/.workspace-workbench' : 'state');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot, workspaceRoot: join(root, 'workspaces'), repositories: names.map(path => ({ id: path.replaceAll('/', '-'), path })), discovery: { mode: 'manual' }, management: { enabled: true } }));
  const callbacks = new Map<string, (...args: any[]) => void>();
  const scheduler = new ObservationScheduler({ internalPaths: [stateRoot], subscribe: async (path, callback) => { callbacks.set(path, callback); return { unsubscribe: async () => {} }; } });
  const service = new Service(loadConfig(config), 'test', { scheduler });
  const id = (await service.handle('workspace.list')).workspaces[0].id as string;
  return { root, repo: join(root, names[0]), stateRoot, callbacks, service, id,
    async query(paths: string[], force = true) { return await service.handle('files.request', { action: 'decorations', workspaceId: id, paths, force }) as FileDecorations; },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
}
const entries = (result: FileDecorations) => new Map(result.entries.map(entry => [entry.path, entry]));

test('real index/worktree status, deletions and cross-directory renames decorate the actual tree', async () => {
  const f = await fixture();
  try {
    await put(join(f.repo, 'mod.txt'), 'modified\n');
    await put(join(f.repo, 'staged.txt'), 'staged\n'); git(f.repo, 'add', 'staged.txt'); await put(join(f.repo, 'staged.txt'), 'edited after staging\n');
    await put(join(f.repo, 'added.txt'), 'added'); git(f.repo, 'add', 'added.txt'); await put(join(f.repo, 'untracked.txt'), 'untracked');
    await mkdir(join(f.repo, 'after')); git(f.repo, 'mv', 'before/rename.txt', 'after/renamed.txt'); await rm(join(f.repo, 'gone/old.txt'));
    await rm(join(f.repo, 'type.txt')); await symlink('clean.txt', join(f.repo, 'type.txt')); git(f.repo, 'rm', '--cached', 'cached.txt');
    const paths = ['', 'repo', 'repo/mod.txt', 'repo/staged.txt', 'repo/added.txt', 'repo/untracked.txt', 'repo/cached.txt', 'repo/type.txt', 'repo/gone', 'repo/before', 'repo/after', 'repo/after/renamed.txt', 'repo/clean.txt'];
    const result = await f.query(paths); assert.equal(result.freshness, 'fresh', JSON.stringify(result));
    const rows = entries(result);
    for (const [name, mark] of [['mod.txt', 'M'], ['staged.txt', 'M'], ['added.txt', 'A'], ['untracked.txt', 'U'], ['cached.txt', 'D'], ['type.txt', 'T'], ['after/renamed.txt', 'R']]) assert.equal(rows.get('repo/'+name)?.mark, mark, name);
    assert.deepEqual(rows.get('repo/staged.txt')?.changes, [{ index: 'M', worktree: 'M' }]);
    assert.equal(rows.get('repo/cached.txt')?.changes?.length, 2, 'staged deletion and untracked disk file are both retained');
    assert.equal(rows.get('repo/clean.txt')?.mark, undefined);
    assert.equal(rows.get('repo/gone')?.directory?.deleted, 1);
    assert.equal(rows.get('repo/before')?.directory?.renamed, 1); assert.equal(rows.get('repo/after')?.directory?.renamed, 1);
    assert.equal(rows.get('repo')?.directory?.renamed, 1, 'common ancestor counts the rename once');
    const page = await f.service.handle('files.request', { action: 'list', workspaceId: f.id, path: 'repo/gone' }); assert.equal(page.entries.length, 0, 'deletions do not create virtual filesystem nodes');
    const details = fileGitDescription(rows.get('repo/staged.txt'), true); assert.match(details, /暂存区：修改/); assert.match(details, /工作目录：修改/);
  } finally { await f.close(); }
});

test('real merge conflicts take priority on files and collapsed ancestors', async () => {
  const f = await fixture();
  try {
    const branch = git(f.repo, 'branch', '--show-current'); git(f.repo, 'checkout', '-qb', 'other'); await put(join(f.repo, 'conflicts/file.txt'), 'other\n'); git(f.repo, 'commit', '-qam', 'other');
    git(f.repo, 'checkout', '-q', branch); await put(join(f.repo, 'conflicts/file.txt'), 'main\n'); git(f.repo, 'commit', '-qam', 'main');
    assert.throws(() => git(f.repo, 'merge', 'other'));
    const rows = entries(await f.query(['', 'repo/conflicts', 'repo/conflicts/file.txt']));
    assert.equal(rows.get('repo/conflicts/file.txt')?.mark, '!'); assert.equal(rows.get('repo/conflicts')?.mark, '!'); assert.equal(rows.get('')?.mark, '!');
    assert.equal(rows.get('repo/conflicts')?.directory?.conflicts, 1);
  } finally { await f.close(); }
});

test('Git ignore sources, negations, special names and tracked matches keep their exact semantics', async () => {
  const f = await fixture();
  try {
    await put(join(f.repo, '.gitignore'), 'ignored/\n*.tmp\n!keep.tmp\nrmignored.txt\n');
    git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore rules');
    await put(join(f.repo, '.git/info/exclude'), 'local.secret\n');
    const global = join(f.root, 'global-ignore'); await put(global, '*.global\n'); git(f.repo, 'config', 'core.excludesFile', global);
    for (const name of ['ignored/deep/file.txt', 'new.tmp', 'line\n tab\t.tmp', ':(literal)name.tmp', 'bracket[abc].tmp', 'keep.tmp', 'local.secret', 'test.global']) await put(join(f.repo, name), 'ignored?');
    git(f.repo, 'rm', '--cached', 'rmignored.txt');
    const rows = entries(await f.query(['repo', 'repo/ignored', 'repo/ignored/deep/file.txt', 'repo/new.tmp', 'repo/line\n tab\t.tmp', 'repo/:(literal)name.tmp', 'repo/bracket[abc].tmp', 'repo/keep.tmp', 'repo/local.secret', 'repo/test.global', 'repo/tracked.tmp', 'repo/rmignored.txt']));
    for (const name of ['ignored', 'ignored/deep/file.txt', 'new.tmp', 'line\n tab\t.tmp', ':(literal)name.tmp', 'bracket[abc].tmp', 'local.secret', 'test.global']) { const entry = rows.get('repo/'+name); assert.ok(entry?.ignored, name); assert.equal(entry?.mark, undefined); }
    assert.match(rows.get('repo/local.secret')!.ignored!.source, /info\/exclude$/); assert.equal(rows.get('repo/test.global')!.ignored!.source, global);
    assert.equal(rows.get('repo/keep.tmp')?.ignored, undefined); assert.equal(rows.get('repo/keep.tmp')?.mark, 'U');
    assert.equal(rows.get('repo/tracked.tmp')?.ignored, undefined); assert.equal(rows.get('repo/tracked.tmp')?.mark, undefined, 'tracked clean files are not ignored');
    assert.equal(rows.get('repo/rmignored.txt')?.mark, 'D'); assert.equal(rows.get('repo/rmignored.txt')?.ignored, undefined, 'actual staged changes override ignore');
    assert.equal(rows.get('repo')?.directory?.total, 2, 'only staged deletion and untracked negation contribute');
    await put(join(f.repo, 'tracked.tmp'), 'modified despite ignore'); assert.equal(entries(await f.query(['repo/tracked.tmp'])).get('repo/tracked.tmp')?.mark, 'M');
  } finally { await f.close(); }
});

test('ignored descendants alone do not color parents; opening ignored folders does not rerun Git status', async () => {
  const f = await fixture(), original = Git.prototype.run; let statuses = 0;
  try {
    await put(join(f.repo, '.gitignore'), 'build/\n'); git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore build');
    await put(join(f.repo, 'build/deep/data'), 'generated');
    Git.prototype.run = async function(...args) { if (args[0][0] === 'status') statuses++; return original.apply(this, args); };
    const result = entries(await f.query(['repo', 'repo/build'], false)); assert.equal(result.get('repo')?.mark, undefined); assert.equal(result.get('repo')?.directory?.total, 0); assert.ok(result.get('repo/build')?.ignored);
    const before = statuses; await f.query(['repo/build/deep', 'repo/build/deep/data'], false);
    assert.equal(statuses, before, 'new paths only need batched ignore checking against the shared status');
    const allBefore = f.service.health().git.commands; await f.query(['repo/build/deep', 'repo/build/deep/data'], false); assert.equal(f.service.health().git.commands, allBefore, 'same version and path batch uses the bounded cache');
  } finally { Git.prototype.run = original; await f.close(); }
});

test('external ignore edits are revalidated within thirty seconds and manual refresh is immediate', async () => {
  const f = await fixture(); let clock = Date.now();
  const status = new RepositoryStatus(f.service.cache, f.service.observation.scheduler, 3000, () => clock), decorations = new FileDecorationsService(f.service.files.roots, status);
  try {
    const global = join(f.root, 'global-ignore'); await put(global, '*.secret\n'); git(f.repo, 'config', 'core.excludesFile', global); await put(join(f.repo, 'key.secret'), 'key');
    const context = await f.service.files.roots.context(f.id);
    const first = await decorations.query(context, ['repo/key.secret']); assert.ok(first.entries[0].ignored);
    await put(global, ''); clock += 30_001;
    let result = await decorations.query(context, ['repo/key.secret']);
    for (let i = 0; i < 100 && result.freshness !== 'fresh'; i++) { await sleep(10); result = await decorations.query(context, ['repo/key.secret']); }
    assert.equal(result.entries[0].mark, 'U'); assert.equal(result.entries[0].ignored, undefined);
    await put(global, '*.secret\n'); result = await decorations.query(context, ['repo/key.secret'], true); assert.ok(result.entries[0].ignored); assert.equal(result.freshness, 'fresh');
  } finally { status.close(); await f.close(); }
});

test('multiple and nested repositories use the nearest registered owner and aggregate once', async () => {
  const f = await fixture(['outer', 'outer/inner', 'sibling']);
  try {
    await put(join(f.repo, '.gitignore'), 'inner/\n'); git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'outer ignores inner');
    await put(join(f.root, 'outer/inner/mod.txt'), 'inner changed'); await put(join(f.root, 'sibling/new.txt'), 'new'); await put(join(f.root, 'outside.txt'), 'outside');
    const rows = entries(await f.query(['', 'outer', 'outer/inner', 'outer/inner/mod.txt', 'sibling', 'outside.txt']));
    assert.equal(rows.get('outer/inner')?.ignored, undefined); assert.equal(rows.get('outer/inner/mod.txt')?.repository, 'outer/inner'); assert.equal(rows.get('outer/inner/mod.txt')?.mark, 'M');
    assert.equal(rows.get('outer')?.directory?.total, 1); assert.equal(rows.get('')?.directory?.total, 2); assert.equal(rows.get('sibling')?.mark, 'A');
    assert.equal(rows.get('outside.txt')?.mark, undefined); assert.equal(rows.get('outside.txt')?.repository, undefined);
  } finally { await f.close(); }
});

test('failed refresh retains useful decorations and initial incomplete results stay unknown', async () => {
  const f = await fixture(), original = Git.prototype.run;
  try {
    await put(join(f.repo, 'mod.txt'), 'modified'); const first = await f.query(['repo', 'repo/mod.txt']); assert.equal(first.entries[1].mark, 'M');
    Git.prototype.run = async function(...args) { if (args[0][0] === 'status') throw new Error('injected offline Git'); return original.apply(this, args); };
    const stale = await f.query(['repo', 'repo/mod.txt']); assert.equal(stale.freshness, 'stale'); assert.equal(stale.entries[1].mark, 'M');
    const unknown = await f.query(['repo/clean.txt']); assert.equal(unknown.freshness, 'unknown'); assert.equal(unknown.entries[0].state, 'unknown');
  } finally { Git.prototype.run = original; await f.close(); }
});

test('decoration batches obey item/byte limits and cannot escape through symlink parents', async () => {
  const f = await fixture();
  try {
    assert.equal(fileRequest.safeParse({ action: 'decorations', workspaceId: f.id, paths: Array(201).fill('a') }).success, false);
    await assert.rejects(f.query(Array.from({ length: 4 }, (_, n) => String(n).repeat(20000))), /byte budget/);
    await assert.rejects(f.query(['../outside']), /Invalid path/);
    await symlink(tmpdir(), join(f.root, 'external')); const result = await f.query(['external/path']); assert.equal(result.entries[0].state, 'unknown');
  } finally { await f.close(); }
});

test('Gitlink content and pointer changes respect child checkout boundaries', async () => {
  const f = await fixture(['repo', 'child']);
  try {
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', join(f.root, 'child'), 'server'); git(f.repo, 'commit', '-qam', 'add child');
    const candidates = await f.service.handle('linked.workspaces.list');
    await f.service.handle('linked.workspaces.save', { revision: candidates.revision, repositories: [f.repo] });
    const live = f.service.workspaces.list().find(row => row.kind === 'linked-live')!;
    const query = async () => await f.service.handle('files.request', { action: 'decorations', workspaceId: live.id, paths: ['', 'server', 'server/mod.txt'], force: true }) as FileDecorations;
    await put(join(f.repo, 'server/mod.txt'), 'child working change');
    let rows = entries(await query()); assert.equal(rows.get('server/mod.txt')?.repository, 'server'); assert.equal(rows.get('')?.directory?.total, 1, 'dirty child content is not also an outer pointer modification');
    git(join(f.repo, 'server'), 'config', 'user.name', 'Fixture'); git(join(f.repo, 'server'), 'config', 'user.email', 'fixture@example.invalid'); git(join(f.repo, 'server'), 'commit', '-qam', 'child commit');
    rows = entries(await query()); assert.equal(rows.get('server/mod.txt')?.mark, undefined); assert.equal(rows.get('server')?.mark, 'M'); assert.equal(rows.get('')?.directory?.modified, 1, 'new child HEAD is an outer Gitlink pointer change');
  } finally { await f.close(); }
});

test('file decorations share original XY snapshots with the selected Git view', async () => {
  const f = await fixture(), original = Git.prototype.run; let fullStatuses = 0;
  try {
    await put(join(f.repo, 'staged.txt'), 'staged'); git(f.repo, 'add', 'staged.txt'); await put(join(f.repo, 'staged.txt'), 'unstaged');
    Git.prototype.run = async function(...args) { if (args[0][0] === 'status' && args[0].includes('--untracked-files=all')) fullStatuses++; return original.apply(this, args); };
    const input = { workspaceId: f.id, repoPath: 'repo', scope: 'working', requestId: 'shared-xy' };
    let task = await f.service.handle('observer.refresh', input);
    for (let i = 0; i < 300 && ['queued', 'running'].includes(task.state); i++) { await sleep(10); task = await f.service.handle('observer.refresh', { action: 'status', taskId: task.taskId, requestId: input.requestId }); }
    assert.equal(task.state, 'ready');
    const before = fullStatuses; assert.ok(before > 0);
    const result = await f.query(['repo/staged.txt'], false); assert.equal(fullStatuses, before, 'no second status scan to add file colors'); assert.deepEqual(result.entries[0].changes, [{ index: 'M', worktree: 'M' }]);
  } finally { Git.prototype.run = original; await f.close(); }
});

test('retired Workspace cache ownership and late decorations cannot populate a replacement instance', async () => {
  const f = await fixture(), original = Git.prototype.run; let release: (() => void) | undefined;
  try {
    const w = await f.service.handle('workspace.create', { name: 'decorated', repositories: ['repo'] });
    const context = await f.service.files.roots.context(w.id);
    const call = (paths: string[]) => f.service.handle('files.request', { action: 'decorations', workspaceId: w.id, instance: context.instance, paths });
    assert.equal((await call(['repo'])).freshness, 'fresh');
    const before = f.service.cache.status().memory.entries;
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    Git.prototype.run = async function(...args) { if (args[0][0] === 'check-ignore' && this.path === join(w.treePath, 'repo')) { entered(); await gate; } return original.apply(this, args); };
    const late = call(['repo/clean.txt']); await ready;
    f.service.files.retire(w.id); f.service.observation.scheduler.retireWorkspace(w.id); f.service.cache.evictWorkspace(w.id);
    assert.ok(f.service.cache.status().memory.entries < before);
    const record = f.service.workspaces.get(w.id); f.service.workspaces.records.save({ ...record, instanceId: 'replacement-instance' }, false);
    f.service.cache.reconcileWorkspaces(f.service.workspaces.list());
    release!(); const result = await late; assert.equal(result.freshness, 'unknown');
    const current = await f.service.files.roots.context(w.id); assert.notEqual(current.instance, context.instance);
    await assert.rejects(call(['repo']), /instance changed/);
    // Retired producers are fenced both in memory and in the derived JSON persisted at shutdown.
    await f.service.cache.close(); const saved = JSON.parse(await readFile(f.service.cache.path, 'utf8'));
    assert.ok(saved.entries.every(([, entry]: any[]) => entry.value.instance !== context.instance));
  } finally { release?.(); Git.prototype.run = original; await f.close(); }
});

test('a raw status flight from the same ID in an older instance is never reused by its replacement', async () => {
  const f = await fixture(), original = Git.prototype.run; let release: (() => void) | undefined;
  try {
    const roster = (instanceId: string) => [{ id: 'same', state: 'active', instanceId, repositories: [{ worktreePath: f.repo }] }];
    f.service.cache.reconcileWorkspaces(roster('one'));
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
    Git.prototype.run = async function(...args) {
      const result = await original.apply(this, args);
      if (args[0][0] === 'status' && first) { first = false; entered(); await gate; }
      return result;
    };
    const old = f.service.observation.status.read('same', f.repo, false, 'one'); await ready;
    f.service.cache.reconcileWorkspaces(roster('two')); await put(join(f.repo, 'mod.txt'), 'new instance modification');
    const fresh = await f.service.observation.status.read('same', f.repo, false, 'two'); assert.ok(fresh.rows.some(([code, name]) => name === 'mod.txt' && code === ' M'));
    release!(); const retired = await old; assert.equal(retired.rows.length, 0);
    await f.service.cache.close(); const saved = JSON.parse(await readFile(f.service.cache.path, 'utf8'));
    assert.ok(saved.entries.filter(([key]: string[]) => key.startsWith('raw-status:')).every(([key]: string[]) => !key.endsWith(hash('one'))));
  } finally { release?.(); Git.prototype.run = original; await f.close(); }
});

test('durable upload progress in a repository-local state directory does not invalidate Git decorations', async () => {
  const f = await fixture(['repo'], true);
  try {
    const bytes = Buffer.alloc(512 * 1024, 7), sha256 = createHash('sha256').update(bytes).digest('hex');
    await f.service.handle('files.request', { action: 'upload', workspaceId: f.id, path: 'repo', id: 'progress-only', name: 'upload.bin', size: bytes.length * 2, modifiedAt: 1, policy: 'ask' });
    const first = await f.query(['repo'], false); assert.equal(first.entries[0].directory?.total, 0, 'internal journals are not user-file changes');
    const before = f.service.health().git.commands, token = f.service.observation.scheduler.statusToken(f.repo);
    for (const offset of [0, bytes.length]) {
      await f.service.handle('files.request', { action: 'chunk', id: 'progress-only', offset, data: bytes.toString('base64'), sha256 });
      f.callbacks.get(f.repo)?.(null, [{ type: 'update', path: join(f.stateRoot, 'file-transfers/tasks.sqlite3-wal') }]);
    }
    await sleep(350); assert.equal(f.service.observation.scheduler.statusToken(f.repo), token);
    await f.query(['repo'], false); assert.equal(f.service.health().git.commands, before);
    await f.service.handle('files.request', { action: 'control', id: 'progress-only', command: 'cancel' });
  } finally { await f.close(); }
});

test('decoration updates retain tree UI state, bound requests, and fence late instance replies', async () => {
  const tree = new FilesTreeState('decorations-test', 'a'); tree.instance = 'old'; tree.selected.add('file'); tree.expanded.add('folder'); tree.scroll = 123;
  const response = (paths: string[], instance = 'old'): FileDecorations => ({ workspaceId: 'a', instance, observedAt: 'now', freshness: 'fresh', version: 'v1', entries: paths.map(path => ({ path, state: 'ready', mark: 'M' })), issues: [] });
  const requests: any[] = [];
  await tree.decorations.refresh(Array.from({ length: 401 }, (_, n) => 'file'+n), async input => { requests.push(input); return response(input.paths); });
  assert.deepEqual(requests.map(request => request.paths.length), [200, 200, 1]); assert.equal(tree.selected.has('file'), true); assert.equal(tree.expanded.has('folder'), true); assert.equal(tree.scroll, 123); assert.equal(tree.pages.size, 0);
  await tree.decorations.refresh(['file0'], async () => { throw new Error('offline'); }); assert.equal(tree.decorations.entries.get('file0')?.entry.mark, 'M'); assert.equal(tree.decorations.entries.get('file0')?.freshness, 'stale');
  await tree.decorations.refresh(['file0'], async () => ({ ...response([]), freshness: 'unknown' })); assert.equal(tree.decorations.entries.get('file0')?.entry.mark, 'M');
  let finish!: (result: FileDecorations) => void; const late = tree.decorations.refresh(['late'], () => new Promise(resolve => { finish = resolve; })); tree.clear(); tree.instance = 'new'; finish(response(['late'])); await late; assert.equal(tree.decorations.entries.size, 0);
});

test('status priority, neutral icon coverage and theme colors preserve compact distinctions', () => {
  assert.equal(gitMark('AM'), 'M'); assert.equal(gitMark('RM'), 'R'); assert.equal(gitMark('AD'), 'D'); assert.equal(gitMark('UU'), '!'); assert.equal(gitMark('C '), 'C'); assert.equal(gitMark(' T'), 'T');
  assert.equal(directoryGitMark({ ...emptyGitCounts(), untracked: 1 }), 'A'); assert.equal(directoryGitMark({ ...emptyGitCounts(), untracked: 1, conflicts: 1 }), '!');
  for (const [name, kind] of [['dir', 'directory'], ['a.ts', 'file'], ['a.json', 'file'], ['photo.png', 'file'], ['archive.zip', 'file'], ['README.md', 'file'], ['other', 'file'], ['link', 'link']]) assert.ok(iconShapes[fileTreeIcon(name, kind)]);
  const light = fileGitPalette({ colors: { surface0: '#ffffff', accent: '#0000ff' } }), dark = fileGitPalette({ colors: { surface0: '#171717', accent: '#0000ff' } });
  assert.notEqual(light.ignored, dark.ignored); assert.notEqual(dark.ignored, dark.added);
  assert.equal(fileGitColor({ path: '', state: 'ready', mark: 'A', directory: { ...emptyGitCounts(), added: 1 } }, dark, '#fff'), dark.added);
  assert.equal(fileGitColor({ path: '', state: 'ready', mark: 'M', directory: { ...emptyGitCounts(), renamed: 1 } }, dark, '#fff'), dark.modified);
});
