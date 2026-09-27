import { OBSERVATION_POLICY as policy } from '../shared/observation-policy.ts';
import type { ObserverResponse } from '../shared/observer.ts';
import { shouldRefreshVersionedQuery, versionDelta, type Versions } from './version-invalidation.ts';

export type ObservationMeta = {
  state?: string; validationKey?: string; validationToken?: string;
  validationDependencies?: Record<string, string>; immutableIdentity?: string;
  refreshing?: boolean; cacheState?: string; validatedAt?: string; observedAt?: string;
};
export function observationMeta(data?: ObserverResponse): ObservationMeta {
  return (data?.result as { observation?: ObservationMeta } | undefined)?.observation || {};
}
export function dependencies(meta: ObservationMeta): Record<string, string> {
  return meta.validationDependencies || (meta.validationKey && meta.validationToken !== undefined ? { [meta.validationKey]: meta.validationToken } : {});
}
export function validation(data: ObserverResponse | undefined, versions: Versions | null): 'same' | 'changed' | 'unknown' {
  const meta = observationMeta(data);
  if (data?.ok && meta.immutableIdentity) return 'same';
  const entries = Object.entries(dependencies(meta));
  if (!entries.length || !versions?.tokens) return 'unknown';
  if (entries.some(([key, token]) => versions.tokens?.[key] !== undefined && versions.tokens[key] !== token)) return 'changed';
  return entries.every(([key]) => versions.tokens?.[key] !== undefined) ? 'same' : 'unknown';
}
export type QueryView = {
  id: string; key: readonly unknown[]; eventOnly?: boolean; validationWindowMs?: number; active: boolean; fetching: boolean;
  data?: ObserverResponse; error?: unknown; updatedAt: number;
  fetch(): Promise<unknown>; validate(at: string): void;
};
export type CoordinatorHost = {
  queries(): QueryView[];
  read(ids: string[]): Promise<ObserverResponse>;
  issue(value: string | null): void;
};
export type Clock = { now(): number; set(fn: () => void, ms: number): unknown; clear(timer: unknown): void };
const clock: Clock = { now: Date.now, set: (fn, ms) => setTimeout(fn, ms), clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) };
type Task = { due: number; reason: string };
type Entry = { active: boolean; lastUsed: number; seen?: ObserverResponse; seenError?: unknown; failures: number; followToken: string; follows: number; lastAttempt: number; task?: Task; running: boolean; pending?: Task; waiters: Set<() => void> };
const durable = new Set(['path_invalid', 'file_not_changed', 'worktree_missing', 'repository_missing', 'commit_missing', 'base_missing', 'workspace_not_found']);

