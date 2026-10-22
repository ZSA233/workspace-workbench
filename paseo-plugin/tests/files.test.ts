import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../server/backend/config.ts';
import { Workspaces } from '../server/backend/workspaces.ts';
import { ObservationCache } from '../server/backend/cache.ts';
import { WorkspaceFiles } from '../server/backend/files.ts';
import { FILE_CHUNK_BYTES } from '../shared/files.ts';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function fixture(externalTrees = false) {
  const root = await mkdtemp(join(tmpdir(), 'wb-files-')), repo = join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README'), 'initial'); git('add', '.'); git('commit', '-qm', 'initial');
  if (externalTrees) await mkdir(resolve(import.meta.dirname, '../../.local'), { recursive: true });
  const external = externalTrees ? await mkdtemp(resolve(import.meta.dirname, '../../.local/files-cross-device-')) : undefined;
  const configPath = join(root, 'project.json'); await writeFile(configPath, JSON.stringify({ ...(external ? { treesRoot: join(external, 'trees') } : {}), schemaVersion: 1, sourceRoot: root, repositories: [{ id: 'repo', path: 'repo' }], management: { enabled: true } }));
  const config = loadConfig(configPath), workspaces = new Workspaces(config), cache = new ObservationCache(config);
  let files = new WorkspaceFiles(workspaces, cache, () => {});
  const main = workspaces.list()[0].id;
  return { root, repo, config, workspaces, cache, main, get files() { return files; },
    async restart() { await files.close(); files = new WorkspaceFiles(workspaces, cache, () => {}); },
    async close() { await files.close(); await workspaces.observationRecords.close(); await cache.close(); await rm(root, { recursive: true, force: true }); if (external) await rm(external, { recursive: true, force: true }); },
    call(input: Record<string, any>) { return files.request(input); },
    async wait(id: string, states = ['complete', 'failed', 'conflict', 'active']) { for (let i = 0; i < 600; i++) { const t = files.tasks.journal.require(id); if (states.includes(t.state)) return t; await new Promise(r => setTimeout(r, 10)); } throw new Error('task did not settle: ' + id); },
  };
}

test('uploads confirm durable chunks, reconcile lost ACKs and resume after restart', async () => {
  const f = await fixture();
  try {
    const request = { action: 'upload', id: 'durable', workspaceId: f.main, path: 'deep/nested', name: 'data.bin', size: FILE_CHUNK_BYTES + 31, modifiedAt: 123, policy: 'ask' };
    const start = await f.call(request), first = Buffer.alloc(FILE_CHUNK_BYTES, 19), last = Buffer.alloc(31, 24);
    const chunk = { action: 'chunk', id: request.id, offset: 0, data: first.toString('base64'), sha256: sha(first) };
    assert.equal((await f.call(chunk)).offset, first.length);
    assert.equal((await f.call(chunk)).offset, first.length, 'lost confirmation replay is idempotent');
    await assert.rejects(f.call({ ...chunk, sha256: sha(last) }), /checksum|differs/);
    await f.restart(); assert.equal((await f.call({ action: 'task', id: request.id })).state, 'interrupted');
    await f.call({ action: 'verify', id: request.id, offset: 0, sha256: sha(first) });
    await f.call({ action: 'control', id: request.id, command: 'resume' });
    await f.call({ action: 'chunk', id: request.id, offset: first.length, data: last.toString('base64'), sha256: sha(last) });
    await f.call({ action: 'finish', id: request.id }); const result = await f.wait(request.id, ['complete', 'failed']); assert.equal(result.state, 'complete', result.error);
    assert.equal((await f.call({ action: 'finish', id: request.id })).state, 'complete', 'lost commit response can be queried or replayed');
    assert.equal(sha(await readFile(join(f.root, 'deep/nested/data.bin'))), sha(Buffer.concat([first, last])));
    assert.equal((await f.call(request)).instance, start.instance);
    await assert.rejects(f.call({ ...request, size: 9 }), /reused/);
  } finally { await f.close(); }
});

