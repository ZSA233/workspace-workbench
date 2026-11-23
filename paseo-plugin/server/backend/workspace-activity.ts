import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WORKSPACE_ACTIVITY_LEASE_MS, WORKSPACE_ACTIVITY_VISIBLE_LIMIT, type WorkspaceActivityScan, type WorkspaceActivitySummary, type WorkspaceActivityUpdate, type WorkspaceActivityView } from '../../shared/workspace-activity.ts';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { activityObjectId, readActivityHead, type ActivityHead } from './activity-head.ts';
import type { Config } from './config.ts';
import { DerivedJsonWriter } from './derived-json.ts';
import { Git, withBackgroundGit } from './git.ts';
import { hash, optionalJson, stable, WorkbenchError, type Json } from './storage.ts';

const TICK_MS = 250;
const MAX_STARTS = 8;
const MAX_PIPELINE = 16;
const MAX_HEAD_READS = 4;
const MAX_GIT_READS = 2;
const MAX_ENTRIES = 10_000;
const RETRY_MS = [60_000, 300_000, 900_000];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SELECTOR_RECHECK_MS = 30_000;

type RepositoryActivity = {
  owners?: Record<string, string>;
  head: string | null;
  latestCommitAt: string | null;
  checkedAt: string | null;
  attemptedAt?: string;
  error?: string;
  failures?: number;
  headToken?: string;
};

type Target = {
  key: string;
  path: string;
  owners: Record<string, string>;
  signature: string;
  changed: boolean;
  version: number;
  actualPath?: string;
  files?: string[];
};
type Workspace = {
  id: string;
  instanceKey: string;
  scope: string;
  tree: string;
  managed: boolean;
  paths: string[];
  keys: string[];
  summary: WorkspaceActivityUpdate;
  pending?: Set<string>;
};
type Scan = WorkspaceActivityScan & {
  workspaceIds: string[];
  pending: Map<string, Target>;
  force: boolean;
  scope: string;
  serial: number;
};
type Job = {
  target: Target;
  version: number;
  force: boolean;
  serial: number;
  automatic: boolean;
  stage: 'queued' | 'probing' | 'git' | 'reading' | 'confirm' | 'confirming';
  controller: AbortController;
  head?: ActivityHead;
  path?: string;
  commit?: Commit;
  separate?: boolean;
};
type Commit = { head: string | null; latestCommitAt: string | null };
type Lease = { selected: string; visible: string[]; openedAt: number; selectorSequence: number; expires: number; sequence: number };
type Demand = { selected: Set<string>; visible: Set<string>; openedAt: number };

const unknown: WorkspaceActivitySummary = {
  latestCommitAt: null, latestCommitObservedAt: null, latestCommitState: 'unknown',
};
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const time = (value?: string | null) => Date.parse(value || '') || 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const repositoryPaths = (workspace: Json) => [...new Set<string>((workspace.repositories || []).flatMap((repo: Json) => {
  const path = repo.worktreePath || repo.sourcePath;
  return typeof path === 'string' && path ? [resolve(path)] : [];
}))].sort();
const belongsTo = (path: string, root: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};

/** HEAD checks have their own bounded queue and publish results per Workspace. */
export class WorkspaceActivityIndex {
  onHeadChange?: (workspaceId: string) => void;
  readonly generation = randomUUID();
  private config: Config;
  private clock: () => number;
  private writer: DerivedJsonWriter;
  private repositories = new Map<string, RepositoryActivity>();
  private targets = new Map<string, Target>();
  private workspaces = new Map<string, Workspace>();
  private used = new Map<string, number>();
  private leases = new Map<string, Lease>();
  private scans = new Map<string, Scan>();
  private latestFull?: Scan;
  private cancelled = new Set<string>();
  private jobs = new Map<string, Job>();
  private running = new Set<Promise<void>>();
  private commits = new Map<string, Commit & { serial: number }>();
  private rosterSignature = '';
  private revision = 0;
  private rosterRevision = 0;
  private serial = 0;
  private warming = false;
  private closed = false;
  private headRunning = 0;
  private gitRunning = 0;
  private timer?: ReturnType<typeof setInterval>;
  private refill?: ReturnType<typeof setTimeout>;
  private collect?: ReturnType<typeof setTimeout>;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private counters = { started: 0, headChecks: 0, gitCommands: 0, reused: 0, failures: 0, maxHeadRunning: 0, maxGitRunning: 0 };
  private priorityStreak = 0;