/** Owns refresh decisions, not payloads. QueryClient remains the single data cache. */
export class ObservationCoordinator {
  private entries = new Map<string, Entry>();
  private versions: Versions | null = null;
  private subscriptions = new Map<object, { ids: string[]; versions: boolean }>();
  private timer: unknown;
  private pollAt = Infinity;
  private pollRunning = false;
  private validatedAt = -Infinity;
  private validatedIds = new Set<string>();
  private failures = 0;
  private failureSince: number | null = null;
  private hostFailures = 0;
  private hostFailureSince: number | null = null;
  private generation = 0;
  private scanning = false;
  private closed = false;
  readonly counters = { cacheHits: 0, versionReads: 0, businessReads: 0, merged: 0, reasons: {} as Record<string, number> };
  readonly project: string;
  private host: CoordinatorHost;
  private time: Clock;
  constructor(project: string, host: CoordinatorHost, time: Clock = clock) { this.project = project; this.host = host; this.time = time; }
  subscribe(ids: string[], versions = true): () => void {
    const resuming = this.subscriptions.size === 0;
    const key = {};
    this.subscriptions.set(key, { ids, versions });
    if (versions && (resuming || this.time.now() - this.validatedAt >= policy.pollMs || ids.some(id => !this.validatedIds.has(id)))) this.pollAt = this.time.now();
    this.changed();
    return () => {
      this.subscriptions.delete(key);
      if (!this.subscriptions.size) {
        this.generation++; this.pollAt = Infinity;
        for (const entry of this.entries.values()) { entry.active = false; entry.task = undefined; entry.pending = undefined; for (const done of entry.waiters) done(); entry.waiters.clear(); }
        this.host.issue(null);
      }
      this.arm();
    };
  }
  private get enabled() { return this.subscriptions.size > 0 && !this.closed; }
  private get warningWindow() {
    const windows = this.host.queries().filter(q => q.active && !q.eventOnly).map(q => q.validationWindowMs || policy.warningMs);
    return windows.length ? Math.min(...windows) : policy.warningMs;
  }
  private get versioned() { return [...this.subscriptions.values()].some(s => s.versions); }
  changed(): void {
    if (!this.enabled || this.scanning) return;
    this.scanning = true;
    try {
      const now = this.time.now(), present = new Set<string>();
      for (const q of this.host.queries()) {
        present.add(q.id);
        let e = this.entries.get(q.id);
        if (!e) { e = { active: false, lastUsed: now, failures: 0, followToken: '', follows: 0, lastAttempt: 0, running: false, waiters: new Set() }; this.entries.set(q.id, e); }
        const activated = q.active && !e.active;
        e.active = q.active;
        if (!q.active) { e.task = undefined; e.pending = undefined; for (const done of e.waiters) done(); e.waiters.clear(); continue; }
        e.lastUsed = now;
        const meta = observationMeta(q.data);
        const newResult = e.seen !== q.data || e.seenError !== q.error;
        if (newResult) {
          e.seen = q.data; e.seenError = q.error;
          if (q.error || q.data?.ok === false || q.data?.ok && meta.state && meta.state !== 'ready') {
            e.failures++;
            if (!durable.has(q.data?.error?.code || '')) this.enqueue(e, policy.retryMs[Math.min(e.failures - 1, 3)], 'retry');
          } else if (q.data?.ok) {
            e.failures = 0;
            if (!meta.refreshing && meta.cacheState !== 'refreshing') {
              if (e.task?.reason === 'follow-up' || e.task?.reason === 'retry') e.task = undefined;
            }
          }
        }
        const refreshing = meta.refreshing || meta.cacheState === 'refreshing';
        if (refreshing) {
          const token = JSON.stringify([dependencies(meta), (q.data?.result as any)?.cache?.updatedAt || meta.observedAt]);
          if (e.followToken !== token) { e.followToken = token; e.follows = 0; }
          if (e.follows < policy.followUpMs.length && !q.fetching && !e.running && !e.task) this.enqueue(e, policy.followUpMs[e.follows], 'follow-up');
        }
        if (activated && q.data?.ok && !q.eventOnly) {
          const state = validation(q.data, this.versions);
          if (state === 'same') this.counters.cacheHits++;
          if (state === 'changed') this.enqueue(e, 0, 'activation-change');
          if (state === 'unknown' && (!this.versioned || !Object.keys(dependencies(meta)).length) && now - Math.max(q.updatedAt, e.lastAttempt) >= policy.legacyReadMs) this.enqueue(e, 0, 'legacy-activation');
          if (this.versioned && !meta.immutableIdentity && (now - this.validatedAt >= policy.pollMs || state === 'unknown' && Object.keys(dependencies(meta)).length > 0)) this.pollAt = Math.min(this.pollAt, now);
        }
        if (activated && !q.eventOnly && (q.error || q.data?.ok === false) && !durable.has(q.data?.error?.code || '') && !e.task)
          this.enqueue(e, 0, 'retry');
        if (activated && !q.eventOnly && !q.data && !q.fetching && !q.error) this.enqueue(e, 0, 'initial');
      }
      for (const [id, entry] of this.entries) if (!present.has(id) || !entry.active && now - entry.lastUsed >= policy.retentionMs) { for (const done of entry.waiters) done(); this.entries.delete(id); }
    } finally { this.scanning = false; }
    this.arm();
  }
  /** Used after a known mutation or explicit refresh; running reads are never cancelled/restarted. */
  refresh(matches: (q: QueryView) => boolean = () => true): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.changed();
    const waits: Promise<void>[] = [];
    for (const q of this.host.queries()) if (q.active && matches(q)) {
      const entry = this.entries.get(q.id);
      if (entry) {
        waits.push(new Promise<void>(resolve => entry.waiters.add(resolve)));
        this.enqueue(entry, 0, 'manual');
      }
    }
    if (this.versioned) this.pollAt = this.time.now();
    this.arm();
    return Promise.all(waits).then(() => undefined);
  }
  private enqueue(e: Entry, delay: number, reason: string) {
    if (reason !== 'manual' && e.failures) delay = Math.max(delay, e.lastAttempt + policy.retryMs[Math.min(e.failures - 1, 3)] - this.time.now());
    if (e.running) {
      const pending = { due: this.time.now() + delay, reason };
      if (!e.pending || pending.due < e.pending.due || reason === 'manual') e.pending = pending;
      this.counters.merged++; return;
    }
    if (e.task) {
      this.counters.merged++;
      if (reason === 'manual') { e.task = { due: Math.min(e.task.due, this.time.now() + delay), reason }; return; }
      if (e.task.due <= this.time.now() + delay) return;
    }
    e.task = { due: this.time.now() + delay, reason };
  }
  private arm() {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    if (!this.enabled) return;
    const due = Math.min(this.versioned && !this.pollRunning ? this.pollAt : Infinity, ...[...this.entries.values()].map(e => e.active && !e.running ? e.task?.due ?? Infinity : Infinity));
    if (Number.isFinite(due)) this.timer = this.time.set(() => { this.timer = undefined; this.tick(); }, Math.max(0, due - this.time.now()));
  }
  private tick() {
    if (!this.enabled) return;
    if (this.versioned && !this.pollRunning && this.pollAt <= this.time.now()) void this.poll();
    for (const q of this.host.queries()) {
      const e = this.entries.get(q.id);
      if (!e?.active || !q.active || e.running || !e.task || e.task.due > this.time.now()) continue;
      if (q.fetching) { e.task.due = this.time.now() + 250; continue; }
      const reason = e.task.reason; e.task = undefined;
      if (reason === 'initial' && q.data?.ok) continue;
      if (['version-change', 'activation-change'].includes(reason) && validation(q.data, this.versions) === 'same' && !observationMeta(q.data).refreshing) continue;
      e.running = true; e.lastAttempt = this.time.now();
      if (reason === 'follow-up') e.follows++;
      this.counters.businessReads++; this.counters.reasons[reason] = (this.counters.reasons[reason] || 0) + 1;
      const waiters = [...e.waiters]; e.waiters.clear();
      void q.fetch().catch(() => {}).finally(() => {
        for (const done of waiters) done();
        e.running = false;
        const pending = e.pending; e.pending = undefined;
        if (this.enabled && e.active && pending) this.enqueue(e, Math.max(0, pending.due - this.time.now()), pending.reason);
        this.changed();
      });
    }
    this.arm();
  }
  private async poll() {
    this.pollRunning = true; this.pollAt = Infinity;
    const generation = this.generation;
    const ids = [...new Set([...this.subscriptions.values()].flatMap(s => s.ids))].sort();
    this.counters.versionReads++;
    try {
      const response = await this.host.read(ids);
      if (!this.enabled || generation !== this.generation) return;
      if (!response.ok) throw new Error(response.error?.code || 'observer_unavailable');
      const value = response.result as Versions, now = this.time.now();
      const restarted = this.versions !== null && this.versions.instanceId !== value.instanceId;
      const delta = versionDelta(this.versions, value);
      this.versions = value; this.validatedAt = now; this.validatedIds = new Set(ids);
      this.failures = 0; this.failureSince = null;
      const disconnected = ['disconnected', 'disposed', 'closed'].includes(value.hostTransport?.state || '');
      if (disconnected) { this.hostFailures++; this.hostFailureSince ??= now; } else { this.hostFailures = 0; this.hostFailureSince = null; }
      this.host.issue(this.hostFailures >= 3 && now - (this.hostFailureSince ?? now) >= this.warningWindow ? 'host_transport_unavailable' : null);
      for (const q of this.host.queries()) {
        const e = this.entries.get(q.id);
        if (!q.active || !e) continue;
        const meta = observationMeta(q.data), state = validation(q.data, value);
        if (restarted && !meta.immutableIdentity) { this.enqueue(e, 0, 'backend-generation'); continue; }
        if (q.data?.ok && state === 'same') {
          if (!meta.refreshing && meta.cacheState !== 'refreshing' && meta.state === 'ready') q.validate(new Date(now).toISOString());
          // A cache publication can finish without changing the source token.
          else if (!q.fetching) this.enqueue(e, 0, 'refresh-completion');
        } else if (state === 'changed') this.enqueue(e, 0, 'version-change');
        else if (q.data?.ok && (shouldRefreshVersionedQuery(this.project, delta, q.key, q.data, true) || !q.eventOnly && now - Math.max(q.updatedAt, e.lastAttempt) >= policy.legacyReadMs)) this.enqueue(e, 0, 'legacy-validation');
        else if (!q.eventOnly && !q.data?.ok && !durable.has(q.data?.error?.code || '') && !q.fetching && !e.task) this.enqueue(e, 0, 'recovery');
      }
    } catch (error) {
      if (!this.enabled || generation !== this.generation) return;
      this.failures++; this.failureSince ??= this.time.now();
      if (this.enabled && generation === this.generation && this.failures >= 3 && this.time.now() - this.failureSince >= this.warningWindow) this.host.issue(error instanceof Error ? error.message : 'observer_unavailable');
    } finally {
      this.pollRunning = false;
      if (this.enabled) {
        const missing = [...this.subscriptions.values()].some(s => s.ids.some(id => !this.validatedIds.has(id)));
        this.pollAt = this.time.now() + (this.failures ? policy.retryMs[Math.min(this.failures - 1, 3)] : missing || generation !== this.generation ? 0 : policy.pollMs);
      }
      this.changed();
    }
  }
  close() { this.closed = true; this.generation++; if (this.timer !== undefined) this.time.clear(this.timer); this.subscriptions.clear(); for (const e of this.entries.values()) for (const done of e.waiters) done(); this.entries.clear(); }
}