test('target versions gate replacement; empty uploads and protected paths work', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'existing'), 'old');
    const request = { action: 'upload', id: 'replace', workspaceId: f.main, path: '', name: 'existing', size: 0, modifiedAt: 123, policy: 'ask' };
    assert.equal((await f.call(request)).state, 'conflict');
    await writeFile(join(f.root, 'existing'), 'edited while deciding');
    const changed = await f.call({ action: 'control', id: 'replace', command: 'replace' }); assert.equal(changed.state, 'conflict'); assert.equal(changed.conflict, 'changed');
    assert.equal(await readFile(join(f.root, 'existing'), 'utf8'), 'edited while deciding');
    await f.call({ action: 'control', id: 'replace', command: 'replace' });
    await writeFile(join(f.root, 'existing'), 'new user edit');
    await f.call({ action: 'finish', id: 'replace' });
    assert.equal((await f.wait('replace', ['conflict', 'failed', 'complete'])).state, 'conflict');
    assert.equal(await readFile(join(f.root, 'existing'), 'utf8'), 'new user edit');
    await f.call({ action: 'control', id: 'replace', command: 'keep' });
    assert.equal((await f.wait('replace', ['complete', 'failed'])).state, 'complete');
    assert.equal((await lstat(join(f.root, 'existing (1)'))).size, 0);
    for (const path of ['../outside', '/etc', 'repo/.git', '.workspace-workbench']) await assert.rejects(f.call({ ...request, id: 'bad_' + Math.random().toString(36).slice(2), path }));
    await symlink(tmpdir(), join(f.root, 'external'));
    await assert.rejects(f.call({ ...request, id: 'symlink', path: 'external' }), /symbolic|directory/);
    await assert.rejects(f.call({ action: 'mutate', id: 'remove_repo', operation: 'delete', entries: [{ workspaceId: f.main, path: 'repo' }], confirm: true }), /protected/);
  } finally { await f.close(); }
});

test('directory listings paginate real untracked files and file operations retain versions', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'docs')); await writeFile(join(f.root, 'docs/a'), 'A'); await writeFile(join(f.root, 'docs/b'), 'B');
    const first = await f.call({ action: 'list', workspaceId: f.main, path: 'docs', limit: 1 }); assert.equal(first.entries.length, 1); assert.ok(first.cursor);
    const next = await f.call({ action: 'list', workspaceId: f.main, path: 'docs', limit: 1, cursor: first.cursor }); assert.equal(next.entries.length, 1); assert.notEqual(first.entries[0].path, next.entries[0].path);
    await f.call({ action: 'mutate', id: 'copy', operation: 'copy', entries: [{ workspaceId: f.main, path: 'docs/a', version: first.entries.find((e: any) => e.path === 'docs/a')?.version }], destination: { workspaceId: f.main, path: '' } });
    assert.equal((await f.wait('copy', ['complete', 'failed'])).state, 'complete'); assert.equal(await readFile(join(f.root, 'a'), 'utf8'), 'A');
    await f.call({ action: 'mutate', id: 'rename', operation: 'rename', entries: [{ workspaceId: f.main, path: 'a' }], name: 'renamed' });
    assert.equal((await f.wait('rename', ['complete', 'failed'])).state, 'complete');
    await assert.rejects(f.call({ action: 'mutate', id: 'delete', operation: 'delete', entries: [{ workspaceId: f.main, path: 'renamed' }] }), /Confirm/);
    await f.call({ action: 'mutate', id: 'delete', operation: 'delete', entries: [{ workspaceId: f.main, path: 'renamed' }], confirm: true });
    assert.equal((await f.wait('delete', ['complete', 'failed'])).state, 'complete'); await assert.rejects(lstat(join(f.root, 'renamed')));
  } finally { await f.close(); }
});

