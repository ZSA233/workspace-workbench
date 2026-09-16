import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import * as watcher from '@parcel/watcher';
import { Git, withBackgroundGit } from './git.ts';
import { canonical, WorkbenchError } from './storage.ts';

type Subscription = { unsubscribe(): Promise<void> };
type Watch = { users: Set<Repo>; promise: Promise<Subscription | null>; close?: () => void };
type Repo = {
  path: string; successfulAt?: string; working: number; refs: number; lease: number; verified: number;
  issue: string | null; retryAt: number; failures: number; ready?: Promise<void>;
  watches: Set<string>; firstEvent: number; timer?: ReturnType<typeof setTimeout>;
  pendingWorking: boolean; pendingRefs: boolean; refresh?: () => Promise<unknown>; refreshing?: Promise<unknown>;
};
export type SchedulerOptions = {
  subscribe?: typeof watcher.subscribe; leaseMs?: number; reconcileMs?: number;
  degradedMs?: number; debounceMs?: number; maxWaitMs?: number; subscribeMs?: number;
};
/** Events invalidate derived data, never claim that a Git observation succeeded. */
export class ObservationScheduler {
  readonly instanceId = randomUUID();
  revision = 0;
  private repos = new Map<string, Repo>();
  private workspaces = new Map<string, Set<string>>();
  private watches = new Map<string, Watch>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private options: Required<SchedulerOptions>;
  constructor(options: SchedulerOptions = {}) {
    this.options = { subscribe: watcher.subscribe, leaseMs: 30_000, reconcileMs: 300_000,
      degradedMs: 30_000, debounceMs: 300, maxWaitMs: 1_000, subscribeMs: 5_000, ...options };
    this.timer = setInterval(() => this.tick(), 1_000); this.timer.unref();
  }
  register(workspace: string, path: string, refresh?: () => Promise<unknown>) {
    path = canonical(path);
    let repo = this.repos.get(path);
    if (!repo) {
      repo = { path, working: 0, refs: 0, lease: 0, verified: Date.now(), issue: null,
        retryAt: 0, failures: 0, watches: new Set(), firstEvent: 0, pendingWorking: false, pendingRefs: false };
      this.repos.set(path, repo);
    }
    if (refresh) repo.refresh = refresh;
    const paths = this.workspaces.get(workspace) || new Set<string>(); paths.add(path); this.workspaces.set(workspace, paths);
    this.touch(repo);
    return repo.ready || this.prepare(repo);
  }
  private touch(repo: Repo) {
    if (repo.lease < Date.now()) { repo.working++; repo.refs++; this.revision++; }
    repo.lease = Date.now() + this.options.leaseMs;
  }
  // Called by the lightweight RPC. No filesystem reads or Git processes here.
  versions(workspaceIds: string[]) {
    for (const id of workspaceIds) for (const path of this.workspaces.get(id) || []) this.touch(this.repos.get(path)!);
    const tokens: Record<string, string> = {};
    for (const id of workspaceIds) {
      tokens[`workspace:${id}`] = this.workspaceToken(id);
      for (const path of this.workspaces.get(id) || []) for (const scope of ['working', 'refs'] as const) tokens[`${path}#${scope}`] = this.token(path, scope);
    }
    return { instanceId: this.instanceId, revision: this.revision, tokens,
      repositories: [...new Set(workspaceIds.flatMap(id => [...(this.workspaces.get(id) || [])]))].map(path => {
        const r = this.repos.get(path)!;
        return { path, revision: `${r.working}:${r.refs}`, refreshing: !!r.refreshing,
          issue: r.issue, lastSuccessfulAt: r.successfulAt || null, lastVerifiedAt: new Date(r.verified).toISOString() };
      }) };
  }
  token(path: string, scope: 'working' | 'refs' = 'working') {
    const r = this.repos.get(path) || this.repos.get(canonical(path));
    return `${this.instanceId}:${r?.refs || 0}:${scope === 'working' ? r?.working || 0 : ''}`;
  }
  workspaceToken(id: string) { return [...(this.workspaces.get(id) || [])].map(path => this.token(path)).join(':'); }
  observed(path: string) { const r = this.repos.get(path); if (r) r.successfulAt = new Date().toISOString(); }
  published() { this.revision++; }
  force(workspace?: string) {
    for (const r of this.repos.values()) if (!workspace || this.workspaces.get(workspace)?.has(r.path)) {
      if (workspace) this.touch(r);
      this.event(r, true, true, true);
    }
    this.revision++;
  }
  private prepare(repo: Repo): Promise<void> {
    if (this.closed) return Promise.resolve();
    const promise = (async () => {
      try {
        if (!existsSync(repo.path))
          throw new WorkbenchError('repository_missing', 'Repository directory does not exist');
        try { accessSync(repo.path, constants.R_OK | constants.X_OK); }
        catch { throw new WorkbenchError('repository_access_denied', 'Repository directory is not accessible'); }
        const git = new Git(repo.path, 3_000, Date.now() + 10_000);
        if (await git.root() !== repo.path)
          throw new WorkbenchError('repository_root_mismatch', 'Observation requires an exact Git worktree root');
        const gitDir = canonical(await git.text(['rev-parse', '--absolute-git-dir']));
        const commonDir = resolve(repo.path, await git.text(['rev-parse', '--git-common-dir']));
        const tracked = (await git.text(['ls-files', '-z'])).split('\0').filter(Boolean);
        const ignored = (await git.text(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']))
          .split('\0').filter(p => p.endsWith('/') && !tracked.some(t => t.startsWith(p))).map(p => resolve(repo.path, p));
        await this.watch(repo, repo.path, [join(repo.path, '.git'), ...ignored], false);
        await this.watch(repo, gitDir, [join(gitDir, 'objects')], true);
        if (canonical(commonDir) !== gitDir) await this.watch(repo, canonical(commonDir), [join(commonDir, 'objects'), join(commonDir, 'worktrees')], true);
        if (this.closed) return;
        repo.issue = null; repo.failures = 0; repo.retryAt = 0; repo.working++; repo.refs++; this.revision++;
      } catch (error) {
        repo.issue = error instanceof WorkbenchError ? error.code : 'watcher_unavailable';
        repo.retryAt = repo.issue === 'repository_missing' || repo.issue === 'repository_root_mismatch' || repo.issue === 'repository_access_denied'
          ? Date.now() + this.options.degradedMs
          : Date.now() + Math.min(300_000, 5_000 * 2 ** Math.min(6, repo.failures++));
        this.revision++;
      }
    })();
    repo.ready = promise;
    return promise;
  }
  private async watch(repo: Repo, path: string, ignore: string[], metadata: boolean) {
    if (this.closed) return;
    let item = this.watches.get(path);
    if (!item) {
      const users = new Set<Repo>();
      let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
      const pending = this.options.subscribe(path, (error, events) => {
        if (this.closed || expired) return;
        for (const r of users) {
          if (error) { r.issue = 'watcher_unavailable'; r.retryAt = Date.now() + 5_000; this.revision++; continue; }
          const paths = events.map(e => relative(path, e.path).replaceAll('\\', '/'));
          const refs = metadata && paths.some(p => /^(HEAD|refs(?:\/|$)|packed-refs|config|shallow)/.test(p));
          const working = !metadata || paths.some(p => /^(index|HEAD|config|info\/exclude)/.test(p));
          if (working || refs) this.event(r, working, refs);
          if ((!metadata && paths.some(p => p.endsWith('.gitignore'))) || (metadata && paths.some(p => /^(index|config|info\/exclude)$/.test(p)))) {
            r.issue = 'watcher_reconfiguring'; r.retryAt = Date.now();
          }
        }
      }, { ignore });
      let cancel = () => {};
      const promise = new Promise<Subscription | null>((resolvePromise, reject) => {
        cancel = () => { expired = true; clearTimeout(timer); resolvePromise(null); };
        timer = setTimeout(() => { expired = true; reject(new WorkbenchError('watcher_subscribe_timeout', 'Watcher subscription timed out')); }, this.options.subscribeMs);
        pending.then(subscription => {
          clearTimeout(timer);
          if (expired || this.closed) { void subscription.unsubscribe().catch(() => {}); resolvePromise(null); }
          else resolvePromise(subscription);
        }, error => { clearTimeout(timer); reject(error); });
      });
      item = { users, promise, close: cancel };
      this.watches.set(path, item);
      void promise.catch(() => { if (this.watches.get(path) === item) this.watches.delete(path); });
    }
    item.users.add(repo); repo.watches.add(path);
    await item.promise;
  }
  private event(repo: Repo, working: boolean, refs: boolean, immediate = false) {
    repo.pendingWorking ||= working; repo.pendingRefs ||= refs;
    repo.firstEvent ||= Date.now();
    clearTimeout(repo.timer);
    const flush = () => {
      repo.timer = undefined; repo.firstEvent = 0;
      if (repo.pendingWorking) repo.working++;
      if (repo.pendingRefs) repo.refs++;
      repo.pendingWorking = repo.pendingRefs = false; this.revision++;
      if (repo.lease > Date.now()) this.refresh(repo);
    };
    if (immediate) flush();
    else { repo.timer = setTimeout(flush, Math.max(0, Math.min(this.options.debounceMs, this.options.maxWaitMs - (Date.now() - repo.firstEvent)))); repo.timer.unref(); }
  }
  private refresh(repo: Repo) {
    if (repo.refreshing || !repo.refresh || this.closed) return;
    const version = this.token(repo.path);
    repo.refreshing = withBackgroundGit(() => Promise.resolve().then(repo.refresh!)).then((value: any) => { repo.verified = Date.now(); if (value?.status !== "error" && value?.status !== "missing") repo.successfulAt = new Date().toISOString(); })
      .catch(() => {}).finally(() => {
        repo.refreshing = undefined;
        if (version !== this.token(repo.path) && repo.lease > Date.now()) this.refresh(repo);
      });
  }
  private async release(repo: Repo) {
    for (const path of repo.watches) {
      const item = this.watches.get(path); if (!item) continue;
      item.users.delete(repo);
      if (!item.users.size) { this.watches.delete(path); item.close?.(); await item.promise.then(s => s?.unsubscribe()).catch(() => {}); }
    }
    repo.watches.clear();
  }
  private tick() {
    if (this.closed) return;
    for (const repo of this.repos.values()) {
      if (repo.lease <= Date.now()) {
        if (repo.watches.size) repo.ready = this.release(repo).finally(() => { repo.ready = undefined; });
        continue;
      }
      if (!repo.ready) { void this.prepare(repo); continue; }
      if (repo.issue && repo.retryAt <= Date.now()) {
        repo.retryAt = Date.now() + 300_000;
        repo.ready = this.release(repo).then(() => this.prepare(repo));
      }
      if (Date.now() - repo.verified >= (repo.issue ? this.options.degradedMs : this.options.reconcileMs)) {
        repo.verified = Date.now(); this.event(repo, true, true, true);
      }
    }
  }
  health() { return { instanceId: this.instanceId, revision: this.revision, watchedDirectories: this.watches.size,
    repositories: this.repos.size, activeRepositories: [...this.repos.values()].filter(r => r.lease > Date.now()).length,
    issues: [...new Set([...this.repos.values()].map(r => r.issue).filter(Boolean))] }; }
  async close() {
    this.closed = true; clearInterval(this.timer);
    for (const repo of this.repos.values()) { clearTimeout(repo.timer); await this.release(repo); }
    await Promise.allSettled([...this.repos.values()].map(r => r.ready));
    await Promise.allSettled([...this.repos.values()].map(r => r.refreshing));
  }
}
