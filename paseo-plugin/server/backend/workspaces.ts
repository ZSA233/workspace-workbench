import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { type Config, type Repository, repositoryPath } from "./config.ts";
import { Git } from "./git.ts";
import {
  atomicJson,
  canonical,
  hash,
  inside,
  now,
  optionalJson,
  readJson,
  SerialQueue,
  slug,
  WorkbenchError,
  issue,
  type Json,
} from "./storage.ts";

function pythonJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${pythonJson(key)}: ${pythonJson(value[key])}`)
      .join(", ")}}`;
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export class Workspaces {
  config: Config;
  readonly mutations = new SerialQueue();
  constructor(config: Config) {
    this.config = config;
    for (const root of [
      config.stateRoot,
      config.workspaceRoot,
      config.recordsRoot,
      config.treesRoot,
    ])
      mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  capabilities() {
    const c = this.config;
    return {
      observe: true,
      create: c.managementEnabled,
      prepare: c.managementEnabled && !!c.toolchain,
      agent: c.agentEnabled,
      cleanup: c.managementEnabled,
      remove: c.managementEnabled,
      restore: c.managementEnabled,
      permanentDelete: c.managementEnabled,
    };
  }
  sourceRecord(repo: Repository): Json {
    const path = repositoryPath(this.config, repo);
    return {
      id: repo.id,
      name: repo.name,
      repoPath: repo.path,
      sourcePath: path,
      worktreePath: path,
      baseRef: null,
      baseSha: null,
      branch: null,
      mode: "live",
      role: repo.role,
    };
  }
  recordPath(id: string) {
    return join(this.config.recordsRoot, `${slug(id)}.json`);
  }
  read(path: string): Json | null {
    try {
      const value = readJson(path);
      if (
        value.schemaVersion !== 1 ||
        value.id !== basename(path, ".json") ||
        !Array.isArray(value.repositories) ||
        !inside(value.treePath, this.config.treesRoot)
      )
        return null;
      for (const repo of value.repositories) {
        const configured = this.config.repositories.find(
          (item) => item.id === repo.id,
        );
        if (
          !configured ||
          canonical(repo.sourcePath) !==
            repositoryPath(this.config, configured) ||
          !inside(repo.worktreePath, value.treePath)
        )
          return null;
      }
      return value;
    } catch {
      return null;
    }
  }
  list(): Json[] {
    const c = this.config;
    const main = {
      id: "main",
      displayName: c.mainWorkspaceName,
      kind: "live",
      managed: false,
      description: "Current source checkouts",
      state: "active",
      sourceRoot: c.sourceRoot,
      treePath: c.sourceRoot,
      repositories: c.repositories
        .filter((repo) => repo.enabled)
        .map((repo) => this.sourceRecord(repo)),
      createdAt: null,
      updatedAt: null,
    };
    const records = readdirSync(c.recordsRoot)
      .filter((path) => path.endsWith(".json"))
      .map(
        (path) =>
          this.read(join(c.recordsRoot, path)) || {
            id: basename(path, ".json"),
            displayName: basename(path, ".json"),
            kind: "managed",
            managed: true,
            state: "record_invalid",
            repositories: [],
          },
      );
    records.sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(
        String(a.updatedAt || a.createdAt || ""),
      ),
    );
    return [main, ...records];
  }
  get(id: string): Json {
    if (id === "main") return this.list()[0];
    const path = this.recordPath(id),
      value = this.read(path);
    if (!value || value.id !== id)
      throw new WorkbenchError(
        existsSync(path) ? "record_invalid" : "workspace_missing",
        `workspace unavailable: ${id}`,
      );
    return value;
  }
  save(value: Json, manifest = true): Json {
    const record: Json = { ...value, updatedAt: now() };
    atomicJson(this.recordPath(record.id), record);
    // The durable record owns recovery. A manifest failure is visible and a
    // repeated request reconciles it without repeating Git mutations.
    if (manifest && existsSync(record.treePath))
      atomicJson(join(record.treePath, ".workspace/manifest.json"), record);
    return record;
  }
  matches(repo: Json, ref: unknown) {
    if (typeof ref !== "string" || !ref.trim()) return false;
    return (
      [
        repo.id,
        repo.name,
        repo.repoPath,
        repo.sourcePath,
        repo.worktreePath,
      ].includes(ref) ||
      [repo.sourcePath, repo.worktreePath]
        .filter(Boolean)
        .some(
          (path) =>
            canonical(resolve(this.config.sourceRoot, ref)) === canonical(path),
        )
    );
  }
  repository(workspace: Json, ref: unknown): Json {
    const matches = workspace.repositories.filter((repo: Json) =>
      this.matches(repo, ref),
    );
    if (matches.length !== 1)
      throw new WorkbenchError(
        matches.length ? "repository_ambiguous" : "repository_missing",
        "repository reference is unavailable or ambiguous",
      );
    return matches[0];
  }
  select(params: Json): Array<{ repo: Repository; baseRef: string | null }> {
    const candidates = this.config.repositories.filter((repo) => repo.enabled);
    if (
      params.repositories !== undefined &&
      !Array.isArray(params.repositories)
    )
      throw new WorkbenchError(
        "request_invalid",
        "repositories must be an array",
      );
    const selected: Repository[] = [];
    for (const requested of params.repositories ??
      candidates.map((repo) => repo.id)) {
      const matches = candidates.filter((repo) =>
        this.matches(this.sourceRecord(repo), requested),
      );
      if (matches.length !== 1)
        throw new WorkbenchError(
          "repository_invalid",
          "unknown, disabled or ambiguous repository",
        );
      if (!selected.includes(matches[0])) selected.push(matches[0]);
    }
    if (!selected.length)
      throw new WorkbenchError(
        "repositories_empty",
        "select at least one repository",
      );
    const bases = params.baseRefs ?? {};
    if (!bases || typeof bases !== "object" || Array.isArray(bases))
      throw new WorkbenchError("request_invalid", "baseRefs must be an object");
    for (const [key, value] of Object.entries(bases))
      if (
        typeof value !== "string" ||
        !value.trim() ||
        !selected.some((repo) => this.matches(this.sourceRecord(repo), key))
      )
        throw new WorkbenchError("request_invalid", "invalid base ref mapping");
    return selected.map((repo) => {
      const refs = Object.entries(bases)
        .filter(([key]) => this.matches(this.sourceRecord(repo), key))
        .map(([, value]) => String(value));
      if (new Set(refs).size > 1)
        throw new WorkbenchError("request_invalid", "conflicting base refs");
      return { repo, baseRef: refs[0] || null };
    });
  }
  assertIdle(id: string) {
    try {
      const bindings =
        optionalJson(join(this.config.stateRoot, "agent-bindings.json"))
          .bindings || [];
      if (!Array.isArray(bindings)) throw new Error("invalid bindings");
      if (
        bindings.some(
          (item: Json) =>
            item.workspaceId === id &&
            ![
              "completed",
              "failed",
              "cancelled",
              "stopped",
              "idle",
              "archived",
              "closed",
              "error",
            ].includes(item.status),
        )
      )
        throw new WorkbenchError(
          "workspace_task_active",
          "finish execution before changing workspace scope",
        );
      const reviews = join(this.config.stateRoot, "reviews");
      if (existsSync(reviews))
        for (const path of readdirSync(reviews).filter((path) =>
          path.endsWith(".json"),
        )) {
          const item = readJson(join(reviews, path));
          if (
            item.workspaceId === id &&
            ![
              "approved",
              "stopped",
              "failed",
              "blocked",
              "limit_reached",
            ].includes(item.status)
          )
            throw new WorkbenchError(
              "workspace_task_active",
              "finish review before changing workspace scope",
            );
        }
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError(
        "workspace_task_status_unavailable",
        "persisted task state could not be checked",
      );
    }
  }
  async plan(
    repo: Repository,
    workspace: Json,
    ref: string | null,
    template = "obs/{workspace}/{repository}",
  ): Promise<Json> {
    const source = repositoryPath(this.config, repo),
      git = new Git(source, this.config.operationTimeout);
    if (!(await git.valid()))
      throw new WorkbenchError(
        "repository_invalid",
        "configured source is not a Git repository",
      );
    const branch = template
      .replaceAll("{workspace}", workspace.id)
      .replaceAll("{repository}", repo.id);
    if (
      !/^[A-Za-z0-9._/-]+$/.test(branch) ||
      branch.includes("..") ||
      branch.startsWith("/")
    )
      throw new WorkbenchError("branch_invalid", "invalid branch template");
    await git.run(["check-ref-format", "--branch", branch]);
    const worktreePath = canonical(join(workspace.treePath, repo.id));
    if (!inside(worktreePath, workspace.treePath))
      throw new WorkbenchError(
        "path_invalid",
        "invalid repository worktree path",
      );
    const baseRef = ref || repo.defaultBase || (await git.branch()) || "HEAD";
    if (
      existsSync(worktreePath) ||
      (await git.run(["show-ref", "--verify", `refs/heads/${branch}`], false))
        .code === 0
    )
      throw new WorkbenchError(
        "branch_exists",
        "target path or branch already exists",
      );
    return {
      ...this.sourceRecord(repo),
      worktreePath,
      branch,
      baseRef,
      baseSha: await git.commit(baseRef),
      mode: "managed",
    };
  }
  async materialize(plan: Json, workspace: Json) {
    const configured = this.config.repositories.find(
      (repo) => repo.id === plan.id,
    );
    if (
      !configured ||
      canonical(plan.sourcePath) !== repositoryPath(this.config, configured) ||
      canonical(plan.worktreePath) !==
        canonical(join(workspace.treePath, plan.id)) ||
      !inside(plan.worktreePath, workspace.treePath)
    )
      throw new WorkbenchError(
        "worktree_identity_changed",
        "invalid operation journal identity",
      );
    const git = new Git(plan.sourcePath, this.config.operationTimeout);
    if ((await git.commit(plan.baseSha)) !== plan.baseSha)
      throw new WorkbenchError(
        "worktree_identity_changed",
        "invalid journal base",
      );
    await git.run(["check-ref-format", "--branch", plan.branch]);
    if (await git.completed(plan.worktreePath, plan.branch, plan.baseSha))
      return;
    if (existsSync(plan.worktreePath))
      throw new WorkbenchError(
        "worktree_identity_changed",
        "existing worktree changed; preserved for inspection",
      );
    const ref = await git.run(
      ["show-ref", "--verify", `refs/heads/${plan.branch}`],
      false,
    );
    if (!ref.code && ref.stdout.split(/\s+/)[0] !== plan.baseSha)
      throw new WorkbenchError(
        "worktree_identity_changed",
        "branch changed; preserved",
      );
    try {
      await git.run(
        ref.code
          ? [
              "worktree",
              "add",
              "-b",
              plan.branch,
              plan.worktreePath,
              plan.baseSha,
            ]
          : ["worktree", "add", plan.worktreePath, plan.branch],
      );
    } catch (error) {
      if (
        !(error instanceof WorkbenchError) ||
        error.code !== "git_timeout" ||
        !(await git.completed(plan.worktreePath, plan.branch, plan.baseSha))
      )
        throw error;
    }
  }
  async create(params: Json) {
    if (!params.name?.trim())
      throw new WorkbenchError(
        "workspace_name_required",
        "workspace name is required",
      );
    const id = slug(params.id || params.name),
      requestHash = hash(pythonJson(params));
    if (id === "main")
      throw new WorkbenchError(
        "workspace_id_reserved",
        "reserved workspace id",
      );
    const selected = this.select(params),
      path = this.recordPath(id);
    let workspace: Json;
    if (existsSync(path)) {
      workspace = this.get(id);
      if (
        workspace.requestHash !== requestHash ||
        !["active", "creating", "create_failed"].includes(workspace.state)
      )
        throw new WorkbenchError(
          "workspace_exists",
          "workspace already exists",
        );
      if (workspace.state === "active") return this.save(workspace);
    } else {
      const treePath = canonical(join(this.config.treesRoot, id));
      if (!inside(treePath, this.config.treesRoot) || existsSync(treePath))
        throw new WorkbenchError(
          "path_invalid",
          "workspace target already exists",
        );
      workspace = {
        schemaVersion: 1,
        requestHash,
        id,
        displayName: params.name.trim(),
        kind: "managed",
        managed: true,
        description: params.description || "",
        state: "creating",
        sourceRoot: this.config.sourceRoot,
        treePath,
        repositoryIds: selected.map((item) => item.repo.id),
        repositories: [],
        createdAt: now(),
      };
      for (const item of selected)
        workspace.repositories.push(
          await this.plan(
            item.repo,
            workspace,
            item.baseRef,
            params.branchTemplate,
          ),
        );
      mkdirSync(treePath, { recursive: true, mode: 0o700 });
      this.save(workspace, false);
    }
    try {
      for (const item of selected) {
        let plan = workspace.repositories.find(
          (repo: Json) => repo.id === item.repo.id,
        );
        if (!plan) {
          plan = await this.plan(
            item.repo,
            workspace,
            item.baseRef,
            params.branchTemplate,
          );
          workspace.repositories.push(plan);
          this.save(workspace, false);
        }
        await this.materialize(plan, workspace);
      }
      workspace.state = "active";
      delete workspace.issues;
      return this.save(workspace);
    } catch (error) {
      workspace.state = "create_failed";
      workspace.issues = [issue(error)];
      this.save(workspace, false);
      throw new WorkbenchError(
        "create_failed",
        "creation failed; retry the same request to recover",
        workspace.issues,
      );
    }
  }
  async add(params: Json) {
    const workspace = this.get(String(params.workspaceId || ""));
    if (!workspace.managed || workspace.state !== "active")
      throw new WorkbenchError(
        "workspace_state_invalid",
        "only active managed workspaces can add repositories",
      );
    this.assertIdle(workspace.id);
    if (!Array.isArray(params.repositories) || !params.repositories.length)
      throw new WorkbenchError("request_invalid", "select repositories to add");
    const journal = Object.assign(
        Object.create(null),
        workspace.repositoryAdditions || {},
      ),
      plans: Json[] = [];
    for (const { repo, baseRef } of this.select(params)) {
      const existing = workspace.repositories.find(
          (item: Json) => item.id === repo.id,
        ),
        pending = journal[repo.id];
      if (existing) {
        if (baseRef && baseRef !== existing.baseRef)
          throw new WorkbenchError(
            "repository_base_conflict",
            "repository already added with a different base",
          );
        continue;
      }
      if (pending && pending.branch !== `obs/${workspace.id}/${repo.id}`)
        throw new WorkbenchError(
          "worktree_identity_changed",
          "addition branch identity changed; preserved",
        );
      if (pending && baseRef && baseRef !== pending.baseRef)
        throw new WorkbenchError(
          "repository_base_conflict",
          "retry with the original base ref",
        );
      plans.push(
        pending || (await this.plan(repo, workspace, baseRef || repo.defaultBase || "HEAD")),
      );
    }
    workspace.repositoryAdditions = journal;
    for (const plan of plans) {
      journal[plan.id] = plan;
      this.save(workspace);
      try {
        await this.materialize(plan, workspace);
        workspace.repositories.push(plan);
        workspace.repositoryIds = workspace.repositories.map(
          (repo: Json) => repo.id,
        );
        delete journal[plan.id];
        delete workspace.repositoryAdditionError;
        this.save(workspace);
      } catch (error) {
        workspace.repositoryAdditionError = issue(error);
        this.save(workspace);
        throw error;
      }
    }
    return this.save(workspace);
  }
  async impact(workspace: Json) {
    const repositories: Json[] = [],
      externalReferences: Json[] = [];
    for (const repo of workspace.repositories) {
      const exists = existsSync(repo.worktreePath);
      let dirtyPaths: string[] = [],
        unavailable = false;
      try {
        if (exists)
          dirtyPaths = (
            await new Git(repo.worktreePath, this.config.gitTimeout).status()
          ).map(([, path]) => path);
      } catch {
        unavailable = true;
      }
      repositories.push({
        ...repo,
        worktreeExists: exists,
        dirty: !!dirtyPaths.length || unavailable,
        dirtyPaths,
      });
    }
    return {
      workspaceId: workspace.id,
      treePath: workspace.treePath,
      repositories,
      repositoryCount: repositories.length,
      dirtyRepositoryCount: repositories.filter((repo) => repo.dirty).length,
      branchesPreserved: workspace.repositories
        .map((repo: Json) => repo.branch)
        .filter(Boolean),
      dirtyRepositories: repositories.filter((repo) => repo.dirty).length,
      irreversible: true,
      preserves: ["commits", "local branches", "external references"],
      loses: ["workspace record", "managed worktree files"],
      externalReferences,
      recordPath: this.recordPath(workspace.id),
      preview: true,
      canDelete: workspace.state === "removed",
    };
  }
  async remove(params: Json) {
    const w = this.get(String(params.workspaceId || ""));
    if (
      !w.managed ||
      !["active", "create_failed", "deletion_pending", "removed"].includes(
        w.state,
      )
    )
      throw new WorkbenchError(
        "workspace_state_invalid",
        "workspace cannot be removed",
      );
    const tasks = Array.isArray(params.activeTasks) ? params.activeTasks : [];
    if (w.state === "removed")
      return {
        workspaceId: w.id,
        removed: true,
        pending: false,
        state: w.state,
      };
    w.state = params.lockOnly || tasks.length ? "deletion_pending" : "removed";
    if (w.state === "deletion_pending")
      w.deletion = {
        requestedAt: w.deletion?.requestedAt || now(),
        activeTasks: tasks,
        blocksNewTasks: true,
      };
    else delete w.deletion;
    this.save(w);
    return {
      workspaceId: w.id,
      removed: w.state === "removed",
      pending: w.state === "deletion_pending",
      state: w.state,
      activeTasks: tasks,
    };
  }
  restore(params: Json) {
    const w = this.get(String(params.workspaceId || ""));
    if (
      !w.managed ||
      !["active", "removed", "deletion_pending"].includes(w.state)
    )
      throw new WorkbenchError(
        "workspace_state_invalid",
        "workspace cannot be restored",
      );
    if (!existsSync(w.treePath))
      throw new WorkbenchError(
        "workspace_restore_unavailable",
        "worktree no longer exists",
      );
    w.state = "active";
    delete w.deletion;
    this.save(w);
    return { workspaceId: w.id, restored: true, state: w.state };
  }
  private async deletionTargets(w: Json) {
    this.assertIdle(w.id);
    // Check all targets before removing any. Never force-remove user changes,
    // unregistered paths, or commits made after the recorded base.
    const targets: Array<{ git: Git; path: string }> = [];
    for (const repo of w.repositories) {
      if (!existsSync(repo.worktreePath)) continue;
      const target = new Git(repo.worktreePath, this.config.operationTimeout),
        source = new Git(repo.sourcePath, this.config.operationTimeout);
      if (
        (await target.root()) !== canonical(repo.worktreePath) ||
        (await target.branch()) !== repo.branch ||
        !(await source.registered(repo.worktreePath))
      )
        throw new WorkbenchError(
          "worktree_identity_changed",
          "worktree identity changed; preserved",
        );
      if ((await target.status()).length)
        throw new WorkbenchError(
          "workspace_dirty",
          "worktree has user changes; preserved",
        );
      if ((await target.head()) !== repo.baseSha)
        throw new WorkbenchError(
          "workspace_has_commits",
          "worktree contains commits; preserved",
        );
      targets.push({ git: source, path: repo.worktreePath });
    }
    // Refuse unknown files in the workspace container, including cached runtime
    // artifacts. Nothing recursively deletes an uninspected directory.
    const allowed = new Set([
      ...w.repositories.map((repo: Json) => basename(repo.worktreePath)),
      ".workspace",
    ]);
    if (
      existsSync(w.treePath) &&
      readdirSync(w.treePath).some((name) => !allowed.has(name))
    )
      throw new WorkbenchError(
        "workspace_dirty",
        "workspace contains extra files; preserved",
      );
    const metadata = join(w.treePath, ".workspace");
    if (
      existsSync(metadata) &&
      readdirSync(metadata).some((name) => name !== "manifest.json")
    )
      throw new WorkbenchError(
        "workspace_dirty",
        "workspace metadata contains user files; preserved",
      );
    return targets;
  }
  async cleanup(params: Json, permanent = false) {
    const w = this.get(String(params.workspaceId || ""));
    if (!w.managed)
      throw new WorkbenchError(
        "workspace_not_managed",
        "live workspace cannot be deleted",
      );
    const impact = await this.impact(w);
    if (permanent && w.state !== "removed") {
      if (!params.confirm)
        return {
          ...impact,
          canDelete: false,
          state: w.state,
          blockedReason:
            w.state === "deletion_pending"
              ? "workspace_task_active"
              : "workspace_must_be_removed",
          requiresRemoval: true,
          deleted: false,
        };
      throw new WorkbenchError(
        w.state === "deletion_pending"
          ? "workspace_task_active"
          : "workspace_must_be_removed",
        "remove workspace after finishing tasks before permanent deletion",
      );
    }
    let targets: Array<{ git: Git; path: string }>;
    try {
      targets = await this.deletionTargets(w);
    } catch (error) {
      if (permanent && !params.confirm)
        return {
          ...impact,
          canDelete: false,
          deleted: false,
          blockedReason: issue(error).code,
          issues: [issue(error)],
        };
      throw error;
    }
    if (!params.confirm)
      return permanent
        ? { ...impact, canDelete: true, deleted: false }
        : {
            workspaceId: w.id,
            preview: true,
            removed: false,
            repositories: targets.length,
          };
    const metadata = join(w.treePath, ".workspace");
    for (const target of targets)
      await target.git.run(["worktree", "remove", target.path]);
    if (existsSync(join(metadata, "manifest.json")))
      unlinkSync(join(metadata, "manifest.json"));
    if (existsSync(metadata)) rmdirSync(metadata);
    if (existsSync(w.treePath)) rmdirSync(w.treePath);
    if (permanent) unlinkSync(this.recordPath(w.id));
    else {
      w.state = "removed";
      this.save(w, false);
    }
    return {
      workspaceId: w.id,
      preview: false,
      ...(permanent
        ? {
            deleted: true,
            branchesPreserved: impact.branchesPreserved,
            externalReferences: [],
          }
        : { removed: true }),
    };
  }
  identify(directory: string) {
    for (const w of this.list().sort(
      (a, b) => Number(b.managed) - Number(a.managed),
    ))
      if (
        w.state !== "removed" &&
        w.treePath &&
        inside(directory, w.treePath, true)
      )
        return { matched: true, workspaceId: w.id, repoPath: null };
    return { matched: false, workspaceId: null, repoPath: null };
  }
}
