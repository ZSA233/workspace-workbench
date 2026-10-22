import { join, resolve } from "node:path";
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { type Config } from "./config.ts";
import { issue, optionalJson, stable, WorkbenchError, type Json } from "./storage.ts";
import { DerivedJsonWriter } from './derived-json.ts';

/** Transport budget and refresh intent cannot change the identity of content. */
export function observationCacheIdentity(params: Json): string {
  const { observationBudgetMs: _budget, force: _force, ...content } = params;
  return stable(content);
}

type Entry = {
  value: Json;
  fingerprint: string;
  time: number;
  bytes: number;
  fingerprintProbed?: boolean;
  owners?: string[];
  instances?: Record<string, string>;
  repoPath?: string;
  ownershipBytes?: number;
};
type Fingerprint = string | (() => Promise<string> | string);
export type CachePublication = { workspaceId?: string; repoPath?: string };
const evictOnRefreshFailure = new Set([
  "file_not_changed",
  "path_invalid",
  "worktree_missing",
  "commit_missing",
  "base_missing",
]);
/** Bounded derived observations; legacy SQLite is retained, never migrated destructively. */
export class ObservationCache {
  private entries = new Map<string, Entry>();
  private flights = new Map<string, Promise<Json>>();
  private probes = new Set<Entry>();
  private background = new Set<Promise<unknown>>();
  private failures = new Map<string, string>();
  private generation = 0;
  private workspaceGenerations = new Map<string, number>();
  private workspaceInstances = new Map<string, string>();
  private writer: DerivedJsonWriter;
  private rosterSignature = '';
  workspaceEpoch(id: string) { return this.workspaceGenerations.get(id) || 0; }
  invalidateWorkspace(id: string) { if (this.workspaceGenerations.size >= 1000 && !this.workspaceGenerations.has(id)) { this.generation++; this.workspaceGenerations.clear(); } this.workspaceGenerations.set(id, this.workspaceEpoch(id) + 1); }
  private closed = false;
  onProduced?: (scope?: CachePublication) => void;
  config: Config;
  path: string;
  private clock:()=>number;
  constructor(config: Config, clock:()=>number = Date.now) {
    this.clock=clock;
    this.config = config;
    this.path = join(config.stateRoot, "observer-node-cache.json");
    this.writer = new DerivedJsonWriter(this.path);
    try {
      const saved = optionalJson(this.path);
      if (saved.version === 1)
        for (const [key, value] of saved.entries || [])
          this.entries.set(key, value);
      this.trim();
    } catch {
      this.entries.clear();
    }
  }
  private own(entry: Entry, scope?: CachePublication) {
    if (scope?.workspaceId) {
      entry.owners = [...new Set([...(entry.owners || []), scope.workspaceId])];
      const instance = this.workspaceInstances.get(scope.workspaceId);
      if (instance) entry.instances = { ...entry.instances, [scope.workspaceId]: instance };
    }
    if (scope?.repoPath) entry.repoPath = resolve(scope.repoPath);
    if (entry.owners || entry.instances || entry.repoPath) { const bytes = Buffer.byteLength(JSON.stringify({ owners: entry.owners, instances: entry.instances, repoPath: entry.repoPath })); entry.bytes += bytes - (entry.ownershipBytes || 0); entry.ownershipBytes = bytes; this.trim(); }
  }
  evictWorkspace(id: string) {
    this.invalidateWorkspace(id); this.generation++;
    for (const [key, entry] of this.entries) {
      const owners = entry.owners || [entry.value.workspaceId || entry.value.workspace?.id].filter(Boolean);
      if (owners.includes(id)) {
        entry.owners = owners.filter(owner => owner !== id);
        if (entry.instances) delete entry.instances[id];
        if (!entry.owners.length) { this.entries.delete(key); this.failures.delete(key); }
      } else if (Array.isArray(entry.value.workspaces)) { this.entries.delete(key); this.failures.delete(key); }
    }
    this.writer.save({ version: 1, entries: [...this.entries] });
  }
  /** Only call with a complete, successfully decoded record roster. */
  reconcileWorkspaces(workspaces: Json[]) {
    if (workspaces.some(w => !w.id || w.state === 'record_invalid')) return;
    const active = workspaces.filter(w => w.state !== 'removed');
    const instances = new Map(active.map(w => [String(w.id), workspaceInstanceKey(w as Json & { id: string })]));
    const signature = stable(active.map(w => ({ id: w.id, instance: instances.get(w.id), root: w.treePath || w.sourceRoot, repositories: (w.repositories || []).map((r: Json) => resolve(r.worktreePath || r.sourcePath)).sort() })).sort((a,b)=>a.id.localeCompare(b.id)));
    if (signature === this.rosterSignature) return;
    this.rosterSignature = signature;
    const repositories = new Map<string, string[]>();
    for (const w of active) for (const repo of w.repositories || []) { const path = resolve(repo.worktreePath || repo.sourcePath); repositories.set(path, [...(repositories.get(path) || []), w.id]); }
    this.generation++; // Late producers from the retired roster cannot restore discarded entries.
    for (const [key, entry] of this.entries) {
      const value = entry.value, id = value.workspaceId || value.workspace?.id;
      const repo = entry.repoPath || value.repoPath || value.repository?.repoPath;
      const owners = id ? entry.owners || [id] : repo ? repositories.get(resolve(repo)) : entry.owners;
      if (owners) {
        entry.owners = owners.filter(owner => instances.has(owner) && (!entry.instances?.[owner] || entry.instances[owner] === instances.get(owner)));
        if (entry.owners.length) { this.own(entry); continue; }
      }
      // Old unowned JSON snapshots are derived data, safe to recompute after migration.
      this.entries.delete(key); this.failures.delete(key);
    }
    this.workspaceInstances = instances;
    this.writer.save({ version: 1, entries: [...this.entries] });
  }
  private trim() {
    let bytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    while (
      this.entries.size > this.config.cacheEntries ||
      bytes > this.config.cacheBytes
    ) {
      const key = this.entries.keys().next().value!;
      bytes -= this.entries.get(key)!.bytes;
      this.entries.delete(key);
    }
  }
  private metadata(entry: Entry, refreshing = false, failureCode?: string): Json {
    const sourceObservation = entry.value.observation || {};
    const observation = { ...sourceObservation };
    if (failureCode && !['partial', 'unavailable'].includes(failureCode)) {
      observation.state = 'partial';
      observation.issues = [...(observation.issues || []), { code: failureCode }];
    }
    const observationState = observation.state || "ready";
    const ageMs = Math.max(0, this.clock() - entry.time);
    const observedAt = observation.observedAt;
    const cacheState = refreshing
      ? "refreshing"
      : observationState !== "ready"
        ? "degraded"
        : "fresh";
    observation.cacheState = cacheState;
    observation.cacheAgeMs = ageMs;
    observation.refreshing = refreshing;
    if (!observation.lastObservedAt && observedAt)
      observation.lastObservedAt = observedAt;
    if (!observation.lastSuccessfulAt && observationState === "ready")
      observation.lastSuccessfulAt = observedAt;
    return {
      ...entry.value,
      cache: {
        state: refreshing ? "refreshing" : "fresh",
        refreshing,
        updatedAt: new Date(entry.time).toISOString(),
        ageMs,
      },
      observation,
    };
  }
  private produce(key: string, fingerprint: Fingerprint, work: () => Promise<Json>, scope?: CachePublication) {
    if (this.closed) throw new WorkbenchError("observer_closed", "observation cache is closed");
    const active = this.flights.get(key);
    if (active) return active;
    if (this.flights.size >= 32) throw new WorkbenchError("observer_busy", "snapshot computation limit reached");
    const generation = this.generation;
    const workspaceGeneration = scope?.workspaceId ? this.workspaceEpoch(scope.workspaceId) : 0;
    const flight = work()
      .then((value) => {
        const previous = this.entries.get(key);
        if (value.observation?.state === "partial" && previous)
          for (const [field, id] of [
            ["repositories", "repoPath"],
            ["workspaces", "id"],
          ])
            if (Array.isArray(value[field]))
              value[field] = value[field].map((row: Json) => {
                const transient = [
                  ...(row.issues || []),
                  ...(row.changeIssues || []),
                ].some((e: Json) =>
                  [
                    "git_timeout",
                    "observation_timeout",
                    "observer_busy",
                    "observer_timeout",
                    "observer_unavailable",
                    "observer_connection_refused",
                    "observer_socket_error",
                  ].includes(e.code),
                );
                const old = previous.value[field]?.find(
                  (r: Json) => r[id] === row[id],
                );
                return transient && old
                  ? { ...old, observationStale: true, issues: row.issues }
                  : row;
              });
        if (value.observation) {
          value.observation.lastObservedAt = value.observation.observedAt;
          if (value.observation.state === "ready")
            value.observation.lastSuccessfulAt = value.observation.observedAt;
          else if (previous?.value.observation?.lastSuccessfulAt)
            value.observation.lastSuccessfulAt =
              previous.value.observation.lastSuccessfulAt;
          else delete value.observation.lastSuccessfulAt;
        }
        const entry = {
          value, owners: previous?.owners, instances: previous?.instances, repoPath: previous?.repoPath,
          // A function fingerprint is deliberately evaluated after the
          // observation is produced.  A slow fingerprint must never delay an
          // existing cached snapshot (or the first useful response).
          fingerprint: typeof fingerprint === "string" ? fingerprint : "pending",
          time: this.clock(),
          bytes: Buffer.byteLength(JSON.stringify(value)),
        };
        this.own(entry, scope);
        if (generation === this.generation && (!scope?.workspaceId || workspaceGeneration === this.workspaceEpoch(scope.workspaceId))) {
          this.entries.delete(key);
          this.entries.set(key, entry);
          this.trim();
          this.onProduced?.(scope);
          if (value.observation?.state && value.observation.state !== "ready")
            this.failures.set(key, value.observation.state);
          else this.failures.delete(key);
        }
        if (typeof fingerprint !== "string" && this.background.size >= 32) entry.fingerprint = "unavailable";
        if (typeof fingerprint !== "string" && this.background.size < 32) {
          const pending = Promise.resolve()
            .then(() => fingerprint())
            .then((nextFingerprint) => {
              const current = this.entries.get(key);
              if (generation === this.generation && current === entry) {
                current.fingerprint = nextFingerprint;
                current.fingerprintProbed = true;
              }
            })
            .catch(() => {
              const current = this.entries.get(key);
              if (generation === this.generation && current === entry)
                current.fingerprint = "unavailable";
            });
          this.background.add(pending);
          void pending.finally(() => this.background.delete(pending));
        }
        return this.metadata(entry);
      })
      .catch((error) => {
        const code = issue(error).code;
        // A background refresh is stale-while-revalidate: transient failures
        // must leave the last good entry available for the next request. Only
        // errors that make this cache key permanently invalid evict it.
        if (evictOnRefreshFailure.has(code)) this.entries.delete(key);
        this.failures.set(key, code);
        if (this.failures.size > 256)
          this.failures.delete(this.failures.keys().next().value!);
        throw error;
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    return flight;
  }
  private startFingerprintProbe(
    key: string,
    entry: Entry,
    fingerprint: () => Promise<string> | string,
    work: () => Promise<Json>,
    scope?: CachePublication,
  ): void {
    // A function fingerprint is intentionally rechecked on later reads. The
    // first probe makes a persisted entry usable across process generations;
    // subsequent probes let scheduler revisions invalidate an already visible
    // snapshot without making the request wait for Git. `probes` still keeps
    // concurrent reads to one probe per entry.
    if (this.probes.has(entry) || entry.fingerprint === "pending" || this.background.size >= 32) return;
    this.probes.add(entry);
    entry.fingerprintProbed = true;
    const probe = Promise.resolve()
      .then(() => fingerprint())
      .then(async (nextFingerprint) => {
        const current = this.entries.get(key);
        if (
          current === entry &&
          nextFingerprint !== "unavailable" &&
          nextFingerprint !== entry.fingerprint
        )
          await this.produce(key, nextFingerprint, work, scope).catch(() => {});
      })
      .catch(() => {})
      .finally(() => this.probes.delete(entry));
    this.background.add(probe);
    void probe.finally(() => this.background.delete(probe));
  }
  get epoch() { return this.generation; }
  retained(key: string): Json | undefined {
    const entry = this.entries.get(key);
    return entry ? this.metadata(entry, this.flights.has(key), this.failures.get(key)) : undefined;
  }
  publish(key: string, fingerprint: string, value: Json, scope?: CachePublication, expectedEpoch = this.generation): void {
    if (this.closed || expectedEpoch !== this.generation) return;
    this.failures.delete(key);
    const entry = { value, fingerprint, time: this.clock(), bytes: Buffer.byteLength(JSON.stringify(value)) }; this.own(entry, scope);
    this.entries.set(key, entry);
    this.trim(); this.onProduced?.(scope);
  }
  peek(key: string, fingerprint: string): Json | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.fingerprint !== fingerprint || this.failures.has(key) || entry.value.observation?.state !== 'ready') return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return this.metadata(entry);
  }
  async read(key: string, fingerprint: Fingerprint, work: () => Promise<Json>, versioned = false, waitFresh = false, scope?: CachePublication) {
    if (this.closed) throw new WorkbenchError("observer_closed", "observation cache is closed");
    const entry = this.entries.get(key);
    if (entry) this.own(entry, scope);
    const fingerprintMatches =
      typeof fingerprint !== "string" || entry?.fingerprint === fingerprint;
    const healthy = !this.failures.has(key) && (!entry?.value.observation?.state || entry.value.observation.state === 'ready');
    // Partial entries retain the TTL cooldown, but cannot become immortal just
    // because the source token is unchanged (including persisted snapshots).
    if (entry && fingerprintMatches && (versioned && healthy || this.clock() - entry.time <= this.config.cacheTtl)) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      if (typeof fingerprint !== "string")
        this.startFingerprintProbe(key, entry, fingerprint, work, scope);
      return this.metadata(entry, false, this.failures.get(key));
    }
    if (entry && !waitFresh) {
      try { void this.produce(key, fingerprint, work, scope).catch(() => {}); }
      catch (error) {
        const retained = this.metadata(entry);
        return { ...retained, observation: { ...retained.observation, cacheState: "degraded", refreshing: false,
          issues: [{ code: issue(error).code }] } };
      }
      return this.metadata(entry, true, this.failures.get(key));
    }
    return this.produce(key, fingerprint, work, scope);
  }
  clear() {
    this.generation++;
    this.entries.clear();
    this.failures.clear();
    this.probes.clear();
  }
  status() {
    return {
      memory: {
        entries: this.entries.size,
        bytes: [...this.entries.values()].reduce(
          (sum, entry) => sum + entry.bytes,
          0,
        ),
        maxEntries: this.config.cacheEntries,
        maxBytes: this.config.cacheBytes,
      },
      persistent: { format: "json", path: this.path },
      refreshing: this.flights.size,
      background: this.background.size,
      probes: this.probes.size,
      closed: this.closed,
      failedRefreshes: this.failures.size,
      issueCodes: [...new Set(this.failures.values())],
      ttlSeconds: this.config.cacheTtl / 1000,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    while (this.flights.size || this.background.size)
      await Promise.allSettled([...this.flights.values(), ...this.background]);
    this.writer.save({ version: 1, entries: [...this.entries] }); await this.writer.flush();
    this.entries.clear();
    this.failures.clear();
    this.probes.clear();
  }
}
