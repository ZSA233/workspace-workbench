import { OBSERVATION_POLICY as policy } from '../shared/observation-policy.ts';
import type { ObserverResponse } from '../shared/observer.ts';
import { shouldRefreshVersionedQuery, versionDelta, type Versions } from './version-invalidation.ts';

export type ObservationMeta = {
  readTask?: { state: string; nextPollMs: number; deadline: number };
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
const terminalRead = (q: QueryView) => (q.data?.error?.details as { terminal?: boolean } | undefined)?.terminal === true;
const durable = new Set(['path_invalid', 'file_not_changed', 'worktree_missing', 'repository_missing', 'commit_missing', 'base_missing', 'workspace_not_found']);

/** Owns refresh decisions, not payloads. QueryClient remains the single data cache. */
export function createObservationCoordinator(project: string, host: CoordinatorHost, time: Clock = clock) {
  let entries = new Map<string, Entry>();
  let versions: Versions | null = null;
  let subscriptions = new Map<object, { ids: string[]; versions: boolean }>();
  let timer: unknown;
  let pollAt = Infinity;
  let pollRunning = false;
  let validatedAt = -Infinity;
  let validatedIds = new Set<string>();
  let failures = 0;
  let failureSince: number | null = null;
  let hostFailures = 0;
  let hostFailureSince: number | null = null;
  let generation = 0;
  let scanning = false;
  let closed = false;
  const counters = { cacheHits: 0, versionReads: 0, businessReads: 0, merged: 0, reasons: {} as Record<string, number> };
  function subscribe(ids: string[], allowVersions = true): () => void {
    const resuming = subscriptions.size === 0;
    const key = {};
    subscriptions.set(key, { ids, versions: allowVersions });
    if (allowVersions && (resuming || time.now() - validatedAt >= policy.pollMs || ids.some(id => !validatedIds.has(id)))) pollAt = time.now();
    changed();
    return () => {
      subscriptions.delete(key);
      if (!subscriptions.size) {
        generation++; pollAt = Infinity;
        for (const entry of entries.values()) { entry.active = false; entry.task = undefined; entry.pending = undefined; for (const done of entry.waiters) done(); entry.waiters.clear(); }
        host.issue(null);
      }
      arm();
    };
  }
  function enabled() { return subscriptions.size > 0 && !closed; }
  function warningWindow() {
    const windows = host.queries().filter(q => q.active && !q.eventOnly).map(q => q.validationWindowMs || policy.warningMs);
    return windows.length ? Math.min(...windows) : policy.warningMs;
  }
  function versioned() { return [...subscriptions.values()].some(s => s.versions); }
  function changed(): void {
    if (!enabled() || scanning) return;
    scanning = true;
    try {
      const now = time.now(), present = new Set<string>();
      for (const q of host.queries()) {
        present.add(q.id);
        let e = entries.get(q.id);
        if (!e) { e = { active: false, lastUsed: now, failures: 0, followToken: '', follows: 0, lastAttempt: 0, running: false, waiters: new Set() }; entries.set(q.id, e); }
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
            if (!terminalRead(q) && !durable.has(q.data?.error?.code || '')) enqueue(e, policy.retryMs[Math.min(e.failures - 1, 3)], 'retry');
          } else if (q.data?.ok) {
            e.failures = 0;
            if (!meta.refreshing && meta.cacheState !== 'refreshing') {
              if (e.task?.reason === 'follow-up' || e.task?.reason === 'retry') e.task = undefined;
            }
          }
        }
        if (meta.readTask) {
          if (!q.fetching && !e.running && !e.task) enqueue(e, meta.readTask.nextPollMs, 'read-task');
          continue;
        }
        const refreshing = meta.refreshing || meta.cacheState === 'refreshing';
        if (refreshing) {
          const token = JSON.stringify([dependencies(meta), (q.data?.result as any)?.cache?.updatedAt || meta.observedAt]);
          if (e.followToken !== token) { e.followToken = token; e.follows = 0; }
          if (e.follows < policy.followUpMs.length && !q.fetching && !e.running && !e.task) enqueue(e, policy.followUpMs[e.follows], 'follow-up');
        }
        if (activated && q.data?.ok && !q.eventOnly) {
          const state = validation(q.data, versions);
          if (state === 'same') counters.cacheHits++;
          if (state === 'changed') enqueue(e, 0, 'activation-change');
          if (state === 'unknown' && (!versioned() || !Object.keys(dependencies(meta)).length) && now - Math.max(q.updatedAt, e.lastAttempt) >= policy.legacyReadMs) enqueue(e, 0, 'legacy-activation');
          if (versioned() && !meta.immutableIdentity && (now - validatedAt >= policy.pollMs || state === 'unknown' && Object.keys(dependencies(meta)).length > 0)) pollAt = Math.min(pollAt, now);
        }
        if (activated && !terminalRead(q) && !q.eventOnly && (q.error || q.data?.ok === false) && !durable.has(q.data?.error?.code || '') && !e.task)
          enqueue(e, 0, 'retry');
        if (activated && !q.eventOnly && !q.data && !q.fetching && !q.error) enqueue(e, 0, 'initial');
      }
      for (const [id, entry] of entries) if (!present.has(id) || !entry.active && now - entry.lastUsed >= policy.retentionMs) { for (const done of entry.waiters) done(); entries.delete(id); }
    } finally { scanning = false; }
    arm();
  }
  /** Used after a known mutation or explicit refresh; running reads are never cancelled/restarted. */
  function refresh(matches: (q: QueryView) => boolean = () => true): Promise<void> {
    if (!enabled()) return Promise.resolve();
    changed();
    const waits: Promise<void>[] = [];
    for (const q of host.queries()) if (q.active && matches(q)) {
      const entry = entries.get(q.id);
      if (entry) {
        waits.push(new Promise<void>(resolve => entry.waiters.add(resolve)));
        enqueue(entry, 0, 'manual');
      }
    }
    if (versioned()) pollAt = time.now();
    arm();
    return Promise.all(waits).then(() => undefined);
  }
  function enqueue(e: Entry, delay: number, reason: string) {
    if (reason !== 'manual' && e.failures) delay = Math.max(delay, e.lastAttempt + policy.retryMs[Math.min(e.failures - 1, 3)] - time.now());
    if (e.running) {
      const pending = { due: time.now() + delay, reason };
      if (!e.pending || pending.due < e.pending.due || reason === 'manual') e.pending = pending;
      counters.merged++; return;
    }
    if (e.task) {
      counters.merged++;
      if (reason === 'manual') { e.task = { due: Math.min(e.task.due, time.now() + delay), reason }; return; }
      if (e.task.due <= time.now() + delay) return;
    }
    e.task = { due: time.now() + delay, reason };
  }
  function arm() {
    if (timer !== undefined) time.clear(timer);
    timer = undefined;
    if (!enabled()) return;
    const due = Math.min(versioned() && !pollRunning ? pollAt : Infinity, ...[...entries.values()].map(e => e.active && !e.running ? e.task?.due ?? Infinity : Infinity));
    if (Number.isFinite(due)) timer = time.set(() => { timer = undefined; tick(); }, Math.max(0, due - time.now()));
  }
  function tick() {
    if (!enabled()) return;
    if (versioned() && !pollRunning && pollAt <= time.now()) void poll();
    for (const q of host.queries()) {
      const e = entries.get(q.id);
      if (!e?.active || !q.active || e.running || !e.task || e.task.due > time.now()) continue;
      if (q.fetching) { e.task.due = time.now() + 250; continue; }
      const reason = e.task.reason; e.task = undefined;
      if (reason === 'initial' && q.data?.ok) continue;
      if (['version-change', 'activation-change'].includes(reason) && validation(q.data, versions) === 'same' && !observationMeta(q.data).refreshing) continue;
      e.running = true; e.lastAttempt = time.now();
      if (reason === 'follow-up') e.follows++;
      counters.businessReads++; counters.reasons[reason] = (counters.reasons[reason] || 0) + 1;
      const waiters = [...e.waiters]; e.waiters.clear();
      void q.fetch().catch(() => {}).finally(() => {
        for (const done of waiters) done();
        e.running = false;
        const pending = e.pending; e.pending = undefined;
        if (enabled() && e.active && pending) enqueue(e, Math.max(0, pending.due - time.now()), pending.reason);
        changed();
      });
    }
    // QueryObserver can finish its initial read before our queued activation
    // runs. Reconcile the returned pending state after dropping that duplicate.
    changed();
  }
  async function poll() {
    pollRunning = true; pollAt = Infinity;
    const pollGeneration = generation;
    const ids = [...new Set([...subscriptions.values()].flatMap(s => s.ids))].sort();
    counters.versionReads++;
    try {
      const response = await host.read(ids);
      if (!enabled() || pollGeneration !== generation) return;
      if (!response.ok) throw new Error(response.error?.code || 'observer_unavailable');
      const value = response.result as Versions, now = time.now();
      const restarted = versions !== null && versions.instanceId !== value.instanceId;
      const delta = versionDelta(versions, value);
      versions = value; validatedAt = now; validatedIds = new Set(ids);
      failures = 0; failureSince = null;
      const disconnected = ['disconnected', 'disposed', 'closed'].includes(value.hostTransport?.state || '');
      if (disconnected) { hostFailures++; hostFailureSince ??= now; } else { hostFailures = 0; hostFailureSince = null; }
      host.issue(hostFailures >= 3 && now - (hostFailureSince ?? now) >= warningWindow() ? 'host_transport_unavailable' : null);
      for (const q of host.queries()) {
        const e = entries.get(q.id);
        if (!q.active || !e) continue;
        const meta = observationMeta(q.data), state = validation(q.data, value);
        if (meta.readTask || terminalRead(q)) continue;
        if (restarted && !meta.immutableIdentity) { enqueue(e, 0, 'backend-generation'); continue; }
        if (q.data?.ok && state === 'same') {
          if (!meta.refreshing && meta.cacheState !== 'refreshing' && meta.state === 'ready') q.validate(new Date(now).toISOString());
          // A cache publication can finish without changing the source token.
          else if (!q.fetching) enqueue(e, 0, 'refresh-completion');
        } else if (state === 'changed') enqueue(e, 0, 'version-change');
        else if (q.data?.ok && (shouldRefreshVersionedQuery(project, delta, q.key, q.data, true) || !q.eventOnly && now - Math.max(q.updatedAt, e.lastAttempt) >= policy.legacyReadMs)) enqueue(e, 0, 'legacy-validation');
        else if (!q.eventOnly && !q.data?.ok && !durable.has(q.data?.error?.code || '') && !q.fetching && !e.task) enqueue(e, 0, 'recovery');
      }
    } catch (error) {
      if (!enabled() || pollGeneration !== generation) return;
      failures++; failureSince ??= time.now();
      if (enabled() && pollGeneration === generation && failures >= 3 && time.now() - failureSince >= warningWindow()) host.issue(error instanceof Error ? error.message : 'observer_unavailable');
    } finally {
      pollRunning = false;
      if (enabled()) {
        const missing = [...subscriptions.values()].some(s => s.ids.some(id => !validatedIds.has(id)));
        pollAt = time.now() + (failures ? policy.retryMs[Math.min(failures - 1, 3)] : missing || pollGeneration !== generation ? 0 : policy.pollMs);
      }
      changed();
    }
  }
  function debug() {
    return { enabled: enabled(), subscribers: subscriptions.size, timer: timer !== undefined, pollRunning: pollRunning,
      queries: host.queries().filter(q => q.active).slice(0, 12).map(q => ({ kind: q.key[1] === 'file-review' ? 'file-review' : q.key[2], active: q.active, fetching: q.fetching, readTask: !!observationMeta(q.data).readTask, scheduled: entries.get(q.id)?.task?.reason, running: entries.get(q.id)?.running })) };
  }
  function close() { closed = true; generation++; if (timer !== undefined) time.clear(timer); subscriptions.clear(); for (const e of entries.values()) for (const done of e.waiters) done(); entries.clear(); }
  return { project, counters, subscribe, changed, refresh, debug, close };
}
export type ObservationCoordinator = ReturnType<typeof createObservationCoordinator>;
