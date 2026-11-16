import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { join, resolve } from "node:path";
import { Git, withBackgroundGit } from "./git.ts";
import type { Config } from "./config.ts";
import { canonicalAsync, hash, now, optionalJson, stable, type Json } from "./storage.ts";
import { DerivedJsonWriter } from './derived-json.ts';
import { activityHeadToken } from './activity-head.ts';

const CACHE_TTL_MS = 30 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;

type RepositoryActivity = {
  owners?: Record<string, string>;
  head: string | null;
  latestCommitAt: string | null;
  checkedAt: string | null;
  attemptedAt?: string;
  error?: string;
  headToken?: string;
};

type ActivityFile = { version: 1; repositories: Record<string, RepositoryActivity> };
type RepositoryTarget = { key: string; path: string };
type ScanState = "running" | "complete" | "cancelled";

type Scan = {
  id: string;
  epoch: number;
  state: ScanState;
  workspaceIds: string[];
  total: number;
  completed: number;
  errors: number;
  controller: AbortController;
  promise?: Promise<void>;
  force?: boolean;
};

export type WorkspaceActivitySummary = {
  latestCommitAt: string | null;
  latestCommitObservedAt: string | null;
  latestCommitState: "ready" | "pending" | "partial" | "unknown";
};

/** Persisted, on-demand HEAD metadata. It never polls and never walks commit history. */
export class WorkspaceActivityIndex {
  onHeadChange?: (workspaceId: string) => void;
  private readonly path: string;
  private readonly config: Config;
  private repositories = new Map<string, RepositoryActivity>();
  private scans = new Map<string, Scan>();
  private cancelledScanIds = new Set<string>();
  private liveKeys?: Set<string>;
  private owners = new Map<string, Record<string, string>>();
  private rosterSignature = '';
  private epoch = 0;
  reconcileWorkspaces(workspaces: Json[]) {
    if (workspaces.some(w => !w.id || w.state === 'record_invalid')) return;
    const owners = new Map<string, Record<string, string>>();
    for (const workspace of workspaces.filter(w => w.state !== 'removed')) for (const target of this.targets([workspace])) { const value = owners.get(target.key) || Object.create(null); value[workspace.id] = workspaceInstanceKey(workspace as Json & { id: string }); owners.set(target.key, value); }
    const signature = stable([...owners].sort(([a], [b]) => a.localeCompare(b))); if (signature === this.rosterSignature) return;
    this.rosterSignature = signature; this.epoch++; this.liveKeys = new Set(owners.keys());
    for (const [key, entry] of this.repositories) {
      const next = owners.get(key), previous = entry.owners;
      if (!next || !previous || !Object.keys(next).some(id => previous[id] === next[id]) || Object.keys(next).some(id => previous[id] && previous[id] !== next[id])) this.repositories.delete(key);
      else entry.owners = next;
    }
    this.owners = owners; this.persist();
  }
  private activeScanId: string | null = null;
  private writer: DerivedJsonWriter;

  constructor(config: Config) {
    this.config = config;
    this.path = join(config.stateRoot, "workspace-activity.json");
    this.writer = new DerivedJsonWriter(this.path);
    try {
      const saved = optionalJson(this.path);
      if (saved.version === 1 && saved.repositories && typeof saved.repositories === "object") {
        for (const [key, rawValue] of Object.entries(saved.repositories as Record<string, Json>)) {
          const value = rawValue as Json;
          if (value && typeof value === "object" && typeof value.latestCommitAt !== "undefined") {
            const latestCommitAt = typeof value.latestCommitAt === "string" && Number.isFinite(Date.parse(value.latestCommitAt)) ? value.latestCommitAt : null;
            const checkedAt = typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null;
            this.repositories.set(key, {
              ...(value.owners && typeof value.owners === 'object' && !Array.isArray(value.owners) ? { owners: Object.fromEntries(Object.entries(value.owners).filter(([, instance]) => typeof instance === 'string')) as Record<string, string> } : {}),
              head: typeof value.head === "string" ? value.head : null,
              latestCommitAt,
              checkedAt,
              ...(typeof value.headToken === 'string' ? { headToken: value.headToken } : {}),
              ...(typeof value.attemptedAt === "string" ? { attemptedAt: value.attemptedAt } : {}),
              ...(typeof value.error === "string" ? { error: value.error } : {}),
            });
          }
        }
      }
    } catch {
      this.repositories.clear();
    }
    this.trim();
  }