test('confirming one replacement does not authorize the next conflicting file in an operation', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'from')); await mkdir(join(f.root, 'to'));
    for (const name of ['a', 'b']) { await writeFile(join(f.root, 'from', name), 'new ' + name); await writeFile(join(f.root, 'to', name), 'old ' + name); }
    await f.call({ action: 'mutate', id: 'individual_conflicts', operation: 'copy', entries: ['a', 'b'].map(name => ({ workspaceId: f.main, path: 'from/' + name })), destination: { workspaceId: f.main, path: 'to' } });
    assert.equal((await f.wait('individual_conflicts', ['conflict', 'failed'])).state, 'conflict');
    await f.call({ action: 'control', id: 'individual_conflicts', command: 'replace' });
    const second = await f.wait('individual_conflicts', ['conflict', 'failed', 'complete']); assert.equal(second.state, 'conflict'); assert.equal(second.processed, 1);
    assert.equal(await readFile(join(f.root, 'to/a'), 'utf8'), 'new a'); assert.equal(await readFile(join(f.root, 'to/b'), 'utf8'), 'old b');
    await f.call({ action: 'control', id: 'individual_conflicts', command: 'skip' }); assert.equal((await f.wait('individual_conflicts', ['complete', 'failed'])).state, 'complete');
    assert.equal(await readFile(join(f.root, 'to/b'), 'utf8'), 'old b');
  } finally { await f.close(); }
});

test('small deletions and upload commits return confirmed changes and an authoritative directory page', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'docs')); await writeFile(join(f.root, 'docs/remove.txt'), 'remove');
    const page = await f.call({ action: 'list', workspaceId: f.main, path: 'docs' }); assert.equal(page.entries.length, 1);
    const deleted = await f.call({ action: 'mutate', id: 'quick_delete', operation: 'delete', entries: [{ workspaceId: f.main, instance: page.instance, path: 'docs/remove.txt' }], confirm: true });
    assert.equal(deleted.state, 'complete', 'small operations settle in the initial response');
    assert.deepEqual(deleted.changes, [{ workspaceId: f.main, instance: page.instance, paths: ['docs/remove.txt'], removed: ['docs/remove.txt'] }]);
    const fresh = await f.call({ action: 'list', workspaceId: f.main, path: 'docs', fresh: true }); assert.equal(fresh.entries.length, 0);
    await f.call({ action: 'upload', id: 'quick_upload', workspaceId: f.main, path: 'docs', name: 'new.txt', size: 0, modifiedAt: 1 });
    const uploaded = await f.call({ action: 'finish', id: 'quick_upload' }); assert.equal(uploaded.state, 'complete');
    assert.deepEqual(uploaded.changes, [{ workspaceId: f.main, instance: page.instance, paths: ['docs/new.txt'] }]);
    assert.equal((await f.call({ action: 'list', workspaceId: f.main, path: 'docs', fresh: true })).entries[0].name, 'new.txt');
    await mkdir(join(f.root, 'protected/.git'), { recursive: true }); await writeFile(join(f.root, 'protected/keep'), 'keep');
    const failed = await f.call({ action: 'mutate', id: 'failed_delete', operation: 'delete', entries: [{ workspaceId: f.main, path: 'protected' }], confirm: true });
    assert.equal(failed.state, 'failed'); assert.equal(failed.changes, undefined); assert.equal(await readFile(join(f.root, 'protected/keep'), 'utf8'), 'keep');
  } finally { await f.close(); }
});

