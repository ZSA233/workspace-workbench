import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, lstat, rename, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { CacheManagement } from '../server/backend/cache-management.ts';
import { GoCacheProvider, safeGoCachePath } from '../server/backend/cache-go.ts';
import { measureCachePaths } from '../server/backend/cache-measure.ts';
import { withCacheLease } from '../server/backend/cache-lease.ts';
import { assertCacheIdle } from '../server/backend/cache-guards.ts';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
import { hash } from '../server/backend/storage.ts';
import type { CacheProvider, CacheDiscoveryContext } from '../server/backend/cache-provider.ts';
import type { CacheTask, CacheResource } from '../shared/cache-management.ts';
import { cacheTaskActive } from '../shared/cache-management.ts';
import { workspaceInstanceKey } from '../shared/workspace-lineage.ts';
import { cacheRelationship } from '../client/cache-presentation.ts';
import { runtimeCacheRoot } from '../server/backend/runtime-layout.ts';

async function fixture(options: { providers?: CacheProvider[]; measure?: typeof measureCachePaths; hostRoot?: string; cacheScope?: string } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wb-cache-management-'))), source = join(root, 'project');
  await mkdir(source);
  const configPath = join(source, 'project.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: source, stateRoot: join(root, 'state'), workspaceRoot: join(root, 'workspaces'),
    project: { id: 'cache-fixture' }, repositories: [], discovery: { mode: 'manual' }, cache: { root: join(root, 'managed'), scope: options.cacheScope || 'project' } }));
  const config = loadConfig(configPath), service = new Service(config);
  await service.cacheManagement.close();
  const data = join(root, 'data'); await mkdir(data); await writeFile(join(data, 'blob'), Buffer.alloc(8192, 1));
  let cleanups = 0;
  const provider: CacheProvider = { id: 'fixture', label: { en: 'Fixture', zh: '测试工具' },
    async discover(context) {
      const main = context.workspaces[0];
      return [{ kind: 'index', kindLabel: { en: 'Index cache', zh: '索引缓存' }, scope: 'project', displayPath: data, paths: [data],
        references: [{ projectConfig: configPath, workspaceId: main.id, instance: workspaceInstanceKey(main as any), displayName: 'Main' }],
        cleanup: { action: 'clear', label: { en: 'Clear index', zh: '清理索引' }, available: true } }];
    },
    async cleanup(resource) { cleanups++; assert.deepEqual(resource.paths, [data]); await rm(join(data, 'blob')); },
  };
  const manager = new CacheManagement(service.workspaces, { providers: options.providers || [provider], hostRoot: options.hostRoot || join(root, 'host'), measure: options.measure,
    assertIdle: async () => [configPath] });
  service.cacheManagement = manager;
  return { root, source, config, configPath, service, manager, data, provider, cleanups: () => cleanups,
    close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}
async function settle(manager: CacheManagement, task: CacheTask) {
  let result = task;
  const deadline = Date.now() + 15000;
  while (cacheTaskActive(result) && Date.now() < deadline) { await pause(10); result = await manager.task({ taskId: task.taskId }) as CacheTask; }
  assert.ok(!cacheTaskActive(result), 'cache task finished'); return result;
}
async function scan(manager: CacheManagement) {
  const task = await manager.scan({ action: 'start', force: true }) as CacheTask;
  const result = await settle(manager, task); assert.ok(['complete','partial'].includes(result.state), result.error); return manager.list();
}

