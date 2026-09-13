import { queryObserver } from "./observer.ts";
import { handleWorkspaceBinding, type AgentContext } from "./agent-provider.ts";
import { clearReviewWorkspaceState, getReviewWorkspaceState, readReviewSession } from "./agent-review.ts";
import { getAgentBinding, removeAgentBinding } from "./agent-store.ts";
import {
  workspaceLifecycle,
  type WorkspaceLifecycleInput,
  type WorkspaceLifecycleResponse,
} from "../shared/workspace-lifecycle.ts";
import type { ObserverResponse } from "../shared/observer.ts";

const activeAgentStatuses = new Set(["pending", "initializing", "running", "permission", "blocked"]);
const activeReviewStatuses = new Set(["waiting_execution", "ready_for_review", "queued", "reviewing", "changes_requested", "fixing", "stopping"]);

type ActiveTask = WorkspaceLifecycleResponse["activeTasks"][number];
export type WorkspaceRuntimeState = {
  agentBinding: boolean;
  reviewSessionCount: number;
  activeReviewSessionId: string | null;
};
type WorkspaceRuntimeCleanup = ReturnType<typeof clearWorkspaceRuntimeState>;

function workspaceRuntimeState(workspaceId: string): WorkspaceRuntimeState {
  const review = getReviewWorkspaceState(workspaceId);
  return {
    agentBinding: Boolean(getAgentBinding(workspaceId)),
    reviewSessionCount: review.sessionCount,
    activeReviewSessionId: review.activeSessionId,
  };
}

export function clearWorkspaceRuntimeState(workspaceId: string): { bindingRemoved: boolean; sessionsRemoved: number; indexRemoved: boolean; authRecordsRemoved: number; runtimeRecordsRemoved: number } {
  const bindingRemoved = removeAgentBinding(workspaceId);
  return { bindingRemoved, ...clearReviewWorkspaceState(workspaceId) };
}

function withRuntimeState(result: unknown, runtimeState: WorkspaceRuntimeState): unknown {
  return result && typeof result === "object"
    ? { ...(result as Record<string, unknown>), runtimeState }
    : { runtimeState, result };
}

export async function activeWorkspaceTasks(workspaceId: string, context: AgentContext): Promise<{ tasks: ActiveTask[]; error?: { code: string; message: string } }> {
  const tasks: ActiveTask[] = [];
  try {
    const binding = await handleWorkspaceBinding({ workspaceId }, context);
    if (binding.binding && binding.error && !binding.agent) return { tasks, error: binding.error };
    const status = binding.agent?.status || binding.binding?.status || "";
    if (binding.agent && activeAgentStatuses.has(status)) {
      tasks.push({ kind: "agent", id: binding.agent.id, label: "Execution Agent", status });
    }
  } catch (error) {
    return { tasks, error: { code: "workspace_task_status_unavailable", message: error instanceof Error ? error.message : "Workspace task status is unavailable" } };
  }
  try {
    const session = readReviewSession(workspaceId);
    if (session && activeReviewStatuses.has(session.status)) {
      tasks.push({ kind: "review", id: session.id, label: "Agent Review", status: session.status });
    }
  } catch {
    return { tasks, error: { code: "workspace_task_status_unavailable", message: "Review state could not be checked; retry after recovery" } };
  }
  return { tasks };
}

function failed(input: WorkspaceLifecycleInput, error: { code: string; message: string }, activeTasks: ActiveTask[] = []): WorkspaceLifecycleResponse {
  return { ok: false, action: input.action, workspaceId: input.workspaceId, activeTasks, error };
}

function success(input: WorkspaceLifecycleInput, result: unknown, activeTasks: ActiveTask[] = []): WorkspaceLifecycleResponse {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
  return {
    ok: true,
    action: input.action,
    workspaceId: input.workspaceId,
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.pending === "boolean" ? { pending: value.pending } : {}),
    activeTasks,
    result,
  };
}

type PermanentDeleteOperations = {
  preview: () => Promise<ObserverResponse>;
  clearRuntime: () => WorkspaceRuntimeCleanup;
  deleteWorkspace: () => Promise<ObserverResponse>;
};