test('same-path moves and renames create no journal entries; invalid descendants are rejected before queuing', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'folder/sub'), { recursive: true }); await writeFile(join(f.root, 'folder/photo.jpg'), 'photo');
    const count = f.files.tasks.journal.list().length;
    for (const [id, operation, path, destination, name] of [
      ['file_noop', 'move', 'folder/photo.jpg', 'folder', undefined],
      ['folder_noop', 'move', 'folder', '', undefined],
      ['rename_noop', 'rename', 'folder/photo.jpg', 'folder', 'photo.jpg'],
    ] as const) {
      const result = await f.call({ action: 'mutate', id, operation, entries: [{ workspaceId: f.main, path }], destination: { workspaceId: f.main, path: destination }, name });
      assert.deepEqual(result, { noop: true });
    }
    await assert.rejects(f.call({ action: 'mutate', id: 'invalid_self', operation: 'move', entries: [{ workspaceId: f.main, path: 'folder' }], destination: { workspaceId: f.main, path: 'folder/sub' } }), /into itself/);
    assert.equal(f.files.tasks.journal.list().length, count); assert.equal(await readFile(join(f.root, 'folder/photo.jpg'), 'utf8'), 'photo');
    await writeFile(join(f.root, 'other.txt'), 'other');
    const mixed = await f.call({ action: 'mutate', id: 'mixed_move', operation: 'move', entries: ['folder/photo.jpg', 'other.txt'].map(path => ({ workspaceId: f.main, path })), destination: { workspaceId: f.main, path: 'folder' } });
    assert.equal(mixed.state, 'complete'); assert.equal(mixed.files, 1); assert.equal(await readFile(join(f.root, 'folder/other.txt'), 'utf8'), 'other');
    assert.ok(mixed.changes[0].removed.includes('other.txt')); assert.ok(!mixed.changes[0].removed.includes('folder/photo.jpg'));
  } finally { await f.close(); }
});

test('download chunks stop on source change; directories generate streaming ZIPs', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'docs')); await writeFile(join(f.root, 'docs/a'), 'A'); await mkdir(join(f.root, 'docs/empty'));
    await f.call({ action: 'download', id: 'single', workspaceId: f.main, paths: ['docs/a'] }); assert.equal((await f.wait('single')).state, 'active');
    const chunk = await f.call({ action: 'read', id: 'single', offset: 0 }); assert.equal(Buffer.from(chunk.data, 'base64').toString(), 'A');
    await writeFile(join(f.root, 'docs/a'), 'changed'); await assert.rejects(f.call({ action: 'read', id: 'single', offset: 0 }), /Source changed/);
    await f.call({ action: 'download', id: 'zip', workspaceId: f.main, paths: ['docs'] }); const zip = await f.wait('zip'); assert.equal(zip.state, 'active', zip.error); assert.ok(zip.size! > 0);
    const archive = await f.call({ action: 'read', id: 'zip', offset: 0 }); assert.equal(Buffer.from(archive.data, 'base64').readUInt32LE(0), 0x04034b50);
    await f.call({ action: 'ack', id: 'zip', offset: zip.size }); assert.equal((await f.call({ action: 'task', id: 'zip' })).state, 'ready_to_save');
    await f.call({ action: 'control', id: 'zip', command: 'complete' }); assert.equal((await f.call({ action: 'task', id: 'zip' })).state, 'complete');
  } finally { await f.close(); }
});

test('download selections cross request batches and restarts without starting a partial archive', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'many'));
    const paths = Array.from({ length: 201 }, (_, n) => `many/file-${n}.txt`);
    await Promise.all(paths.map(path => writeFile(join(f.root, path), path)));
    const task = await f.call({ action: 'download', id: 'selection', workspaceId: f.main, paths: paths.slice(0, 200), defer: true });
    assert.equal(task.selectionPending, true); assert.equal(task.selectionCount, 200);
    await assert.rejects(f.call({ action: 'delegate', id: task.id }), /incomplete/);
    await f.restart(); await assert.rejects(f.call({ action: 'control', id: task.id, command: 'resume' }), /incomplete/);
    const final = { action: 'download-selection', id: task.id, offset: 200, paths: paths.slice(200), final: true };
    const selected = await f.call(final); assert.equal(selected.selectionCount, 201); assert.equal(selected.selectionPending, false);
    await f.call(final); // A lost confirmation can replay exactly the same last selection batch.
    await assert.rejects(f.call({ ...final, paths: ['many/file-0.txt'] }), /differs/);
    const ready = await f.wait(task.id, ['active', 'failed']); assert.equal(ready.state, 'active', ready.error); assert.equal(ready.processed, 201);
    const result = await f.call({ action: 'read', id: task.id, offset: 0 }), zip = Buffer.from(result.data, 'base64');
    assert.equal(zip.subarray(0, 2).toString(), 'PK'); assert.ok(zip.includes(Buffer.from('file-0.txt'))); assert.ok(zip.includes(Buffer.from('file-200.txt')));
  } finally { await f.close(); }
});