test('allocated usage de-duplicates hardlinks and overlapping roots and never follows symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-cache-measure-'));
  try {
    const data = join(root, 'data'), external = join(root, 'external'); await mkdir(data); await mkdir(external);
    await writeFile(join(data, 'one'), Buffer.alloc(8192)); await link(join(data, 'one'), join(data, 'two'));
    await writeFile(join(external, 'large'), Buffer.alloc(1024 * 1024)); await symlink(external, join(data, 'pointer'));
    const union = new Set<string>(), first = await measureCachePaths([data, join(data, 'one')], { signal: new AbortController().signal, union });
    assert.equal(first.state, 'ready'); assert.ok(first.bytes! < 100000); assert.equal(first.bytes, first.uniqueBytes);
    const second = await measureCachePaths([data], { signal: new AbortController().signal, union }); assert.equal(second.uniqueBytes, 0); assert.equal(second.bytes, first.bytes);
    const missing = await measureCachePaths([join(root, 'absent')], { signal: new AbortController().signal }); assert.equal(missing.state, 'missing'); assert.equal(missing.bytes, 0);
    const timed = await measureCachePaths([data], { signal: new AbortController().signal, deadline: Date.now() - 1 }); assert.equal(timed.bytes, null); assert.equal(timed.state, 'failed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generic inventory supports a second provider, shared references, snapshots and stable Workspace records', async () => {
  const f = await fixture();
  try {
    const second: CacheProvider = { ...f.provider, id: 'another-tool', label: { en: 'Another tool', zh: '其他工具' },
      async discover(context) { return (await f.provider.discover(context)).map(value => ({ ...value, kind: 'packages', kindLabel: { en: 'Packages', zh: '依赖包' }, paths: [f.source], displayPath: f.source, cleanup: { ...value.cleanup, available: false } })); } };
    await f.manager.close();
    const manager = new CacheManagement(f.service.workspaces, { providers: [f.provider, second], hostRoot: join(f.root, 'host'), assertIdle: async () => [f.configPath] });
    f.service.cacheManagement = manager;
    const before = await readFile(f.configPath, 'utf8'), initial = await manager.list(); assert.equal(initial.stale, true); assert.equal(initial.resources.length, 0);
    const result = await scan(manager); assert.equal(result.resources.length, 2); assert.equal(result.resources.find(resource => resource.providerId === 'another-tool')?.kindLabel.zh, '依赖包');
    assert.ok(result.totalBytes! >= 8192); assert.equal(result.workspaces.length, 1); assert.equal(cacheRelationship(result.resources, true), '项目共享');
    assert.equal(await readFile(f.configPath, 'utf8'), before);
    await manager.close();
    const reopened = new CacheManagement(f.service.workspaces, { providers: [f.provider, second], hostRoot: join(f.root, 'host') }); f.service.cacheManagement = reopened;
    assert.equal((await reopened.list()).resources.length, 2); assert.equal((await reopened.list()).stale, false);
  } finally { await f.close(); }
});

test('scan RPC is prompt, cancellation is bounded, and a new scan retains the last successful value on failure', async () => {
  let blocked = false, release!: () => void;
  const f = await fixture({ measure: async (paths, options) => {
    if (blocked && paths.some(path => path.endsWith('/data'))) { await new Promise<void>(resolve => { release = resolve; }); if (options.signal.aborted) throw new Error('cancelled'); return { bytes: null, state: 'failed', error: 'permission denied' }; }
    return measureCachePaths(paths, options);
  } });
  try {
    const first = await scan(f.manager), bytes = first.resources[0].usage.bytes;
    blocked = true;
    const task = await f.manager.scan({ action: 'start', force: true }) as CacheTask;
    while (!release) await pause(5);
    assert.ok(cacheTaskActive(task)); assert.equal(f.service.health().implementation, 'node');
    await f.manager.scan({ action: 'cancel', taskId: task.taskId }); release();
    assert.equal((await settle(f.manager, task)).state, 'cancelled'); assert.equal((await f.manager.list()).resources[0].usage.bytes, bytes);
    release = undefined as any;
    const next = await f.manager.scan({ action: 'start', force: true }) as CacheTask;
    while (!release) await pause(5); release();
    assert.equal((await settle(f.manager, next)).state, 'partial');
    const partial = await f.manager.list(); assert.equal(partial.resources[0].usage.bytes, bytes); assert.equal(partial.resources[0].usage.state, 'failed');
  } finally { release?.(); await f.close(); }
});

test('cleanup uses a fixed preview and request identity, re-scans afterwards and survives receipt reopening', async () => {
  const f = await fixture();
  try {
    const inventory = await scan(f.manager), resource = inventory.resources[0];
    const preview = await f.manager.cleanup({ action: 'preview', resourceId: resource.id });
    const first = await f.manager.cleanup({ action: 'start', previewId: preview.previewId, requestId: 'same-cleanup' }) as CacheTask;
    const duplicate = await f.manager.cleanup({ action: 'start', previewId: preview.previewId, requestId: 'same-cleanup' }); assert.equal(duplicate.taskId, first.taskId);
    assert.equal((await settle(f.manager, first)).state, 'complete'); assert.equal(f.cleanups(), 1); assert.equal((await f.manager.list()).stale, true);
    await assert.rejects(f.manager.cleanup({ action: 'start', previewId: 'different', requestId: 'same-cleanup' }), /identity/);
    await f.manager.close();
    const reopened = new CacheManagement(f.service.workspaces, { providers: [f.provider], hostRoot: join(f.root, 'host'), assertIdle: async () => [f.configPath] }); f.service.cacheManagement = reopened;
    assert.equal((await reopened.cleanup({ action: 'start', previewId: preview.previewId, requestId: 'same-cleanup' })).state, 'complete'); assert.equal(f.cleanups(), 1);
    assert.equal((await scan(reopened)).resources[0].usage.bytes, (await lstat(f.data)).blocks * 512);
  } finally { await f.close(); }
});

test('a stale scan cannot publish results after the project configuration changes', async () => {
  let blocked = false, release!: () => void;
  const f = await fixture({ measure: async (paths, options) => {
    if (blocked && paths.includes(f.data)) await new Promise<void>(resolve => { release = resolve; });
    return measureCachePaths(paths, options);
  } });
  try {
    const first = await scan(f.manager); blocked = true;
    const task = await f.manager.scan({ force: true }) as CacheTask;
    while (!release) await pause(5);
    const changed = JSON.parse(await readFile(f.configPath, 'utf8')); changed.cache.root = join(f.root, 'new-scope');
    await writeFile(f.configPath, JSON.stringify(changed)); release();
    const result = await settle(f.manager, task);
    assert.equal(result.state, 'failed'); assert.match(result.error!, /changed during scan/);
    assert.equal((await f.manager.list()).observedAt, first.observedAt);
  } finally { release?.(); await f.close(); }
});

test('provider discovery failures retain the last known paths for inspection and disable cleanup', async () => {
  const f = await fixture();
  try {
    const first = await scan(f.manager);
    f.provider.discover = async () => { throw Error('provider temporarily unavailable'); };
    const result = await scan(f.manager);
    assert.equal(result.state, 'partial'); assert.equal(result.resources[0].id, first.resources[0].id);
    assert.equal(result.resources[0].usage.bytes, first.resources[0].usage.bytes);
    assert.equal(result.resources[0].cleanup.available, false); assert.match(result.errors[0], /temporarily unavailable/);
    await assert.rejects(f.manager.cleanup({ action: 'preview', resourceId: result.resources[0].id }), /temporarily unavailable/);
  } finally { await f.close(); }
});

test('replaced directories and changed configuration invalidate cleanup previews without touching new content', async () => {
  const f = await fixture();
  try {
    const resource = (await scan(f.manager)).resources[0];
    const preview = await f.manager.cleanup({ action: 'preview', resourceId: resource.id });
    await rename(f.data, f.data + '-old'); await mkdir(f.data); await writeFile(join(f.data, 'blob'), 'user content');
    const task = await f.manager.cleanup({ action: 'start', previewId: preview.previewId, requestId: 'replaced' }) as CacheTask;
    assert.equal((await settle(f.manager, task)).state, 'failed'); assert.equal(f.cleanups(), 0); assert.equal(await readFile(join(f.data, 'blob'), 'utf8'), 'user content');
    const next = await f.manager.cleanup({ action: 'preview', resourceId: resource.id });
    const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.cache.root = join(f.root, 'other'); await writeFile(f.configPath, JSON.stringify(config));
    const changed = await f.manager.cleanup({ action: 'start', previewId: next.previewId, requestId: 'config-changed' }) as CacheTask;
    assert.equal((await settle(f.manager, changed)).state, 'failed'); assert.equal(f.cleanups(), 0);
  } finally { await f.close(); }
});

test('interrupted durable cleanups are never replayed after a worker restart', async () => {
  const f = await fixture();
  try {
    const id = hash('cleanup:interrupted').slice(0, 40), root = join(f.config.stateRoot, 'cache-management');
    await mkdir(join(root, 'tasks'), { recursive: true });
    await writeFile(join(root, 'tasks', `${id}.json`), JSON.stringify({ protocol: 1, taskId: id, requestId: 'interrupted', previewId: 'old-preview', generation: 'old-worker', kind: 'cleanup', state: 'running', phase: 'clean' }));
    const task = await f.manager.task({ requestId: 'interrupted' }); assert.equal(task.state, 'interrupted'); assert.equal(f.cleanups(), 0);
    assert.equal((await f.manager.cleanup({ action: 'start', previewId: 'old-preview', requestId: 'interrupted' })).state, 'interrupted');
    await assert.rejects(f.manager.cleanup({ action: 'preview', resourceId: '../../arbitrary' }));
    await access(join(f.data, 'blob'));
  } finally { await f.close(); }
});

test('a missing derived task pointer cannot strand an accepted durable cleanup', async () => {
  const f = await fixture();
  try {
    const inventory = await scan(f.manager), pointer = join(f.config.stateRoot, 'cache-management', 'latest-task.json');
    const preview = await f.manager.cleanup({ action: 'preview', resourceId: inventory.resources[0].id });
    await rm(pointer); await mkdir(pointer);
    const task = await f.manager.cleanup({ action: 'start', previewId: preview.previewId, requestId: 'pointer-write-failed' }) as CacheTask;
    assert.equal((await settle(f.manager, task)).state, 'complete'); assert.equal(f.cleanups(), 1);
    assert.equal((await f.manager.task({ requestId: 'pointer-write-failed' })).state, 'complete');
  } finally { await f.close(); }
});

test('the host lease serializes scans across project workers and releases cancelled waiters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-cache-lease-'));
  let release!: () => void, entered = 0;
  try {
    const one = withCacheLease(root, new AbortController().signal, async () => { entered++; await new Promise<void>(resolve => { release = resolve; }); });
    while (!release) await pause(5);
    const abort = new AbortController();
    const two = withCacheLease(root, abort.signal, async () => { entered++; });
    const rejected = assert.rejects(two, /cancelled/);
    await pause(30); assert.equal(entered, 1); abort.abort(); await rejected; release(); await one;
    await withCacheLease(root, new AbortController().signal, async () => { entered++; }); assert.equal(entered, 2);
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

test('Go discovery preserves version/platform roots, separates module caches and rejects protected paths', async () => {
  const f = await fixture();
  try {
    const build = join(f.root, 'global-build'), module = join(f.root, 'global-modules'); await mkdir(build); await mkdir(module);
    for (const version of ['go1.26','go1.27']) await mkdir(join(f.config.cacheRoot, 'shared', 'go-build', version, 'darwin-arm64'), { recursive: true });
    await mkdir(join(f.config.cacheRoot, 'shared', 'go-mod'), { recursive: true });
    const calls: any[] = [];
    const provider = new GoCacheProvider({ executable: process.execPath, env: { PATH: process.env.PATH }, run: async (exe, args, options) => { calls.push({exe,args,options}); return { code: 0, stdout: JSON.stringify({ GOCACHE: build, GOMODCACHE: module, GOCACHEPROG: '' }), stderr: '', truncated: false, bytes: 0 }; } });
    const metadata = await f.service.workspaces.observationRecords.request('roster');
    const context: CacheDiscoveryContext = { config: f.config, workspaces: metadata.workspaces, signal: new AbortController().signal };
    const resources = await provider.discover(context); const project = resources.find(resource => resource.scope === 'project' && resource.kind === 'build')!;
    assert.equal(project.paths.length, 2); assert.ok(project.paths.every(path => path.endsWith('darwin-arm64')));
    assert.equal(resources.filter(resource => resource.scope === 'global').length, 2);
    assert.ok(resources.find(resource => resource.kind === 'module')!.cleanup.label.zh.includes('模块'));
    assert.equal(await safeGoCachePath(f.source, context), false); assert.equal(await safeGoCachePath('/', context), false); assert.equal(await safeGoCachePath(build, context), true);
    assert.equal(await safeGoCachePath(join(f.source, '.git', 'objects'), context), false);
    assert.equal(await safeGoCachePath(join(f.config.recordsRoot, 'nested'), context), false);
    const global = resources.find(resource => resource.scope === 'global' && resource.kind === 'build')!;
    await provider.cleanup({ ...global, id: 'test', providerId: 'go', providerLabel: provider.label, usage: { bytes: 0, state: 'ready' } }, context);
    const call = calls.at(-1); assert.deepEqual(call.args, ['clean','-cache']); assert.equal(call.options.env.GOCACHE, build); assert.equal(call.options.env.GOTOOLCHAIN, 'local');
    const progress: number[] = []; let validations = 0;
    await provider.cleanup({ ...project, id: 'aggregate', providerId: 'go', providerLabel: provider.label, usage: { bytes: 0, state: 'ready' } }, {
      ...context, validateCleanup: async () => { validations++; }, cleanupProgress: async value => { progress.push(value); },
    });
    assert.equal(validations, 2); assert.deepEqual(progress, [1,2]);
    assert.deepEqual(calls.slice(-2).map(call => call.options.env.GOCACHE), project.paths);
    const mod = resources.find(resource => resource.scope === 'global' && resource.kind === 'module')!;
    await provider.cleanup({ ...mod, id: 'test', providerId: 'go', providerLabel: provider.label, usage: { bytes: 0, state: 'ready' } }, context);
    assert.deepEqual(calls.at(-1).args, ['clean','-modcache']); assert.equal(calls.at(-1).options.env.GOMODCACHE, module);
    const failing = new GoCacheProvider({ executable: process.execPath, run: async () => ({ code: 1, stdout: '', stderr: 'native failure', truncated: false, bytes: 0 }) });
    await writeFile(join(build, 'keep'), 'keep');
    await assert.rejects(failing.cleanup({ ...global, id: 'test', providerId: 'go', providerLabel: provider.label, usage: { bytes: 0, state: 'ready' } }, context), /native failure/);
    assert.equal(await readFile(join(build, 'keep'), 'utf8'), 'keep');
  } finally { await f.close(); }
});

test('known preparation and execution users prevent cleaning, independent of backend health', async () => {
  const f = await fixture();
  try {
    const resource = (await scan(f.manager)).resources[0];
    assert.equal(f.service.health().implementation, 'node');
    await assertCacheIdle(resource, f.config);
    await mkdir(f.config.stateRoot, { recursive: true });
    await writeFile(join(f.config.stateRoot, 'agent-bindings.json'), JSON.stringify({bindings:[{workspaceId:'main',status:'running'}]}));
    await assert.rejects(assertCacheIdle(resource, f.config), /execution/);
    await writeFile(join(f.config.stateRoot, 'agent-bindings.json'), JSON.stringify({bindings:[{workspaceId:'main',status:'idle'}]}));
    await mkdir(join(f.config.stateRoot, 'prepare-operations'), { recursive: true });
    await writeFile(join(f.config.stateRoot, 'prepare-operations', 'test.json'), JSON.stringify({workspaceId:'main',state:'queued'}));
    await assert.rejects(assertCacheIdle(resource, f.config), /Preparation/);
  } finally { await f.close(); }
});

test('Go workspace scopes include retained roots and environment snapshots without duplicate inventory totals', async () => {
  const f = await fixture({ cacheScope: 'workspace' });
  try {
    const metadata = await f.service.workspaces.observationRecords.request('roster');
    const main = metadata.workspaces[0], local = runtimeCacheRoot(f.config, main), retained = join(f.config.cacheRoot, 'workspaces', 'retained-id');
    const module = join(local, 'go-mod'), build = join(local, 'go-build'), saved = join(f.root, 'saved-build');
    for (const path of [module, build, saved, join(retained,'go-mod'), join(retained,'go-build')]) await mkdir(path, { recursive: true });
    await mkdir(join(f.config.stateRoot, 'environments'), { recursive: true });
    await writeFile(join(f.config.stateRoot, 'environments', 'snapshot-custom.json'), JSON.stringify({ workspaceId: main.id, environment: { variables: { GOCACHE: saved, GOMODCACHE: module } } }));
    const provider = new GoCacheProvider({ executable: process.execPath, run: async () => ({ code: 0, stdout: JSON.stringify({ GOCACHE: build, GOMODCACHE: module }), stderr: '', truncated: false, bytes: 0 }) });
    const discovered = await provider.discover({ config: f.config, workspaces: metadata.workspaces, signal: new AbortController().signal });
    assert.ok(discovered.some(resource => resource.scope === 'workspace' && resource.displayPath === saved && resource.references[0].workspaceId === 'main'));
    assert.ok(discovered.some(resource => resource.scope === 'workspace' && resource.displayPath === join(retained,'go-mod') && !resource.references.length));
    await f.manager.close();
    const manager = new CacheManagement(f.service.workspaces, { providers: [provider], hostRoot: join(f.root, 'host') }); f.service.cacheManagement = manager;
    const inventory = await scan(manager);
    assert.equal(inventory.resources.filter(resource => resource.paths.includes(module)).length, 1);
    const merged = inventory.resources.find(resource => resource.paths.includes(module))!;
    assert.equal(merged.scope, 'global'); assert.equal(merged.references.length, 1);
    assert.equal(new Set(inventory.resources.map(resource => resource.id)).size, inventory.resources.length);
  } finally { await f.close(); }
});

test('real Go clean commands operate only on temporary caches and keep the other category intact', { timeout: 60000 }, async t => {
  let executable: string;
  try { executable = execFileSync('which', ['go'], { encoding: 'utf8' }).trim(); } catch { t.skip('Go not installed'); return; }
  const f = await fixture();
  try {
    const build = join(f.root, 'go-build'), module = join(f.root, 'go-mod'); await mkdir(build); await mkdir(module);
    await writeFile(join(module, 'module-keep'), 'module');
    const env = { ...process.env, GOCACHE: build, GOMODCACHE: module, GOTOOLCHAIN: 'local', GOCACHEPROG: '' };
    const provider = new GoCacheProvider({ executable, env });
    const metadata = await f.service.workspaces.observationRecords.request('roster');
    const context: CacheDiscoveryContext = { config: f.config, workspaces: metadata.workspaces, signal: new AbortController().signal };
    const resource = (kind: 'build' | 'module'): CacheResource => ({ id: kind, providerId: 'go', providerLabel: provider.label, kind, kindLabel: { en: kind, zh: kind }, scope: 'global', displayPath: kind === 'build' ? build : module, paths: [kind === 'build' ? build : module], references: [], cleanup: { action: 'clear', label: {en:'Clean',zh:'清理'}, available:true }, usage: {bytes:0,state:'ready'} });
    await provider.cleanup(resource('build'), context); assert.equal(await readFile(join(module, 'module-keep'), 'utf8'), 'module');
    await writeFile(join(build, 'build-keep'), 'build'); await provider.cleanup(resource('module'), context);
    await assert.rejects(access(join(module, 'module-keep'))); assert.equal(await readFile(join(build, 'build-keep'), 'utf8'), 'build');
  } finally { await f.close(); }
});
