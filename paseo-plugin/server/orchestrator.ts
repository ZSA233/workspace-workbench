import type { AgentContext } from "./agent-provider.ts";
import { handleAgentDelegate, handleWorkspaceBinding } from "./agent-provider.ts";
import { childExecutionConfig } from "./execution-policy.ts";
import { queryObserver } from "./observer.ts";
import { currentProject, resolveProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import type { WorkflowRequest } from "../shared/orchestration.ts";

type Progress = { identity: string; workspaceId?: string; stage: string; result?: Awaited<ReturnType<typeof handleAgentDelegate>> };
const flights = new Map<string, Promise<unknown>>();

export async function orchestrate(action: "preview" | "execute" | "status", request: WorkflowRequest, parentAgentId: string, context: AgentContext) {
  const query = context.query || queryObserver;
  const parent = (await context.paseo.agents.ref(parentAgentId).refresh())?.agent;
  if (!parent) throw new Error("parent_agent_unavailable");
  if (action === "execute" && parent.labels?.["workspace-workbench.role"] === "workspace-worker") throw new Error("execution_child_must_not_delegate");
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  if (resolveProject({ directory: parent.cwd }).configPath !== project.configPath) throw new Error("parent_project_mismatch");
  const identity = digest({ request, parentAgentId });
  const key = `workflow:${parentAgentId}:${request.requestId}`;
  const previous = readState<Progress>(key);
  if (previous && previous.identity !== identity) throw new Error("request_identity_conflict");
  if (action === "status") return { ok: true, progress: previous, execution: previous?.workspaceId ? await handleWorkspaceBinding({ workspaceId: previous.workspaceId }, context) : null };
  const listing = await query({ method: "workspace.list", params: { includeRemoved: true } });
  if (!listing.ok) return listing;
  const capabilities = (listing.result as { capabilities?: { create?: boolean; agent?: boolean; prepare?: boolean } }).capabilities;
  if (!capabilities?.agent || !request.workspaceId && !capabilities?.create) throw new Error("capability_unavailable");
  if (!request.workspaceId && (!request.name || !request.repositories?.length)) throw new Error("workspace_selection_required");
  if (action === "preview") {
    const catalog = await query({ method: "workspace.detail", params: { workspaceId: request.workspaceId || "main", summary: true } });
    if (!catalog.ok) return catalog;
    return { ok: true, action: request.workspaceId ? "reuse" : "create", request, catalog: catalog.result, sideEffects: [], requiresExecution: true };
  }
  childExecutionConfig(parent, request.handoff.startMode === "plan-first");
  if (previous?.stage === "handed-off") return previous.result;
  const flightKey = `${project.configPath}:${key}`;
  const active = flights.get(flightKey);
  if (active) return active;
  const run = (async () => {
    let progress: Progress = previous || { identity, workspaceId: request.workspaceId, stage: "validated" };
    writeState(key, progress);
    if (!progress.workspaceId) {
      const response = await query({ method: "workspace.create", params: { name: request.name, repositories: request.repositories, baseRefs: request.baseRefs } });
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
    const expected = request.handoff.expected;
    const repositories = (runtime.result as { repositories?: Array<{ id: string; repoPath: string; branch: string; baseSha: string }> }).repositories || [];
    for (const [repo, branch] of Object.entries(expected.branchByRepository)) {
      if (!repositories.some((item) => (item.id === repo || item.repoPath === repo) && item.branch === branch)) throw new Error("handoff_branch_mismatch");
    }
    for (const [repo, base] of Object.entries(expected.baseByRepository)) {
      if (!repositories.some((item) => (item.id === repo || item.repoPath === repo) && item.baseSha === base)) throw new Error("handoff_base_mismatch");
    }
    progress = { ...progress, stage: "delegating" };
    writeState(key, progress);
    const result = await handleAgentDelegate({ workspaceId: progress.workspaceId!, parentAgentId, handoff: request.handoff }, context);
    writeState(key, { ...progress, stage: result.ok ? "handed-off" : "handoff-blocked", result });
    return result;
  })().finally(() => flights.delete(flightKey));
  flights.set(flightKey, run);
  return run;
}
