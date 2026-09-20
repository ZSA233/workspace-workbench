import { withProject } from "./projects.ts";
import { handleObserver } from "./observer.ts";
import type { ObserverResponse } from "../shared/observer.ts";
import { issue } from "./backend/storage.ts";
import type { WorkspaceAddRepositoriesInput, WorkspaceCreateInput, WorkspaceOperationStatusInput } from "../shared/workspace-operations.ts";

function failed(error: unknown) {
  const value = issue(error);
  return { ok: false, error: { code: String(value.code || "internal_error"), message: String(value.message || "Workspace operation failed"), ...(value.details === undefined ? {} : { details: value.details }) } };
}

function operationResult(operationId: string | undefined, response: ObserverResponse) {
  if (!response.ok) return { ok: false, ...(operationId ? { operationId } : {}), error: response.error };
  const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
  return {
    ok: true,
    ...(typeof result.operationId === "string" ? { operationId: result.operationId } : operationId ? { operationId } : {}),
    ...(typeof result.id === "string" ? { workspaceId: result.id } : typeof result.workspaceId === "string" ? { workspaceId: result.workspaceId } : {}),
    ...(typeof result.treePath === "string" ? { treePath: result.treePath } : {}),
    ...(typeof result.state === "string" ? { stage: result.state } : typeof result.stage === "string" ? { stage: result.stage } : {}),
    ...(result.reused === true ? { reused: true } : {}),
    ...(result.inProgress === true ? { inProgress: true } : {}),
    result,
  };
}

/** Create only: no host Agent API and no handoff validation. */
export async function handleWorkspaceCreate(input: WorkspaceCreateInput) {
  try {
    return await withProject({ projectConfig: input.projectConfig }, async () => {
      const response = await handleObserver({ method: "workspace.create", params: {
        ...(input.requestId ? { requestId: input.requestId } : {}),
        name: input.name,
        ...(input.repositories ? { repositories: input.repositories } : {}),
        ...(input.sourceWorkspaceId ? { sourceWorkspaceId: input.sourceWorkspaceId } : {}),
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.rootBaseRef ? { rootBaseRef: input.rootBaseRef } : {}),
        baseRefs: input.baseRefs,
      } });
      return operationResult(input.requestId, response);
    });
  } catch (error) { return failed(error); }
}

export async function handleWorkspaceOperationStatus(input: WorkspaceOperationStatusInput) {
  try {
    return await withProject({ projectConfig: input.projectConfig }, async () => {
      const response = await handleObserver({ method: "workspace.operation.status", params: { operationId: input.operationId } });
      return operationResult(input.operationId, response);
    });
  } catch (error) { return failed(error); }
}

export async function handleWorkspaceAddRepositories(input: WorkspaceAddRepositoriesInput) {
  try {
    return await withProject({ projectConfig: input.projectConfig }, async () => {
      const response = await handleObserver({
        method: "workspace.addRepositories",
        params: {
          workspaceId: input.workspaceId,
          repositories: input.repositories,
          baseRefs: input.baseRefs,
        },
      });
      if (!response.ok) return { ok: false, workspaceId: input.workspaceId, addedRepositories: [], existingRepositories: [], error: response.error };
      const result = response.result && typeof response.result === "object" ? response.result as Record<string, unknown> : {};
      return {
        ok: true,
        workspaceId: input.workspaceId,
        stage: "active",
        addedRepositories: Array.isArray(result.addedRepositories) ? result.addedRepositories.filter((value): value is string => typeof value === "string") : [],
        existingRepositories: Array.isArray(result.existingRepositories) ? result.existingRepositories.filter((value): value is string => typeof value === "string") : [],
        result,
      };
    });
  } catch (error) { return failed(error); }
}
