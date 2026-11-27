import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../server/backend/config.ts';
import { Workspaces } from '../server/backend/workspaces.ts';
import { WorkspaceFiles } from '../server/backend/files.ts';
import { ObservationCache } from '../server/backend/cache.ts';
import { automaticFileDirectory, browseDirectories, fileBrowserSettings } from '../server/backend/file-browser.ts';
import { filesTreeState } from '../client/files-tree-store.ts';
import { clearDocuments, getDocuments, openDocument, reconcileDocuments } from '../client/document-store.ts';

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/wb-file-browser-'));
  const projects = join(root, 'projects'), main = join(projects, 'team', 'communications-service'), other = join(projects, 'YUVA', 'agent-tools');
  for (const path of [main, other]) {
    await mkdir(path, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'pipe' });
    git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(path, 'README.md'), path === main ? 'main checkout\n' : 'other checkout\n'); git('add', '.'); git('commit', '-qm', 'initial');
  }
  const local = join(main, '.workspace-workbench'); await mkdir(local);
  const configPath = join(local, 'project.json');
  const raw = { schemaVersion: 1, project: { id: 'communications-service' }, sourceRoot: projects, workspaceRoot: '.', treesRoot: 'trees', recordsRoot: 'records', stateRoot: 'state',
    discovery: { mode: 'manual' }, repositories: [{ id: 'communications-service', path: main }, { id: 'agent-tools', path: other }], management: { enabled: true }, unknownHistory: ['keep'] };
  await writeFile(configPath, JSON.stringify(raw));
  const config = loadConfig(configPath), workspaces = new Workspaces(config), cache = new ObservationCache(config), files = new WorkspaceFiles(workspaces, cache, () => {});
  return { root, projects, main, other, raw, config, workspaces, files, call: (input: Record<string, any>) => files.request(input),
    async close() { await files.close(); await workspaces.observationRecords.close(); await cache.close(); await rm(root, { recursive: true, force: true }); } };
}

test('main files automatically use the host project directory without changing multi-repository scope or worktrees', async () => {
  const f = await fixture();
  try {
    const settings = await f.call({ action: 'browser-settings' });
    assert.equal(settings.mainDirectory, null); assert.equal(settings.effectiveDirectory, f.main);
    const workspace = f.workspaces.get('main');
    assert.equal(workspace.sourceRoot, f.projects); assert.equal(workspace.treePath, f.projects);
    assert.equal(workspace.fileRoot, f.main); assert.equal(workspace.repositories.length, 2);
    const page = await f.call({ action: 'list', workspaceId: 'main' });
    assert.ok(page.entries.some((entry: any) => entry.name === 'README.md')); assert.ok(!page.entries.some((entry: any) => entry.name === 'YUVA'));
    const preview = await f.call({ action: 'document', workspaceId: 'main', instance: page.instance, path: 'README.md' });
    assert.equal(preview.text, 'main checkout\n');
    const created: Record<string, any> = await f.workspaces.create({ name: 'work', repositories: ['communications-service'] });
    const recordPath = f.workspaces.records.recordPath(created.id);
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...record, fileRoot: f.other, futureHistory: ['keep'] }));
    const context = await f.files.roots.context(created.id);
    assert.equal(context.root, created.treePath); assert.notEqual(context.root, settings.effectiveDirectory);
    assert.equal(context.workspace.fileRoot, f.other, 'unknown record fields survive without becoming a file operation target');
    assert.equal(automaticFileDirectory({ ...f.config, configPath: join(f.root, 'external.json') }), f.projects);
    assert.deepEqual(JSON.parse(await readFile(f.config.configPath, 'utf8')), f.raw);
  } finally { await f.close(); }
});

test('choosing and resetting a main file directory preserve records, reject old instances and stale settings revisions', async () => {
  const f = await fixture();
  try {
    const old = await f.files.roots.context('main'), initial = fileBrowserSettings(f.config);
    const statePath = join(f.config.stateRoot, 'file-browser.json');
    await writeFile(statePath, JSON.stringify({ schemaVersion: 1, mainDirectory: null, history: ['keep'], future: { enabled: true } }));
    await assert.rejects(f.call({ action: 'browser-configure', revision: initial.revision, mainDirectory: f.other }), /changed/);
    const current = fileBrowserSettings(f.config);
    const changed = await f.call({ action: 'browser-configure', revision: current.revision, mainDirectory: f.other });
    assert.equal(changed.effectiveDirectory, f.other);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).history, ['keep']);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).future, { enabled: true });
    await assert.rejects(f.call({ action: 'list', workspaceId: 'main', instance: old.instance }), /instance changed/);
    await assert.rejects(f.call({ action: 'mkdir', workspaceId: 'main', instance: old.instance, path: '', name: 'stale', id: 'stale' }), /instance changed/);
    const page = await f.call({ action: 'document', workspaceId: 'main', path: 'README.md' }); assert.equal(page.text, 'other checkout\n');
    const reset = await f.call({ action: 'browser-configure', revision: changed.revision, mainDirectory: null });
    assert.equal(reset.effectiveDirectory, f.main);
    assert.deepEqual(JSON.parse(await readFile(f.config.configPath, 'utf8')), f.raw);
  } finally { await f.close(); }
});

