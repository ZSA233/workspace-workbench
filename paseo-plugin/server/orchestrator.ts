import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { coordinatorGuidance, handoffOutcome } from "../shared/handoff-guidance.mjs";
import { createPreviewBundle, readBundle, assertBundleReady, writeBundleEnvironment } from "./handoff-bundles.ts";
import type { BundleRef } from "../shared/handoff-materials.ts";
import { isAbsolute, resolve, relative } from "node:path";
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
  submissionIdentity?: string;
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
    // Freeze the parent's repository scope in the workflow checkpoint. Later
    // additions to that parent must not silently expand an authorized handoff.
    const requestedRepositories = request.repositories || (request.parentWorkspaceId && !request.workspaceId ? catalog.repositories.map(repository => repository.id) : undefined);
    const repositories: string[] | undefined = requestedRepositories
      ? [...new Set(requestedRepositories.map((reference) => {
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
    const handoff = request.contextMode === 'paseo' ? {...request.handoff,reviewPacket:{...request.handoff.reviewPacket,references:request.handoff.reviewPacket.references.map(reference => {
      if (!reference.path || !isAbsolute(reference.path)) return reference;
      const matches = (catalog.repositories || []).filter(repo => !reference.repositoryId || reference.repositoryId === repo.id).flatMap(repo => {
        const root = repo.worktreePath || repo.sourcePath;
        if (!root) return [];
        const path = relative(root,reference.path!);
        return path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) ? [{repositoryId:repo.id,path}] : [];
      });
      if (matches.length !== 1) throw {code:'artifact_path_invalid',message:`Original path must identify a file in one source repository: ${reference.id}`};
      return {...reference,...matches[0]};
    })}} : request.handoff;
    return { ok: true, request: { ...request, handoff, ...(repositories ? { repositories } : {}), baseRefs } };
  } catch (error) {
    const failure = error as { code?: string; message?: string; details?: unknown };
    return { ok: false, error: { code: failure.code || "repository_invalid", message: failure.message || "Repository reference is invalid", ...(failure.details === undefined ? {} : { details: failure.details }) } };
  }
}

/**
 * Host-independent preview used by the MCP tool.  Preview is a local
 * validation/material-freeze step; it must not require a live Paseo Agent
 * websocket just to inspect the configured repositories.  Delegation and
 * execution still use the existing host-bound path after this checkpoint.
 */
export async function previewWorkflowLocally(
  request: WorkflowRequest,
  parentAgentId: string,
  parentCwd: string,
  query: typeof queryObserver = queryObserver,
) {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  if (resolveProject({ directory: parentCwd }).configPath !== project.configPath) throw new Error("parent_project_mismatch");

  const rawRequest = workflowRequest.parse(request);
  const listing = await query({ method: "workspace.list", params: { includeRemoved: true } });
  if (!listing.ok) return listing;
  const capabilities = (listing.result as { capabilities?: { create?: boolean; agent?: boolean } }).capabilities;
  // Preview itself does not start an Agent.  Only a new Workspace needs the
  // local create capability; an existing Workspace can always be previewed.
  if (!rawRequest.workspaceId && !rawRequest.sourceWorkspaceId && !capabilities?.create) throw new Error("capability_unavailable");
  if (!rawRequest.workspaceId && (!rawRequest.name || (!rawRequest.repositories?.length && !rawRequest.sourceWorkspaceId && !rawRequest.parentWorkspaceId))) throw new Error("workspace_selection_required");
  if (rawRequest.sourceWorkspaceId && rawRequest.repositories?.length) throw new Error("gitlink_repositories_implicit");
  const catalog = await query({ method: "workspace.detail", params: { workspaceId: rawRequest.workspaceId || rawRequest.sourceWorkspaceId || rawRequest.parentWorkspaceId || "main", summary: true } });
  if (!catalog.ok) return catalog;
  const normalized = normalizeWorkflowRequest(rawRequest, catalog.result);
  if (!normalized.ok) return normalized;
  const fullRequest = normalized.request;
  const identity = digest({ request: fullRequest, parentAgentId });
  const key = `workflow:${parentAgentId}:${fullRequest.requestId}`;
  const previous = readState<Progress>(key);
  if (previous && previous.identity !== identity) {
    return {
      ok: false,
      action: "blocked" as const,
      requestId: fullRequest.requestId,
      sideEffects: [],
      requiresExecution: false,
      error: {
        code: "request_identity_conflict",
        message: "This requestId already has a different preview. Retry with the original request or choose a new requestId.",
        details: { previousStage: previous.stage, previewRequestAvailable: Boolean(previous.request) },
      },
    };
  }
  const repos = (catalog.result as { repositories?: Array<{ id: string; worktreePath?: string; sourcePath?: string }> }).repositories || [];
  const material = previous?.bundle
    ? readBundle(previous.bundle)
    : !previous
      ? await createPreviewBundle({
          ownerAgentId: parentAgentId,
          ownerCwd: parentCwd,
          identity,
          handoff: fullRequest.handoff,
          runtime: { repositories: repos.flatMap(repo => repo.worktreePath || repo.sourcePath ? [{ id: repo.id, worktreePath: (repo.worktreePath || repo.sourcePath)! }] : []) },
        })
      : null;
  if (!previous) writeState(key, { identity, identityVersion: 2, request: fullRequest, workspaceId: fullRequest.workspaceId, stage: "previewed", previewedAt: new Date().toISOString(), ...(material ? { bundle: material.bundle } : {}) });
  return {
    ok: true,
    action: fullRequest.workspaceId ? "reuse" : "create",
    request: fullRequest,
    catalog: catalog.result,
    sideEffects: material ? ["handoff.bundle"] : [],
    requiresExecution: true,
    materials: material ? {
      bundle: material.bundle,
      ready: !material.blockers.length,
      blockers: material.blockers,
      warnings: material.warnings,
      sourceCount: material.sources.length,
      requiredSources: material.sources.filter(source => source.required).map(source => source.id),
      conversation: material.conversation,
    } : null,
    instructions: coordinatorGuidance,
  };
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
      parentWorkspaceId: simple.parentWorkspaceId, sourceWorkspaceId: simple.sourceWorkspaceId, branchName: simple.branchName, rootBaseRef: simple.rootBaseRef,
      baseRefs: simple.baseRefs,
      contextMode: "paseo",
      handoff: {
        goal: simple.task,
        startMode: simple.startMode,
        relationship: simple.relationship,
        reviewPacket: {
          requirementUnderstanding: "Use the task statement and original documents directly; inspect repository facts before implementation.",
          references: [...simple.references.map(reference => ({...reference, required: true})), ...simple.originalPaths.map((path, index) => ({ id: `original-path-${index + 1}`, kind: "document" as const, title: path.split(/[\\/]/).at(-1) || path, path: resolve(parent.cwd,path), required: true }))],
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
    const submissionIdentity = digest({submission:request,parentAgentId});
    if (previous?.submissionIdentity && previous.submissionIdentity !== submissionIdentity) return {ok:false,error:{code:'request_identity_conflict',message:'This requestId belongs to a different submission'}};
    if (previous) return { ok: true, action: previous.stage === "handed-off" ? "handed-off" : "accepted", requestId: request.requestId, progress: previous, nextAction: "end_turn" };
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
  if (!rawRequest.workspaceId && (!rawRequest.name || (!rawRequest.repositories?.length && !rawRequest.sourceWorkspaceId && !rawRequest.parentWorkspaceId))) throw new Error("workspace_selection_required");
  if (rawRequest.sourceWorkspaceId && rawRequest.repositories?.length) throw new Error("gitlink_repositories_implicit");
  const catalog = await query({ method: "workspace.detail", params: { workspaceId: rawRequest.workspaceId || rawRequest.sourceWorkspaceId || rawRequest.parentWorkspaceId || "main", summary: true } });
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
  if (submitted) {
    // Acknowledgement means the context and explicit originals are durably frozen.
    // Later messages and edits must not slip into the accepted handoff.
    const submissionIdentity = digest({submission:request,parentAgentId});
    try {
      const repos = (catalog.result as RepositoryCatalog).repositories || [];
      const material = await createPreviewBundle({ownerAgentId:parentAgentId,ownerCwd:parent.cwd,identity,handoff:fullRequest.handoff,
        runtime:{repositories:repos.flatMap(repo => repo.worktreePath || repo.sourcePath ? [{id:repo.id,worktreePath:(repo.worktreePath || repo.sourcePath)!}] : [])},context,lightweight:true});
      assertBundleReady(material.bundle);
      const concurrent = readState<Progress>(key);
      if (concurrent) {
        if (concurrent.submissionIdentity !== submissionIdentity) return {ok:false,error:{code:'request_identity_conflict',message:'This requestId belongs to a different submission'}};
        return {ok:true,action:concurrent.stage==='handed-off'?'handed-off':'accepted',requestId:fullRequest.requestId,progress:concurrent,nextAction:'end_turn'};
      }
      const accepted: Progress = { submissionIdentity, request: fullRequest, bundle: material.bundle, identity, identityVersion: 2, workspaceId: fullRequest.workspaceId, stage: "previewed", previewedAt: new Date().toISOString() };
      writeState(key, accepted);
      const canonical = fullRequest;
      queueMicrotask(() => {
        void orchestrate("submit-execute", canonical, parentAgentId, context).then(result => {
          if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
            const current = readState<Progress>(key) || accepted;
            if (['accepted','previewed','created'].includes(current.stage)) writeState(key,{...current,stage:'failed',result:{ok:false,action:'failed',error:'error' in result && result.error ? result.error as {code:string;message:string} : {code:'submission_failed',message:'Handoff could not be completed'}}});
          }
        }).catch(error => {
          const current = readState<Progress>(key) || accepted;
          writeState(key, { ...current, stage: "failed", result: { ok: false, action: "failed", error: { code: error && typeof error === "object" && "code" in error ? String(error.code) : String(error instanceof Error ? error.message : error).split(":")[0], message: error instanceof Error ? error.message : String(error) } } });
        });
      });
      return { ok: true, action: "accepted", requestId: request.requestId, progress: accepted, nextAction: "end_turn", instructions: "The durable submission was accepted. Use workbench_workspace_status with this requestId if later reconciliation is needed; do not resubmit." };
    } catch (error) {
      return {ok:false,error:{code:error && typeof error==='object' && 'code' in error ? String(error.code) : String(error instanceof Error?error.message:error).split(':')[0],message:error instanceof Error?error.message:String(error)}};
    }
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
    if (fullRequest.contextMode === 'paseo' && !progress.bundle) {
      const repos = (catalog.result as RepositoryCatalog).repositories || [];
      const material = await createPreviewBundle({ownerAgentId:parentAgentId,ownerCwd:parent.cwd,identity,handoff:fullRequest.handoff,
        runtime:{repositories:repos.flatMap(repo => repo.worktreePath || repo.sourcePath ? [{id:repo.id,worktreePath:(repo.worktreePath || repo.sourcePath)!}] : [])},context,lightweight:true});
      progress = {...progress,bundle:material.bundle};
      writeState(key,progress);
    }
    if (progress.bundle) assertBundleReady(progress.bundle);
    if (!progress.workspaceId) {
      await verifyExecution();
      const response = await query({ method: "workspace.create", params: { name: fullRequest.name, repositories: fullRequest.repositories, baseRefs: fullRequest.baseRefs,
        creator: {agentId:parentAgentId,...(parent.title ? {name:parent.title} : {}),recordedAt:new Date().toISOString()},
        requestId: fullRequest.requestId, parentWorkspaceId: fullRequest.parentWorkspaceId, sourceWorkspaceId: fullRequest.sourceWorkspaceId, branchName: fullRequest.branchName, rootBaseRef: fullRequest.rootBaseRef } });
      if (!response.ok) return response;
      progress = { ...progress, workspaceId: (response.result as { id: string }).id, stage: "created" };
      writeState(key, progress);
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
    const result = await handleAgentDelegate({ workspaceId: progress.workspaceId!, parentAgentId, handoff: fullRequest.handoff, bundle: progress.bundle, runtimeRepositories: fullRequest.repositories }, context);
    const material = progress.bundle ? readBundle(progress.bundle) : undefined;
    const transfer = material?.historyFile ? {history:'exported',historicalAttachments:'not_enumerated',sources:material.sources.map(source=>({id:source.id,title:source.title,mimeType:source.mimeType,status:source.status})),notice:'Chat text exported; historical attachments were not automatically enumerated.'} : undefined;
    const published = transfer ? {...result,transfer} : result;
    writeState(key, { ...progress, stage: result.ok ? "handed-off" : "handoff-blocked", result: published });
    return { ...handoffOutcome(published), requestId: fullRequest.requestId };
  })().finally(() => flights.delete(flightKey));
  flights.set(flightKey, run);
  return run;
}