test('unfinished transfers retain storage and block both source and destination Workspace removal', async () => {
  const f = await fixture();
  try {
    const workspace: any = await f.workspaces.create({ name: 'files', repositories: ['repo'] });
    const context = await f.files.roots.context(workspace.id);
    await f.call({ action: 'upload', id: 'pending', workspaceId: workspace.id, instance: context.instance, path: '', name: 'local', size: 9, modifiedAt: 1 });
    assert.throws(() => f.files.assertIdle(workspace.id), /Finish or cancel/);
    await f.call({ action: 'control', id: 'pending', command: 'cancel' }); assert.doesNotThrow(() => f.files.assertIdle(workspace.id));
    await assert.rejects(f.call({ action: 'list', workspaceId: workspace.id, instance: 'retired-instance' }), /instance changed/);
  } finally { await f.close(); }
});


test('cross-filesystem moves publish a verified copy before removing the source', async t => {
  const f = await fixture(true);
  try {
    const workspace: any = await f.workspaces.create({ name: 'cross-device', repositories: ['repo'] });
    if ((await lstat(workspace.treePath)).dev === (await lstat(f.root)).dev) { t.skip('Requires separate temporary and checkout filesystems'); return; }
    await writeFile(join(f.root, 'moving.txt'), 'cross filesystem proof');
    await f.call({ action: 'mutate', id: 'cross', operation: 'move', entries: [{ workspaceId: f.main, path: 'moving.txt' }], destination: { workspaceId: workspace.id, path: '' } });
    const moved = await f.wait('cross', ['complete', 'failed']); assert.equal(moved.state, 'complete', moved.error);
    assert.equal(await readFile(join(workspace.treePath, 'moving.txt'), 'utf8'), 'cross filesystem proof'); await assert.rejects(lstat(join(f.root, 'moving.txt')));
    await writeFile(join(f.root, 'changing.txt'), 'original');
    const tasks = f.files.tasks as any, publish = tasks.publish.bind(tasks);
    tasks.publish = async (...args: any[]) => { await publish(...args); await writeFile(join(f.root, 'changing.txt'), 'new user changes'); };
    await f.call({ action: 'mutate', id: 'changed_move', operation: 'move', entries: [{ workspaceId: f.main, path: 'changing.txt' }], destination: { workspaceId: workspace.id, path: '' } });
    const stopped = await f.wait('changed_move', ['complete', 'failed']); assert.equal(stopped.state, 'failed'); assert.match(stopped.error!, /source changed/);
    assert.equal(await readFile(join(f.root, 'changing.txt'), 'utf8'), 'new user changes'); assert.equal(await readFile(join(workspace.treePath, 'changing.txt'), 'utf8'), 'original');
    await f.call({ action: 'control', id: 'changed_move', command: 'cancel' });
    assert.equal(await readFile(join(f.root, 'changing.txt'), 'utf8'), 'new user changes');
  } finally { await f.close(); }
});

