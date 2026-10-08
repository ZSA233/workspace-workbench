import {ChangeNotes} from './change-notes.ts';
import { compareRepository, fetchComparisonRef } from './repository-comparison.ts';
import type {ObservationScheduler} from './observation-scheduler.ts';
import { RuntimeReadQueue } from './runtime-read-queue.ts';
import { sessionEnvironment } from './session-environment.ts';
import { resolveRuntimeDeclarations } from './runtime-declarations.ts';
import { PrepareTasks } from "./prepare-tasks.ts";
import { EventLoopMetrics } from "../event-loop-metrics.ts";
import { gitDiagnostics, withMutationGit } from "./git.ts";
import { buildId } from "../../shared/build-id.mjs";
import { loadConfig, type Config } from "./config.ts";
import { Workspaces } from "./workspaces.ts";
import { ObservationCache } from "./cache.ts";
import { Runtime } from "./runtime.ts";
import { Observation, protocol } from "./observation.ts";
import { runtimeIdentity } from "./identity.ts";
import { compareObserved } from "./review.ts";
import { issue, stable, hash, WorkbenchError, type Json } from "./storage.ts";
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
  notes: ChangeNotes;
  config: Config;
  workspaces: Workspaces;
  runtime: Runtime | null;
  preparations: PrepareTasks;
  environmentReads = new RuntimeReadQueue();
  cache: ObservationCache;
  observation: Observation;
  startedAt = Date.now();
  eventLoop = new EventLoopMetrics();
  version: string;
  build = buildId(["../server/backend/service.ts", "../server/backend/change-notes.ts", "./change-notes.ts", "../server/backend/repository-comparison.ts", "../server/backend/diff-content.ts", "./comparison.ts", "../server/backend/observation.ts", "../server/backend/observation-scheduler.ts", "../server/backend/cache.ts", "../server/backend/git.ts", "../server/backend/workspace-activity.ts", "../server/backend/workspace-refs.ts", "../server/backend/review.ts", "./observation-policy.ts", "../server/backend/file-diff.ts", "../server/backend/diff-content.ts", "../server/backend/diff-read-tasks.ts", "../server/backend/repository-refresh.ts", "../server/backend/observation-records.ts", "../server/backend/observation-records-worker.ts", "../server/backend/derived-json.ts", "../server/backend/storage.ts", "../server/backend/file-statistics.ts", "../server/backend/git-scheduler.ts", "./diff-read.ts", "./task-state.ts", "../server/backend/basic-reads.ts", "../server/backend/prepare-tasks.ts", "../server/backend/prepare-worker.ts", "../server/backend/operation-storage.ts", "../server/backend/runtime-install-lock.ts", "../server/backend/runtime.ts", "../server/backend/session-environment.ts", "../server/backend/runtime-declarations.ts", "../server/backend/runtime-tools.ts", "../server/backend/runtime-layout.ts", "../server/backend/runtime-summary.ts", "../server/backend/runtime-observation.ts", "../server/backend/runtime-read-queue.ts", "../server/backend/environment-snapshots.ts", "../server/backend/workspaces.ts", "../server/backend/workspace-records.ts", "../server/backend/workspace-catalog.ts", "../server/backend/workspace-directory.ts", "../server/backend/workspace-creation.ts", "../server/backend/workspace-removal.ts", "../server/backend/workspace-deletion.ts", "../server/backend/workspace-activity-guard.ts", "../server/backend/workspace-record-encoding.ts", "../server/backend/workspace-infrastructure.ts", "../server/backend/workspace-scope.ts", "../server/backend/workspace-lineage.ts", "./workspace-lineage.ts"]);
  constructor(config: Config, version = "0.1.3", dependencies:{scheduler?:ObservationScheduler;cacheClock?:()=>number}={}) {
    this.config = config;
    this.version = version;
    this.workspaces = new Workspaces(config);
    this.notes = new ChangeNotes(this.workspaces,path=>String(this.observation.scheduler.token(path,'working')));
    this.runtime = config.toolchain ? new Runtime(config) : null;
    this.cache = new ObservationCache(config,dependencies.cacheClock);
    this.observation = new Observation(
      this.workspaces,
      this.runtime,
      this.cache,
      dependencies.scheduler,
    );
    this.workspaces.onOrphanScanChanged = () => this.observation.scheduler.rosterChanged();
    this.workspaces.onDiscoveryChanged = () => this.observation.scheduler.rosterChanged();
    this.preparations = new PrepareTasks(this.workspaces, workspaceId => { this.observation.scheduler.published({workspaceId}); });
    this.workspaces.preparationActive = id => this.preparations.active(id);
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
      generation: this.observation.diffTasks.generation,
      eventLoop: this.eventLoop.snapshot(),
      environmentReads: this.environmentReads.health(),
      git: gitDiagnostics(),
      recordReads: this.workspaces.observationRecords.health(),
      diffRead: this.observation.diffTasks.health(),
      refreshProtocol: 1,
      refreshControls: this.observation.refresh.controlHealth(),
      prepareProtocol: 1,
      environmentProtocol: 1,
      basicSummaryProtocol: 1,
      fileStatistics: this.observation.statistics.health(),
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
    if (method === 'notes.read') return this.notes.read(params,signal);
    if (method === 'notes.write') return this.workspaces.mutations.run(()=>this.notes.write(params,params.author));
    if (method === 'notes.manage') return this.workspaces.mutations.run(()=>this.notes.manage(params));
    if (method === 'notes.feedback') return this.workspaces.mutations.run(()=>this.notes.feedback(params));
    if (method === 'workspace.prepare.task') return params.action === 'status' ? this.preparations.request(params) : this.workspaces.mutations.run(() => this.preparations.request(params));
    if (method === 'workspace.prepare') {
      const task = await this.workspaces.mutations.run(() => this.preparations.request({...params, action:'start', requestId: params.requestId || `legacy:${hash(stable(params))}`}));
      const state = await this.preparations.wait(task.operationId);
      if (state.state === 'ready' || state.state === 'failed' && state.repositories[0]?.result) return state.repositories[0].result;
      if (state.state === 'interrupted') throw new WorkbenchError('operation_interrupted', 'Preparation interrupted; inspect the operation before continuing', {operationId:task.operationId,method:'workspace.prepare.task',action:'status',statusTool:'workbench_workspace_operation_status',dispatched:true});
      throw new WorkbenchError('operation_pending', 'Runtime preparation continues; query its operation status without replaying it', {operationId:task.operationId,method:'workspace.prepare.task',action:'status',statusTool:'workbench_workspace_operation_status',dispatched:true});
    }
    if (managementMethods.has(method))
      return withMutationGit(() => this.workspaces.mutations.run(async () => {
        if (!["observer.reload", "main.repositories.save", "linked.workspaces.save"].includes(method) && !this.config.managementEnabled)
          throw new WorkbenchError(
            "capability_unavailable",
            "workspace management disabled",
          );
        try {
          return await this.mutate(method, params);
        } finally {
          this.workspaces.invalidateOrphanScan();
          this.workspaces.observationRecords.invalidate();
          if (params.workspaceId) this.cache.invalidateWorkspace(String(params.workspaceId));
          this.observation.scheduler.force(params.workspaceId ? String(params.workspaceId) : undefined);
          this.observation.scheduler.rosterChanged();
        }
      }));
    switch (method) {
      case "observer.versions":
        return {...await this.observation.scheduler.versions(Array.isArray(params.workspaceIds) ? params.workspaceIds.slice(0, 100).filter((id: unknown) => typeof id === "string") : []), notesRevision:this.notes.revision};
      case "observer.health":
        return this.health();
      case "workspace.list":
        return this.observation.list(params, signal);
      case "workspace.activity":
        return this.observation.activityRequest(params);
      case "workspace.orphan.preview":
        return this.workspaces.orphanPreview(String(params.workspaceId || ""), signal);
      case "workspace.detail":
        return this.observation.detail(params, signal);
      case "workspace.identify":
        return this.workspaces.observationRecords.request('identify', { directory: String(params.directory || this.config.sourceRoot) });
      case "workspace.operation.status": {
        const preparation = await this.preparations.request({action:'status',operationId:String(params.operationId || '')});
        if(preparation.state !== 'idle') return {operationId:preparation.operationId,workspaceId:preparation.workspaceId,stage:preparation.state,result:preparation};
        return this.workspaces.operationStatus(String(params.operationId || ""));
      }
      case "main.repositories.list":
        return this.workspaces.mainCandidates();
      case "linked.workspaces.list":
        return this.workspaces.linkedCandidates();
      case "linked.workspace.preview":
        return this.workspaces.previewGitlink(params);
      case "workspace.environment": {
        const deadline = Math.min(Date.now() + (Number(params.observationBudgetMs) || 2000), Number(params.environmentDeadline) || Infinity);
        const {environmentDeadline,observationBudgetMs,...identity} = params;
        return this.environmentReads.read(stable({config:this.config,params:identity}),deadline,signal,owned => sessionEnvironment(this,{...params,environmentDeadline:deadline},owned));
      }
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
        const resolved = await resolveRuntimeDeclarations(this.config,w);
        const toolchain = this.runtime ? new Runtime(resolved.config).summary(w) : null;
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
        const w = await this.workspaces.observationRecords.request('get', { workspaceId: String(params.workspaceId || '') });
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
      case "observer.refresh":
        return this.observation.refresh.request(params);
      case "repository.fetch":
        return fetchComparisonRef(this.observation, params);
      case "repository.compare":
        return compareRepository(this.observation, params, signal);
      case "repository.summary":
        return this.observation.refresh.query(method, params, signal);
      case "repository.diff.read":
        return this.observation.diffRead(params);
      case "repository.graph":
      case "repository.changes":
      case "repository.diff":
        return this.observation.repositoryQuery(method, params, signal);
      case "review-set.compare":
      case "review-set.brief":
        return compareObserved(this.observation, params, method === "review-set.brief", signal);
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
      const workspace: Json = await this.workspaces.add(params);
      if (!this.runtime) return {...workspace,preparations:[]};
      const task = await this.preparations.request({action:'start',workspaceId:workspace.id,repositories:params.repositories,requestId:`add-prepare:${hash(stable(params))}`});
      const state = await this.preparations.wait(task.operationId);
      return {...workspace, preparationOperationId:task.operationId, preparations:state.repositories.map((repo:Json)=>repo.result || {repositoryId:repo.id,status:repo.state,operationId:task.operationId})};

    }
    if (method === "workspace.remove") return this.workspaces.remove(params);
    if (method === "workspace.restore") return this.workspaces.restore(params);
    return this.workspaces.cleanup(params, method === "workspace.delete");
  }
  async close() {
    this.eventLoop.close();
    await this.environmentReads.close();
    await this.preparations.close();
    await this.workspaces.observationRecords.close();
    await this.observation.refresh.close();
    await this.observation.diffTasks.close();
    await this.observation.statistics.close();
    await this.workspaces.mutations.drain();
    await this.observation.close();
    await this.observation.scheduler.close();
    await this.cache.close();
  }
}
