import { join } from "node:path";
import { type Config } from "./config.ts";
import { atomicJson, issue, optionalJson, type Json } from "./storage.ts";

type Entry = { value: Json; fingerprint: string; time: number; bytes: number };
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
  private failures = new Map<string, string>();
  private generation = 0;
  config: Config;
  path: string;
  constructor(config: Config) {
    this.config = config;
    this.path = join(config.stateRoot, "observer-node-cache.json");
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
  private metadata(entry: Entry, refreshing = false): Json {
    const sourceObservation = entry.value.observation || {};
    const observation = { ...sourceObservation };
    const observationState = observation.state || "ready";
    const ageMs = Math.max(0, Date.now() - entry.time);
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
  private produce(key: string, fingerprint: string, work: () => Promise<Json>) {
    const active = this.flights.get(key);
    if (active) return active;
    const generation = this.generation;
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
          value,
          fingerprint,
          time: Date.now(),
          bytes: Buffer.byteLength(JSON.stringify(value)),
        };
        if (generation === this.generation) {
          this.entries.delete(key);
          this.entries.set(key, entry);
          this.trim();
          if (value.observation?.state && value.observation.state !== "ready")
            this.failures.set(key, value.observation.state);
          else this.failures.delete(key);
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
  async read(key: string, fingerprint: string, work: () => Promise<Json>) {
    const entry = this.entries.get(key);
    if (
      entry &&
      entry.fingerprint === fingerprint &&
      Date.now() - entry.time <= this.config.cacheTtl
    ) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return this.metadata(entry);
    }
    if (entry) {
      void this.produce(key, fingerprint, work).catch(() => {});
      return this.metadata(entry, true);
    }
    return this.produce(key, fingerprint, work);
  }
  clear() {
    this.generation++;
    this.entries.clear();
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
      failedRefreshes: this.failures.size,
      issueCodes: [...new Set(this.failures.values())],
      ttlSeconds: this.config.cacheTtl / 1000,
    };
  }
  async close() {
    await Promise.allSettled(this.flights.values());
    atomicJson(this.path, { version: 1, entries: [...this.entries] });
  }
}
