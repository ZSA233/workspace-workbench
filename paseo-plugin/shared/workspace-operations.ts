import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const projectConfig = z.string().trim().min(1);
const requestId = z.string().trim().min(1).max(200).optional();
const repositoryRefs = z.array(z.string().trim().min(1)).min(1).optional();
const baseRefs = z.record(z.string().trim().min(1), z.string().trim().min(1)).default({});
const requiredRepositoryRefs = z.array(z.string().trim().min(1)).min(1);

/**
 * The Git operation boundary deliberately has no Agent, Reviewer or handoff
 * identity.  A separate delegate call is responsible for starting a child
 * session after a worktree exists.
 */
export const workspaceCreate = defineRpc({
  name: "workspace.workbench.workspace-create",
  input: z.object({
    projectConfig,
    requestId,
    name: z.string().trim().min(1),
    repositories: repositoryRefs,
    sourceWorkspaceId: z.string().trim().min(1).optional(),
    branchName: z.string().trim().min(1).optional(),
    rootBaseRef: z.string().trim().min(1).optional(),
    baseRefs,
  }),
  output: z.object({
    ok: z.boolean(),
    operationId: z.string().optional(),
    workspaceId: z.string().optional(),
    treePath: z.string().optional(),
    stage: z.string().optional(),
    reused: z.boolean().optional(),
    inProgress: z.boolean().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
  }),
});

export const workspaceOperationStatus = defineRpc({
  name: "workspace.workbench.workspace-operation-status",
  input: z.object({ projectConfig, operationId: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    operationId: z.string().optional(),
    workspaceId: z.string().optional(),
    treePath: z.string().optional(),
    stage: z.string().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
  }),
});

/** Add repositories to an existing flat managed Workspace without involving
 * an Agent, handoff, Reviewer or parent session. */
export const workspaceAddRepositories = defineRpc({
  name: "workspace.workbench.workspace-add-repositories",
  input: z.object({
    projectConfig,
    workspaceId: z.string().trim().min(1),
    repositories: requiredRepositoryRefs,
    baseRefs,
  }),
  output: z.object({
    ok: z.boolean(),
    workspaceId: z.string().optional(),
    stage: z.string().optional(),
    addedRepositories: z.array(z.string()).default([]),
    existingRepositories: z.array(z.string()).default([]),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
  }),
});

export type WorkspaceCreateInput = z.infer<typeof workspaceCreate.input>;
export type WorkspaceOperationStatusInput = z.infer<typeof workspaceOperationStatus.input>;
export type WorkspaceAddRepositoriesInput = z.infer<typeof workspaceAddRepositories.input>;