test('active main transfers keep their pinned destinations while directory changes are rejected', async () => {
  const f = await fixture();
  try {
    let settings = fileBrowserSettings(f.config);
    await f.call({ action: 'upload', id: 'pending', workspaceId: 'main', path: '', name: 'pending.txt', size: 10, modifiedAt: 1 });
    const before = await f.files.roots.context('main');
    settings = await f.call({ action: 'browser-configure', revision: settings.revision, mainDirectory: f.main }) as typeof settings;
    assert.equal((await f.files.roots.context('main')).instance, before.instance, 'saving the same directory does not retarget an active task');
    await assert.rejects(f.call({ action: 'browser-configure', revision: settings.revision, mainDirectory: f.other }), /file tasks/);
    assert.equal(fileBrowserSettings(f.config).effectiveDirectory, f.main);
    await f.call({ action: 'control', id: 'pending', command: 'cancel' });
    const result = await f.call({ action: 'browser-configure', revision: settings.revision, mainDirectory: f.other });
    assert.equal(result.effectiveDirectory, f.other);
  } finally { await f.close(); }
});

test('host directory picker paginates directories, includes hidden folders and validates paths and cursors', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'choices'); await mkdir(path);
    await Promise.all(Array.from({ length: 205 }, (_, i) => mkdir(join(path, 'folder-' + i))));
    await mkdir(join(path, '.hidden')); await writeFile(join(path, 'file.txt'), 'not a directory');
    let page = await browseDirectories(path), names = page.entries.map(entry => entry.name);
    assert.equal(page.parent, f.root); assert.equal(page.entries.length, 100); assert.ok(page.cursor);
    while (page.cursor) { page = await browseDirectories(path, page.cursor); names.push(...page.entries.map(entry => entry.name)); }
    assert.equal(new Set(names).size, 206); assert.ok(names.includes('.hidden')); assert.ok(!names.includes('file.txt'));
    await assert.rejects(browseDirectories(path, 'invalid'), /changed/);
    await assert.rejects(browseDirectories('../escape'), /absolute/);
    await assert.rejects(browseDirectories(join(path, 'file.txt')), /directory/);
    const first = await browseDirectories(path); await mkdir(join(path, 'new-folder'));
    await assert.rejects(browseDirectories(path, first.cursor), /changed/);
  } finally { await f.close(); }
});

test('switching file views retains separate directory states and a new main root retires only its old tree', () => {
  const scope = 'file-browser-regression';
  const main = filesTreeState(scope, 'main', '/project'); main.instance = 'old'; main.root = 'docs'; main.expanded.add('docs'); main.scroll = 100; main.save();
  const work = filesTreeState(scope, 'work'); work.root = 'src'; work.scroll = 200;
  assert.equal(filesTreeState(scope, 'main', '/project'), main); assert.equal(main.root, 'docs'); assert.equal(main.scroll, 100);
  const changed = filesTreeState(scope, 'main', '/other');
  assert.equal(changed.root, ''); assert.equal(changed.instance, ''); assert.equal(changed.scroll, 0);
  assert.equal(work.root, 'src'); assert.equal(work.scroll, 200);
});

test('changing the main root retires old main document tabs while retaining managed Workspace documents', () => {
  const host = 'file-browser-documents', scope = 'file-browser-documents-scope';
  const selection = { hostWorkspaceId: host, scope, projectConfig: '/project.json', workspaceName: 'Main', path: 'README', workspaceId: 'main', instance: 'main:original:hash', directory: '/original' };
  openDocument(selection); openDocument({ ...selection, workspaceId: 'work', instance: 'work:one:hash', directory: '/work' });
  reconcileDocuments(scope, [{ id: 'main', state: 'active', instanceKey: 'main:original', fileRoot: '/changed' }, { id: 'work', state: 'active', instanceKey: 'work:one' }]);
  assert.deepEqual(getDocuments(host).map(document => document.workspaceId), ['work']);
  clearDocuments(host);
});
