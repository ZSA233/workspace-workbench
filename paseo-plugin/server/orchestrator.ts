import type { AgentContext } from "./agent-provider.ts";
import { handleAgentDelegate, handleWorkspaceBinding } from "./agent-provider.ts";
import { childExecutionConfig } from "./execution-policy.ts";
import { queryObserver } from "./observer.ts";
import { currentProject, resolveProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { workflowRequest, type WorkflowRequest, type WorkflowStatusRequest } from "../shared/orchestration.ts";

type Progress = { identity: string; workspaceId?: string; stage: string; result?: Awaited<ReturnType<typeof handleAgentDelegate>> };
const flights = new Map<string, Promise<unknown>>();

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
  const fullRequest = workflowRequest.parse(request);
  const identity = digest({ request: fullRequest, parentAgentId });
  if (previous && previous.identity !== identity) throw new Error("request_identity_conflict");
  const listing = await query({ method: "workspace.list", params: { includeRemoved: true } });
  if (!listing.ok) return listing;
  const capabilities = (listing.result as { capabilities?: { create?: boolean; agent?: boolean; prepare?: boolean } }).capabilities;
  if (!capabilities?.agent || !fullRequest.workspaceId && !capabilities?.create) throw new Error("capability_unavailable");
  if (!fullRequest.workspaceId && (!fullRequest.name || !fullRequest.repositories?.length)) throw new Error("workspace_selection_required");
  if (action === "preview") {
    const catalog = await query({ method: "workspace.detail", params: { workspaceId: fullRequest.workspaceId || "main", summary: true } });
    if (!catalog.ok) return catalog;
    return { ok: true, action: fullRequest.workspaceId ? "reuse" : "create", request: fullRequest, catalog: catalog.result, sideEffects: [], requiresExecution: true };
  }
  childExecutionConfig(parent, fullRequest.handoff.startMode === "plan-first");
  if (previous?.stage === "handed-off") return previous.result;
  const flightKey = `${project.configPath}:${key}`;
  const active = flights.get(flightKey);
  if (active) return active;
  const run = (async () => {
    let progress: Progress = previous || { identity, workspaceId: fullRequest.workspaceId, stage: "validated" };
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