export async function executePermanentWorkspaceDelete(
  input: WorkspaceLifecycleInput,
  activeTasks: ActiveTask[],
  runtimeState: WorkspaceRuntimeState,
  operations: PermanentDeleteOperations,
): Promise<WorkspaceLifecycleResponse> {
  const preview = await operations.preview();
  if (!preview.ok) {
    return failed(input, preview.error || { code: "workspace_delete_failed", message: "Workspace could not be permanently deleted" }, activeTasks);
  }

  let runtimeCleanup: WorkspaceRuntimeCleanup;
  try {
    runtimeCleanup = operations.clearRuntime();
  } catch (error) {
    return failed(input, {
      code: "workspace_runtime_cleanup_failed",
      message: error instanceof Error ? error.message : "Workspace runtime state could not be cleaned up",
    }, activeTasks);
  }

  const response = await operations.deleteWorkspace();
  if (!response.ok) {
    return failed(input, response.error || { code: "workspace_delete_failed", message: "Workspace could not be permanently deleted" }, activeTasks);
  }
  return success(input, {
    ...(withRuntimeState(response.result ?? preview.result, runtimeState) as Record<string, unknown>),
    runtimeCleanup,
  }, activeTasks);
}

export async function handleWorkspaceLifecycle(input: WorkspaceLifecycleInput, context: AgentContext): Promise<WorkspaceLifecycleResponse> {
  let active = input.action === "remove" ? { tasks: [] as ActiveTask[] } : await activeWorkspaceTasks(input.workspaceId, context);
  if (active.error && ["remove", "delete"].includes(input.action)) return failed(input, active.error, active.tasks);
  if (["remove", "delete"].includes(input.action) && active.tasks.length > 0) {
    if (input.action === "delete") return failed(input, { code: "workspace_task_active", message: "Stop or finish the active Workspace task before permanently deleting it" }, active.tasks);
  }

  if (input.action === "inspect") {
    const listing = await queryObserver({ method: "workspace.list", params: { includeRemoved: true } });
    if (!listing.ok) return failed(input, listing.error || { code: "workspace_list_failed", message: "Workspace state is unavailable" }, active.tasks);
    const listed = (listing.result as { workspaces?: Array<{ id?: string; state?: string }> } | undefined)?.workspaces || [];
    const state = listed.find((workspace) => workspace.id === input.workspaceId)?.state || "active";
    const response = await queryObserver({ method: "workspace.delete", params: { workspaceId: input.workspaceId, confirm: false } });
    if (!response.ok) return failed(input, response.error || { code: "workspace_inspect_failed", message: "Workspace deletion impact is unavailable" }, active.tasks);
    return { ...success(input, withRuntimeState(response.result, workspaceRuntimeState(input.workspaceId)), active.tasks), state };
  }

  if (input.action === "remove") {
    const lock = await queryObserver({
      method: "workspace.remove",
      params: { workspaceId: input.workspaceId, lockOnly: true },
    });
    if (!lock.ok) return failed(input, lock.error || { code: "workspace_remove_failed", message: "Workspace could not be locked for removal" });
    active = await activeWorkspaceTasks(input.workspaceId, context);
    if (active.error) return failed(input, active.error, active.tasks);
    const response = await queryObserver({
      method: "workspace.remove",
      params: { workspaceId: input.workspaceId, ...(active.tasks.length ? { activeTasks: active.tasks } : {}) },
    });
    if (!response.ok) return failed(input, response.error || { code: "workspace_remove_failed", message: "Workspace could not be removed" }, active.tasks);
    return success(input, response.result, active.tasks);
  }

  if (input.action === "restore") {
    const response = await queryObserver({ method: "workspace.restore", params: { workspaceId: input.workspaceId } });
    if (!response.ok) return failed(input, response.error || { code: "workspace_restore_failed", message: "Workspace could not be restored" }, active.tasks);
    return success(input, response.result, active.tasks);
  }

  try {
    const runtimeState = workspaceRuntimeState(input.workspaceId);
    if (input.confirm !== true) {
      const response = await queryObserver({ method: "workspace.delete", params: { workspaceId: input.workspaceId, confirm: false } });
      if (!response.ok) return failed(input, response.error || { code: "workspace_delete_failed", message: "Workspace could not be permanently deleted" }, active.tasks);
      return success(input, withRuntimeState(response.result, runtimeState), active.tasks);
    }
    return executePermanentWorkspaceDelete(input, active.tasks, runtimeState, {
      preview: () => queryObserver({ method: "workspace.delete", params: { workspaceId: input.workspaceId, confirm: false } }),
      clearRuntime: () => clearWorkspaceRuntimeState(input.workspaceId),
      deleteWorkspace: () => queryObserver({ method: "workspace.delete", params: { workspaceId: input.workspaceId, confirm: true } }),
    });
  } catch (error) {
    return failed(input, { code: "workspace_runtime_state_unavailable", message: error instanceof Error ? error.message : "Workspace runtime state is unavailable" }, active.tasks);
  }
}

export { workspaceLifecycle };
