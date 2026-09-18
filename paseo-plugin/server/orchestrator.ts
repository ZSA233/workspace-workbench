import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { coordinatorGuidance, handoffOutcome } from "../shared/handoff-guidance.mjs";
import { createPreviewBundle, readBundle, assertBundleReady, writeBundleEnvironment } from "./handoff-bundles.ts";
import type { BundleRef } from "../shared/handoff-materials.ts";
import { isAbsolute, resolve } from "node:path";
import type { AgentContext } from "./agent-provider.ts";
import { handleAgentDelegate, handleWorkspaceBinding } from "./agent-provider.ts";
import { childExecutionConfig, assertCoordinatorExecution } from "./execution-policy.ts";
import { queryObserver } from "./observer.ts";
import { currentProject, resolveProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { getWorkbenchCopy } from "../shared/copy.ts";
import { workflowRequest, workflowSubmitRequest, type WorkflowRequest, type WorkflowStatusRequest, type WorkflowSubmitRequest } from "../shared/orchestration.ts";

type Progress = {
  bundle?: BundleRef;
  request?: WorkflowRequest;
  identity: string;
  identityVersion?: 2;
  workspaceId?: string;
  stage: string;
  previewedAt?: string;
  result?: Awaited<ReturnType<typeof handleAgentDelegate>> | { ok: false; action: "failed"; error: { code: string; message: string } };
};
const resumableWorkflowStages = new Set(["previewed", "validated", "created", "prepare-failed", "delegating", "handoff-blocked"]);
const flights = new Map<string, Promise<unknown>>();

type CatalogRepository = {
  id: string;
  name?: string;
  repoPath?: string;
  sourcePath?: string;
  worktreePath?: string;
};

type RepositoryCatalog = {
  workspace?: { sourceRoot?: string };
  sourceRoot?: string;
  repositories?: CatalogRepository[];
};

type NormalizedRequest =
  | { ok: true; request: WorkflowRequest }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

function canonicalPath(value: string, root?: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const candidate = isAbsolute(raw) ? raw : root ? resolve(root, raw) : null;
  if (!candidate) return null;
  try { return realpathSync(candidate); }
  catch { return resolve(candidate); }
}

function repositoryAliases(repository: CatalogRepository, sourceRoot?: string): { values: Set<string>; paths: Set<string> } {
  const values = new Set<string>();
  const paths = new Set<string>();
  for (const value of [repository.id, repository.name, repository.repoPath, repository.sourcePath, repository.worktreePath]) {
    if (typeof value !== "string" || !value.trim()) continue;
    values.add(value.trim());
  }
  if (repository.repoPath) {
    const path = canonicalPath(repository.repoPath, sourceRoot);
    if (path) paths.add(path);
  }
  for (const value of [repository.sourcePath, repository.worktreePath]) {
    if (!value) continue;
    const path = canonicalPath(value);
    if (path) paths.add(path);
  }
  return { values, paths };
}

function resolveRepositoryReference(reference: string, catalog: RepositoryCatalog): { ok: true; id: string } | { ok: false; error: { code: string; message: string; details: unknown } } {
  const raw = reference.trim();
  const repositories = catalog.repositories || [];
  const sourceRoot = catalog.workspace?.sourceRoot || catalog.sourceRoot;
  const exactIds = repositories.filter((repository) => repository.id === raw);
  if (exactIds.length === 1) return { ok: true, id: exactIds[0].id };
  const matches = repositories.filter((repository) => {
    const aliases = repositoryAliases(repository, sourceRoot);
    const path = canonicalPath(raw, sourceRoot);
    return aliases.values.has(raw) || Boolean(path && aliases.paths.has(path));
  });
  if (!matches.length) {
    return {
      ok: false,
      error: {
        code: "repository_invalid",
        message: `Unknown or disabled repository reference: ${raw}`,
        details: { requested: raw, known: repositories.map((repository) => repository.id).sort() },
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: {
        code: "repository_ambiguous",
        message: `Repository reference matches more than one configured repository: ${raw}`,
        details: { requested: raw, matches: matches.map((repository) => repository.id).sort() },
      },
    };
  }
  return { ok: true, id: matches[0].id };
}

function normalizeWorkflowRequest(request: WorkflowRequest, value: unknown): NormalizedRequest {
  const catalog = value && typeof value === "object" ? value as RepositoryCatalog : {};
  if (!Array.isArray(catalog.repositories) || !catalog.repositories.length) {
    return { ok: false, error: { code: "workspace_repositories_unavailable", message: "Workspace repository catalog is unavailable" } };
  }
  const resolveReference = (reference: string) => resolveRepositoryReference(reference, catalog);
  try {
    const repositories: string[] | undefined = request.repositories
      ? [...new Set(request.repositories.map((reference) => {
          const resolved = resolveReference(reference);
          if (!resolved.ok) throw resolved.error;
          return resolved.id;
        }))]
      : undefined;
    const baseRefs: Record<string, string> = {};
    for (const [reference, base] of Object.entries(request.baseRefs)) {
      const resolved = resolveReference(reference);
      if (!resolved.ok) throw resolved.error;
      if (repositories && !repositories.includes(resolved.id)) {
        return { ok: false, error: { code: "request_invalid", message: `baseRefs must reference selected repositories: ${resolved.id}` } };
      }
      const previous = baseRefs[resolved.id];
      if (previous !== undefined && previous !== base) {
        return { ok: false, error: { code: "request_invalid", message: `Conflicting base refs for repository ${resolved.id}` } };
      }
      baseRefs[resolved.id] = base;
    }
    return { ok: true, request: { ...request, ...(repositories ? { repositories } : {}), baseRefs } };
  } catch (error) {
    const failure = error as { code?: string; message?: string; details?: unknown };
    return { ok: false, error: { code: failure.code || "repository_invalid", message: failure.message || "Repository reference is invalid", ...(failure.details === undefined ? {} : { details: failure.details }) } };
  }
}

export async function orchestrate(action: "preview" | "execute" | "status" | "submit" | "submit-execute", request: WorkflowRequest | WorkflowStatusRequest | WorkflowSubmitRequest, parentAgentId: string, context: AgentContext) {
  const query = context.query || queryObserver;
  const parent = (await context.paseo.agents.ref(parentAgentId).refresh())?.agent;
  if (!parent) throw new Error("parent_agent_unavailable");
  if ((action === "execute" || action === "submit" || action === "submit-execute")
    && parent.labels?.["workspace-workbench.role"] === "workspace-worker"
    && (parent.labels?.["workspace-workbench.relationship"] || "child") === "child") throw new Error("execution_child_must_not_delegate");
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  if (resolveProject({ directory: parent.cwd }).configPath !== project.configPath) throw new Error("parent_project_mismatch");
  let submitted = false;
  const authorizedSubmission = action === "submit-execute";
  if (authorizedSubmission) action = "execute";
  if (action === "submit") {
    const simple = workflowSubmitRequest.parse(request);
    const requestId = simple.requestId || randomUUID();
    request = workflowRequest.parse({
      requestId, workspaceId: simple.workspaceId, name: simple.name, repositories: simple.repositories,
      sourceWorkspaceId: simple.sourceWorkspaceId, branchName: simple.branchName, rootBaseRef: simple.rootBaseRef,
      baseRefs: simple.baseRefs,
      handoff: {
        goal: simple.task,
        startMode: simple.startMode,
        relationship: simple.relationship,
        reviewPacket: {
          requirementUnderstanding: "Use the task statement and original documents directly; inspect repository facts before implementation.",
          references: simple.originalPaths.map((path, index) => ({ id: `source-${index + 1}`, kind: "document", title: path.split(/[\\/]/).at(-1) || path, path, required: false })),
          instructions: simple.originalPaths.length ? `Read these original paths directly when accessible:\n${simple.originalPaths.join("\n")}` : "",
        },
      },
    });
    action = "execute";
    submitted = true;
  }
  const key = `workflow:${parentAgentId}:${request.requestId}`;
  let previous = readState<Progress>(key);
  if (submitted) {
    if (previous) return { ok: true, action: previous.stage === "handed-off" ? "handed-off" : "accepted", requestId: request.requestId, progress: previous, nextAction: "end_turn" };
    const accepted: Progress = { identity: digest({ submission: request, parentAgentId }), identityVersion: 2, workspaceId: request.workspaceId, stage: "accepted" };
    writeState(key, accepted);
    const canonical = request as WorkflowRequest;
    queueMicrotask(() => {
      void orchestrate("submit-execute", canonical, parentAgentId, context).catch(error => {
        const current = readState<Progress>(key) || accepted;
        writeState(key, { ...current, stage: "failed", result: { ok: false, action: "failed", error: { code: "submission_failed", message: error instanceof Error ? error.message : String(error) } } });
      });
    });
    return { ok: true, action: "accepted", requestId: request.requestId, progress: accepted, nextAction: "end_turn", instructions: "The durable submission was accepted. Use workbench_workspace_status with this requestId if later reconciliation is needed; do not resubmit." };
  }
  if (action === "status") {
    if (!previous) return { ok: false, progress: null, execution: null, error: { code: "workflow_not_found", message: "No Workspace handoff exists for this request" } };
    if (request.workspaceId && previous.workspaceId && request.workspaceId !== previous.workspaceId) {
      return { ok: false, progress: previous, execution: null, error: { code: "workspace_identity_conflict", message: "The requested Workspace does not match this handoff" } };
    }
    return { ok: true, progress: previous, execution: previous.workspaceId ? await handleWorkspaceBinding({ workspaceId: previous.workspaceId }, context) : null };
  }
  // A preview is the canonical execution input. The execute tool can be
  // retried with only its requestId, which avoids asking an agent to recreate
  // a large handoff object byte-for-byte after a successful preview.
  if (action === "execute" && !("handoff" in request)) {
    if (!previous?.request) {
      return {
        ok: false,
        action: "blocked",
        requestId: request.requestId,
        sideEffects: [],
        requiresExecution: false,
        error: { code: "preview_request_unavailable", message: "This preview predates canonical request storage; run preview again with a new requestId before execute" },
      };
    }
    request = previous.request;
  }
  const rawRequest = workflowRequest.parse(request);
  if (action === "execute" && !previous && !submitted) {
    return { ok: false, action: "blocked", sideEffects: [], requiresExecution: false, error: { code: "preview_required", message: getWorkbenchCopy(rawRequest.handoff.reviewLocale).workspacePreviewRequired } };
  }
  const listing = await query({ method: "workspace.list", params: { includeRemoved: true } });
  if (!listing.ok) return listing;
  const capabilities = (listing.result as { capabilities?: { create?: boolean; agent?: boolean; prepare?: boolean } }).capabilities;
  if (!capabilities?.agent || !rawRequest.workspaceId && !capabilities?.create) throw new Error("capability_unavailable");
  if (!rawRequest.workspaceId && (!rawRequest.name || (!rawRequest.repositories?.length && !rawRequest.sourceWorkspaceId))) throw new Error("workspace_selection_required");
  if (rawRequest.sourceWorkspaceId && rawRequest.repositories?.length) throw new Error("gitlink_repositories_implicit");
  const catalog = await query({ method: "workspace.detail", params: { workspaceId: rawRequest.workspaceId || rawRequest.sourceWorkspaceId || "main", summary: true } });
  if (!catalog.ok) return catalog;
  const normalized = normalizeWorkflowRequest(rawRequest, catalog.result);
  if (!normalized.ok) return normalized;
  const fullRequest = normalized.request;
  const identity = digest({ request: fullRequest, parentAgentId });
  if (authorizedSubmission && previous?.stage === "accepted") {
    previous = { ...previous, identity, identityVersion: 2, stage: "previewed", previewedAt: new Date().toISOString() };
    writeState(key, previous);
  }
  let compatiblePrevious = previous;
  if (compatiblePrevious && compatiblePrevious.identity !== identity) {
    const legacyRetry = compatiblePrevious.identityVersion === undefined
      && compatiblePrevious.stage === "validated"
      && !compatiblePrevious.workspaceId
      && !compatiblePrevious.result;
    if (!legacyRetry) {
      if (action === "execute") {
        return {
          ok: false,
          action: "blocked",
          requestId: fullRequest.requestId,
          sideEffects: [],
          requiresExecution: false,
          error: {
            code: "request_identity_conflict",
            message: "Execute input differs from the saved preview. Retry execute with requestId only, or run a new preview with a new requestId.",
            details: { previousStage: compatiblePrevious.stage, previewRequestAvailable: Boolean(compatiblePrevious.request) },
          },
        };
      }
      throw new Error("request_identity_conflict");
    }
    compatiblePrevious = { ...compatiblePrevious, identity, identityVersion: 2 };
  }
  if (action === "preview") {
    // Persist the canonical, side-effect-free checkpoint so execute can be
    // guarded by the same request identity. A retry never needs to rely on a
    // model remembering that preview happened.
    const repos = (catalog.result as { repositories?: Array<{ id: string; worktreePath?: string; sourcePath?: string }> }).repositories || [];
    const material = previous?.bundle ? readBundle(previous.bundle) : !previous ? await createPreviewBundle({ ownerAgentId: parentAgentId, ownerCwd: parent.cwd, identity,
      handoff: fullRequest.handoff, runtime: { repositories: repos.flatMap(repo => repo.worktreePath || repo.sourcePath ? [{ id: repo.id, worktreePath: (repo.worktreePath || repo.sourcePath)! }] : []) }, context }) : null;
    if (!previous) writeState(key, { identity, identityVersion: 2, request: fullRequest, workspaceId: fullRequest.workspaceId, stage: "previewed", previewedAt: new Date().toISOString(), ...(material ? { bundle: material.bundle } : {}) });
    return { ok: true, action: fullRequest.workspaceId ? "reuse" : "create", request: fullRequest, catalog: catalog.result,
      sideEffects: material ? ["handoff.bundle"] : [], requiresExecution: true,
      materials: material ? { bundle: material.bundle, ready: !material.blockers.length, blockers: material.blockers, warnings: material.warnings, sourceCount: material.sources.length, requiredSources: material.sources.filter(s => s.required).map(s => s.id), conversation: material.conversation } : null,
      instructions: coordinatorGuidance };
  }
  if (previous?.stage === "handed-off") return handoffOutcome(previous.result);
  if (previous?.bundle) assertBundleReady(previous.bundle);
  // The preview is the approval boundary for Workspace creation. Existing
  // progress stages remain resumable, but a new identity must first establish
  // a canonical preview checkpoint; no prompt can substitute for this guard.
  if (!previous || !resumableWorkflowStages.has(previous.stage)) {
    return { ok: false, action: "blocked", request: fullRequest, catalog: catalog.result, sideEffects: [], requiresExecution: false, error: { code: "preview_required", message: getWorkbenchCopy(fullRequest.handoff.reviewLocale).workspacePreviewRequired } };
  }
  const flightKey = `${project.configPath}:${key}`;
  const active = flights.get(flightKey);
  if (active) return active;
  const run = (async () => {
    let progress: Progress = compatiblePrevious || { identity, identityVersion: 2, request: fullRequest, workspaceId: fullRequest.workspaceId, stage: "validated" };
    if (!progress.request) progress = { ...progress, request: fullRequest };
    if (progress.identity !== identity) progress = { ...progress, identity, identityVersion: 2 };
    const verifyExecution = async () => {
      const snapshot = (await context.paseo.agents.ref(parentAgentId).refresh())?.agent;
      if (!snapshot) throw new Error("parent_agent_unavailable");
      assertCoordinatorExecution(snapshot);
    };
    await verifyExecution();
    writeState(key, progress);
    if (!progress.workspaceId) {
      await verifyExecution();
      const response = await query({ method: "workspace.create", params: { name: fullRequest.name, repositories: fullRequest.repositories, baseRefs: fullRequest.baseRefs,
        sourceWorkspaceId: fullRequest.sourceWorkspaceId, branchName: fullRequest.branchName, rootBaseRef: fullRequest.rootBaseRef } });
      if (!response.ok) return response;
      progress = { ...progress, workspaceId: (response.result as { id: string }).id, stage: "created" };
      writeState(key, progress);
    }
    if (capabilities.prepare) {
      const detail = await query({ method: "workspace.detail", params: { workspaceId: progress.workspaceId, summary: true } });
      if (!detail.ok) return detail;
      const repositories = (detail.result as { repositories: Array<{ id: string }> }).repositories;
      if (!repositories?.length) throw new Error("workspace_repositories_unavailable");
      for (const repository of repositories) {
        await verifyExecution();
        const response = await query({ method: "workspace.prepare", params: { workspaceId: progress.workspaceId, repositoryId: repository.id } });
        const preparation = response.result as { status?: string; issues?: Array<{ code?: string; message?: string; details?: unknown }> } | undefined;
        if (!response.ok || preparation?.status === "prepare_failed") {
          writeState(key, { ...progress, stage: "prepare-failed" });
          const issue = preparation?.issues?.find((item) => item.message) || null;
          return { ok: false, error: response.error || (issue ? { code: issue.code || "prepare_failed", message: issue.message || "Runtime preparation failed", ...(issue.details === undefined ? {} : { details: issue.details }) } : { code: "prepare_failed", message: "Runtime preparation failed" }) };
        }
      }
    }
    const runtime = await query({ method: "workspace.runtime", params: { workspaceId: progress.workspaceId } });
    if (!runtime.ok) return runtime;
    const expected = fullRequest.handoff.expected;
    const repositories = (runtime.result as { repositories?: Array<{ id: string; repoPath: string; branch: string; baseSha: string }> }).repositories || [];
    for (const [repo, branch] of Object.entries(expected.branchByRepository)) {
      if (!repositories.some((item) => (item.id === repo || item.repoPath === repo) && item.branch === branch)) throw new Error("handoff_branch_mismatch");
    }
    for (const [repo, base] of Object.entries(expected.baseByRepository)) {
      if (!repositories.some((item) => (item.id === repo || item.repoPath === repo) && item.baseSha === base)) throw new Error("handoff_base_mismatch");
    }
    progress = { ...progress, stage: "delegating" };
    writeState(key, progress);
    if (progress.bundle) writeBundleEnvironment(progress.bundle, runtime.result);
    const result = await handleAgentDelegate({ workspaceId: progress.workspaceId!, parentAgentId, handoff: fullRequest.handoff, bundle: progress.bundle }, context);
    writeState(key, { ...progress, stage: result.ok ? "handed-off" : "handoff-blocked", result });
    return { ...handoffOutcome(result), requestId: fullRequest.requestId };
  })().finally(() => flights.delete(flightKey));
  flights.set(flightKey, run);
  return run;
}
