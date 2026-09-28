import { RepositoryRefresh } from "./repository-refresh.ts";
import { randomUUID } from "node:crypto";
import { DiffContent } from "./diff-content.ts";
import { DiffReadTasks } from "./diff-read-tasks.ts";
import { FileStatistics } from "./file-statistics.ts";
import { ObservationScheduler } from "./observation-scheduler.ts";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Git, withBackgroundGit, type GitFile } from "./git.ts";
import { Workspaces } from "./workspaces.ts";
import { Runtime } from "./runtime.ts";
import { ObservationCache, observationCacheIdentity } from "./cache.ts";
import { WorkspaceActivityIndex } from "./workspace-activity.ts";
import { gitlinkDetails } from "./gitlinks.ts";
import { workspaceBranchLabel, workspaceCurrentRefSummary } from "./workspace-refs.ts";
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
  ...(files.some(f => f.statisticsState && f.statisticsState !== "ready") ? { complete: false } : {}),
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
  diffContent: DiffContent;
  refresh: RepositoryRefresh;
  diffTasks = new DiffReadTasks();
  statistics = new FileStatistics();
  private linkedReads = new Map<string, AbortController>();
  private closing = false;
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
    this.diffContent = new DiffContent(workspaces, cache, scheduler);
    this.refresh = new RepositoryRefresh(this);
  }
  git(repo: Json, deadline?: number, signal?: AbortSignal) {
    const git = new Git(
      repo.worktreePath || repo.sourcePath,
      Math.min(
        this.workspaces.config.gitTimeout,
        this.workspaces.config.foregroundGitTimeout || this.workspaces.config.gitTimeout,
      ),
      deadline,
      signal,
    );
    git.statistics = this.statistics;
    git.statisticsComplete = () => this.scheduler.statisticsChanged(git.path);
    return git;
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
    const currentRef = roster
      ? { currentRef: null, currentRefState: "unknown" as const }
      : workspaceCurrentRefSummary(observed);
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
      workspaceBranchLabel: workspaceBranchLabel(workspace),
      ...currentRef,
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
      // A directory listing must not inspect installed binaries for every row.
      // Selected workspace detail still supplies its runtime status.
      ...(this.runtime && !roster ? { toolchain: this.runtime.summary(workspace) } : {}),
    };
  }
  async repository(repo: Json, deadline?: number, signal?: AbortSignal): Promise<Json> {
    const path = repo.worktreePath || repo.sourcePath;
    return this.cache.read(`summary:v2:${path}`, this.scheduler.token(path),
      () => this.repositorySnapshot(repo, deadline, signal), true, true, { repoPath: path });
  }
  private async repositorySnapshot(repo: Json, deadline?: number, signal?: AbortSignal): Promise<Json> {
    const started = Date.now(),
      git = this.git(repo, deadline, signal);
    const result: Json = {
      ...repo,
      registeredBranch: typeof repo.branch === "string" ? repo.branch : null,
      refState: "unknown",
      refCandidates: [],
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
      result.refState = "missing";
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
            result.refState = "unknown";
            result.status = "invalid";
            result.issues = [
              { code: "repository_invalid", message: "path is not a Git checkout" },
            ];
            return;
          }
          const head = await git.head(),
            branch = await git.branch(),
            refCandidates = !branch && head ? await git.refsAtHead(head) : [],
            [upstream, upstreamSha] = await git.upstream(),
            status = await git.status(repo.role === "gitlink-root");
          const baseSha = repo.baseSha || upstreamSha,
            baseRef = repo.baseRef || upstream;
          Object.assign(result, {
            head,
            headShort: head?.slice(0, 8) || null,
            branch: branch || "",
            refState: branch ? "attached" : "detached",
            refCandidates,
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
    const metadata = await this.workspaces.observationRecords.request('roster', { force: params.force === true });
    const orphanScan = metadata.orphanScan,
      orphanCandidates = orphanScan.candidates,
      orphanIds = new Set(orphanCandidates.map((candidate: Json) => candidate.id)),
      c = this.workspaces.config,
      workspaces = metadata.workspaces
        .filter((w: Json) => (params.includeRemoved || w.state !== "removed") &&
          !(orphanIds.has(w.id) && ["record_invalid", "adopting", "adopt_failed"].includes(w.state)));
    const discovered = metadata.discovered;
    if (signal?.aborted) throw new WorkbenchError("observer_cancelled", "observation cancelled");
    return {
      schemaVersion: protocol,
      project: { id: c.projectId, displayName: c.displayName },
      workspaces: workspaces.map((w: Json) => this.summary(w, [], true)),
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
        refreshing: [orphanScan.state, discovered.state].some(state => state === 'scanning' || state === 'stale'),
        validationKey: "roster",
        validationToken: String(this.scheduler.rosterRevision),
      },
    };
  }
  async activityRequest(params: Json): Promise<Json> {
    const action = String(params.action || "status"),
      scanId = String(params.scanId || "");
    if (action === "status") return this.activity.status(scanId);
    if (action === "cancel") return this.activity.cancel(scanId);
    if (action !== "start") throw new WorkbenchError("activity_action_invalid", "workspace activity action must be start, status, or cancel");
    const requested = Array.isArray(params.workspaceIds)
      ? [...new Set(params.workspaceIds.slice(0, 500).filter((value: unknown): value is string => typeof value === "string" && value.length <= 256))]
      : [];
    const requestedIds = new Set(requested),
      workspaces = (await this.workspaces.observationRecords.request('list')).filter((workspace: Json) => requestedIds.has(workspace.id));
    return this.activity.start(scanId, workspaces);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const abort of this.linkedReads.values()) abort.abort();
    await this.activity.close();
  }
  /** Gitlink metadata supplements the roster; it never gates cached rows. */
  private linkedSupplement(workspace: Json): Json | undefined {
    if (workspace.layout !== 'gitlink') return undefined;
    const key = `linked-supplement:v1:${workspace.id}`;
    const token = this.scheduler.workspaceToken(workspace.id) + stable(workspace);
    const retained = this.cache.retained(key);
    if (!this.closing && retained?.sourceToken !== token && !this.linkedReads.has(key)) {
      const abort = new AbortController(); this.linkedReads.set(key, abort);
      const signal = abort.signal;
      const timer = setTimeout(() => abort.abort(), Math.min(30_000, this.workspaces.config.observationTimeout)); timer.unref();
      void this.cache.read(key, token, () => withBackgroundGit(async () => {
        const current = await this.workspaces.refreshLinked(workspace, signal);
        const gitlinks = await gitlinkDetails(current.treePath, this.workspaces.config.gitTimeout, signal);
        return { workspace: current, gitlinks, sourceToken: token, observation: { state: 'ready', observedAt: now() } };
      }), true, true, { workspaceId: workspace.id }).catch(() => {}).finally(() => { clearTimeout(timer); this.linkedReads.delete(key); });
    }
    return { ...retained, pending: retained?.sourceToken !== token };
  }
  async fingerprint(repo: Json) {
    return this.scheduler.token(repo.worktreePath || repo.sourcePath);
  }
  async workspaceFingerprint(workspace: Json) {
    return stable(workspace) + workspace.repositories.map((repo: Json) => this.scheduler.token(repo.worktreePath || repo.sourcePath)).join(":");
  }
  async detail(params: Json, signal?: AbortSignal) {
    const workspaceId = String(params.workspaceId || "");
    const baseWorkspace = await this.workspaces.observationRecords.request('get', { workspaceId });
    if (params.mode === 'roster') {
      const supplement = this.linkedSupplement(baseWorkspace);
      const workspace = supplement?.workspace || baseWorkspace;
      const repositories = workspace.repositories.map((repo: Json) => this.refresh.retained(workspace, repo) || this.cache.retained(`summary:v2:${repo.worktreePath || repo.sourcePath}`) || {
        ...repo, registeredBranch: repo.branch || null, branch: '', head: null, refState: 'unknown', refCandidates: [], status: 'unknown', dirty: null, unpushed: null,
        dirtyPaths: [], issues: [], changeIssues: [], workingChanges: null, changes: null, changesLoaded: false, worktreeExists: existsSync(repo.worktreePath || repo.sourcePath), observationPending: true,
      });
      return { schemaVersion: protocol, workspace: this.summary(workspace, repositories), repositories,
        ...(supplement?.gitlinks ? { gitlinks: supplement.gitlinks } : {}),
        observation: { state: 'ready', refreshing: !!supplement?.pending, observedAt: now(), validationKey: `workspace:${workspaceId}`, validationToken: this.scheduler.workspaceToken(workspaceId) } };
    }
    // Do not make a cached detail wait for Gitlink refreshes, watcher setup, or
    // a new scheduler generation. The cache accepts an async fingerprint and
    // probes it after returning the last useful snapshot; a cold request still
    // waits for registration inside the producer below.
    const workspacePromise = this.workspaces.refreshLinked(baseWorkspace, signal);
    const registeredWorkspace = workspacePromise.then(async (workspace) => {
      await Promise.all(workspace.repositories.map((repo: Json) => this.scheduler.register(workspace.id,
        repo.worktreePath || repo.sourcePath, () => this.repository(repo, Date.now() + this.workspaces.config.observationTimeout))));
      return workspace;
    });
    if (params.force) this.scheduler.force(workspaceId);
    const currentToken = this.scheduler.workspaceToken(workspaceId);
    // Once a normal workspace has been registered, its scheduler token is a
    // cheap synchronous invalidation key. Reserve the asynchronous probe for
    // a cold process (where it is what makes persisted cache useful) and for
    // Gitlink workspaces whose repository list is refreshed from Git.
    const fingerprint = currentToken && baseWorkspace.kind !== "linked-live"
      ? stable(baseWorkspace) + currentToken
      : () => registeredWorkspace.then((workspace) => this.workspaceFingerprint(workspace));
    return this.cache.read(
      `detail:v2:${workspaceId}:${observationCacheIdentity(params)}`,
      fingerprint,
      async () => {
        const workspace = await registeredWorkspace;
        const validationToken = this.scheduler.workspaceToken(workspace.id);
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
      }, true, false, { workspaceId },
    );
  }
  async diffRead(params: Json): Promise<Json> {
    const action = params.action || 'start', requestId = String(params.requestId || '');
    if (action === 'status') return this.diffTasks.status(String(params.taskId || ''), requestId);
    if (action === 'release') return this.diffTasks.release(String(params.taskId || ''), requestId);
    if (action !== 'start') throw new WorkbenchError('request_invalid', 'Unsupported diff action');
    const context = await this.diffContent.identify(params);
    const stat = context.immutable ? null : await lstat(join(context.path, params.path)).catch(() => null);
    if (Number.isFinite(params.readDeadline) && Date.now() >= params.readDeadline) throw new WorkbenchError('observer_timeout', 'Diff start request expired before acceptance');
    const sourceKey = `${context.taskKey}:${stat?.ino}:${stat?.mtimeMs}:${stat?.size}`;
    return this.diffTasks.start(sourceKey, requestId, (signal, deadline) => this.diffContent.read(params, deadline, signal), 30_000, context.identity);
  }
  async repositoryQuery(method: string, params: Json, signal?: AbortSignal) {
    if (method === 'repository.diff') {
      const requestId = `legacy:${randomUUID()}`;
      const deadline = Date.now() + Math.min(this.workspaces.config.observationTimeout, Number(params.observationBudgetMs) || this.workspaces.config.observationTimeout);
      let task: Json | undefined;
      try {
        if (signal?.aborted) throw new WorkbenchError('observer_cancelled', 'Diff caller cancelled');
        task = await this.diffRead({ ...params, requestId, readDeadline: deadline });
        if (task.state === 'queued' || task.state === 'running') task = await this.diffTasks.wait(task.taskId, requestId, deadline, signal);
        if (task.state !== 'ready') throw new WorkbenchError(task.error?.code || 'git_diff_failed', task.error?.message || 'File read failed', task.error?.details);
        return task.result;
      } finally { if (task) this.diffTasks.release(task.taskId, requestId); }
    }
    return this.refresh.query(method, params, signal);
  }
}