  private repoKey(path: string): string {
    return hash(resolve(path));
  }

  private targets(workspaces: Json[]): RepositoryTarget[] {
    const result = new Map<string, RepositoryTarget>();
    for (const workspace of workspaces) {
      for (const repository of workspace.repositories || []) {
        const path = String(repository.worktreePath || repository.sourcePath || "");
        if (!path) continue;
        const key = this.repoKey(path);
        if (!result.has(key)) result.set(key, { key, path });
      }
    }
    return [...result.values()];
  }

  summary(workspace: Json): WorkspaceActivitySummary {
    const targets = this.targets([workspace]);
    const entries = targets.map((target) => this.repositories.get(target.key));
    const dated = entries.filter((entry): entry is RepositoryActivity => Boolean(entry?.latestCommitAt));
    const latest = dated
      .map((entry) => entry.latestCommitAt!)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
    const checked = entries
      .map((entry) => entry?.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    const pending = this.activeScanId
      ? this.scans.get(this.activeScanId)?.state === "running" && this.scans.get(this.activeScanId)?.workspaceIds.includes(String(workspace.id || ""))
      : false;
    const failed = entries.some((entry) => Boolean(entry?.error));
    const complete = entries.length > 0 && entries.every((entry) => Boolean(entry?.checkedAt));
    const hasCommits = dated.length > 0;
    return {
      latestCommitAt: latest,
      latestCommitObservedAt: checked[0] || null,
      latestCommitState: pending ? "pending" : failed ? "partial" : complete && hasCommits ? "ready" : complete ? "unknown" : "unknown",
    };
  }

  start(scanId: string, workspaces: Json[], force = false): Json {
    if (!scanId || scanId.length > 128) return { state: "error", error: "scan_id_invalid" };
    if (this.cancelledScanIds.has(scanId)) return { scanId, state: "cancelled", total: 0, completed: 0, errors: 0 };
    const existing = this.scans.get(scanId);
    if (existing) return this.status(scanId);
    const previousScan = this.activeScanId ? this.scans.get(this.activeScanId) : undefined;
    if (previousScan) this.cancel(previousScan.id);

    const workspaceIds = [...new Set(workspaces.map((workspace) => String(workspace.id || "")).filter(Boolean))];
    const targets = this.targets(workspaces);
    // Even a fresh entry must validate HEAD. Validation runs off the RPC path.
    const stale = targets;
    const scan: Scan = {
      id: scanId,
      epoch: this.epoch,
      state: stale.length ? "running" : "complete",
      workspaceIds,
      total: stale.length,
      completed: 0,
      errors: 0,
      controller: new AbortController(),
      force,
    };
    this.scans.set(scanId, scan);
    this.trimScans();
    if (!stale.length) return this.status(scanId);

    this.activeScanId = scanId;
    scan.promise = (async () => {
      if (previousScan?.promise) await previousScan.promise;
      if (!scan.controller.signal.aborted) await this.run(scan, stale);
    })();
    return this.status(scanId);
  }

  status(scanId: string): Json {
    const scan = this.scans.get(scanId);
    if (!scan) return { scanId, state: "unknown", total: 0, completed: 0, errors: 0 };
    return {
      scanId: scan.id,
      state: scan.state,
      total: scan.total,
      completed: scan.completed,
      errors: scan.errors,
      workspaceIds: scan.workspaceIds,
    };
  }

  cancel(scanId: string): Json {
    const scan = this.scans.get(scanId);
    if (!scan) {
      if (scanId && scanId.length <= 128) {
        this.cancelledScanIds.add(scanId);
        while (this.cancelledScanIds.size > 128) this.cancelledScanIds.delete(this.cancelledScanIds.values().next().value!);
      }
      return this.status(scanId);
    }
    if (scan.state === "running") {
      scan.state = "cancelled";
      scan.controller.abort();
      if (this.activeScanId === scanId) this.activeScanId = null;
    }
    return this.status(scanId);
  }

  async close(): Promise<void> {
    for (const scan of this.scans.values()) this.cancel(scan.id);
    await Promise.allSettled([...this.scans.values()].map((scan) => scan.promise).filter((promise): promise is Promise<void> => Boolean(promise)));
    this.persist();
    await this.writer.flush();
  }

  private async run(scan: Scan, targets: RepositoryTarget[]): Promise<void> {
    const staged = new Map<string, RepositoryActivity>();
    try {
      for (const target of targets) {
        if (scan.epoch !== this.epoch) break;
        if (this.liveKeys && !this.liveKeys.has(target.key)) continue;
        if (scan.controller.signal.aborted) break;
        const attemptedAt = now(), epoch = scan.epoch;
        try {
          const timeout = Math.min(this.config.gitTimeout, this.config.foregroundGitTimeout || this.config.gitTimeout);
          const path = await canonicalAsync(target.path);
          const headToken = await activityHeadToken(path);
          const previous = this.repositories.get(target.key);
          const age = Date.now() - Date.parse(previous?.checkedAt || '');
          if (!scan.force && previous?.headToken === headToken &&
            (age < CACHE_TTL_MS || previous.error && Date.now() - Date.parse(previous.attemptedAt || '') < FAILURE_RETRY_MS)) {
            scan.completed++;
            continue;
          }
          const result = await withBackgroundGit(() => new Git(path, timeout, undefined, scan.controller.signal, true)
            .run(["show", "-s", "--format=%H%x00%cI", "HEAD"], false));
          if (scan.controller.signal.aborted) break;
          if (epoch !== this.epoch || this.liveKeys && !this.liveKeys.has(target.key)) { scan.completed++; continue; }
          const [head, latestCommitAt] = result.stdout.trim().split("\0");
          if (result.code === 0 && head && Number.isFinite(Date.parse(latestCommitAt || ""))) {
            staged.set(target.key, { owners: this.owners.get(target.key), head, latestCommitAt, checkedAt: now(), attemptedAt, headToken });
          } else if (result.code === 0 && !head) {
            staged.set(target.key, { owners: this.owners.get(target.key), head: null, latestCommitAt: null, checkedAt: now(), attemptedAt, headToken });
          } else {
            this.recordError(staged, target.key, attemptedAt, result.stderr.trim() || "commit_unavailable");
            scan.errors++;
          }
        } catch (error) {
          if (scan.controller.signal.aborted) break;
          if (epoch !== this.epoch || this.liveKeys && !this.liveKeys.has(target.key)) { scan.completed++; continue; }
          this.recordError(staged, target.key, attemptedAt, error instanceof Error ? error.message : String(error));
          scan.errors++;
        }
        scan.completed++;
      }
    } finally {
      // Publish one complete batch. Cancelled or superseded scans publish nothing.
      if (!scan.controller.signal.aborted && scan.epoch === this.epoch) {
        const changed = new Set<string>();
        for (const [key, entry] of staged) if (!this.liveKeys || this.liveKeys.has(key)) {
          const previous = this.repositories.get(key);
          if (previous && !entry.error && previous.head !== entry.head) for (const id of Object.keys(entry.owners || {})) changed.add(id);
          this.repositories.set(key, entry);
        }
        for (const id of changed) this.onHeadChange?.(id);
      }
      if (scan.state === "running") scan.state = scan.controller.signal.aborted ? "cancelled" : "complete";
      if (this.activeScanId === scan.id) this.activeScanId = null;
      this.persist();
    }
  }

  private recordError(staged: Map<string, RepositoryActivity>, key: string, attemptedAt: string, error: string): void {
    if (this.liveKeys && !this.liveKeys.has(key)) return;
    const previous = this.repositories.get(key);
    staged.set(key, {
      owners: this.owners.get(key),
      head: previous?.head || null,
      latestCommitAt: previous?.latestCommitAt || null,
      checkedAt: previous?.checkedAt || null,
      attemptedAt,
      error: error.slice(0, 300),
    });
  }

  private trim(): void {
    if (this.repositories.size <= MAX_CACHE_ENTRIES) return;
    const ordered = [...this.repositories.entries()].sort((left, right) => {
      const leftAt = Date.parse(left[1].checkedAt || left[1].attemptedAt || "") || 0;
      const rightAt = Date.parse(right[1].checkedAt || right[1].attemptedAt || "") || 0;
      return rightAt - leftAt;
    });
    this.repositories = new Map(ordered.slice(0, MAX_CACHE_ENTRIES));
  }

  private trimScans(): void {
    while (this.scans.size > 8) {
      const first = this.scans.keys().next().value;
      if (!first || first === this.activeScanId) break;
      this.scans.delete(first);
    }
  }

  private persist(): void {
    this.trim();
    try {
      this.writer.save({ version: 1, repositories: Object.fromEntries(this.repositories) } satisfies ActivityFile);
    } catch {
      // The index is a performance hint; a disk failure must not fail observation.
    }
  }
}