  constructor(config: Config, clock = Date.now) {
    this.config = config;
    this.clock = clock;
    const path = join(config.stateRoot, 'workspace-activity.json');
    this.writer = new DerivedJsonWriter(path);
    try {
      const saved = optionalJson(path);
      if (saved.version !== 1 || !saved.repositories || typeof saved.repositories !== 'object') return;
      for (const [key, raw] of Object.entries(saved.repositories as Record<string, Json>).slice(-MAX_ENTRIES)) {
        if (!raw || typeof raw !== 'object' || !('latestCommitAt' in raw)) continue;
        this.repositories.set(key, {
          owners: raw.owners && typeof raw.owners === 'object' && !Array.isArray(raw.owners) ? raw.owners : undefined,
          head: typeof raw.head === 'string' && activityObjectId.test(raw.head) ? raw.head : null,
          latestCommitAt: date(raw.latestCommitAt),
          checkedAt: date(raw.checkedAt),
          attemptedAt: date(raw.attemptedAt) || undefined,
          ...(typeof raw.headToken === 'string' ? { headToken: raw.headToken } : {}),
          ...(typeof raw.error === 'string' ? { error: raw.error, failures: Math.min(RETRY_MS.length, Math.max(1, Number(raw.failures) || 1)) } : {}),
        });
      }
      if (saved.used && typeof saved.used === 'object') for (const [key, value] of Object.entries(saved.used)) {
        if (typeof value === 'number' && Number.isFinite(value)) this.used.set(key, value);
        if (this.used.size >= MAX_ENTRIES) break;
      }
    } catch { /* An unavailable derived index can be rebuilt. */ }
  }

  reconcileWorkspaces(workspaces: Json[]) {
    if (this.closed || workspaces.some(row => !row.id || row.state === 'record_invalid')) return;
    const rows = workspaces.filter(row => row.state !== 'removed').map(row => {
      const instanceKey = workspaceInstanceKey(row as Json & { id: string });
      const paths = repositoryPaths(row);
      const tree = resolve(row.treePath || this.config.sourceRoot);
      const managed = row.id !== 'main' && row.managed !== false && Boolean(row.treePath);
      return { id: String(row.id), instanceKey, paths, tree, managed, scope: hash(stable([instanceKey, paths, tree, managed])) };
    });
    const signature = stable(rows.map(row => [row.id, row.scope]).sort(([a], [b]) => a.localeCompare(b)));
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;
    this.rosterRevision = ++this.revision;

    const proposed = new Map<string, { path: string; owners: Record<string, string>; scopes: string[] }>();
    for (const row of rows) for (const path of row.paths) {
      const key = hash(path);
      const target = proposed.get(key) || { path, owners: Object.create(null), scopes: [] as string[] };
      target.owners[row.id] = row.instanceKey;
      target.scopes.push(row.scope);
      proposed.set(key, target);
    }
    const targets = new Map<string, Target>();
    let retainedChanged = false;
    for (const [key, target] of proposed) {
      const previous = this.targets.get(key);
      const signature = stable([target.owners, target.scopes.sort()]);
      const next = previous?.signature === signature
        ? previous
        : { key, path: target.path, owners: target.owners, signature, changed: false, version: 0 };
      const saved = this.repositories.get(key);
      if (saved && previous !== next) {
        const common = Object.keys(next.owners).filter(id => saved.owners?.[id] === next.owners[id]);
        const replaced = Object.keys(next.owners).some(id => saved.owners?.[id] && saved.owners[id] !== next.owners[id]);
        if (common.length === 0 || replaced) {
          this.repositories.delete(key); retainedChanged = true;
        } else {
          if (stable(saved.owners) !== stable(next.owners)) {
            this.repositories.set(key, { ...saved, owners: next.owners });
            retainedChanged = true;
          }
          // Persisted checks remain due by their own timestamps on startup.
          next.changed = Boolean(previous?.changed);
        }
      }
      targets.set(key, next);
    }
    for (const key of this.repositories.keys()) if (!targets.has(key)) {
      this.repositories.delete(key); retainedChanged = true;
    }
    this.targets = targets;
    for (const job of this.jobs.values()) if (targets.get(job.target.key) !== job.target) this.abort(job);
    for (const scan of new Set(this.scans.values())) {
      if (scan.state !== 'running') continue;
      for (const [key, target] of scan.pending) if (targets.get(key) !== target) this.completeTarget(scan, key, false);
    }

    const old = this.workspaces;
    const next = new Map<string, Workspace>();
    for (const row of rows) {
      const previous = old.get(row.id);
      const keys = row.paths.map(hash);
      const workspace: Workspace = previous?.scope === row.scope ? previous : {
        ...row, keys, summary: { ...unknown, workspaceId: row.id, instanceKey: row.instanceKey, activityScope: row.scope, revision: 0 },
      };
      if (workspace.pending) for (const key of workspace.pending) {
        if (!targets.has(key) || !targets.get(key)?.owners[row.id]) workspace.pending.delete(key);
      }
      next.set(row.id, workspace);
      if (!workspace.pending?.size) this.publish(workspace);
    }
    this.workspaces = next;
    const live = new Set(rows.map(row => row.instanceKey));
    for (const key of this.used.keys()) if (!live.has(key)) { this.used.delete(key); retainedChanged = true; }
    if (retainedChanged) this.persistSoon();
  }

