import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { handoffSchema } from "./handoff.ts";

export const workflowRequest = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  repositories: z.array(z.string().min(1)).min(1).optional(),
  baseRefs: z.record(z.string(), z.string()).default({}),
  handoff: handoffSchema,
});
export const orchestrationRpc = defineRpc({
  name: "workspace.workbench.orchestrate",
  input: z.object({ projectConfig: z.string(), token: z.string().min(1), action: z.enum(["preview", "execute", "status"]), request: workflowRequest }),
  output: z.unknown(),
});
export type WorkflowRequest = z.infer<typeof workflowRequest>;
