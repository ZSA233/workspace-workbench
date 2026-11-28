import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../server/backend/config.ts';
import { Workspaces } from '../server/backend/workspaces.ts';
import { WorkspaceFiles } from '../server/backend/files.ts';
import { ObservationCache } from '../server/backend/cache.ts';

async function fixture() {
  const root = await realpath(await mkdtemp('/tmp/wb-metadata-')), repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
  git('init', '-qb', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README.md'), 'ordinary source\n'); git('add', '.'); git('commit', '-qm', 'initial');
  const local = join(repo, '.workspace-workbench'); await mkdir(local);
  const configPath = join(local, 'project.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: root, workspaceRoot: '.', stateRoot: 'state', recordsRoot: 'state/records', treesRoot: 'worktrees', repositories: [{ id: 'repo', path: repo }], discovery: { mode: 'manual' }, management: { enabled: true } }));
  await mkdir(join(local, 'notes')); await writeFile(join(local, 'notes', 'readme.md'), '# Internal note\n\nRead only.\n');
  const config = loadConfig(configPath), workspaces = new Workspaces(config), cache = new ObservationCache(config), files = new WorkspaceFiles(workspaces, cache, () => {});
  return { root, repo, local, configPath, workspaces, files, git, call: (request: Record<string, any>) => files.request({ workspaceId: 'main', ...request }),
    async close() { await files.close(); await workspaces.observationRecords.close(); await cache.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Git and Workbench metadata directories expand, paginate and revalidate as read-only in both listing protocols', async () => {
  const f = await fixture();
  try {
    for (const listingProtocol of [undefined, 2]) {
      const root = await f.call({ action: 'list', path: '', listingProtocol });
      for (const name of ['.git', '.workspace-workbench']) {
        const entry = root.entries.find((entry: any) => entry.name === name);
        assert.equal(entry.kind, 'directory'); assert.equal(entry.protected, true); assert.equal(entry.readOnly, true);
        const page = await f.call({ action: 'list', path: name, instance: root.instance, listingProtocol, ...(listingProtocol === 2 ? { order: 'sorted' } : {}), limit: 1 });
        assert.equal(page.readOnly, true); assert.ok(page.entries.length); assert.ok(page.entries.every((entry: any) => entry.readOnly && entry.protected));
        assert.ok(page.cursor);
        const next = await f.call({ action: 'list', path: name, instance: root.instance, listingProtocol, cursor: page.cursor, limit: 1 });
        assert.equal(next.readOnly, true); assert.notEqual(next.entries[0].path, page.entries[0].path);
      }
      const nested = await f.call({ action: 'list', path: '.workspace-workbench/notes', listingProtocol });
      assert.equal(nested.entries[0].path, '.workspace-workbench/notes/readme.md'); assert.equal(nested.readOnly, true);
      const versions = await f.call({ action: 'versions', paths: ['.git', '.workspace-workbench', '.workspace-workbench/notes'], listingProtocol });
      assert.ok(Object.values(versions.versions).every(version => version !== 'missing'));
    }
  } finally { await f.close(); }
});

test('protected files support preview, document paging and syntax without creating transfer tasks', async () => {
  const f = await fixture();
  try {
    for (const path of ['.git/HEAD', '.git/config', '.workspace-workbench/project.json', '.workspace-workbench/notes/readme.md']) {
      const text = await readFile(join(f.repo, path), 'utf8');
      const preview = await f.call({ action: 'preview', path }); assert.equal(Buffer.from(preview.data, 'base64').toString(), text);
      const page = await f.call({ action: 'document', path }); assert.equal(page.text, text); assert.equal(page.readOnly, true);
      const syntax = await f.call({ action: 'document-syntax', path, version: page.version, markdown: path.endsWith('.md') }); assert.equal(syntax.version, page.version);
      const info = await f.call({ action: 'document-stat', path, version: page.version }); assert.equal(info.size, Buffer.byteLength(text));
    }
    assert.equal((await f.call({ action: 'tasks' })).tasks.length, 0);
    assert.equal((await f.call({ action: 'document', path: 'README.md' })).readOnly, undefined);
  } finally { await f.close(); }
});

test('metadata write, rename, delete, copy, move and archive guards remain authoritative', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.configPath, 'utf8'), head = await readFile(join(f.repo, '.git/HEAD'), 'utf8');
    for (const path of ['.git/hooks', '.workspace-workbench/notes', '.workspace-workbench/state']) {
      await assert.rejects(f.call({ action: 'upload', id: 'upload-' + path.length, path, name: 'new.txt', size: 0, modifiedAt: 1 }), /protected/);
      await assert.rejects(f.call({ action: 'mkdir', id: 'mkdir-' + path.length, path, name: 'new' }), /protected/);
    }
    for (const path of ['.git/HEAD', '.workspace-workbench/project.json', '.workspace-workbench/notes']) {
      for (const operation of ['delete', 'rename', 'move', 'copy'])
        await assert.rejects(f.call({ action: 'mutate', id: operation + '-' + path.length, operation, entries: [{ workspaceId: 'main', path }], destination: { workspaceId: 'main', path: '' }, name: 'changed', confirm: true }), /protected/);
      await assert.rejects(f.call({ action: 'download', id: 'download-' + path.length, paths: [path] }), /ordinary directories/);
    }
    await assert.rejects(f.call({ action: 'mutate', id: 'copy-into-metadata', operation: 'copy', entries: [{ workspaceId: 'main', path: 'README.md' }], destination: { workspaceId: 'main', path: '.workspace-workbench/notes' } }), /protected/);
    const context = await f.files.roots.context('main');
    await assert.rejects(f.files.roots.path(context, '.git/HEAD', { inspect: true, mutate: true }), /protected/);
    await assert.rejects(f.files.roots.read(context, '.git/HEAD'), /protected/, 'transfer reads do not implicitly gain inspection permission');
    assert.equal((await f.call({ action: 'tasks' })).tasks.length, 0);
    assert.equal(await readFile(f.configPath, 'utf8'), before); assert.equal(await readFile(join(f.repo, '.git/HEAD'), 'utf8'), head);
  } finally { await f.close(); }
});