test('browser delegation seals an immutable snapshot and unfinished disk failures keep confirmed offsets', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source'), 'snapshot');
    await f.call({ action: 'download', id: 'delegation', workspaceId: f.main, paths: ['source'] }); await f.wait('delegation', ['active']);
    assert.equal((await f.call({ action: 'delegate', id: 'delegation' })).pending, true); await f.wait('delegation', ['active', 'failed']);
    const target = await f.call({ action: 'delegate', id: 'delegation' }); assert.equal(await readFile(join(target.cwd, target.path), 'utf8'), 'snapshot');
    await writeFile(join(f.root, 'source'), 'changed'); assert.equal(Buffer.from((await f.call({ action: 'read', id: 'delegation', offset: 0 })).data, 'base64').toString(), 'snapshot');
    const upload = { action: 'upload', id: 'disk', workspaceId: f.main, path: '', name: 'disk.bin', size: 2, modifiedAt: 1 };
    await f.call(upload); const first = Buffer.from('A'); await f.call({ action: 'chunk', id: 'disk', offset: 0, data: first.toString('base64'), sha256: sha(first) });
    const tasks = f.files.tasks as any, free = tasks.free;
    tasks.free = async () => { throw new Error('ENOSPC injected'); };
    const last = Buffer.from('B'); await assert.rejects(f.call({ action: 'chunk', id: 'disk', offset: 1, data: last.toString('base64'), sha256: sha(last) }), /ENOSPC/);
    assert.equal((await f.call({ action: 'task', id: 'disk' })).offset, 1); tasks.free = free;
    await f.call({ action: 'chunk', id: 'disk', offset: 1, data: last.toString('base64'), sha256: sha(last) });
    await f.call({ action: 'finish', id: 'disk' }); assert.equal((await f.wait('disk', ['complete', 'failed'])).state, 'complete');
  } finally { await f.close(); }
});


test('repository archives and copies skip protected metadata; multi-directory selection and links stay inside their scope', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root,'other')); await writeFile(join(f.root,'other/note'), 'note');
    await symlink('/external/reference-only', join(f.root,'other/link'));
    await f.call({action:'download', id:'multi', workspaceId:f.main, paths:['repo','repo/README','other/note','other/link']});
    const task=await f.wait('multi',['active','failed']);assert.equal(task.state,'active',task.error);assert.ok(task.excluded! >= 1);
    const buffer=Buffer.from((await f.call({action:'read',id:'multi',offset:0})).data,'base64');
    assert.ok(buffer.includes(Buffer.from('repo/README')));assert.ok(buffer.includes(Buffer.from('other/note')));assert.ok(buffer.includes(Buffer.from('/external/reference-only')));assert.equal(buffer.includes(Buffer.from('repo/.git')),false);
    await f.call({action:'mutate',id:'copy_repo',operation:'copy',entries:[{workspaceId:f.main,path:'repo'}],destination:{workspaceId:f.main,path:'other'}});
    const copied=await f.wait('copy_repo',['complete','failed']);assert.equal(copied.state,'complete',copied.error);assert.equal(await readFile(join(f.root,'other/repo/README'),'utf8'),'initial');await assert.rejects(lstat(join(f.root,'other/repo/.git')));
  } finally { await f.close(); }
});


test('final verification catches corrupted partials and publication receipts survive restart without overwriting later edits', async () => {
  const f = await fixture();
  try {
    const input = { action:'upload', id:'corrupt', workspaceId:f.main, path:'', name:'corrupt', size:3, modifiedAt:1 };
    await f.call(input);const bytes=Buffer.from('abc');await f.call({action:'chunk',id:input.id,offset:0,data:bytes.toString('base64'),sha256:sha(bytes)});
    await writeFile((f.files.tasks as any).part(input.id),'BAD');await f.call({action:'finish',id:input.id});const corrupt=await f.wait(input.id,['failed','complete']);assert.equal(corrupt.state,'failed');await assert.rejects(lstat(join(f.root,'corrupt')));
    const next={...input,id:'receipt',name:'receipt'};await f.call(next);await f.call({action:'chunk',id:next.id,offset:0,data:bytes.toString('base64'),sha256:sha(bytes)});
    const tasks=f.files.tasks as any,publish=tasks.publish.bind(tasks);tasks.publish=async(...args:any[])=>{await publish(...args);throw new Error('lost publication receipt injected');};
    await f.call({action:'finish',id:next.id});assert.equal((await f.wait(next.id,['failed','complete'])).state,'failed');assert.equal(await readFile(join(f.root,'receipt'),'utf8'),'abc');
    await writeFile(join(f.root,'receipt'),'later user edit');await f.restart();await f.call({action:'control',id:next.id,command:'resume'});assert.equal((await f.wait(next.id,['complete','failed'])).state,'complete');assert.equal(await readFile(join(f.root,'receipt'),'utf8'),'later user edit');
    assert.equal(Number(f.files.tasks.journal.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE task=?').get(next.id)?.n),0);
  }finally{await f.close();}
});


test('directory uploads reuse registered roots and protected name conflicts can keep both', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call({action:'mkdir',workspaceId:f.main,path:'',name:'repo',id:'existing_root',existOk:true})).state,'complete');
    const input={action:'upload',workspaceId:f.main,path:'',name:'repo',id:'root_collision',size:0,modifiedAt:1};
    const conflict=await f.call(input);assert.equal(conflict.state,'conflict');assert.equal(conflict.canReplace,false);
    await f.call({action:'control',id:input.id,command:'keep'});await f.call({action:'finish',id:input.id});assert.equal((await f.wait(input.id,['complete','failed'])).state,'complete');assert.equal((await lstat(join(f.root,'repo (1)'))).size,0);
    await f.call({action:'mutate',id:'copy_same_repo',operation:'copy',entries:[{workspaceId:f.main,path:'repo'}],destination:{workspaceId:f.main,path:''}});
    const rootCopy=await f.wait('copy_same_repo',['conflict','failed']);assert.equal(rootCopy.state,'conflict',rootCopy.error);assert.equal(rootCopy.canReplace,false);
    await f.call({action:'control',id:'copy_same_repo',command:'keep'});assert.equal((await f.wait('copy_same_repo',['complete','failed'])).state,'complete');assert.equal(await readFile(join(f.root,'repo (2)/README'),'utf8'),'initial');
  }finally{await f.close();}
});

