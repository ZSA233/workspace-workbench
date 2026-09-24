import { ObservationScheduler } from "./observation-scheduler.ts";
import { existsSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Git, type GitFile } from "./git.ts";
import { Workspaces } from "./workspaces.ts";
import { Runtime } from "./runtime.ts";
import { ObservationCache } from "./cache.ts";
import { WorkspaceActivityIndex } from "./workspace-activity.ts";
import { gitlinkDetails } from "./gitlinks.ts";
import {
  hash,
  issue,
  now,
  stable,
  WorkbenchError,
  type Json,
} from "./storage.ts";
export const protocol = "workspace.workbench/v1";
export const count = (files: Array<Partial<GitFile>>) => ({
  files: files.length,
  additions: files.reduce((n, f) => n + (f.additions || 0), 0),
  deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
  binaryFiles: files.filter((f) => f.binary).length,
});
export const fileJson = (file: GitFile) => ({
  ...file,
  statusLabel:
    (
      {
        A: "Added",
        M: "Modified",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
      } as Record<string, string>
    )[file.status] || "Changed",
  truncated: false,
  missing: false,
});
export class Observation {
  workspaces: Workspaces;
  runtime: Runtime | null;
  cache: ObservationCache;
  scheduler: ObservationScheduler;
  activity: WorkspaceActivityIndex;
  constructor(
    workspaces: Workspaces,
    runtime: Runtime | null,
    cache: ObservationCache,
    scheduler = new ObservationScheduler(),
  ) {
    this.workspaces = workspaces;
    this.runtime = runtime;
    this.cache = cache;
    this.scheduler = scheduler;
    this.activity = new WorkspaceActivityIndex(workspaces.config);
  }
  git(repo: Json, deadline?: number, signal?: AbortSignal) {
    return new Git(
      repo.worktreePath || repo.sourcePath,
      Math.min(
        this.workspaces.config.gitTimeout,
        this.workspaces.config.foregroundGitTimeout || this.workspaces.config.gitTimeout,
      ),
      deadline,
      signal,
    );
  }
  private async withinDeadline<T>(work: Promise<T>, deadline?: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new WorkbenchError("observer_cancelled", "observation cancelled");
    if (deadline === undefined && !signal) return work;
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0)
      throw new WorkbenchError(
        "observation_timeout",
        "observation deadline exceeded",
      );
    return new Promise<T>((resolve, reject) => {
      const timer = deadline === undefined ? undefined : setTimeout(
        () =>
          reject(
            new WorkbenchError(
              "observation_timeout",
              "observation deadline exceeded",
            ),
          ),
        remaining,
      );
      const onAbort = () => reject(new WorkbenchError("observer_cancelled", "observation cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
  summary(workspace: Json, observed: Json[] = [], roster = false): Json {
    const dirty = observed.filter((repo) => repo.dirty).length,
      unpushed = observed.filter((repo) => repo.unpushed).length,
      issues = [
        ...(workspace.issues || []),
        ...observed.flatMap((repo) => repo.issues || []),
      ];
    const blockers = observed
      .flatMap((repo) => repo.issues || [])
      .filter((e) => !["git_timeout", "observation_timeout"].includes(e.code));
    return {
      id: workspace.id,
      displayName: workspace.displayName || workspace.id,
      kind: workspace.kind || "managed",
      managed: workspace.managed !== false,
      ...(workspace.layout ? { layout: workspace.layout } : {}),
      description: workspace.description || "",
      state: workspace.state || "active",
      ...(workspace.deletion ? { deletion: workspace.deletion } : {}),
      sourceRoot: workspace.sourceRoot,
      treePath: workspace.treePath,
      repositoryCount: roster ? workspace.repositories.length : observed.length,
      dirty: roster ? null : dirty > 0,
      dirtyRepositoryCount: roster ? null : dirty,
      dirtyRepositories: dirty,
      unpushed: roster ? null : unpushed > 0,
      unpushedRepositoryCount: roster ? null : unpushed,
      unpushedRepositories: unpushed,
      claim: workspace.claim || null,
      blockerCount: blockers.length,
      attentionReasons: [
        ...(dirty ? ["dirty"] : []),
        ...(unpushed ? ["unpushed"] : []),
        ...(blockers.length ? ["needs-review"] : []),
      ],
      issues,
      createdAt: workspace.createdAt || null,
      updatedAt: workspace.updatedAt || null,
      ...this.activity.summary(workspace),
      observedAt: roster ? null : now(),
      observationStale: roster,
      ...(this.runtime ? { toolchain: this.runtime.summary(workspace) } : {}),
    };
  }
  async repository(repo: Json, deadline?: number, signal?: AbortSignal): Promise<Json> {
    const path = repo.worktreePath || repo.sourcePath;
    return this.cache.read(`summary:${path}`, this.scheduler.token(path),
      () => this.repositorySnapshot(repo, deadline, signal), true, true, { repoPath: path });
  }
  private async repositorySnapshot(repo: Json, deadline?: number, signal?: AbortSignal): Promise<Json> {
    const started = Date.now(),
      git = this.git(repo, deadline, signal);
    const result: Json = {
      ...repo,
      status: "clean",
      branch: "",
      head: null,
      headShort: null,
      baseRef: null,
      baseSha: null,
      baseShaShort: null,
      upstream: null,
      upstreamSha: null,
      ahead: null,
      behind: null,
      pushed: null,
      dirty: false,
      unpushed: false,
      dirtyPaths: [],
      branchScopeAvailable: false,
      worktreeExists: existsSync(git.path),
      issues: [],
      changeIssues: [],
      changesLoaded: false,
      workingChanges: null,
      changes: null,
    };
    if (!result.worktreeExists) {
      result.status = "missing";
      result.issues = [
        {
          code: "worktree_missing",
          message: "configured worktree does not exist",
          path: git.path,
        },
      ];
      return result;
    }
    try {
      await this.withinDeadline(
        (async () => {
          if (!(await git.valid()) || await git.root() !== git.path) {
            result.status = "invalid";
            result.issues = [
              { code: "repository_invalid", message: "path is not a Git checkout" },
            ];
            return;
          }
          const head = await git.head(),
            branch = await git.branch(),
            [upstream, upstreamSha] = await git.upstream(),
            status = await git.status(repo.role === "gitlink-root");
          const baseSha = repo.baseSha || upstreamSha,
            baseRef = repo.baseRef || upstream;
          Object.assign(result, {
            head,
            headShort: head?.slice(0, 8) || null,
            branch: branch || "",
            upstream,
            upstreamSha,
            baseRef,
            baseSha,
            baseShaShort: baseSha?.slice(0, 8) || null,
            dirty: !!status.length,
            status: status.length ? "dirty" : branch ? "clean" : "detached",
            branchScopeAvailable: !!baseSha,
          });
          if (head && upstreamSha) {
            const [behind, ahead] = (
              await git.text([
                "rev-list",
                "--left-right",
                "--count",
                `${upstreamSha}...${head}`,
              ])
            )
              .split(/\s+/)
              .map(Number);
            Object.assign(result, {
              ahead,
              behind,
              unpushed: ahead > 0,
              pushed: ahead === 0,
            });
          }
          result.dirtyPaths = status.map(([, path]) => path);
          // Expensive numstat and branch diffs belong to Changes, not summary.
          result.workingChanges = null;
          result.changes = null;
          result.changesLoaded = false;
        })(),
        deadline,
        signal,
      );
    } catch (error) {
      result.status = "error";
      result.issues.push(issue(error));
    }
    if (!["error", "missing", "invalid"].includes(result.status)) this.scheduler.observed(git.path);
    return { ...result, observedAt: now(), durationMs: Date.now() - started };
  }
  async list(params: Json, signal?: AbortSignal) {
    const orphanScan = await this.workspaces.orphanSnapshot(params.force === true, 250, signal),
      orphanCandidates = orphanScan.candidates,
      orphanIds = new Set(orphanCandidates.map((candidate: Json) => candidate.id)),
      c = this.workspaces.config,
      workspaces = this.workspaces
        .list()
        .filter((w) => (params.includeRemoved || w.state !== "removed") &&
          !(orphanIds.has(w.id) && ["record_invalid", "adopting", "adopt_failed"].includes(w.state)));
    const discovered = await this.workspaces.discoverySnapshot(false, 0, signal);
    if (signal?.aborted) throw new WorkbenchError("observer_cancelled", "observation cancelled");
    return {
      schemaVersion: protocol,
      project: { id: c.projectId, displayName: c.displayName },
      workspaces: workspaces.map((w) => this.summary(w, [], true)),
      orphanCandidates,
      capabilities: this.workspaces.capabilities(),
      discoveredCandidates: discovered.repositories,
      discovery: { state: discovered.state, incomplete: discovered.incomplete, ...(discovered.reason ? { reason: discovered.reason } : {}), scannedDirectories: discovered.scannedDirectories, ...(discovered.startedAt ? { startedAt: discovered.startedAt } : {}), ...(discovered.completedAt ? { completedAt: discovered.completedAt } : {}) },
      orphanScan: {
        state: orphanScan.state,
        scannedDirectories: orphanScan.scannedDirectories,
        ...(orphanScan.reason ? { reason: orphanScan.reason } : {}),
        ...(orphanScan.startedAt ? { startedAt: orphanScan.startedAt } : {}),
        ...(orphanScan.completedAt ? { completedAt: orphanScan.completedAt } : {}),
      },
      observation: {
        state: "ready",
        observedAt: now(),
        durationMs: 0,
        deferred: true,
      },
    };
  }
  activityRequest(params: Json): Json {
    const action = String(params.action || "status"),
      scanId = String(params.scanId || "");
    if (action === "status") return this.activity.status(scanId);
    if (action === "cancel") return this.activity.cancel(scanId);
    if (action !== "start") throw new WorkbenchError("activity_action_invalid", "workspace activity action must be start, status, or cancel");
    const requested = Array.isArray(params.workspaceIds)
      ? [...new Set(params.workspaceIds.slice(0, 500).filter((value: unknown): value is string => typeof value === "string" && value.length <= 256))]
      : [];
    const requestedIds = new Set(requested),
      workspaces = this.workspaces.list().filter((workspace) => requestedIds.has(workspace.id));
    return this.activity.start(scanId, workspaces);
  }
  async close(): Promise<void> {
    await this.activity.close();
  }
  async fingerprint(repo: Json) {
    return this.scheduler.token(repo.worktreePath || repo.sourcePath);
  }
  async workspaceFingerprint(workspace: Json) {
    return stable(workspace) + workspace.repositories.map((repo: Json) => this.scheduler.token(repo.worktreePath || repo.sourcePath)).join(":");
  }
  async detail(params: Json, signal?: AbortSignal) {
    const workspace = await this.workspaces.refreshLinked(this.workspaces.get(String(params.workspaceId || "")), signal);
    await Promise.all(workspace.repositories.map((repo: Json) => this.scheduler.register(workspace.id,
      repo.worktreePath || repo.sourcePath, () => this.repository(repo, Date.now() + this.workspaces.config.observationTimeout))));
    if (params.force) this.scheduler.force(workspace.id);
    const validationToken = this.scheduler.workspaceToken(workspace.id);
    return this.cache.read(
      `detail:${workspace.id}:${stable(params)}`,
      await this.workspaceFingerprint(workspace),
      async () => {
        const start = Date.now(),
          deadline = start + Math.min(this.workspaces.config.observationTimeout, Number(params.observationBudgetMs) || this.workspaces.config.observationTimeout),
          repositories: Json[] = [];
        // Keep four repository workers active. A slow repository occupies one
        // worker until its deadline, while completed workers continue with
        // later repositories instead of making the whole workspace wait.
        let nextRepository = 0;
        const observeNext = async () => {
          while (nextRepository < workspace.repositories.length) {
            const index = nextRepository++;
            repositories[index] = await this.repository(
              workspace.repositories[index],
              deadline,
              signal,
            );
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(4, workspace.repositories.length) },
            () => observeNext(),
          ),
        );
        repositories.sort((a, b) =>
          String(a.repoPath).localeCompare(String(b.repoPath)),
        );
        const transient = repositories.some((repo) =>
          [...repo.issues, ...repo.changeIssues].some(
            (e: Json) =>
              ![
                "worktree_missing",
                "repository_invalid",
                "record_invalid",
                "base_missing",
                "workspace_dirty",
                "unpushed",
              ].includes(e.code),
          ),
        );
        return {
          schemaVersion: protocol,
          workspace: this.summary(workspace, repositories),
          repositories,
          ...(workspace.layout === "gitlink" ? { gitlinks: await gitlinkDetails(workspace.treePath, Math.min(this.workspaces.config.gitTimeout, this.workspaces.config.foregroundGitTimeout || this.workspaces.config.gitTimeout), signal).catch(error => [{ path: "", issue: issue(error).code }]) } : {}),
          observation: {
            state: transient ? "partial" : "ready",
            validationKey: `workspace:${workspace.id}`, validationToken,
            observedAt: now(),
            durationMs: Date.now() - start,
          },
        };
      }, true, false, { workspaceId: workspace.id },
    );
  }
  async repositoryQuery(method: string, params: Json, signal?: AbortSignal) {
    if (method === "repository.diff") {
      if (typeof params.path !== "string" || !params.path)
        throw new WorkbenchError("path_required", "path is required");
      if (isAbsolute(params.path) || params.path.split("/").includes(".."))
        throw new WorkbenchError(
          "path_invalid",
          "diff path must remain inside the repository",
        );
    }
    const workspace = await this.workspaces.refreshLinked(this.workspaces.get(String(params.workspaceId || "")), signal),
      repo = this.workspaces.repository(
        workspace,
        params.repoPath || params.repositoryId || "",
      );
    await this.scheduler.register(workspace.id, repo.worktreePath || repo.sourcePath,
      () => this.repository(repo, Date.now() + this.workspaces.config.observationTimeout));
    if (params.force) this.scheduler.force(workspace.id);
    const git = this.git(repo);
    const validationScope = method === "repository.graph" || params.scope === "branch" || params.scope === "commit" ? "refs" : "working";
    const validationToken = this.scheduler.token(git.path, validationScope);
    let marker = "";
    if (params.path)
      try {
        const st = lstatSync(join(git.path, params.path));
        marker = `${st.mtimeMs}:${st.size}`;
      } catch {}
    return this.cache.read(
      `${method}:${workspace.id}:${stable(params)}`,
      this.scheduler.token(git.path, method === "repository.graph" || params.scope === "branch" || params.scope === "commit" ? "refs" : "working") + stable(repo) + marker,
      async () => {
        const deadline = Date.now() + Math.min(this.workspaces.config.observationTimeout, Number(params.observationBudgetMs) || this.workspaces.config.observationTimeout);
        return this.withinDeadline(
          (async () => {
            const git = this.git(repo, deadline, signal),
              [, upstream] = await git.upstream(),
              baseSha = repo.baseSha || upstream,
              scope = params.scope || "branch",
              head = await git.head();
            const common = {
              schemaVersion: protocol,
              workspaceId: workspace.id,
              repoPath: repo.repoPath,
              head,
              observation: { state: "ready", observedAt: now(), validationKey: `${git.path}#${validationScope}`, validationToken },
            };
            if (method === "repository.graph") {
              const historyMode =
                  params.historyMode ||
                  (workspace.kind === "live" ? "full" : "branch"),
                maxCommits = Math.max(
                  1,
                  Math.min(200, Number(params.maxCommits) || 50),
                ),
                graph = await git.graph(historyMode === "branch" && !baseSha ? "full" : historyMode, baseSha, maxCommits);
              return {
                ...common,
                branch: await git.branch(),
                baseSha,
                truncated: graph.hasOlder,
                ...graph,
              };
            }
            if (method === "repository.changes") {
              const files = (await git.files(scope, baseSha, params.commitSha, repo.role === "gitlink-root")).map(
                fileJson,
              );
              return {
                ...common,
                scope,
                baseSha,
                files,
                summary: count(files),
                issues: [],
              };
            }
            const diff = await git.diff(
                scope,
                String(params.path || ""),
                baseSha,
                params.commitSha,
              ),
              bytes = Buffer.from(diff.patch),
              limit = this.workspaces.config.maxDiffBytes;
            // Drop a partial UTF-8 sequence at the truncation boundary.
            let end = Math.min(bytes.length, limit);
            while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80)
              end--;
            return {
              ...common,
              scope,
              path: params.path,
              baseSha: diff.left,
              left: diff.left,
              right: diff.right,
              patch: bytes.subarray(0, end).toString("utf8"),
              head: diff.right || head,
              binary: /Binary files |GIT binary patch/.test(diff.patch),
              truncated: bytes.length > limit,
            };
          })(),
          deadline,
          signal,
        );
      }, true, false, { workspaceId: workspace.id, repoPath: git.path },
    );
  }
}
