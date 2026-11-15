import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { CacheCleanupPreview, CacheListResult, CacheResource, CacheSnapshot, CacheTask, CacheUsage } from '../../shared/cache-management.ts';
import { cacheTaskActive } from '../../shared/cache-management.ts';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { CacheProviders, type CacheDiscoveryContext, type CacheProvider } from './cache-provider.ts';
import { GoCacheProvider } from './cache-go.ts';
import { measureCachePaths } from './cache-measure.ts';
import { cacheHostRoot, withCacheLease } from './cache-lease.ts';
import { assertCacheIdle } from './cache-guards.ts';
import { DerivedJsonWriter, writeDerivedJson } from './derived-json.ts';
import { writeOperation } from './operation-storage.ts';
import { gitQueue } from './git-scheduler.ts';
import { loadConfig } from './config.ts';
import { hash, stable, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';

const TTL = 10 * 60_000;
type Preview = CacheCleanupPreview & { configIdentity: string; rosterIdentity: string; pathIdentity: string; rootIdentities: string[] };
type StoredTask = CacheTask & { previewId?: string };
type Options = { providers?: CacheProvider[]; hostRoot?: string; measure?: typeof measureCachePaths; assertIdle?: typeof assertCacheIdle };
const emptyUsage = (): CacheUsage => ({ bytes: null, state: 'pending' });
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{40}$/.test(id);

/** Owns background jobs, never borrows the foreground Git/read queue for directory walks. */
export class CacheManagement {
  readonly generation = randomUUID();
  private providers: CacheProviders;
  private options: Options;
  private workspaces: Workspaces;
  private snapshot: CacheSnapshot;
  private writer: DerivedJsonWriter;
  private loaded?: Promise<void>;
  private tasks = new Map<string, StoredTask>();
  private controllers = new Map<string, AbortController>();
  private queue: StoredTask[] = [];
  private latest?: string;
  private flight?: Promise<void>;
  private closed = false;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(workspaces: Workspaces, options: Options = {}) {
    this.workspaces = workspaces; this.options = options;
    this.providers = new CacheProviders(options.providers || [new GoCacheProvider()]);
    this.snapshot = { protocol: 1, projectConfig: workspaces.config.configPath, state: 'empty', resources: [], workspaces: [], totalBytes: null, errors: [] };
    this.writer = new DerivedJsonWriter(join(this.root, 'snapshot.json'));
  }
  private get root() { return join(this.workspaces.config.stateRoot, 'cache-management'); }
  private taskFile(id: string) { return join(this.root, 'tasks', `${id}.json`); }
  private async json(path: string) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
  private load() {
    return this.loaded ||= (async () => {
      const saved = await this.json(join(this.root, 'snapshot.json')).catch(() => null);
      if (saved?.protocol === 1 && saved.projectConfig === this.workspaces.config.configPath && Array.isArray(saved.resources) && Array.isArray(saved.workspaces)) this.snapshot = saved;
      const latest = await this.json(join(this.root, 'latest-task.json')).catch(() => null);
      if (validId(latest?.taskId)) { this.latest = latest.taskId; await this.readTask(latest.taskId); }
    })();
  }
  private async readTask(id: string): Promise<StoredTask | undefined> {
    if (!validId(id)) throw new WorkbenchError('cache_task_invalid', 'Invalid cache task ID');
    const cached = this.tasks.get(id); if (cached) return cached;
    const value = await this.json(this.taskFile(id));
    if (!value) return;
    if (value.taskId !== id || value.protocol !== 1 || !['scan','cleanup'].includes(value.kind)) throw new WorkbenchError('cache_task_invalid', 'Invalid cache operation record');
    if (cacheTaskActive(value) && value.generation !== this.generation) {
      value.state = 'interrupted'; value.phase = 'reconcile'; value.error = 'Previous worker stopped; inspect the result before starting another cleanup'; value.updatedAt = Date.now();
      await writeOperation(this.taskFile(id), value);
    }
    this.tasks.set(id, value); return value;
  }
  private view(task: StoredTask): CacheTask { const { previewId, ...value } = task; return value; }
  private trimTasks() {
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= 128) break;
      if (!cacheTaskActive(task) && id !== this.latest) this.tasks.delete(id);
    }
  }
  private async save(task: StoredTask) { task.updatedAt = Date.now(); await writeOperation(this.taskFile(task.taskId), task); }
  async list(): Promise<CacheListResult> {
    await this.load();
    const task = [...this.tasks.values()].find(cacheTaskActive) || (this.latest ? this.tasks.get(this.latest) : undefined);
    return { ...this.snapshot, stale: !this.snapshot.observedAt || Date.now() - this.snapshot.observedAt >= TTL, ...(task ? { task: this.view(task) } : {}) };
  }
  async task(params: Json): Promise<Json> {
    await this.load();
    const id = params.taskId || (params.requestId ? hash(`cleanup:${params.requestId}`).slice(0, 40) : this.latest);
    if (!id) return { protocol: 1, state: 'idle' };
    const task = await this.readTask(id);
    return task ? this.view(task) : { protocol: 1, state: 'idle' };
  }
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work); this.serial = result.catch(() => {}); return result;
  }
  async scan(params: Json): Promise<Json> {
    return this.locked(async () => {
      await this.load();
      if (params.action === 'cancel') {
        const task = params.taskId ? await this.readTask(params.taskId) : [...this.tasks.values()].find(value => value.kind === 'scan' && cacheTaskActive(value));
        if (!task || task.kind !== 'scan') throw new WorkbenchError('cache_task_invalid', 'No scan to cancel');
        this.controllers.get(task.taskId)?.abort();
        if (cacheTaskActive(task)) { task.state = 'cancelled'; task.phase = 'cancelled'; await this.save(task); }
        return this.view(task);
      }
      if (params.action && params.action !== 'start') throw new WorkbenchError('cache_action_invalid', 'Unknown scan action');
      const active = [...this.tasks.values()].find(value => value.kind === 'scan' && cacheTaskActive(value));
      if (active) return this.view(active);
      if (!params.force && this.snapshot.observedAt && Date.now() - this.snapshot.observedAt < TTL) return { protocol: 1, state: 'complete', phase: 'fresh' };
      return this.accept('scan', params.requestId || randomUUID());
    });
  }
  private async context(signal: AbortSignal): Promise<CacheDiscoveryContext> {
    const metadata = await this.workspaces.observationRecords.request('roster', { force: true });
    if (metadata.workspaces.some((workspace: Json) => workspace.state === 'record_invalid')) throw new WorkbenchError('cache_roster_unavailable', 'Workspace records could not be verified');
    return { config: this.workspaces.config, workspaces: metadata.workspaces, signal };
  }
  private rosterIdentity(context: CacheDiscoveryContext) {
    return hash(stable(context.workspaces.map(workspace => ({ id: workspace.id, instance: workspaceInstanceKey(workspace as any), state: workspace.state,
      path: workspace.treePath || workspace.sourceRoot, repositories: workspace.repositories })).sort((a,b) => a.id.localeCompare(b.id))));
  }
  private configIdentity(context: CacheDiscoveryContext) { return hash(stable(loadConfig(context.config.configPath))); }
  private async pathIdentity(resource: CacheResource) {
    return hash(stable(await Promise.all(resource.paths.map(async path => {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new WorkbenchError('cache_path_changed', 'Cache root changed');
      return { path, device: info.dev, inode: info.ino };
    }))));
  }
  private async discover(context: CacheDiscoveryContext) {
    const resources: CacheResource[] = [], errors: string[] = [];
    for (const provider of this.providers.all()) {
      const issues: string[] = [];
      try {
        for (const value of await provider.discover({ ...context, reportDiscoveryIssue: message => { issues.push(message); } })) {
          if (!value.paths.length) continue;
          const paths = [...new Set(value.paths)].sort();
          const matches = resources.filter(resource => resource.providerId === provider.id && resource.kind === value.kind && resource.paths.some(path => paths.includes(path)));
          const target = matches[0];
          if (target) {
            target.paths = [...new Set([...target.paths, ...paths, ...matches.flatMap(resource => resource.paths)])].sort();
            const refs = [...target.references, ...value.references, ...matches.flatMap(resource => resource.references)];
            target.references = [...new Map(refs.map(ref => [`${ref.projectConfig}:${ref.instance}`,ref])).values()];
            if (value.scope === 'global' || matches.some(resource => resource.scope === 'global')) target.scope = 'global';
            else if (value.scope === 'project' || target.references.length > 1) target.scope = 'project';
            target.cleanup.available &&= value.cleanup.available;
            for (const other of matches.slice(1)) resources.splice(resources.indexOf(other), 1);
          } else resources.push({ ...value, paths, id: '', providerId: provider.id, providerLabel: provider.label, usage: emptyUsage() });
        }
      } catch (error) { if (context.signal.aborted) throw error; issues.push(String(error)); }
      if (issues.length) {
        const reason = issues.join('; ').slice(0, 400); errors.push(`${provider.id}: ${reason}`);
        for (const previous of this.snapshot.resources.filter(resource => resource.providerId === provider.id)) {
          if (!resources.some(resource => resource.providerId === provider.id && resource.kind === previous.kind && resource.paths.some(path => previous.paths.includes(path)))) {
            resources.push({ ...previous, cleanup: { ...previous.cleanup, available: false, reason } });
          }
        }
      }
    }
    for (const resource of resources) {
      resource.id = hash(stable([resource.providerId, resource.kind, resource.paths])).slice(0, 40);
      resource.references.sort((a,b) => a.instance.localeCompare(b.instance));
      // An overlapping root reported under incompatible semantics is inspection-only.
      if (resources.some(other => other !== resource && other.paths.some(path => resource.paths.includes(path)))) {
        resource.cleanup.available = false; resource.cleanup.reason = 'Overlapping cache providers or types';
      }
    }
    return { resources: resources.sort((a,b) => a.providerId.localeCompare(b.providerId) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), errors };
  }
  async cleanup(params: Json): Promise<Json> {
    return this.locked(async () => {
      await this.load();
      if (params.action === 'preview') {
        const resource = this.snapshot.resources.find(resource => resource.id === params.resourceId);
        if (!resource?.cleanup.available) throw new WorkbenchError('cache_cleanup_unavailable', resource?.cleanup.reason || 'Refresh the cache inventory first');
        const controller = new AbortController(), context = await this.context(controller.signal);
        const affectedProjects = await (this.options.assertIdle || assertCacheIdle)(resource, context.config);
        const preview: Preview = { previewId: randomUUID(), expiresAt: Date.now() + TTL, resource, affectedProjects: affectedProjects.sort(),
          configIdentity: this.configIdentity(context), rosterIdentity: this.rosterIdentity(context), pathIdentity: await this.pathIdentity(resource),
          rootIdentities: await Promise.all(resource.paths.map(path => this.pathIdentity({ ...resource, paths: [path] }))) };
        await writeOperation(join(this.root, 'previews', `${preview.previewId}.json`), preview);
        const { configIdentity, rosterIdentity, pathIdentity, rootIdentities, ...publicPreview } = preview;
        return publicPreview;
      }
      if (params.action !== 'start' || typeof params.requestId !== 'string' || !params.requestId || params.requestId.length > 200) throw new WorkbenchError('cache_request_invalid', 'Cleanup requires a request identity');
      const previous = await this.readTask(hash(`cleanup:${params.requestId}`).slice(0, 40));
      if (previous) {
        if (previous.previewId !== params.previewId) throw new WorkbenchError('cache_request_conflict', 'Request identity belongs to another cleanup');
        return this.view(previous);
      }
      if (typeof params.previewId !== 'string' || !/^[a-f0-9-]{36}$/.test(params.previewId)) throw new WorkbenchError('cache_preview_invalid', 'A server preview is required');
      const preview = await this.json(join(this.root, 'previews', `${params.previewId}.json`));
      if (!preview || preview.expiresAt < Date.now()) throw new WorkbenchError('cache_preview_expired', 'Preview expired; inspect the cache again');
      // A manual cleanup should not queue behind this panel's own obsolete scan.
      for (const task of this.tasks.values()) if (task.kind === 'scan' && cacheTaskActive(task)) this.controllers.get(task.taskId)?.abort();
      return this.accept('cleanup', params.requestId, preview);
    });
  }
  private async accept(kind: CacheTask['kind'], requestId: string, preview?: Preview): Promise<CacheTask> {
    if (this.closed) throw new WorkbenchError('cache_closed', 'Cache management closed');
    if (this.queue.length >= 16) throw new WorkbenchError('cache_busy', 'Cache task queue is full');
    const taskId = hash(`${kind}:${requestId}`).slice(0, 40);
    const previous = await this.readTask(taskId); if (previous) return this.view(previous);
    const task: StoredTask = { protocol: 1, taskId, requestId, generation: this.generation, kind, state: 'queued', phase: 'queued', acceptedAt: Date.now(), updatedAt: Date.now(), completed: 0, total: 0,
      ...(preview ? { previewId: preview.previewId, resourceId: preview.resource.id } : {}) };
    await this.save(task);
    this.latest = taskId;
    // This pointer is only a convenience; the durable request record is authoritative.
    await writeDerivedJson(join(this.root, 'latest-task.json'), { taskId }).catch(() => {});
    this.tasks.set(taskId, task); this.trimTasks(); this.controllers.set(taskId, new AbortController()); this.queue.push(task);
    this.pump(); return this.view(task);
  }
  private pump() {
    if (this.flight || this.closed) return;
    const task = this.queue.shift(); if (!task) return;
    const controller = this.controllers.get(task.taskId)!;
    this.flight = (async () => {
      try {
        await withCacheLease(this.options.hostRoot || cacheHostRoot(), controller.signal, async () => {
          task.state = 'running'; task.phase = task.kind === 'scan' ? 'discover' : 'validate'; await this.save(task);
          if (task.kind === 'scan') await this.runScan(task, controller.signal); else await this.runCleanup(task, controller.signal);
        });
        if (cacheTaskActive(task)) { task.state = 'complete'; task.phase = 'complete'; }
      } catch (error) {
        task.state = controller.signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : task.kind === 'cleanup' && task.completed > 0 ? 'partial' : 'failed';
        task.error = String(error).slice(0, 1000); task.phase = task.state;
      } finally {
        await this.save(task); this.controllers.delete(task.taskId); this.trimTasks();
      }
    })().finally(() => { this.flight = undefined; this.pump(); });
    // A failed journal write must not become an unhandled rejection.
    void this.flight.catch(() => {});
  }
  private retain(previous: CacheUsage | undefined, next: CacheUsage): CacheUsage {
    return next.bytes === null && previous?.bytes !== null && previous?.bytes !== undefined ? { ...next, bytes: previous.bytes, uniqueBytes: previous.uniqueBytes } : next;
  }
  private async runScan(task: StoredTask, signal: AbortSignal) {
    const context = await this.context(signal), identity = this.rosterIdentity(context), configIdentity = this.configIdentity(context);
    const { resources, errors } = await this.discover(context);
    const previous = this.snapshot;
    for (const resource of resources) resource.usage = previous.resources.find(value => value.id === resource.id)?.usage || emptyUsage();
    const rows = context.workspaces.filter(workspace => workspace.state !== 'removed').map(workspace => {
      const instance = workspaceInstanceKey(workspace as any), path = workspace.treePath || workspace.sourceRoot;
      return { id: workspace.id, instance, displayName: workspace.displayName || workspace.id, state: workspace.state, path,
        usage: previous.workspaces.find(row => row.instance === instance && row.path === path)?.usage || emptyUsage(),
        resourceIds: resources.filter(resource => resource.references.some(ref => ref.instance === instance)).map(resource => resource.id) };
    });
    const staged: CacheSnapshot = { ...previous, resources, workspaces: rows, state: 'partial', errors };
    const publish = () => { if (!signal.aborted && !this.closed) this.snapshot = { ...staged, resources: [...staged.resources], workspaces: [...staged.workspaces] }; };
    const foreground = async () => { while (gitQueue.health().byIntent.interactive > 0 && !signal.aborted) await pause(25); };
    const measure = this.options.measure || measureCachePaths, union = new Set<string>();
    task.total = resources.length + rows.length; task.phase = 'measure'; publish();
    for (const resource of resources) {
      resource.usage = this.retain(resource.usage, await measure(resource.paths, { signal, union, yieldToForeground: foreground }));
      if (resource.usage.error) staged.errors.push(resource.usage.error);
      task.completed++; task.updatedAt = Date.now(); publish();
    }
    const workspaceUnion = new Set<string>();
    for (const row of rows) {
      row.usage = this.retain(row.usage, await measure([row.path], { signal, union: workspaceUnion, yieldToForeground: foreground,
        ...(row.id === 'main' ? { exclude: [context.config.stateRoot, context.config.cacheRoot, context.config.workspaceRoot] } : {}) }));
      task.completed++; task.updatedAt = Date.now(); publish();
    }
    if (signal.aborted) throw new Error('Scan cancelled');
    const current = await this.context(signal);
    if (identity !== this.rosterIdentity(current) || configIdentity !== this.configIdentity(current)) { this.snapshot = previous; throw new WorkbenchError('cache_scope_changed', 'Workspace or configuration changed during scan'); }
    staged.observedAt = Date.now();
    staged.state = staged.errors.length || [...resources.map(resource => resource.usage), ...rows.map(row => row.usage)].some(usage => ['failed','partial'].includes(usage.state)) ? 'partial' : 'ready';
    staged.totalBytes = resources.some(resource => resource.usage.bytes !== null) ? resources.reduce((sum, resource) => sum + (resource.usage.uniqueBytes ?? resource.usage.bytes ?? 0), 0) : null;
    staged.workspaceTotalBytes = rows.some(row => row.usage.bytes !== null) ? rows.reduce((sum, row) => sum + (row.usage.uniqueBytes ?? row.usage.bytes ?? 0), 0) : null;
    publish(); this.writer.save(staged);
    if (staged.state === 'partial') task.state = 'partial';
  }
  private async runCleanup(task: StoredTask, signal: AbortSignal) {
    const preview: Preview = await this.json(join(this.root, 'previews', `${task.previewId}.json`));
    if (!preview || preview.expiresAt < Date.now()) throw new WorkbenchError('cache_preview_expired', 'Cleanup preview expired');
    const context = await this.context(signal);
    if (this.configIdentity(context) !== preview.configIdentity || this.rosterIdentity(context) !== preview.rosterIdentity) throw new WorkbenchError('cache_scope_changed', 'Cache ownership changed; preview again');
    const discovery = await this.discover(context), resource = discovery.resources.find(value => value.id === preview.resource.id);
    if (!resource?.cleanup.available || stable(resource.references) !== stable(preview.resource.references)) throw new WorkbenchError('cache_scope_changed', 'Cache target changed; preview again');
    if (await this.pathIdentity(resource) !== preview.pathIdentity) throw new WorkbenchError('cache_path_changed', 'Cache root was replaced');
    const affected = await (this.options.assertIdle || assertCacheIdle)(resource, context.config);
    if (stable(affected.sort()) !== stable(preview.affectedProjects)) throw new WorkbenchError('cache_scope_changed', 'Shared cache users changed; preview again');
    task.total = resource.paths.length; task.phase = 'clean'; await this.save(task);
    // Recheck after queueing and again before each command in a multi-root cleanup.
    // Module cleanup can remove its root, so only remaining roots need inode checks.
    const roots = [...resource.paths];
    context.validateCleanup = async () => {
      if (signal.aborted) throw new WorkbenchError('cache_task_cancelled', 'Cache cleanup cancelled');
      const current = await this.context(signal);
      if (this.configIdentity(current) !== preview.configIdentity || this.rosterIdentity(current) !== preview.rosterIdentity) throw new WorkbenchError('cache_scope_changed', 'Cache ownership changed; preview again');
      for (let index = task.completed; index < roots.length; index++) {
        if (await this.pathIdentity({ ...resource, paths: [roots[index]] }) !== preview.rootIdentities[index]) throw new WorkbenchError('cache_path_changed', 'Cache root was replaced');
      }
      const users = await (this.options.assertIdle || assertCacheIdle)(resource, current.config);
      if (stable(users.sort()) !== stable(preview.affectedProjects)) throw new WorkbenchError('cache_scope_changed', 'Shared cache users changed; preview again');
    };
    context.cleanupProgress = async completed => { task.completed = completed; await this.save(task); };
    try {
      await context.validateCleanup();
      await this.providers.get(resource.providerId).cleanup(resource, context);
      task.completed = task.total;
    } finally {
      this.snapshot = { ...this.snapshot, observedAt: undefined, state: 'partial' };
      this.writer.save(this.snapshot);
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const task of this.queue.splice(0)) { task.state = 'interrupted'; task.phase = 'interrupted'; await this.save(task); }
    await this.flight?.catch(() => {}); await this.serial; await this.writer.flush();
  }
}