  warm() {
    if (this.closed) return;
    this.warming = true;
    this.arm();
  }

  summary(workspace: Json): WorkspaceActivitySummary & { activityScope?: string } {
    const row = this.workspaces.get(workspace.id);
    if (!row || row.instanceKey !== workspaceInstanceKey(workspace as Json & { id: string }) || workspace.state === 'removed') return unknown;
    // Roster reads can overlap a repository addition or a linked tree update.
    // Never stamp an older roster row with the scope of the new target list.
    const paths = repositoryPaths(workspace);
    if (row.tree !== resolve(workspace.treePath || this.config.sourceRoot) ||
      paths.length !== row.paths.length || paths.some((path, index) => path !== row.paths[index])) return unknown;
    const { latestCommitAt, latestCommitObservedAt, latestCommitState } = row.summary;
    return { latestCommitAt, latestCommitObservedAt, latestCommitState, activityScope: row.scope };
  }

  cursor() { return { generation: this.generation, revision: this.revision }; }

  view(params: Json): WorkspaceActivityView {
    const id = params.viewId, sequence = params.sequence;
    if (!identity(id) || !Number.isSafeInteger(sequence) || sequence < 0) throw new WorkbenchError('activity_view_invalid', 'Invalid Workspace activity view');
    const at = this.clock();
    this.demand(at); // Drop expired leases before accepting another panel.
    const previous = this.leases.get(id);
    if (!this.closed && (!params.cursor || params.cursor.generation === this.generation) && (!previous || sequence > previous.sequence)) {
      const selected = this.workspaces.has(params.selectedWorkspaceId) ? String(params.selectedWorkspaceId) : '';
      const visible = Array.isArray(params.visibleWorkspaceIds)
        ? [...new Set<string>(params.visibleWorkspaceIds.slice(0, WORKSPACE_ACTIVITY_VISIBLE_LIMIT).filter((value: unknown): value is string => identity(value) && this.workspaces.has(value)))]
        : [];
      const selectorSequence = Number.isSafeInteger(params.selectorSequence) && params.selectorSequence >= 0 ? params.selectorSequence : 0;
      const openedAt = params.selectorOpen === true
        ? previous?.openedAt && previous.selectorSequence === selectorSequence ? previous.openedAt : at
        : 0;
      this.leases.set(id, { selected, visible, openedAt, selectorSequence, expires: at + WORKSPACE_ACTIVITY_LEASE_MS, sequence });
      while (this.leases.size > 128) this.leases.delete(this.leases.keys().next().value!);
      if (selected && selected !== previous?.selected) {
        this.used.set(this.workspaces.get(selected)!.instanceKey, at);
        this.persistSoon();
      }
    }
    const since = params.cursor?.revision;
    const reset = params.cursor?.generation !== this.generation || !Number.isSafeInteger(since) || since < this.rosterRevision || since > this.revision;
    const updates: WorkspaceActivityUpdate[] = [];
    if (reset || since < this.revision) for (const row of this.workspaces.values()) {
      if (reset || row.summary.revision > since) updates.push(row.summary);
    }
    return { ...this.cursor(), reset, updates, fullScan: this.latestFull ? this.scanStatus(this.latestFull) : null };
  }

