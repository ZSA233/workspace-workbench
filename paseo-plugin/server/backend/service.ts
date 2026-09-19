import { gitDiagnostics } from "./git.ts";
import { buildId } from "../../shared/build-id.mjs";
import { loadConfig, type Config } from "./config.ts";
import { Workspaces } from "./workspaces.ts";
import { ObservationCache } from "./cache.ts";
import { Runtime } from "./runtime.ts";
import { Observation, protocol } from "./observation.ts";
import { runtimeIdentity } from "./identity.ts";
import { compare } from "./review.ts";
import { issue, stable, WorkbenchError, type Json } from "./storage.ts";
export const managementMethods = new Set([
  "observer.reload",
  "workspace.create",
  "workspace.orphan.adopt",
  "workspace.addRepositories",
  "workspace.prepare",
  "workspace.cleanup",
  "workspace.remove",
  "workspace.restore",
  "workspace.delete",
  "main.repositories.save",
  "linked.workspaces.save",
]);
export class Service {
  config: Config;
  workspaces: Workspaces;
  runtime: Runtime | null;
  cache: ObservationCache;
  observation: Observation;
  startedAt = Date.now();
  version: string;
  build = buildId(["../server/backend/service.ts", "../server/backend/observation-scheduler.ts", "../server/backend/cache.ts", "../server/backend/git.ts"]);
  constructor(config: Config, version = "0.1.3") {
    this.config = config;
    this.version = version;
    this.workspaces = new Workspaces(config);
    this.runtime = config.toolchain ? new Runtime(config) : null;
    this.cache = new ObservationCache(config);
    this.observation = new Observation(
      this.workspaces,
      this.runtime,
      this.cache,
    );
    this.workspaces.onOrphanScanChanged = () => this.observation.scheduler.rosterChanged();
    this.cache.onProduced = scope => this.observation.scheduler.published(scope);
  }
  health() {
    const caps = this.workspaces.capabilities();
    return {
      schemaVersion: protocol,
      service: "workspace-workbench",
      implementation: "node",
      version: this.version,
      buildId: this.build,
      git: gitDiagnostics(),
      project: {
        id: this.config.projectId,
        displayName: this.config.displayName,
      },
      capabilities: {
        ...caps,
        workspaceCreate: caps.create,
        workspacePrepare: caps.prepare,
        workspaceCleanup: caps.cleanup,
        agentProvider: caps.agent ? "paseo" : null,
      },
      timing: this.config.timing,
      uptimeSeconds: (Date.now() - this.startedAt) / 1000,
      cache: this.cache.status(),
      observationScheduler: this.observation.scheduler.health(),
    };
  }
  async handle(method: string, params: Json = {}, signal?: AbortSignal): Promise<Json> {
    if (managementMethods.has(method))
      return this.workspaces.mutations.run(async () => {
        if (!["observer.reload", "main.repositories.save", "linked.workspaces.save"].includes(method) && !this.config.managementEnabled)
          throw new WorkbenchError(
            "capability_unavailable",
            "workspace management disabled",
          );
        try {
          return await this.mutate(method, params);
        } finally {
          this.workspaces.invalidateOrphanScan();
          this.cache.clear();
          this.observation.scheduler.force();
          this.observation.scheduler.rosterChanged();
        }
      });
    switch (method) {
      case "observer.versions":
        return this.observation.scheduler.versions(Array.isArray(params.workspaceIds) ? params.workspaceIds.slice(0, 100).filter((id: unknown) => typeof id === "string") : []);
      case "observer.health":
        return this.health();
      case "workspace.list":
        return this.observation.list(params, signal);
      case "workspace.orphan.preview":
        return this.workspaces.orphanPreview(String(params.workspaceId || ""), signal);
      case "workspace.detail":
        return this.observation.detail(params, signal);
      case "workspace.identify":
        return this.workspaces.identify(
          String(params.directory || this.config.sourceRoot),
        );
      case "workspace.operation.status":
        return this.workspaces.operationStatus(String(params.operationId || ""));
      case "main.repositories.list":
        return this.workspaces.mainCandidates();
      case "linked.workspaces.list":
        return this.workspaces.linkedCandidates();
      case "linked.workspace.preview":
        return this.workspaces.previewGitlink(params);
      case "workspace.runtime": {
        const w = this.workspaces.get(String(params.workspaceId || ""));
        if (!w.managed)
          throw new WorkbenchError(
            "workspace_not_managed",
            "live workspace is not managed",
          );
        if (w.state !== "active")
          throw new WorkbenchError(
            "workspace_state_invalid",
            "workspace is not active",
          );
        if (Object.keys(w.repositoryAdditions || {}).length)
          throw new WorkbenchError(
            "repository_addition_pending",
            "recover repository additions before starting a task",
          );
        const repositories = [];
        for (const repo of w.repositories)
          repositories.push(await runtimeIdentity(repo, this.config));
        const toolchain = this.runtime?.summary(w) || null;
        if (toolchain && toolchain.status !== "ready")
          throw new WorkbenchError(
            "toolchain_not_ready",
            "prepare runtimes before execution",
            toolchain,
          );
        return {
          schemaVersion: protocol,
          workspaceId: w.id,
          managed: true,
          treePath: w.treePath,
          sourceRoot: w.sourceRoot,
          repositories,
          capabilities: this.workspaces.capabilities(),
          toolchain,
        };
      }
      case "workspace.reviewRuntime": {
        const w = this.workspaces.get(String(params.workspaceId || ""));
        if (w.state !== "active")
          throw new WorkbenchError("workspace_state_invalid", "workspace is not active");
        const repositories = [], issues = [];
        for (const repo of w.repositories) {
          try { repositories.push(await runtimeIdentity(repo, this.config, w.managed === true)); }
          catch (error) {
            if (w.managed === true) throw error;
            issues.push({ repositoryId: repo.id, path: repo.worktreePath || repo.sourcePath, ...issue(error) });
          }
        }
        if (!repositories.length)
          throw new WorkbenchError("review_repositories_unavailable", "No selected main workspace repositories are available", { issues });
        return {
          schemaVersion: protocol,
          workspaceId: w.id,
          managed: w.managed === true,
          treePath: w.treePath,
          sourceRoot: w.sourceRoot,
          repositories,
          capabilities: this.workspaces.capabilities(),
          reviewOnly: w.managed !== true,
          issues,
        };
      }
      case "repository.graph":
      case "repository.changes":
      case "repository.diff":
        return this.observation.repositoryQuery(method, params, signal);
      case "review-set.compare":
      case "review-set.brief":
        return compare(this.workspaces, params, method === "review-set.brief", signal);
      default:
        throw new WorkbenchError(
          method.startsWith("agent.")
            ? "agent_provider_required"
            : "method_not_allowed",
          "method is not supported",
        );
    }
  }
  private async mutate(method: string, params: Json): Promise<Json> {
    if (method === "main.repositories.save") return this.workspaces.saveMainSelection(params);
    if (method === "linked.workspaces.save") return this.workspaces.saveLinkedSelection(params);
    if (method === "observer.reload") {
      const next = loadConfig(this.config.configPath);
      for (const key of [
        "projectId",
        "sourceRoot",
        "workspaceRoot",
        "stateRoot",
        "socketPath",
        "recordsRoot",
        "treesRoot",
        "repositories",
        "managementEnabled",
        "agentEnabled",
      ] as const)
        if (stable(next[key]) !== stable(this.config[key]))
          throw new WorkbenchError(
            "config_reload_required",
            "project layout changes require backend restart",
          );
      const runtime = next.toolchain ? new Runtime(next) : null;
      this.config = next;
      this.workspaces.config = next;
      this.cache.config = next;
      this.runtime = runtime;
      this.observation.runtime = runtime;
      return {
        reloaded: true,
        project: { id: next.projectId, displayName: next.displayName },
      };
    }
    if (method === "workspace.create") return this.workspaces.create(params);
    if (method === "workspace.orphan.adopt") return this.workspaces.adoptOrphan(params);
    if (method === "workspace.addRepositories") {
      const workspace = await this.workspaces.add(params),
        preparations = [];
      if (this.runtime)
        for (const requested of params.repositories)
          preparations.push(
            await this.runtime.prepare(
              workspace,
              this.workspaces.repository(workspace, requested).id,
            ),
          );
      return { ...workspace, preparations };
    }
    if (method === "workspace.prepare") {
      if (!this.runtime)
        throw new WorkbenchError(
          "capability_unavailable",
          "runtime preparation unavailable",
        );
      const w = this.workspaces.get(String(params.workspaceId || ""));
      return this.runtime.prepare(
        w,
        this.workspaces.repository(
          w,
          params.repositoryId || params.repoPath || "",
        ).id,
      );
    }
    if (method === "workspace.remove") return this.workspaces.remove(params);
    if (method === "workspace.restore") return this.workspaces.restore(params);
    return this.workspaces.cleanup(params, method === "workspace.delete");
  }
  async close() {
    await this.workspaces.mutations.drain();
    await this.observation.scheduler.close();
    await this.cache.close();
  }
}
