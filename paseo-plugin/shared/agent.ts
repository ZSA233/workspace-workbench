import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { handoffSchema, type Handoff } from "./handoff.ts";

export { handoffSchema } from "./handoff.ts";

export const agentStatusQuery = defineRpc({
  name: "workspace.workbench.agent.status",
  input: z.object({ workspaceId: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    agent: z.object({
      id: z.string(),
      workspaceId: z.string().nullable(),
      cwd: z.string().nullable(),
      provider: z.string(),
      model: z.string().nullable(),
      status: z.string().nullable(),
      parentAgentId: z.string().nullable(),
    }).nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export const agentDelegate = defineRpc({
  name: "workspace.workbench.agent.delegate",
  input: z.object({
    workspaceId: z.string().trim().min(1),
    parentAgentId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    provider: z.string().trim().min(1).optional(),
    handoff: handoffSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.enum(["created", "reused", "already-running", "blocked", "failed"]),
    workspaceId: z.string(),
    agentId: z.string().optional(),
    status: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export type AgentStatusResponse = z.infer<typeof agentStatusQuery.output>;
export type AgentDelegateInput = z.infer<typeof agentDelegate.input>;
export type AgentDelegateResponse = z.infer<typeof agentDelegate.output>;
export type { Handoff } from "./handoff.ts";