  /** The existing watcher reports actual metadata paths, including shared refs. */
  refsChanged(files: string[], watchedRepositories: string[]) {
    const paths = new Set(files);
    const watched = new Set(watchedRepositories);
    for (const target of this.targets.values()) {
      const match = target.files
        ? target.files.some(file => paths.has(file))
        : watched.has(target.actualPath || target.path);
      if (!match) continue;
      target.changed = true;
      target.version++;
    }
  }

  private demand(at: number): Demand {
    const selected = new Set<string>(), visible = new Set<string>();
    let openedAt = 0;
    for (const [id, lease] of this.leases) {
      if (lease.expires <= at) { this.leases.delete(id); continue; }
      if (lease.selected) selected.add(lease.selected);
      for (const id of lease.visible) visible.add(id);
      openedAt = Math.max(openedAt, lease.openedAt);
    }
    return { selected, visible, openedAt };
  }
  private due(target: Target, at: number, demand: Demand) {
    const previous = this.repositories.get(target.key);
    if (previous?.error && at < time(previous.attemptedAt) + RETRY_MS[Math.min(RETRY_MS.length, previous.failures || 1) - 1]) return false;
    if (target.changed || !previous?.checkedAt || previous.error) return true;
    // Cold rows can be offscreen precisely because their commit date is stale.
    // Each opening verifies older HEADs once, without promoting every heartbeat
    // or forcing Git reads when the metadata is unchanged.
    if (demand.openedAt - time(previous.checkedAt) >= SELECTOR_RECHECK_MS) return true;
    let interval = 30 * MINUTE;
    for (const id of Object.keys(target.owners)) {
      const owner = this.workspaces.get(id);
      const last = Math.max(time(owner?.summary.latestCommitAt), this.used.get(target.owners[id]) || 0);
      if (demand.selected.has(id)) interval = Math.min(interval, 15_000);
      else if (demand.visible.has(id)) interval = Math.min(interval, 30_000);
      else if (last && at - last < DAY) interval = Math.min(interval, 2 * MINUTE);
      else if (last && at - last < 7 * DAY) interval = Math.min(interval, 10 * MINUTE);
    }
    return at - time(previous.checkedAt) >= interval;
  }

  /** Older clients can still supply Workspace IDs and poll the returned task. */
  start(scanId: string, workspaces?: Json[], force = false): WorkspaceActivityScan {
    if (!identity(scanId) || scanId.length > 128) throw new WorkbenchError('scan_id_invalid', 'Invalid Workspace activity scan');
    if (this.closed || this.cancelled.has(scanId)) return { scanId, state: 'cancelled', total: 0, completed: 0, errors: 0 };
    const existing = this.scans.get(scanId);
    if (existing) return this.scanStatus(existing, scanId);
    if (!this.rosterSignature && workspaces) this.reconcileWorkspaces(workspaces);
    return this.startForIds(scanId, workspaces?.map(row => String(row.id)), force);
  }

  startForIds(scanId: string, ids: string[] | undefined, force: boolean): WorkspaceActivityScan {
    if (!identity(scanId) || scanId.length > 128) throw new WorkbenchError('scan_id_invalid', 'Invalid Workspace activity scan');
    if (this.closed || this.cancelled.has(scanId)) return { scanId, state: 'cancelled', total: 0, completed: 0, errors: 0 };
    const existing = this.scans.get(scanId);
    if (existing) return this.scanStatus(existing, scanId);
    const workspaceIds = [...new Set(ids ?? this.workspaces.keys())].filter(id => this.workspaces.has(id)).sort();
    const scope = stable([ids === undefined ? 'project' : workspaceIds, force]);
    const active = [...new Set(this.scans.values())].find(scan => scan.state === 'running' && scan.scope === scope);
    if (active) {
      this.rememberScan(scanId, active);
      return this.scanStatus(active, scanId);
    }
    const at = this.clock(), demand = this.demand(at);
    const pending = new Map<string, Target>();
    for (const id of workspaceIds) for (const key of this.workspaces.get(id)!.keys) {
      const target = this.targets.get(key)!;
      if (force || this.jobs.has(key) || this.due(target, at, demand)) pending.set(key, target);
    }
    if ([...new Set(this.scans.values())].filter(scan => scan.state === 'running').length >= 8) {
      throw new WorkbenchError('observer_busy', 'Workspace activity queue is full');
    }
    const scan: Scan = {
      scanId, state: pending.size ? 'running' : 'complete', workspaceIds, pending,
      total: pending.size, completed: 0, errors: 0, force, scope, serial: ++this.serial,
    };
    this.rememberScan(scanId, scan);
    if (force && ids === undefined) this.latestFull = scan;
    if (pending.size) this.arm();
    return this.scanStatus(scan);
  }

