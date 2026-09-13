import { existsSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Git, type GitFile } from "./git.ts";
import { Workspaces } from "./workspaces.ts";
import { Runtime } from "./runtime.ts";
import { ObservationCache } from "./cache.ts";
import { discover } from "./config.ts";
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
  constructor(
    workspaces: Workspaces,
    runtime: Runtime | null,
    cache: ObservationCache,
  ) {
    this.workspaces = workspaces;
    this.runtime = runtime;
    this.cache = cache;
  }
  git(repo: Json) {
    return new Git(
      repo.worktreePath || repo.sourcePath,
      this.workspaces.config.gitTimeout,
    );
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
      observedAt: roster ? null : now(),
      observationStale: roster,
      ...(this.runtime ? { toolchain: this.runtime.summary(workspace) } : {}),
    };
  }
  async repository(repo: Json): Promise<Json> {
    const started = Date.now(),
      git = this.git(repo);
    const result: Json = {
      ...repo,
      status: "clean",
      branch: null,
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
      workingChanges: count([]),
      changes: count([]),
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
      if (!(await git.valid())) {
        result.status = "invalid";
        result.issues = [
          { code: "repository_invalid", message: "path is not a Git checkout" },
        ];
        return result;
      }
      const head = await git.head(),
        branch = await git.branch(),
        [upstream, upstreamSha] = await git.upstream(),
        status = await git.status();
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
      if (status.length) {
        const files = await git.files("working");
        result.workingChanges = count(files);
        result.dirtyPaths = files.map((file) => file.path);
      }
      if (baseSha && head && baseSha !== head)
        try {
          result.changes = count(await git.files("branch", baseSha));
        } catch (error) {
          result.changeIssues = [issue(error)];
        }
      result.changesLoaded = true;
    } catch (error) {
      result.status = "error";
      result.issues.push(issue(error));
    }
    return { ...result, observedAt: now(), durationMs: Date.now() - started };
  }
  list(params: Json) {
    const c = this.workspaces.config,
      workspaces = this.workspaces
        .list()
        .filter((w) => params.includeRemoved || w.state !== "removed");
    return {
      schemaVersion: protocol,
      project: { id: c.projectId, displayName: c.displayName },
      workspaces: workspaces.map((w) => this.summary(w, [], true)),
      capabilities: this.workspaces.capabilities(),
      discoveredCandidates: discover(c),
      observation: {
        state: "ready",
        observedAt: now(),
        durationMs: 0,
        deferred: true,
      },
    };
  }
  async fingerprint(repo: Json) {
    const git = this.git(repo);
    if (!existsSync(git.path)) return "missing";
    try {
      const dir = await git.text(["rev-parse", "--absolute-git-dir"]);
      return hash(
        stable([
          await git.head(),
          await git.branch(),
          ...["HEAD", "index", "logs/HEAD"].map((name) => {
            try {
              const st = lstatSync(join(dir, name));
              return `${st.mtimeMs}:${st.size}`;
            } catch {
              return "missing";
            }
          }),
        ]),
      );
    } catch {
      return "unavailable";
    }
  }
  async detail(params: Json) {
    const workspace = this.workspaces.get(String(params.workspaceId || ""));
    const fingerprint = hash(
      stable(workspace) +
        (
          await Promise.all(
            workspace.repositories.map((repo: Json) => this.fingerprint(repo)),
          )
        ).join(":"),
    );
    return this.cache.read(
      `detail:${workspace.id}:${stable(params)}`,
      fingerprint,
      async () => {
        const start = Date.now(),
          repositories: Json[] = [];
        // Bound repository fan-out so large workspaces cannot exhaust subprocesses.
        for (let i = 0; i < workspace.repositories.length; i += 4)
          repositories.push(
            ...(await Promise.all(
              workspace.repositories
                .slice(i, i + 4)
                .map((repo: Json) => this.repository(repo)),
            )),
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
          observation: {
            state: transient ? "partial" : "ready",
            observedAt: now(),
            durationMs: Date.now() - start,
          },
        };
      },
    );
  }
  async repositoryQuery(method: string, params: Json) {
    if (method === "repository.diff") {
      if (typeof params.path !== "string" || !params.path)
        throw new WorkbenchError("path_required", "path is required");
      if (isAbsolute(params.path) || params.path.split("/").includes(".."))
        throw new WorkbenchError(
          "path_invalid",
          "diff path must remain inside the repository",
        );
    }
    const workspace = this.workspaces.get(String(params.workspaceId || "")),
      repo = this.workspaces.repository(
        workspace,
        params.repoPath || params.repositoryId || "",
      ),
      git = this.git(repo);
    let marker = "";
    if (params.path)
      try {
        const st = lstatSync(join(git.path, params.path));
        marker = `${st.mtimeMs}:${st.size}`;
      } catch {}
    const fingerprint = (await this.fingerprint(repo)) + stable(repo) + marker;
    return this.cache.read(
      `${method}:${workspace.id}:${stable(params)}`,
      fingerprint,
      async () => {
        const [, upstream] = await git.upstream(),
          baseSha = repo.baseSha || upstream,
          scope = params.scope || "branch",
          head = await git.head();
        const common = {
          schemaVersion: protocol,
          workspaceId: workspace.id,
          repoPath: repo.repoPath,
          head,
          observation: { state: "ready", observedAt: now() },
        };
        if (method === "repository.graph") {
          const historyMode =
              params.historyMode ||
              (workspace.kind === "live" ? "full" : "branch"),
            maxCommits = Math.max(
              1,
              Math.min(200, Number(params.maxCommits) || 50),
            ),
            graph = await git.graph(historyMode, baseSha, maxCommits);
          return {
            ...common,
            branch: await git.branch(),
            baseSha,
            truncated: graph.hasOlder,
            ...graph,
          };
        }
        if (method === "repository.changes") {
          const files = (await git.files(scope, baseSha, params.commitSha)).map(
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
      },
    );
  }
}
