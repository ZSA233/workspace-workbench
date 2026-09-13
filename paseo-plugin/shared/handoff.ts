import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { agentRelationshipSchema } from "./agent-session.ts";

/** Generic, provider-neutral handoff payload used by the optional Agent provider. */
export const handoffSchema = z.object({
  version: z.literal("workspace.workbench.handoff/v1").default("workspace.workbench.handoff/v1"),
  goal: z.string().trim().min(1),
  decisions: z.array(z.string().trim().min(1)).default([]),
  inScope: z.array(z.string().trim().min(1)).default([]),
  outOfScope: z.array(z.string().trim().min(1)).default([]),
  steps: z.array(z.string().trim().min(1)).default([]),
  acceptance: z.array(z.string().trim().min(1)).default([]),
  constraints: z.array(z.string().trim().min(1)).default([]),
  ambiguities: z.array(z.string().trim().min(1)).default([]),
  startMode: z.enum(["adaptive", "plan-first"]).default("adaptive"),
  handoffId: z.string().trim().min(1).optional(),
  providerModel: z.string().trim().min(1).optional(),
  /** Optional per-task override; project/provider settings remain the default. */
  relationship: agentRelationshipSchema.optional(),
  policy: z.object({
    placementGuard: z.boolean().default(true),
    providerSandbox: z.boolean().optional(),
  }).default({ placementGuard: true }),
  expected: z.object({
    branchByRepository: z.record(z.string(), z.string()).default({}),
    baseByRepository: z.record(z.string(), z.string()).default({}),
    dirty: z.boolean().optional(),
  }).default({ branchByRepository: {}, baseByRepository: {} }),
});

export const workspaceBindingSchema = z.object({
  workspaceId: z.string(),
  paseoWorkspaceId: z.string(),
  treePath: z.string(),
  agentId: z.string().optional(),
  relationship: agentRelationshipSchema.default("child"),
  parentAgentId: z.string().optional(),
  providerModel: z.string().optional(),
  handoffId: z.string().optional(),
  handoffHash: z.string().optional(),
  status: z.enum([
    "pending", "initializing", "running", "idle", "permission", "completed",
    "blocked", "error", "closed", "archived",
  ]),
  lastNotificationKey: z.string().optional(),
  lastError: z.string().optional(),
  lastOutcome: z.string().optional(),
  updatedAt: z.string(),
});

const agentShape = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  cwd: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string().nullable(),
  relationship: agentRelationshipSchema,
  parentAgentId: z.string().nullable(),
  lastUsage: z.object({
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalCostUsd: z.number().optional(),
    contextWindowMaxTokens: z.number().optional(),
    contextWindowUsedTokens: z.number().optional(),
  }).nullable().optional(),
  lastError: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export const workspaceBindingQuery = defineRpc({
  name: "workspace.workbench.binding",
  input: z.object({ workspaceId: z.string().trim().min(1), projectConfig: z.string().optional() }),
  output: z.object({
    ok: z.boolean(),
    binding: workspaceBindingSchema.nullable().optional(),
    handoff: handoffSchema.nullable().optional(),
    agent: agentShape.nullable().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export const workspaceDelegate = defineRpc({
  name: "workspace.workbench.delegate",
  input: z.object({
    projectConfig: z.string().optional(),
    workspaceId: z.string().trim().min(1),
    parentAgentId: z.string().trim().min(1),
    handoff: handoffSchema,
  }),
  output: z.object({
    ok: z.boolean(),
    action: z.enum(["created", "reused", "already-running", "blocked", "failed"]),
    workspaceId: z.string(),
    paseoWorkspaceId: z.string().optional(),
    treePath: z.string().optional(),
    agentId: z.string().optional(),
    relationship: agentRelationshipSchema.optional(),
    parentAgentId: z.string().optional(),
    providerModel: z.string().optional(),
    status: z.string().optional(),
    handoffId: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export const agentContextQuery = defineRpc({
  name: "workspace.workbench.agent_context",
  input: z.object({ projectConfig: z.string().trim().min(1), agentId: z.string().trim().min(1) }),
  output: z.object({
    ok: z.boolean(),
    available: z.boolean(),
    reason: z.enum(["ready", "not_injected", "revoked", "mismatched"]).optional(),
  }),
});

export type Handoff = z.infer<typeof handoffSchema>;
export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>;
export type WorkspaceBindingResponse = z.infer<typeof workspaceBindingQuery.output>;
export type WorkspaceDelegateInput = z.infer<typeof workspaceDelegate.input>;
export type WorkspaceDelegateResponse = z.infer<typeof workspaceDelegate.output>;
export type AgentContextResponse = z.infer<typeof agentContextQuery.output>;