test('inspection cannot traverse symbolic links and private transfer entries remain hidden', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(f.local, 'outside')); await symlink(join(outside, 'secret.txt'), join(f.local, 'outside-file'));
    await assert.rejects(f.call({ action: 'list', path: '.workspace-workbench/outside' }), /directory/);
    await assert.rejects(f.call({ action: 'document', path: '.workspace-workbench/outside/secret.txt' }), /symbolic/);
    await assert.rejects(f.call({ action: 'document', path: '.workspace-workbench/outside-file' }), /ELOOP|symbolic/);
    const privateName = '.workbench-transfer-private'; await mkdir(join(f.local, privateName)); await writeFile(join(f.local, privateName, 'data'), 'temporary');
    for (const listingProtocol of [undefined, 2]) {
      const page = await f.call({ action: 'list', path: '.workspace-workbench', listingProtocol, ...(listingProtocol ? { order: 'sorted' } : {}) });
      assert.ok(!page.entries.some((entry: any) => entry.name === privateName));
    }
    await assert.rejects(f.call({ action: 'list', path: '.workspace-workbench/' + privateName }), /protected/);
    await assert.rejects(f.call({ action: 'document', path: '.workspace-workbench/' + privateName + '/data' }), /protected/);
  } finally { await f.close(); }
});

test('a managed Workspace stays writable while viewing its tree through the main root is read-only', async () => {
  const f = await fixture();
  try {
    const created: Record<string, any> = await f.workspaces.create({ name: 'development', repositories: ['repo'] });
    const current = await f.call({ action: 'browser-settings' });
    await f.call({ action: 'browser-configure', revision: current.revision, mainDirectory: created.treePath });
    const page = await f.call({ action: 'list', path: '' }); assert.equal(page.readOnly, true);
    const repositoryPath = relative(created.treePath, created.repositories[0].worktreePath).split('\\').join('/');
    const repository = page.entries.find((entry: any) => entry.path === repositoryPath);
    assert.ok(repository); assert.equal(repository.readOnly, true); assert.equal(repository.protected, true);
    await assert.rejects(f.call({ action: 'download', id: 'internal-repo-blocked', paths: [repository.path] }), /ordinary directories/);
    await assert.rejects(f.call({ action: 'upload', id: 'main-blocked', path: '', name: 'blocked', size: 0, modifiedAt: 1 }), /protected/);
    const managed = await f.call({ action: 'list', workspaceId: created.id, path: '' }); assert.equal(managed.readOnly, undefined);
    const gitFile = relative(created.treePath, join(created.repositories[0].worktreePath, '.git')).split('\\').join('/');
    const pointer = await f.call({ action: 'document', workspaceId: created.id, path: gitFile });
    assert.equal(pointer.readOnly, true); assert.match(pointer.text, /^gitdir: /, 'worktree Git pointer files are readable without following them outside the Workspace');
    await f.call({ action: 'upload', id: 'managed-allowed', workspaceId: created.id, path: '', name: 'allowed.txt', size: 0, modifiedAt: 1 });
    assert.equal((await f.call({ action: 'finish', id: 'managed-allowed' })).state, 'complete');
    assert.equal(await readFile(join(created.treePath, 'allowed.txt'), 'utf8'), '');
  } finally { await f.close(); }
});

test('choosing metadata itself as the main file root cannot bypass its write protection', async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, 'config-alias'); await symlink(f.local, alias);
    for (const directory of [join(f.repo, '.git'), f.local, f.workspaces.config.stateRoot, alias]) {
      const current = await f.call({ action: 'browser-settings' });
      await f.call({ action: 'browser-configure', revision: current.revision, mainDirectory: directory });
      const page = await f.call({ action: 'list', path: '' }); assert.equal(page.readOnly, true);
      assert.ok(page.entries.every((entry: any) => entry.readOnly && entry.protected));
      await assert.rejects(f.call({ action: 'mkdir', id: 'blocked-root', path: '', name: 'blocked' }), /protected/);
    }
  } finally { await f.close(); }
});