test('publication serializes same-name tasks and recursive directory changes require renewed confirmation', async () => {
  const f=await fixture();
  try{
    for(const name of ['a','b','destination'])await mkdir(join(f.root,name));await writeFile(join(f.root,'a/same'),'A');await writeFile(join(f.root,'b/same'),'B');
    for(const name of ['a','b'])await f.call({action:'mutate',id:'parallel_'+name,operation:'copy',entries:[{workspaceId:f.main,path:name+'/same'}],destination:{workspaceId:f.main,path:'destination'}});
    const results=await Promise.all(['a','b'].map(name=>f.wait('parallel_'+name,['complete','conflict','failed'])));assert.equal(results.filter(t=>t.state==='complete').length,1);assert.equal(results.filter(t=>t.state==='conflict').length,1);
    const pending=results.find(t=>t.state==='conflict')!;await f.call({action:'control',id:pending.id,command:'keep'});assert.equal((await f.wait(pending.id,['complete','failed'])).state,'complete');
    assert.deepEqual(new Set([await readFile(join(f.root,'destination/same'),'utf8'),await readFile(join(f.root,'destination/same (1)'),'utf8')]),new Set(['A','B']));
    await mkdir(join(f.root,'source'));await writeFile(join(f.root,'source/user'),'new content');await mkdir(join(f.root,'destination/source'));await writeFile(join(f.root,'destination/source/user'),'old content');
    await f.call({action:'mutate',id:'directory_replace',operation:'copy',entries:[{workspaceId:f.main,path:'source'}],destination:{workspaceId:f.main,path:'destination'}});assert.equal((await f.wait('directory_replace',['conflict','failed'])).state,'conflict');
    const tasks=f.files.tasks as any,publish=tasks.publish.bind(tasks);tasks.publish=async(...args:any[])=>{await writeFile(join(f.root,'destination/source/user'),'concurrent user edit');return publish(...args);};
    await f.call({action:'control',id:'directory_replace',command:'replace'});assert.equal((await f.wait('directory_replace',['conflict','failed','complete'])).state,'conflict');assert.equal(await readFile(join(f.root,'destination/source/user'),'utf8'),'concurrent user edit');tasks.publish=publish;
    await f.call({action:'control',id:'directory_replace',command:'replace'});const replaced=await f.wait('directory_replace',['complete','failed']);assert.equal(replaced.state,'complete',replaced.error);assert.equal(await readFile(join(f.root,'destination/source/user'),'utf8'),'new content');
  }finally{await f.close();}
});

