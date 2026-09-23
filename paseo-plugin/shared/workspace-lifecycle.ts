import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const workspaceLifecycleAction = z.enum(["inspect", "remove", "restore", "delete"]);

export const workspaceLifecycle = defineRpc({
  name: "workspace.workbench.lifecycle",
  input: z.object({
    projectConfig: z.string().optional(),
    workspaceId: z.string().trim().min(1),
    action: workspaceLifecycleAction,
    confirm: z.boolean().optional(),
    confirmDataLoss: z.boolean().optional().describe("Required for permanent deletion when the preview reports requiresDataLossConfirmation; explicitly authorizes discarding all content in the managed Workspace tree."),
  }),
  output: z.object({
    ok: z.boolean(),
    action: workspaceLifecycleAction,
    workspaceId: z.string(),
    state: z.string().optional(),
    pending: z.boolean().optional(),
    activeTasks: z.array(z.object({
      kind: z.string(),
      id: z.string().optional(),
      label: z.string().optional(),
      status: z.string().optional(),
    })).default([]),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export type WorkspaceLifecycleInput = z.infer<typeof workspaceLifecycle.input>;
export type WorkspaceLifecycleResponse = z.infer<typeof workspaceLifecycle.output>;
