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
import { CacheCoordination } from './cache-coordination.ts';
import { accountUsage, measurementCohorts, publicUsage, targetsOverlap, type MeasureTarget } from './cache-accounting.ts';
import { DISCOVERY_INTERVAL, VIEW_LEASE, retainCacheUsage, resourceScanInterval, usageDueAt, workspaceScanInterval, type CacheActivity } from './cache-schedule.ts';
import { assertCacheIdle } from './cache-guards.ts';
import { DerivedJsonWriter, writeDerivedJson } from './derived-json.ts';
import { writeOperation } from './operation-storage.ts';
import { gitQueue } from './git-scheduler.ts';
import { loadConfig } from './config.ts';
import { hash, stable, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';

const PREVIEW_TTL = 10 * 60_000;
type Preview = CacheCleanupPreview & { configIdentity: string; rosterIdentity: string; pathIdentity: string; rootIdentities: string[] };
type StoredTask = CacheTask & { previewId?: string; viewIds?: string[]; forceAll?: boolean; refreshInventory?: boolean; pendingTargets?: string[] };
type Activity = CacheActivity & { commitAt?: number };
type Options = { providers?: CacheProvider[]; hostRoot?: string; measure?: typeof measureCachePaths; assertIdle?: typeof assertCacheIdle;
  clock?: () => number; latestCommitAt?: (workspace: Json) => string | null; rosterVersion?: () => string };
const emptyUsage = (): CacheUsage => ({ bytes: null, state: 'pending' });
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{40}$/.test(id);
const yielded = () => new WorkbenchError('cache_scan_yield', 'Statistics yielded to a cleanup');

/** Background directory work has its own queue and durable, per-target checkpoints. */
export class CacheManagement {
  readonly generation = randomUUID();
  private providers: CacheProviders;
  private options: Options;
  private workspaces: Workspaces;
  private snapshot: CacheSnapshot;
  private writer: DerivedJsonWriter;
  private activityWriter: DerivedJsonWriter;
  private activities: Record<string, Activity> = Object.create(null);
  private pendingActivity = new Map<string, Activity>();
  private activityFlight?: Promise<void>;
  private knownWorkspaces: Json[] = [];
  private views = new Map<string, { workspaceId?: string; expires: number }>();
  private retiredViews = new Set<string>();
  private loaded?: Promise<void>;
  private coordination?: Promise<CacheCoordination>;
  private invalidationRevision = 0;
  private rosterVersion?: string;
  private inventoryRosterIdentity?: string;
  private tasks = new Map<string, StoredTask>();
  private controllers = new Map<string, AbortController>();
  private intents = new Map<string, ReturnType<typeof setInterval>>();
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
    this.activityWriter = new DerivedJsonWriter(join(this.root, 'activity.json'));
  }
  private now() { return this.options.clock?.() ?? Date.now(); }
  private get root() { return join(this.workspaces.config.stateRoot, 'cache-management'); }
  private get hostRoot() { return this.options.hostRoot || cacheHostRoot(); }
  private control() {
    return this.coordination ||= CacheCoordination.open(this.hostRoot).catch(error => { this.coordination = undefined; throw error; });
  }
  private taskFile(id: string) { return join(this.root, 'tasks', `${id}.json`); }
  private async json(path: string) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
  private load() {
    return this.loaded ||= (async () => {
      const saved = await this.json(join(this.root, 'snapshot.json')).catch(() => null);
      if (saved?.protocol === 1 && saved.projectConfig === this.workspaces.config.configPath && Array.isArray(saved.resources) && Array.isArray(saved.workspaces)) {
        const { inventoryRosterIdentity, ...snapshot } = saved; this.snapshot = snapshot;
      }
      this.inventoryRosterIdentity = typeof saved?.inventoryRosterIdentity === 'string' ? saved.inventoryRosterIdentity : undefined;
      this.rosterVersion = this.options.rosterVersion?.();
      const activity = await this.json(join(this.root, 'activity.json')).catch(() => null);
      if (activity?.version === 1 && activity.workspaces && typeof activity.workspaces === 'object') this.activities = Object.assign(Object.create(null), activity.workspaces);
      const latest = await this.json(join(this.root, 'latest-task.json')).catch(() => null);
      if (validId(latest?.taskId)) { this.latest = latest.taskId; await this.readTask(latest.taskId); }
      const scan = await this.json(join(this.root, 'latest-scan.json')).catch(() => null);
      if (validId(scan?.taskId)) await this.readTask(scan.taskId);
    })();
  }
  private async readTask(id: string): Promise<StoredTask | undefined> {
    if (!validId(id)) throw new WorkbenchError('cache_task_invalid', 'Invalid cache task ID');
    const cached = this.tasks.get(id); if (cached) return cached;
    const value = await this.json(this.taskFile(id));
    if (!value) return;
    if (value.taskId !== id || value.protocol !== 1 || !['scan','cleanup'].includes(value.kind)) throw new WorkbenchError('cache_task_invalid', 'Invalid cache operation record');
    if (cacheTaskActive(value) && value.generation !== this.generation) {
      value.state = 'interrupted'; value.phase = 'reconcile';
      value.error = value.kind === 'cleanup' ? 'Previous worker stopped; inspect the result before starting another cleanup' : 'Previous worker stopped; completed statistics are retained'; value.updatedAt = Date.now();
      await writeOperation(this.taskFile(id), value);
    }
    this.tasks.set(id, value); return value;
  }
  private view(task: StoredTask): CacheTask { const { previewId, viewIds, forceAll, refreshInventory, pendingTargets, ...value } = task; return value; }
  private trimTasks() {
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= 128) break;
      if (!cacheTaskActive(task) && id !== this.latest) this.tasks.delete(id);
    }
  }
  private async save(task: StoredTask) { task.updatedAt = Date.now(); await writeOperation(this.taskFile(task.taskId), task); }
  private lastScan() { return [...this.tasks.values()].filter(value => value.kind === 'scan').sort((a,b) => b.acceptedAt - a.acceptedAt)[0]; }
  private saveActivity() { this.activityWriter.save({ version: 1, workspaces: { ...this.activities } }); }
  noteWorkspaceActivity(id: string, kind: 'used' | 'changed' = 'changed') {
    if (this.closed) return;
    const workspace = this.knownWorkspaces.find(row => row.id === id);
    if (!workspace) {
      this.pendingActivity.set(id, { ...this.pendingActivity.get(id), [kind === 'used' ? 'usedAt' : 'changedAt']: this.now() });
      if (this.pendingActivity.size > 256) this.pendingActivity.delete(this.pendingActivity.keys().next().value!);
      this.activityFlight ||= this.load().then(() => this.context(new AbortController().signal)).then(() => {}).catch(() => {})
        .finally(() => { this.activityFlight = undefined; });
      return;
    }
    const instance = workspaceInstanceKey(workspace as any);
    this.activities[instance] = { ...this.activities[instance], [kind === 'used' ? 'usedAt' : 'changedAt']: this.now() };
    this.saveActivity();
  }
  private intervals() {
    const now = this.now(), current = new Set([...this.views.values()].filter(view => view.expires > now).map(view => view.workspaceId));
    const intervals = new Map<string, number>();
    let changed = false;
    for (const row of this.snapshot.workspaces) {
      const workspace = this.knownWorkspaces.find(value => workspaceInstanceKey(value as any) === row.instance);
      const activity = this.activities[row.instance] || {};
      const commit = workspace && Date.parse(this.options.latestCommitAt?.(workspace) || '');
      if (commit && activity.commitAt !== commit) { this.activities[row.instance] = { ...activity, commitAt: commit }; changed = true; }
      const latest = Math.max(activity.usedAt || 0, activity.changedAt || 0, commit || activity.commitAt || 0);
      intervals.set(row.instance, current.has(row.id) ? 10 * 60_000 : workspaceScanInterval(latest || undefined, now));
    }
    if (changed) this.saveActivity();
    return intervals;
  }
  private mainExcludes() { const config = this.workspaces.config; return [config.stateRoot, config.cacheRoot, config.workspaceRoot]; }
  private targets(): MeasureTarget[] {
    const intervals = this.intervals();
    return [
      ...this.snapshot.resources.map(resource => ({ key: `resource:${resource.id}`, paths: resource.paths, usage: resource.usage, interval: resourceScanInterval(resource, intervals) })),
      ...this.snapshot.workspaces.map(row => ({ key: `workspace:${row.instance}`, paths: [row.path], usage: row.usage, interval: intervals.get(row.instance) || 24 * 60 * 60_000,
        ...(row.id === 'main' ? { exclude: this.mainExcludes() } : {}) })),
    ];
  }
  private discoveryDue() { return !this.snapshot.nextDiscoveryAt || this.snapshot.nextDiscoveryAt <= this.now() || !!this.options.rosterVersion && this.rosterVersion !== this.options.rosterVersion(); }
  private async applyInvalidations() {
    const control = await this.control();
    const changes = control.changes(this.invalidationRevision);
    if (!changes.length) return;
    const update = (usage: CacheUsage, paths: string[], exclude?: string[]) => {
      const affected = changes.filter(change => targetsOverlap({ paths, exclude }, { paths: change.paths }));
      const at = Math.max(0, ...affected.map(change => change.at));
      const revision = Number((usage as CacheUsage & { cacheRevision?: number }).cacheRevision || 0);
      return affected.some(change => change.revision > revision) ? { ...usage, invalidatedAt: at, attemptedAt: undefined, failures: undefined } : usage;
    };
    this.snapshot = { ...this.snapshot,
      resources: this.snapshot.resources.map(row => ({ ...row, usage: update(row.usage, row.paths) })),
      workspaces: this.snapshot.workspaces.map(row => ({ ...row, usage: update(row.usage, [row.path], row.id === 'main' ? this.mainExcludes() : undefined) })),
    };
    this.invalidationRevision = changes.at(-1)!.revision;
    this.checkpoint();
  }
  async list(): Promise<CacheListResult> {
    await this.load();
    let coordinationError: string | undefined;
    try { await this.applyInvalidations(); } catch (error) { coordinationError = `Cache coordination unavailable: ${String(error)}`; }
    const task = [...this.tasks.values()].find(cacheTaskActive) || (this.latest ? this.tasks.get(this.latest) : undefined);
    const targets = this.targets(), byKey = new Map(targets.map(target => [target.key, usageDueAt(target.usage, target.interval)]));
    const scan = this.lastScan();
    const pending = scan && ['paused','interrupted'].includes(scan.state) && scan.pendingTargets?.length;
    const nextScanAt = Math.min(this.discoveryDue() || pending ? 0 : this.snapshot.nextDiscoveryAt!, ...byKey.values());
    return { ...this.snapshot,
      ...(coordinationError ? { errors: [...this.snapshot.errors, coordinationError] } : {}),
      resources: this.snapshot.resources.map(row => ({ ...row, usage: { ...publicUsage(row.usage), nextScanAt: byKey.get(`resource:${row.id}`) } })),
      workspaces: this.snapshot.workspaces.map(row => ({ ...row, usage: { ...publicUsage(row.usage), nextScanAt: byKey.get(`workspace:${row.instance}`) } })),
      stale: nextScanAt <= this.now(), nextScanAt, ...(task ? { task: this.view(task) } : {}) };
  }
  async task(params: Json): Promise<Json> {
    await this.load();
    const id = params.taskId || (params.requestId ? hash(`cleanup:${params.requestId}`).slice(0, 40) : this.latest);
    if (!id) return { protocol: 1, state: 'idle' };
    const task = await this.readTask(id);
    return task ? this.view(task) : { protocol: 1, state: 'idle' };
  }
  private locked<T>(work: () => Promise<T>): Promise<T> { const result = this.serial.then(work); this.serial = result.catch(() => {}); return result; }
  private wanted(task: StoredTask) { return !task.viewIds || task.viewIds.some(id => (this.views.get(id)?.expires || 0) > this.now()); }
  async scan(params: Json): Promise<Json> {
    return this.locked(async () => {
      await this.load();
      if (params.action === 'activity') {
        await this.context(new AbortController().signal);
        if (this.knownWorkspaces.some(row => row.id === params.workspaceId && row.state !== 'removed')) this.noteWorkspaceActivity(params.workspaceId, 'used');
        return { protocol: 1, state: 'complete' };
      }
      if (params.action === 'pause') {
        if (typeof params.viewId !== 'string') throw new WorkbenchError('cache_request_invalid', 'A view identity is required');
        this.views.delete(params.viewId); this.retiredViews.add(params.viewId);
        if (this.retiredViews.size > 256) this.retiredViews.delete(this.retiredViews.values().next().value!);
        return { protocol: 1, state: 'paused' };
      }
      if (params.action === 'cancel') {
        const task = params.taskId ? await this.readTask(params.taskId) : [...this.tasks.values()].find(value => value.kind === 'scan' && cacheTaskActive(value));
        if (!task || task.kind !== 'scan') throw new WorkbenchError('cache_task_invalid', 'No scan to cancel');
        this.controllers.get(task.taskId)?.abort();
        if (cacheTaskActive(task) || task.state === 'paused') { task.state = 'cancelled'; task.phase = 'cancelled'; task.pendingTargets = []; await this.save(task); }
        return this.view(task);
      }
      if (params.action && params.action !== 'start') throw new WorkbenchError('cache_action_invalid', 'Unknown scan action');
      const viewId = params.viewId;
      for (const [id, view] of this.views) if (view.expires <= this.now()) this.views.delete(id);
      if (viewId !== undefined) {
        if (typeof viewId !== 'string' || !/^[a-zA-Z0-9-]{1,160}$/.test(viewId)) throw new WorkbenchError('cache_request_invalid', 'Invalid view identity');
        if (this.retiredViews.has(viewId)) return { protocol: 1, state: 'paused' };
        this.views.set(viewId, { workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : undefined, expires: this.now() + VIEW_LEASE });
      }
      if (params.automatic && !viewId) throw new WorkbenchError('cache_request_invalid', 'Automatic scans require a visible view');
      const active = [...this.tasks.values()].find(value => value.kind === 'scan' && cacheTaskActive(value));
      if (active) {
        if (params.force && !active.forceAll) { active.forceAll = true; active.refreshInventory = true; }
        if (active.viewIds && viewId && !active.viewIds.includes(viewId)) active.viewIds.push(viewId);
        await this.save(active);
        return this.view(active);
      }
      await this.applyInvalidations();
      if ((await this.control()).cleanupPending()) return { protocol: 1, state: 'paused', phase: 'cleanup' };
      if (!this.knownWorkspaces.length || this.options.rosterVersion && this.rosterVersion !== this.options.rosterVersion()) {
        await this.context(new AbortController().signal); this.rosterVersion = this.options.rosterVersion?.();
      }
      const previous = this.lastScan();
      const pendingTargets = previous && ['paused','interrupted'].includes(previous.state) ? previous.pendingTargets || [] : [];
      if (!params.force && !pendingTargets.length && !this.discoveryDue() && !this.targets().some(target => usageDueAt(target.usage, target.interval) <= this.now())) return { protocol: 1, state: 'complete', phase: 'fresh' };
      return this.accept('scan', params.requestId || randomUUID(), undefined, { ...(viewId ? { viewIds: [viewId] } : {}), forceAll: params.force === true, pendingTargets });
    });
  }
  private async context(signal: AbortSignal): Promise<CacheDiscoveryContext> {
    const metadata = await this.workspaces.observationRecords.request('roster', { force: true });
    if (metadata.workspaces.some((workspace: Json) => workspace.state === 'record_invalid')) throw new WorkbenchError('cache_roster_unavailable', 'Workspace records could not be verified');
    this.knownWorkspaces = metadata.workspaces;
    if (this.pendingActivity.size) {
      for (const [id, activity] of this.pendingActivity) {
        const workspace = this.knownWorkspaces.find(row => row.id === id && row.state !== 'removed');
        if (workspace) { const instance = workspaceInstanceKey(workspace as any); this.activities[instance] = { ...this.activities[instance], ...activity }; }
      }
      this.pendingActivity.clear(); this.saveActivity();
    }
    const context = { config: this.workspaces.config, workspaces: metadata.workspaces, signal };
    if (this.inventoryRosterIdentity && this.inventoryRosterIdentity !== this.rosterIdentity(context)) this.snapshot = { ...this.snapshot, nextDiscoveryAt: 0 };
    return context;
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
        const context = await this.context(new AbortController().signal);
        const affectedProjects = await (this.options.assertIdle || assertCacheIdle)(resource, context.config);
        const preview: Preview = { previewId: randomUUID(), expiresAt: Date.now() + PREVIEW_TTL, resource, affectedProjects: affectedProjects.sort(),
          configIdentity: this.configIdentity(context), rosterIdentity: this.rosterIdentity(context), pathIdentity: await this.pathIdentity(resource),
          rootIdentities: await Promise.all(resource.paths.map(path => this.pathIdentity({ ...resource, paths: [path] }))) };
        await writeOperation(join(this.root, 'previews', `${preview.previewId}.json`), preview);
        const { configIdentity, rosterIdentity, pathIdentity, rootIdentities, ...publicPreview } = preview;
        return { ...publicPreview, resource: { ...resource, usage: publicUsage(resource.usage) } };
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
      return this.accept('cleanup', params.requestId, preview);
    });
  }
  private async accept(kind: CacheTask['kind'], requestId: string, preview?: Preview, scan: Partial<StoredTask> = {}): Promise<CacheTask> {
    if (this.closed) throw new WorkbenchError('cache_closed', 'Cache management closed');
    if (this.queue.length >= 16) throw new WorkbenchError('cache_busy', 'Cache task queue is full');
    const taskId = hash(`${kind}:${requestId}`).slice(0, 40);
    const previous = await this.readTask(taskId); if (previous) return this.view(previous);
    const task: StoredTask = { ...scan, protocol: 1, taskId, requestId, generation: this.generation, kind, state: 'queued', phase: 'queued', acceptedAt: Date.now(), updatedAt: Date.now(), completed: 0, total: 0,
      ...(preview ? { previewId: preview.previewId, resourceId: preview.resource.id } : {}) };
    await this.save(task);
    this.latest = taskId;
    await writeDerivedJson(join(this.root, 'latest-task.json'), { taskId }).catch(() => {});
    if (kind === 'scan') await writeDerivedJson(join(this.root, 'latest-scan.json'), { taskId }).catch(() => {});
    this.tasks.set(taskId, task); this.trimTasks(); this.controllers.set(taskId, new AbortController());
    if (kind === 'cleanup') {
      try {
        const control = await this.control(), id = `${this.generation}:${taskId}`;
        control.intent(id);
        const timer = setInterval(() => { try { control.intent(id); } catch { /* A live command still owns the operation lease. */ } }, 5000); timer.unref(); this.intents.set(taskId, timer);
      } catch (error) {
        task.state = 'failed'; task.phase = 'coordinate'; task.error = String(error).slice(0, 1000);
        this.controllers.delete(taskId); await this.save(task); return this.view(task);
      }
    }
    this.queue.push(task); this.queue.sort((a,b) => Number(b.kind === 'cleanup') - Number(a.kind === 'cleanup'));
    this.pump(); return this.view(task);
  }
  private async releaseIntent(task: StoredTask) {
    const timer = this.intents.get(task.taskId);
    if (timer) { clearInterval(timer); this.intents.delete(task.taskId); (await this.control()).release(`${this.generation}:${task.taskId}`); }
  }
  private pump() {
    if (this.flight || this.closed) return;
    const task = this.queue.shift(); if (!task) return;
    const controller = this.controllers.get(task.taskId)!;
    this.flight = (async () => {
      try {
        task.state = 'running'; task.phase = task.kind === 'scan' ? 'discover' : 'validate'; await this.save(task);
        if (task.kind === 'scan') await this.runScan(task, controller.signal);
        else await withCacheLease(this.hostRoot, controller.signal, () => this.runCleanup(task, controller.signal));
        if (cacheTaskActive(task)) { task.state = 'complete'; task.phase = 'complete'; }
      } catch (error) {
        task.state = controller.signal.aborted ? this.closed ? 'interrupted' : 'cancelled' : task.kind === 'cleanup' && task.completed > 0 ? 'partial' : 'failed';
        task.error = String(error).slice(0, 1000); task.phase = task.state;
      } finally {
        await this.releaseIntent(task); await this.save(task); this.controllers.delete(task.taskId); this.trimTasks();
      }
    })().finally(() => { this.flight = undefined; this.pump(); });
    void this.flight.catch(() => {});
  }
  private checkpoint() {
    const intervals = this.intervals();
    const resources = accountUsage(this.snapshot.resources).map(row => ({ ...row,
      usage: { ...row.usage, nextScanAt: usageDueAt(row.usage, resourceScanInterval(row, intervals)) } }));
    const workspaces = accountUsage(this.snapshot.workspaces).map(row => ({ ...row,
      usage: { ...row.usage, nextScanAt: usageDueAt(row.usage, intervals.get(row.instance) || 24 * 60 * 60_000) } }));
    const usages = [...resources.map(row => row.usage), ...workspaces.map(row => row.usage)];
    const times = usages.flatMap(usage => usage.observedAt ? [usage.observedAt] : []);
    this.snapshot = { ...this.snapshot, resources, workspaces,
      state: this.snapshot.errors.length || usages.some(usage => !['ready','missing'].includes(usage.state) || usage.invalidatedAt) ? 'partial' : 'ready',
      totalBytes: resources.some(row => row.usage.bytes !== null) ? resources.reduce((sum, row) => sum + (row.usage.uniqueBytes ?? row.usage.bytes ?? 0), 0) : null,
      workspaceTotalBytes: workspaces.some(row => row.usage.bytes !== null) ? workspaces.reduce((sum, row) => sum + (row.usage.uniqueBytes ?? row.usage.bytes ?? 0), 0) : null,
      totalsEstimated: usages.some(usage => !usage.observedAt || usage.invalidatedAt || ['partial','failed'].includes(usage.state)) || new Set(times).size > 1,
    };
    this.writer.save({ ...this.snapshot, inventoryRosterIdentity: this.inventoryRosterIdentity });
  }
  private async refreshInventory(context: CacheDiscoveryContext, identity: string) {
    const { resources, errors } = await this.discover(context);
    if (identity !== this.configIdentity(context)) throw new WorkbenchError('cache_scope_changed', 'Workspace or configuration changed during scan');
    for (const resource of resources) resource.usage = this.snapshot.resources.find(value => value.id === resource.id)?.usage || emptyUsage();
    this.snapshot = { ...this.snapshot, resources, errors, inventoryObservedAt: this.now(), nextDiscoveryAt: this.now() + (errors.length ? 5 * 60_000 : DISCOVERY_INTERVAL) };
    this.inventoryRosterIdentity = this.rosterIdentity(context);
    this.rosterVersion = this.options.rosterVersion?.();
  }
  private async runScan(task: StoredTask, signal: AbortSignal) {
    if (signal.aborted) throw new Error('Scan cancelled');
    if (!this.wanted(task)) { if (task.forceAll) task.pendingTargets = this.targets().map(target => target.key); task.state = 'paused'; task.phase = 'hidden'; return; }
    const control = await this.control();
    if (control.cleanupPending()) { task.state = 'paused'; task.phase = 'cleanup'; return; }
    const context = await this.context(signal), configIdentity = this.configIdentity(context);
    const previous = this.snapshot;
    if (task.forceAll || this.discoveryDue()) {
      await this.refreshInventory(context, configIdentity); task.refreshInventory = false;
    }
    const resources = this.snapshot.resources;
    this.snapshot = { ...this.snapshot, workspaces: context.workspaces.filter(workspace => workspace.state !== 'removed').map(workspace => {
      const instance = workspaceInstanceKey(workspace as any), path = workspace.treePath || workspace.sourceRoot;
      return { id: workspace.id, instance, displayName: workspace.displayName || workspace.id, state: workspace.state, path,
        usage: previous.workspaces.find(row => row.instance === instance && row.path === path)?.usage || emptyUsage(),
        resourceIds: resources.filter(resource => resource.references.some(ref => ref.instance === instance)).map(resource => resource.id) };
    }) };
    await this.applyInvalidations(); this.checkpoint();
    const buildCohorts = () => {
      const targets = this.targets();
      return [...measurementCohorts(targets.filter(target => target.key.startsWith('resource:'))), ...measurementCohorts(targets.filter(target => target.key.startsWith('workspace:')))];
    };
    let cohorts = buildCohorts();
    const current = new Set([...this.views.values()].filter(view => view.expires > this.now()).map(view => view.workspaceId));
    const currentKeys = new Set(this.snapshot.workspaces.filter(row => current.has(row.id)).map(row => `workspace:${row.instance}`));
    cohorts.sort((a,b) => Number(b.some(target => currentKeys.has(target.key))) - Number(a.some(target => currentKeys.has(target.key))));
    const completed = new Set<string>(), inherited = new Set(task.pendingTargets);
    const due = (group: MeasureTarget[]) => group.some(target => task.forceAll || inherited.has(target.key) || usageDueAt(target.usage, target.interval) <= this.now());
    const remaining = () => cohorts.filter(group => !group.every(target => completed.has(target.key)) && due(group));
    const updatePending = () => { task.pendingTargets = remaining().flatMap(group => group.map(target => target.key)); task.total = task.completed + task.pendingTargets.length; };
    const stop = async (phase: string) => { updatePending(); task.state = 'paused'; task.phase = phase; await this.writer.flush(); };
    task.phase = 'measure'; updatePending(); await this.save(task);
    while (remaining().length || task.refreshInventory) {
      if (signal.aborted) throw new Error('Scan cancelled');
      if (!this.wanted(task)) { await stop('hidden'); return; }
      if (control.cleanupPending()) { await stop('cleanup'); return; }
      if (task.refreshInventory) {
        await this.refreshInventory(await this.context(signal), configIdentity); task.refreshInventory = false;
        this.snapshot = { ...this.snapshot, workspaces: this.snapshot.workspaces.map(row => ({ ...row,
          resourceIds: this.snapshot.resources.filter(resource => resource.references.some(ref => ref.instance === row.instance)).map(resource => resource.id) })) };
        cohorts = buildCohorts(); this.checkpoint(); updatePending();
        if (!remaining().length) break;
      }
      const group = remaining()[0], unit = new AbortController();
      let cleanupYield = false;
      let coordinationFailure: unknown;
      const abort = () => unit.abort(); signal.addEventListener('abort', abort, { once: true });
      const timer = setInterval(() => {
        try { if (control.cleanupPending()) { cleanupYield = true; unit.abort(); } }
        catch (error) { coordinationFailure = error; unit.abort(); }
      }, 50); timer.unref();
      try {
        await withCacheLease(this.hostRoot, unit.signal, async () => {
          if (!this.wanted(task)) throw new WorkbenchError('cache_scan_paused', 'Statistics page closed');
          if (control.cleanupPending()) throw yielded();
          await this.applyInvalidations();
          const values: CacheUsage[] = [], union = new Set<string>();
          const foreground = async () => { while (gitQueue.health().byIntent.interactive > 0 && !unit.signal.aborted) await pause(25); };
          for (const target of group) values.push(await (this.options.measure || measureCachePaths)(target.paths, { signal: unit.signal, union, exclude: target.exclude, yieldToForeground: foreground }));
          if (unit.signal.aborted) throw cleanupYield ? yielded() : new Error('Scan cancelled');
          const current = await this.context(signal);
          if (configIdentity !== this.configIdentity(current)) throw new WorkbenchError('cache_scope_changed', 'Workspace or configuration changed during scan');
          const valid = new Map(current.workspaces.filter(workspace => workspace.state !== 'removed').map(workspace => [workspaceInstanceKey(workspace as any), workspace.treePath || workspace.sourceRoot]));
          const measured = new Map(group.map((target, index) => [target.key, { ...retainCacheUsage(target.usage, values[index], this.now()), cacheRevision: this.invalidationRevision }]));
          this.snapshot = { ...this.snapshot, observedAt: this.now(),
            resources: this.snapshot.resources.map(row => ({ ...row, usage: measured.get(`resource:${row.id}`) || row.usage })),
            workspaces: this.snapshot.workspaces.filter(row => valid.get(row.instance) === row.path).map(row => ({ ...row, usage: measured.get(`workspace:${row.instance}`) || row.usage })),
          };
          if (this.inventoryRosterIdentity !== this.rosterIdentity(current)) this.snapshot.nextDiscoveryAt = 0;
          this.checkpoint(); await this.writer.flush();
          for (const target of group) completed.add(target.key);
          task.completed += group.length; updatePending(); await this.save(task);
        }, () => {
          if (!this.wanted(task)) throw new WorkbenchError('cache_scan_paused', 'Statistics page closed');
          if (control.cleanupPending()) throw yielded();
        });
      } catch (error) {
        if (coordinationFailure) throw coordinationFailure;
        if (!signal.aborted && (error as WorkbenchError).code === 'cache_scan_paused') { await stop('hidden'); return; }
        if (!signal.aborted && (cleanupYield || (error as WorkbenchError).code === 'cache_scan_yield')) { await stop('cleanup'); return; }
        throw error;
      } finally { clearInterval(timer); signal.removeEventListener('abort', abort); }
    }
    task.pendingTargets = [];
    if (this.snapshot.state === 'partial') task.state = 'partial';
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
      (await this.control()).invalidate(resource.paths);
      await this.applyInvalidations();
      await this.providers.get(resource.providerId).cleanup(resource, context);
      task.completed = task.total;
    } finally {
      (await this.control()).invalidate(resource.paths);
      await this.applyInvalidations();
    }
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const task of this.queue.splice(0)) { task.state = 'interrupted'; task.phase = 'interrupted'; await this.releaseIntent(task); await this.save(task); }
    await this.flight?.catch(() => {}); await this.serial; await this.activityFlight; await this.writer.flush(); await this.activityWriter.flush();
    if (this.coordination) await this.coordination.then(control => control.close(), () => {});
  }
}
