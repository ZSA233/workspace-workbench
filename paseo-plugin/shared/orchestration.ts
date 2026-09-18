import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { handoffSchema } from "./handoff.ts";

export const workflowRequest = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  repositories: z.array(z.string().min(1)).min(1).optional(),
  sourceWorkspaceId: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  rootBaseRef: z.string().min(1).optional(),
  baseRefs: z.record(z.string(), z.string()).default({}),
  handoff: handoffSchema,
});
export const workflowStatusRequest = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
});
export const workflowSubmitRequest = z.object({
  requestId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  repositories: z.array(z.string().min(1)).min(1).optional(),
  sourceWorkspaceId: z.string().min(1).optional(),
  branchName: z.string().min(1).optional(),
  rootBaseRef: z.string().min(1).optional(),
  baseRefs: z.record(z.string(), z.string()).default({}),
  task: z.string().trim().min(1),
  originalPaths: z.array(z.string().trim().min(1)).max(128).default([]),
  startMode: z.enum(["adaptive", "plan-first"]).default("adaptive"),
  relationship: z.enum(["independent", "child"]).optional(),
});
export const orchestrationRpc = defineRpc({
  name: "workspace.workbench.orchestrate",
  // Submit includes requestId, so it must be checked before the narrower
  // status shape. Zod objects strip unknown fields; putting status first
  // silently removed submit.task before the handler could read it.
  input: z.object({ projectConfig: z.string(), token: z.string().min(1), action: z.enum(["preview", "execute", "status", "submit"]), request: z.union([workflowRequest, workflowSubmitRequest, workflowStatusRequest]) }),
  output: z.unknown(),
});
export type WorkflowRequest = z.infer<typeof workflowRequest>;
export type WorkflowStatusRequest = z.infer<typeof workflowStatusRequest>;
export type WorkflowSubmitRequest = z.infer<typeof workflowSubmitRequest>;
