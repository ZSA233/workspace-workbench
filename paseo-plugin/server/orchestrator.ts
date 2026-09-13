import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentContext } from "./agent-provider.ts";
import { handleAgentDelegate, handleWorkspaceBinding } from "./agent-provider.ts";
import { childExecutionConfig } from "./execution-policy.ts";
import { queryObserver } from "./observer.ts";
import { currentProject, resolveProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { workflowRequest, type WorkflowRequest, type WorkflowStatusRequest } from "../shared/orchestration.ts";

type Progress = { identity: string; identityVersion?: 2; workspaceId?: string; stage: string; result?: Awaited<ReturnType<typeof handleAgentDelegate>> };
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

export async function orchestrate(action: "preview" | "execute" | "status", request: WorkflowRequest | WorkflowStatusRequest, parentAgentId: string, context: AgentContext) {
  const query = context.query || queryObserver;
  const parent = (await context.paseo.agents.ref(parentAgentId).refresh())?.agent;
  if (!parent) throw new Error("parent_agent_unavailable");
  if (action === "execute" && parent.labels?.["workspace-workbench.role"] === "workspace-worker") throw new Error("execution_child_must_not_delegate");
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  if (resolveProject({ directory: parent.cwd }).configPath !== project.configPath) throw new Error("parent_project_mismatch");
  const key = `workflow:${parentAgentId}:${request.requestId}`;
  const previous = readState<Progress>(key);
  if (action === "status") {
    if (!previous) return { ok: false, progress: null, execution: null, error: { code: "workflow_not_found", message: "No Workspace handoff exists for this request" } };
    if (request.workspaceId && previous.workspaceId && request.workspaceId !== previous.workspaceId) {
      return { ok: false, progress: previous, execution: null, error: { code: "workspace_identity_conflict", message: "The requested Workspace does not match this handoff" } };
    }
    return { ok: true, progress: previous, execution: previous.workspaceId ? await handleWorkspaceBinding({ workspaceId: previous.workspaceId }, context) : null };
  }
  const rawRequest = workflowRequest.parse(request);
  const listing = await query({ method: "workspace.list", params: { includeRemoved: true } });
  if (!listing.ok) return listing;
  const capabilities = (listing.result as { capabilities?: { create?: boolean; agent?: boolean; prepare?: boolean } }).capabilities;
  if (!capabilities?.agent || !rawRequest.workspaceId && !capabilities?.create) throw new Error("capability_unavailable");
  if (!rawRequest.workspaceId && (!rawRequest.name || !rawRequest.repositories?.length)) throw new Error("workspace_selection_required");
  if (action === "execute") childExecutionConfig(parent, rawRequest.handoff.startMode === "plan-first");
  const catalog = await query({ method: "workspace.detail", params: { workspaceId: rawRequest.workspaceId || "main", summary: true } });
  if (!catalog.ok) return catalog;
  const normalized = normalizeWorkflowRequest(rawRequest, catalog.result);
  if (!normalized.ok) return normalized;
  const fullRequest = normalized.request;
  const identity = digest({ request: fullRequest, parentAgentId });
  let compatiblePrevious = previous;
  if (compatiblePrevious && compatiblePrevious.identity !== identity) {
    const legacyRetry = compatiblePrevious.identityVersion === undefined
      && compatiblePrevious.stage === "validated"
      && !compatiblePrevious.workspaceId
      && !compatiblePrevious.result;
    if (!legacyRetry) throw new Error("request_identity_conflict");
    compatiblePrevious = { ...compatiblePrevious, identity, identityVersion: 2 };
  }
  if (action === "preview") {
    return { ok: true, action: fullRequest.workspaceId ? "reuse" : "create", request: fullRequest, catalog: catalog.result, sideEffects: [], requiresExecution: true };
  }
  if (previous?.stage === "handed-off") return previous.result;
  const flightKey = `${project.configPath}:${key}`;
  const active = flights.get(flightKey);
  if (active) return active;
  const run = (async () => {
    let progress: Progress = compatiblePrevious || { identity, identityVersion: 2, workspaceId: fullRequest.workspaceId, stage: "validated" };
    if (progress.identity !== identity) progress = { ...progress, identity, identityVersion: 2 };
    writeState(key, progress);
    if (!progress.workspaceId) {
      const response = await query({ method: "workspace.create", params: { name: fullRequest.name, repositories: fullRequest.repositories, baseRefs: fullRequest.baseRefs } });
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
        const response = await query({ method: "workspace.prepare", params: { workspaceId: progress.workspaceId, repositoryId: repository.id } });
        if (!response.ok || (response.result as { status?: string })?.status === "prepare_failed") { writeState(key, { ...progress, stage: "prepare-failed" }); return { ok: false, error: response.error || { code: "prepare_failed", message: "Runtime preparation failed" } }; }
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
    const result = await handleAgentDelegate({ workspaceId: progress.workspaceId!, parentAgentId, handoff: fullRequest.handoff }, context);
    writeState(key, { ...progress, stage: result.ok ? "handed-off" : "handoff-blocked", result });
    return result;
  })().finally(() => flights.delete(flightKey));
  flights.set(flightKey, run);
  return run;
}
