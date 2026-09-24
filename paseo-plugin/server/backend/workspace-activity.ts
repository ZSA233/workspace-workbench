import { join, resolve } from "node:path";
import { Git, withBackgroundGit } from "./git.ts";
import type { Config } from "./config.ts";
import { atomicJson, hash, now, optionalJson, type Json } from "./storage.ts";

const CACHE_TTL_MS = 30 * 60_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;

type RepositoryActivity = {
  head: string | null;
  latestCommitAt: string | null;
  checkedAt: string | null;
  attemptedAt?: string;
  error?: string;
};

type ActivityFile = { version: 1; repositories: Record<string, RepositoryActivity> };
type RepositoryTarget = { key: string; path: string };
type ScanState = "running" | "complete" | "cancelled";

type Scan = {
  id: string;
  state: ScanState;
  workspaceIds: string[];
  total: number;
  completed: number;
  errors: number;
  controller: AbortController;
  promise?: Promise<void>;
};

export type WorkspaceActivitySummary = {
  latestCommitAt: string | null;
  latestCommitObservedAt: string | null;
  latestCommitState: "ready" | "pending" | "partial" | "unknown";
};

/** Persisted, on-demand HEAD metadata. It never polls and never walks commit history. */
export class WorkspaceActivityIndex {
  private readonly path: string;
  private readonly config: Config;
  private repositories = new Map<string, RepositoryActivity>();
  private scans = new Map<string, Scan>();
  private cancelledScanIds = new Set<string>();
  private activeScanId: string | null = null;

  constructor(config: Config) {
    this.config = config;
    this.path = join(config.stateRoot, "workspace-activity.json");
    try {
      const saved = optionalJson(this.path);
      if (saved.version === 1 && saved.repositories && typeof saved.repositories === "object") {
        for (const [key, rawValue] of Object.entries(saved.repositories as Record<string, Json>)) {
          const value = rawValue as Json;
          if (value && typeof value === "object" && typeof value.latestCommitAt !== "undefined") {
            const latestCommitAt = typeof value.latestCommitAt === "string" && Number.isFinite(Date.parse(value.latestCommitAt)) ? value.latestCommitAt : null;
            const checkedAt = typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null;
            this.repositories.set(key, {
              head: typeof value.head === "string" ? value.head : null,
              latestCommitAt,
              checkedAt,
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

  start(scanId: string, workspaces: Json[]): Json {
    if (!scanId || scanId.length > 128) return { state: "error", error: "scan_id_invalid" };
    if (this.cancelledScanIds.has(scanId)) return { scanId, state: "cancelled", total: 0, completed: 0, errors: 0 };
    const existing = this.scans.get(scanId);
    if (existing) return this.status(scanId);
    const previousScan = this.activeScanId ? this.scans.get(this.activeScanId) : undefined;
    if (previousScan) this.cancel(previousScan.id);

    const workspaceIds = [...new Set(workspaces.map((workspace) => String(workspace.id || "")).filter(Boolean))];
    const targets = this.targets(workspaces);
    const at = Date.now();
    const stale = targets.filter((target) => {
      const entry = this.repositories.get(target.key);
      if (entry?.checkedAt && at - Date.parse(entry.checkedAt) < CACHE_TTL_MS) return false;
      if (entry?.attemptedAt && entry.error && at - Date.parse(entry.attemptedAt) < FAILURE_RETRY_MS) return false;
      return true;
    });
    const scan: Scan = {
      id: scanId,
      state: stale.length ? "running" : "complete",
      workspaceIds,
      total: stale.length,
      completed: 0,
      errors: 0,
      controller: new AbortController(),
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
  }

  private async run(scan: Scan, targets: RepositoryTarget[]): Promise<void> {
    try {
      for (const target of targets) {
        if (scan.controller.signal.aborted) break;
        const attemptedAt = now();
        try {
          const timeout = Math.min(this.config.gitTimeout, this.config.foregroundGitTimeout || this.config.gitTimeout);
          const result = await withBackgroundGit(() => new Git(target.path, timeout, undefined, scan.controller.signal)
            .run(["show", "-s", "--format=%H%x00%cI", "HEAD"], false));
          if (scan.controller.signal.aborted) break;
          const [head, latestCommitAt] = result.stdout.trim().split("\0");
          if (result.code === 0 && head && Number.isFinite(Date.parse(latestCommitAt || ""))) {
            this.repositories.set(target.key, { head, latestCommitAt, checkedAt: now(), attemptedAt });
          } else if (result.code === 0 && !head) {
            this.repositories.set(target.key, { head: null, latestCommitAt: null, checkedAt: now(), attemptedAt });
          } else {
            this.recordError(target.key, attemptedAt, result.stderr.trim() || "commit_unavailable");
            scan.errors++;
          }
        } catch (error) {
          if (scan.controller.signal.aborted) break;
          this.recordError(target.key, attemptedAt, error instanceof Error ? error.message : String(error));
          scan.errors++;
        }
        scan.completed++;
      }
    } finally {
      if (scan.state === "running") scan.state = scan.controller.signal.aborted ? "cancelled" : "complete";
      if (this.activeScanId === scan.id) this.activeScanId = null;
      this.persist();
    }
  }

  private recordError(key: string, attemptedAt: string, error: string): void {
    const previous = this.repositories.get(key);
    this.repositories.set(key, {
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
      atomicJson(this.path, { version: 1, repositories: Object.fromEntries(this.repositories) } satisfies ActivityFile);
    } catch {
      // The index is a performance hint; a disk failure must not fail observation.
    }
  }
}