  private rememberScan(id: string, scan: Scan) {
    this.scans.set(id, scan);
    for (const [key, value] of this.scans) {
      if (this.scans.size <= 128) break;
      if (key !== id && (key !== value.scanId || value.state !== 'running')) this.scans.delete(key);
    }
  }
  private scanStatus(scan: Scan, scanId = scan.scanId) {
    return { scanId, state: scan.state, total: scan.total, completed: scan.completed, errors: scan.errors, workspaceIds: scan.workspaceIds };
  }
  status(scanId: string): WorkspaceActivityScan {
    const scan = this.scans.get(scanId);
    return scan ? this.scanStatus(scan, scanId)
      : { scanId, state: this.cancelled.has(scanId) ? 'cancelled' : 'unknown', total: 0, completed: 0, errors: 0 };
  }
  cancel(scanId: string): WorkspaceActivityScan {
    if (identity(scanId) && scanId.length <= 128) {
      this.cancelled.add(scanId);
      if (this.cancelled.size > 128) this.cancelled.delete(this.cancelled.values().next().value!);
    }
    const scan = this.scans.get(scanId);
    if (scan?.state === 'running') {
      scan.state = 'cancelled';
      scan.pending.clear();
      const scans = this.activeScans();
      for (const job of this.jobs.values()) if (!job.automatic && !scans.some(other => other.pending.has(job.target.key))) this.abort(job);
      this.settleRows();
    }
    return this.status(scanId);
  }
  private completeTarget(scan: Scan, key: string, failed: boolean) {
    if (!scan.pending.delete(key)) return;
    scan.completed++;
    if (failed) scan.errors++;
    if (!scan.pending.size) scan.state = 'complete';
  }
  private activeScans() {
    return [...new Set(this.scans.values())].filter(scan => scan.state === 'running');
  }