test('private staging is ignored by Git and a paused background save cannot reactivate itself', async () => {
  const f=await fixture();
  try{
    const bytes=Buffer.from('uploaded'), input={action:'upload',id:'ignore',workspaceId:f.main,path:'repo',name:'incoming',size:bytes.length,modifiedAt:1};await f.call(input);await f.call({action:'chunk',id:input.id,offset:0,data:bytes.toString('base64'),sha256:sha(bytes)});
    const tasks=f.files.tasks as any,prepare=tasks.stageIgnore.prepare.bind(tasks.stageIgnore);let pause:Promise<any>|undefined;
    tasks.stageIgnore.prepare=async(_roots:any,_context:any,_target:any,_task:any,persist:()=>void)=>{pause=f.call({action:'control',id:input.id,command:'pause'});await new Promise(r=>setImmediate(r));persist();};
    await f.call({action:'finish',id:input.id});await f.wait(input.id,['paused','failed','complete']);await pause;assert.equal((await f.call({action:'task',id:input.id})).state,'paused');await assert.rejects(lstat(join(f.repo,'incoming')));tasks.stageIgnore.prepare=prepare;
    await f.call({action:'control',id:input.id,command:'resume'});assert.equal((await f.wait(input.id,['complete','failed'])).state,'complete');
    await writeFile(join(f.repo,'.workbench-transfer-private'),'partial');const status=execFileSync('git',['-C',f.repo,'status','--porcelain'],{encoding:'utf8'});assert.equal(status.includes('.workbench-transfer-private'),false);assert.ok(status.includes('incoming'));
  }finally{await f.close();}
});

test('combined download reads persist monotonic confirmations and cannot revive a paused task',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.root,'data.bin'),Buffer.alloc(FILE_CHUNK_BYTES*3+17,42));
    await f.call({action:'download',id:'read-window',workspaceId:f.main,paths:['data.bin']});await f.wait('read-window',['active']);
    const second=await f.call({action:'read',id:'read-window',offset:FILE_CHUNK_BYTES,confirmedOffset:FILE_CHUNK_BYTES});assert.equal(second.confirmedOffset,FILE_CHUNK_BYTES);
    await f.call({action:'read',id:'read-window',offset:0,confirmedOffset:0});assert.equal((await f.call({action:'task',id:'read-window'})).offset,FILE_CHUNK_BYTES);
    await f.call({action:'ack',id:'read-window',offset:FILE_CHUNK_BYTES*2});assert.equal((await f.call({action:'ack',id:'read-window',offset:FILE_CHUNK_BYTES})).offset,FILE_CHUNK_BYTES*2);
    await f.call({action:'control',id:'read-window',command:'pause'});
    await assert.rejects(f.call({action:'read',id:'read-window',offset:0,confirmedOffset:FILE_CHUNK_BYTES*3}),/offset|active/i);assert.equal((await f.call({action:'task',id:'read-window'})).state,'paused');
    await f.restart();assert.equal((await f.call({action:'task',id:'read-window'})).offset,FILE_CHUNK_BYTES*2);
  }finally{await f.close();}
});

test('ZIP preparation checkpoints are bounded and preserve a concurrent pause',async()=>{
  const f=await fixture();
  try{
    await mkdir(join(f.root,'archive'));for(let n=0;n<513;n++)await writeFile(join(f.root,'archive',`item-${n}`),'entry');
    const original=f.files.tasks.journal.save.bind(f.files.tasks.journal);let progress=0;
    f.files.tasks.journal.save=(task:any)=>{if(task.id==='zip-progress'&&task.state==='preparing'&&task.processed>0)progress++;return original(task);};
    await f.call({action:'download',id:'zip-progress',workspaceId:f.main,paths:['archive']});const task=await f.wait('zip-progress',['active','failed']);
    assert.equal(task.state,'active',task.error);assert.equal(task.processed,514);assert.ok(progress<30,`${progress} progress saves should be at least 10x fewer than 514`);
  }finally{await f.close();}
});