  private arm() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }
  private refillSoon() {
    if (this.closed || this.refill || this.jobs.size >= MAX_PIPELINE) return;
    // Yield to requests and coalesce completions, then fill available slots.
    // The interval discovers newly due work; it must not throttle an existing
    // backlog to eight cheap HEAD checks every 250 ms.
    this.refill = setTimeout(() => { this.refill = undefined; this.tick(); }, 0);
    this.refill.unref();
  }
  private tick() {
    const scans = this.activeScans();
    if (!this.warming && !scans.length && !this.jobs.size) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    const at = this.clock(), demand = this.demand(at);
    const candidates = new Map<string, { target: Target; force: boolean; automatic: boolean; rank: number; last: number }>();
    for (const target of this.targets.values()) {
      if (this.jobs.has(target.key)) continue;
      const tasks = scans.filter(scan => scan.pending.has(target.key));
      const automatic = this.warming && this.due(target, at, demand);
      if (!automatic && !tasks.length) continue;
      const ids = Object.keys(target.owners);
      const cached = this.repositories.get(target.key);
      const rank = target.changed ? 0
        : ids.some(id => demand.selected.has(id)) ? 1
        : ids.some(id => demand.visible.has(id)) ? 2
        : !cached?.checkedAt && !cached?.error ? 3 : 4;
      candidates.set(target.key, { target, automatic, force: tasks.some(scan => scan.force), rank, last: time(cached?.attemptedAt || cached?.checkedAt) });
    }
    const ordered = [...candidates.values()].sort((a, b) => a.rank - b.rank || a.last - b.last || a.target.key.localeCompare(b.target.key));
    const slots = Math.min(MAX_STARTS, MAX_PIPELINE - this.jobs.size);
    for (let i = 0; i < slots && ordered.length; i++) {
      const ordinary = this.priorityStreak >= 7 ? ordered.findIndex(item => item.rank === 4 && item.automatic) : -1;
      const [{ target, automatic, force, rank }] = ordered.splice(Math.max(0, ordinary), 1);
      this.priorityStreak = rank === 4 ? 0 : Math.min(7, this.priorityStreak + 1);
      for (const id of Object.keys(target.owners)) {
        const row = this.workspaces.get(id)!;
        row.pending ??= new Set(row.keys.filter(key => candidates.has(key) || this.jobs.has(key)));
        row.pending.add(target.key);
      }
      this.jobs.set(target.key, { target, version: target.version, force, automatic, serial: this.serial, stage: 'queued', controller: new AbortController() });
      this.counters.started++;
    }
    this.drainHeads();
    this.settleRows();
  }

  private track(promise: Promise<void>) {
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise)).catch(() => {});
  }
  private valid(job: Job) {
    return !this.closed && !job.controller.signal.aborted && this.targets.get(job.target.key) === job.target && job.version === job.target.version;
  }
  private abort(job: Job) {
    job.controller.abort();
    if (job.stage === 'queued' || job.stage === 'git' || job.stage === 'confirm') this.jobs.delete(job.target.key);
  }
  private async validatedPath(target: Target) {
    const path = await realpath(target.path);
    for (const id of Object.keys(target.owners)) {
      const row = this.workspaces.get(id);
      if (!row || row.instanceKey !== target.owners[id]) throw new Error('Workspace changed');
      const root = row.managed ? this.config.treesRoot : this.config.sourceRoot;
      const tree = row.tree === root ? root : await realpath(row.tree);
      if (!belongsTo(tree, root) || !belongsTo(path, tree)) throw new Error('Repository is outside its Workspace');
    }
    return path;
  }
  private drainHeads() {
    if (this.closed) return;
    for (const job of this.jobs.values()) {
      if (this.headRunning >= MAX_HEAD_READS) break;
      if (job.stage !== 'queued' && job.stage !== 'confirm') continue;
      if (!this.valid(job)) { this.finish(job); continue; }
      const confirming = job.stage === 'confirm';
      job.stage = confirming ? 'confirming' : 'probing';
      this.headRunning++;
      this.counters.maxHeadRunning = Math.max(this.counters.maxHeadRunning, this.headRunning);
      this.track(this.probe(job, confirming).finally(() => {
        this.headRunning--;
        this.drainHeads();
        this.armGit();
      }));
    }
  }
  private async probe(job: Job, confirming: boolean) {
    try {
      const path = await this.validatedPath(job.target);
      if (!this.valid(job)) { this.finish(job); return; }
      this.counters.headChecks++;
      const head = await readActivityHead(path, job.controller.signal);
      if (!this.valid(job)) { this.finish(job); return; }
      const target = job.target;
      target.actualPath = path;
      target.files = head.files;
      if (confirming) {
        if (job.path !== path || job.head?.token !== head.token || (head.head && job.commit?.head !== head.head)) {
          target.changed = true;
          this.finish(job);
        } else this.finish(job, job.commit);
        return;
      }
      job.head = head;
      job.path = path;
      const previous = this.repositories.get(target.key);
      if (!job.force && previous?.checkedAt && !previous.error
        && (head.token === previous.headToken || head.head && head.head === previous.head)) {
        this.counters.reused++;
        this.finish(job, previous);
      } else if (head.unborn) {
        this.finish(job, { head: null, latestCommitAt: null });
      } else {
        const cached = this.commitKey(job), known = cached ? this.commits.get(cached) : undefined;
        if (known && (!job.force || known.serial >= job.serial)) {
          this.counters.reused++;
          this.finish(job, known);
        } else job.stage = 'git';
      }
    } catch (error) { this.finish(job, undefined, error); }
  }

  private commitKey(job: Job) {
    return job.head?.batchable && job.head.head ? job.head.commonDir + '\0' + job.head.head : '';
  }
  private armGit() {
    if (this.closed || this.collect || this.gitRunning >= MAX_GIT_READS || ![...this.jobs.values()].some(job => job.stage === 'git')) return;
    // Collect related loose refs without waiting on an unrelated filesystem read.
    this.collect = setTimeout(() => { this.collect = undefined; this.drainGit(); }, 12);
    this.collect.unref();
  }
  private drainGit() {
    while (!this.closed && this.gitRunning < MAX_GIT_READS) {
      const candidates = [...this.jobs.values()].filter(job => job.stage === 'git');
      for (const job of candidates) if (!this.valid(job)) this.finish(job);
      const first = candidates.find(job => this.valid(job));
      if (!first) break;
      const jobs = this.commitKey(first) && !first.separate
        ? candidates.filter(job => this.valid(job) && !job.separate && job.head?.commonDir === first.head!.commonDir && this.commitKey(job)).slice(0, MAX_STARTS)
        : [first];
      for (const job of jobs) job.stage = 'reading';
      this.gitRunning++;
      this.counters.maxGitRunning = Math.max(this.counters.maxGitRunning, this.gitRunning);
      this.track(this.readCommits(jobs).finally(() => {
        this.gitRunning--;
        this.drainHeads();
        this.armGit();
      }));
    }
  }

  private async readCommits(jobs: Job[]) {
    const first = jobs[0];
    const controller = new AbortController();
    const abortIfUnused = () => {
      if (jobs.every(job => job.controller.signal.aborted)) controller.abort();
    };
    for (const job of jobs) job.controller.signal.addEventListener('abort', abortIfUnused, { once: true });
    const timeout = Math.min(this.config.gitTimeout, this.config.foregroundGitTimeout || this.config.gitTimeout);
    const git = new Git(first.path!, timeout, Date.now() + timeout, controller.signal, true);
    const grouped = jobs.length > 1;
    try {
      if (grouped) {
        const oids = [...new Set(jobs.map(job => job.head!.head!))];
        this.counters.gitCommands++;
        const result = await withBackgroundGit(() => git.run(['log', '--no-walk=unsorted', '--no-show-signature', '--no-notes', '--no-decorate', '-z', '--format=%H%x00%cI', ...oids, '--'], false, { maxBytes: 16_384 }));
        const commits = new Map<string, Commit>();
        if (result.code === 0) {
          const fields = result.stdout.split('\0');
          for (let index = 0; index + 1 < fields.length; index += 2) {
            const head = fields[index], latestCommitAt = date(fields[index + 1]);
            if (activityObjectId.test(head) && latestCommitAt) commits.set(head, { head, latestCommitAt });
          }
        }
        for (const job of jobs) {
          const commit = commits.get(job.head!.head!);
          if (!this.valid(job)) this.finish(job);
          else if (!commit) { job.separate = true; job.stage = 'git'; }
          else { job.commit = commit; job.stage = 'confirm'; }
        }
      } else {
        this.counters.gitCommands++;
        const result = await withBackgroundGit(() => git.run(['show', '-s', '--no-show-signature', '--no-notes', '--no-decorate', '--format=%H%x00%cI', 'HEAD', '--'], false, { maxBytes: 16_384 }));
        const [head, value] = result.stdout.trim().split('\0');
        const latestCommitAt = date(value);
        if (result.code !== 0 || !activityObjectId.test(head) || !latestCommitAt) throw new Error(result.stderr.trim() || 'Commit unavailable');
        if (this.valid(first)) {
          first.commit = { head, latestCommitAt };
          first.stage = 'confirm';
        } else this.finish(first);
      }
    } catch (error) {
      for (const job of jobs) this.finish(job, undefined, error);
    } finally {
      for (const job of jobs) job.controller.signal.removeEventListener('abort', abortIfUnused);
    }
  }

  private finish(job: Job, commit?: Commit, error?: unknown) {
    const target = job.target, key = target.key;
    if (this.jobs.get(key) !== job) return;
    this.jobs.delete(key);
    this.refillSoon();
    if (!this.valid(job) || !commit && error === undefined) return;
    const previous = this.repositories.get(key);
    const now = new Date(this.clock()).toISOString();
    target.changed = false;
    if (commit) {
      this.repositories.set(key, { head: commit.head, latestCommitAt: commit.latestCommitAt, owners: target.owners, checkedAt: now, attemptedAt: now, headToken: job.head?.token });
      const cacheKey = this.commitKey(job);
      if (cacheKey) {
        this.commits.delete(cacheKey);
        this.commits.set(cacheKey, { ...commit, serial: job.serial });
        while (this.commits.size > MAX_ENTRIES) this.commits.delete(this.commits.keys().next().value!);
      }
      if (previous?.checkedAt && previous.head !== commit.head)
        for (const id of Object.keys(target.owners)) this.onHeadChange?.(id);
    } else {
      this.counters.failures++;
      this.repositories.set(key, {
        owners: target.owners, head: previous?.head ?? null, latestCommitAt: previous?.latestCommitAt ?? null,
        checkedAt: previous?.checkedAt ?? null, attemptedAt: now, headToken: previous?.headToken,
        failures: Math.min(RETRY_MS.length, (previous?.failures || 0) + 1),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
    for (const scan of this.activeScans()) if (!scan.force || job.force && job.serial >= scan.serial) this.completeTarget(scan, key, Boolean(error));
    for (const id of Object.keys(target.owners)) {
      const row = this.workspaces.get(id);
      if (!row) continue;
      row.pending?.delete(key);
      if (!row.pending?.size) this.publish(row);
    }
    this.persistSoon();
  }

  private settleRows() {
    const scans = this.activeScans();
    const at = this.clock(), demand = this.demand(at);
    for (const row of this.workspaces.values()) if (row.pending) {
      for (const key of row.pending) {
        const target = this.targets.get(key);
        if (!this.jobs.has(key) && !scans.some(scan => scan.pending.has(key)) && (!target || !this.warming || !this.due(target, at, demand)))
          row.pending.delete(key);
      }
      if (!row.pending.size) this.publish(row);
    }
  }
  private publish(row: Workspace) {
    row.pending = undefined;
    let latestCommitAt: string | null = null, latestCommitObservedAt: string | null = null;
    let failed = false, checked = 0;
    for (const key of row.keys) {
      const entry = this.repositories.get(key);
      if (!entry) continue;
      failed ||= Boolean(entry.error);
      if (entry.checkedAt) {
        checked++;
        if (!latestCommitObservedAt || time(entry.checkedAt) < time(latestCommitObservedAt)) latestCommitObservedAt = entry.checkedAt;
      }
      if (entry.latestCommitAt && (!latestCommitAt || time(entry.latestCommitAt) > time(latestCommitAt))) latestCommitAt = entry.latestCommitAt;
    }
    const latestCommitState = failed ? 'partial' : latestCommitAt ? checked === row.keys.length ? 'ready' : 'partial' : 'unknown';
    if (row.summary.revision && row.summary.latestCommitAt === latestCommitAt
      && row.summary.latestCommitObservedAt === latestCommitObservedAt && row.summary.latestCommitState === latestCommitState) return;
    row.summary = { ...row.summary, latestCommitAt, latestCommitObservedAt, latestCommitState, revision: ++this.revision };
  }

  health() {
    return { ...this.cursor(), targets: this.targets.size, jobs: this.jobs.size, headRunning: this.headRunning, gitRunning: this.gitRunning,
      fullScan: this.latestFull ? this.scanStatus(this.latestFull) : null, ...this.counters };
  }
  private persistSoon() {
    if (this.closed || this.writeTimer) return;
    this.writeTimer = setTimeout(() => { this.writeTimer = undefined; this.persist(); }, 500);
    this.writeTimer.unref();
  }
  private persist() {
    while (this.repositories.size > MAX_ENTRIES) this.repositories.delete(this.repositories.keys().next().value!);
    this.writer.save({ version: 1, repositories: Object.fromEntries(this.repositories), used: Object.fromEntries(this.used) });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.refill);
    clearTimeout(this.collect);
    clearTimeout(this.writeTimer);
    for (const scan of this.activeScans()) this.cancel(scan.scanId);
    for (const job of this.jobs.values()) this.abort(job);
    await Promise.allSettled([...this.running]);
    this.persist();
    await this.writer.flush();
  }
}
