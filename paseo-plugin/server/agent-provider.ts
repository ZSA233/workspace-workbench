import { randomUUID } from "node:crypto";
import { currentProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { childExecutionConfig } from "./execution-policy.ts";
import { copy } from "../shared/copy.ts";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import { queryObserver } from "./observer.ts";
import { getAgentBinding, putAgentBinding, type AgentBinding } from "./agent-store.ts";
import {
  agentDelegate,
  agentStatusQuery,
  type AgentDelegateInput,
} from "../shared/agent.ts";
import {
  workspaceBindingQuery,
  workspaceDelegate,
  type Handoff,
  type WorkspaceBinding,
  type WorkspaceBindingResponse,
  type WorkspaceDelegateInput,
  type WorkspaceDelegateResponse,
} from "../shared/handoff.ts";

type RuntimeResult = {
  workspaceId: string;
  managed: boolean;
  treePath: string | null;
  capabilities?: { agent?: boolean };
  repositories?: Array<{ id: string; worktreePath: string; branch: string; baseSha?: string }>;
  toolchain?: unknown;
};

export type AgentContext = { paseo: PaseoApi; query?: typeof queryObserver };

function compactAgent(agent: PaseoAgent | null, binding: AgentBinding | null) {
  if (!agent) return null;
  return {
    id: agent.id,
    workspaceId: agent.workspaceId || binding?.paseoWorkspaceId || null,
    cwd: agent.cwd || binding?.cwd || null,
    provider: agent.runtimeInfo?.provider || agent.provider,
    model: agent.runtimeInfo?.model || agent.model || null,
    status: agent.status || null,
    parentAgentId: binding?.parentAgentId || null,
  };
}

function bindingStatus(status: string | null | undefined): WorkspaceBinding["status"] {
  if (status === "running" || status === "initializing" || status === "error" || status === "closed") {
    return status;
  }
  if (status === "permission" || status === "blocked" || status === "completed" || status === "archived") {
    return status;
  }
  return "idle";
}

async function currentAgent(context: AgentContext, binding: AgentBinding): Promise<PaseoAgent | null> {
  try {
    const snapshot = await context.paseo.agents.ref(binding.agentId).refresh();
    return snapshot?.agent || null;
  } catch {
    return null;
  }
}

export async function handleWorkspaceBinding(
  input: { workspaceId: string },
  context: AgentContext,
): Promise<WorkspaceBindingResponse> {
  const saved = getAgentBinding(input.workspaceId);
  if (!saved) return { ok: true, binding: null, handoff: null, agent: null };
  const agent = await currentAgent(context, saved);
  const compact = agent ? compactAgent(agent, saved) : null;
  const binding: WorkspaceBinding = {
    workspaceId: saved.workspaceId,
    paseoWorkspaceId: saved.paseoWorkspaceId,
    treePath: saved.cwd,
    agentId: saved.agentId,
    parentAgentId: saved.parentAgentId,
    providerModel: saved.provider,
    status: agent?.pendingPermissions?.length ? "permission" : agent ? bindingStatus(agent.status) : "error",
    lastOutcome: saved.status,
    updatedAt: saved.updatedAt,
  };
  return {
    ok: true,
    binding,
    handoff: saved.handoff || null,
    agent: compact ? { ...compact, lastUsage: agent?.lastUsage || null, lastError: agent?.lastError || null, labels: agent?.labels || {} } : null,
    ...(!agent ? { error: { code: "agent_refresh_failed", message: "执行 Agent 状态暂时不可用" } } : {}),
  };
}

export async function handleWorkspaceDelegate(
  input: WorkspaceDelegateInput,
  context: AgentContext,
): Promise<WorkspaceDelegateResponse> {
  const result = await handleAgentDelegate(input as AgentDelegateInput, context);
  return {
    ok: result.ok,
    action: result.action,
    workspaceId: result.workspaceId,
    agentId: result.agentId,
    status: result.status,
    error: result.error,
  };
}

export async function handleAgentStatus(
  input: { workspaceId: string },
  context: AgentContext,
) {
  const binding = getAgentBinding(input.workspaceId);
  if (!binding) return { ok: true, agent: null };
  try {
    const snapshot = await context.paseo.agents.ref(binding.agentId).refresh();
    if (!snapshot?.agent) return { ok: true, agent: null };
    return { ok: true, agent: compactAgent(snapshot.agent, binding) };
  } catch (error) {
    return {
      ok: true,
      agent: null,
      error: { code: "agent_refresh_failed", message: error instanceof Error ? error.message : "agent refresh failed" },
    };
  }
}

function providerFromAgent(agent: PaseoAgent): string | null {
  const provider = agent.runtimeInfo?.provider || agent.provider;
  const model = agent.runtimeInfo?.model || agent.model;
  if (!provider) return null;
  return model ? `${provider}/${model}` : provider;
}

function handoffPrompt(workspaceId: string, handoff: Handoff, runtime: RuntimeResult): string {
  const section = (title: string, values: readonly string[]) => values.length ? [`${title}:`, ...values.map((value) => `- ${value}`), ""] : [];
  return [
    "Workspace Workbench Agent handoff",
    "You are the execution child, not the coordinator. The Workspace has already been created and prepared. Execute this approved task; do not create or delegate another Workspace or Agent, and do not repeat planning unless start mode is plan-first.",
    "",
    `Workspace: ${workspaceId}`,
    `Assigned directory: ${runtime.treePath}`,
    `Verified worktrees: ${JSON.stringify(runtime.repositories || [])}`,
    `Prepared runtimes: ${JSON.stringify(runtime.toolchain || null)}`,
    "Before editing, confirm the current Workspace and working directory.",
    "If the target is ambiguous, stop and report the mismatch.",
    "",
    "Goal:",
    handoff.goal,
    "",
    ...section("Decisions", handoff.decisions),
    ...section("In scope", handoff.inScope),
    ...section("Out of scope", handoff.outOfScope),
    ...section("Steps", handoff.steps),
    ...section("Acceptance", handoff.acceptance),
    ...section("Constraints", handoff.constraints),
    ...section("Ambiguities", handoff.ambiguities),
    ...section("Expected branches", Object.entries(handoff.expected.branchByRepository).map(([repo, branch]) => `${repo}: ${branch}`)),
    ...section("Expected bases", Object.entries(handoff.expected.baseByRepository).map(([repo, base]) => `${repo}: ${base}`)),
    `Start mode: ${handoff.startMode}`,
    "The workspace root is a multi-repository container. Verify the supplied worktree paths and Git branches before editing. The coordinator already completed the runtime preflight; do not delegate or call execute again.",
    "Respect the host permission and sandbox policy. Verify configured runtimes before executing build commands.",
  ].join("\n");
}

const delegates = new Map<string, { identity: string; promise: Promise<Awaited<ReturnType<typeof delegateAgent>>> }>();

export async function handleAgentDelegate(input: AgentDelegateInput, context: AgentContext) {
  const projectKey = `${currentProject()?.configPath || ""}:${input.workspaceId}`;
  const active = delegates.get(projectKey);
  const identity = JSON.stringify(input);
  if (active) {
    if (active.identity === identity) return active.promise;
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_in_progress", message: "Another handoff is in progress" } };
  }
  const pending = delegateAgent(input, context).finally(() => delegates.delete(projectKey));
  delegates.set(projectKey, { identity, promise: pending });
  return pending;
}

async function delegateAgent(
  input: AgentDelegateInput,
  context: AgentContext,
) {
  const handoffHash = digest(input.handoff);
  const runtimeResponse = await (context.query || queryObserver)({ method: "workspace.runtime", params: { workspaceId: input.workspaceId } });
  const runtime = runtimeResponse.ok ? runtimeResponse.result as RuntimeResult : null;
  if (!runtime?.treePath) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: runtimeResponse.error?.code || "workspace_runtime_unavailable", message: "Workspace runtime is unavailable" } };
  }
  if (!runtime.managed) {
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "live_workspace_not_managed", message: "The live workspace cannot receive an isolated Agent" } };
  }
  if (!runtime.capabilities?.agent) {
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "capability_unavailable", message: "Agent provider is disabled" } };
  }
  const parent = context.paseo.agents.ref(input.parentAgentId);
  let parentSnapshot: Awaited<ReturnType<typeof parent.refresh>>;
  try {
    parentSnapshot = await parent.refresh();
  } catch (error) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "parent_agent_unavailable", message: error instanceof Error ? error.message : "parent Agent unavailable" } };
  }
  if (!parentSnapshot?.agent) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "parent_agent_missing", message: "Parent Agent is unavailable" } };
  }
  let childConfig;
  try { childConfig = childExecutionConfig(parentSnapshot.agent, input.handoff.startMode === "plan-first"); }
  catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: String((error as Error).message), message: copy.agentModeUnconfirmed } }; }
  const selectedProvider = input.provider || providerFromAgent(parentSnapshot.agent);
  if (!selectedProvider) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "agent_provider_missing", message: "No Agent provider was resolved" } };
  }
  if (selectedProvider !== childConfig.provider) return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_provider_mismatch", message: "Selected provider does not match the verified coordinator" } };
  let saved = getAgentBinding(input.workspaceId);
  const project = currentProject();
  const creationKey = `agent-create:${input.workspaceId}`;
  // Recover a created worker before considering another create. Listing failure
  // or an incomplete page is not evidence that no worker exists.
  if (!saved && project) {
    try {
      const candidates: PaseoAgent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await context.paseo.agents.list({ filter: { labels: { "workspace-workbench.project": digest(project.configPath), "workspace-workbench.workspace-id": input.workspaceId, "workspace-workbench.role": "workspace-worker" }, includeArchived: true }, page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        candidates.push(...result.entries.map((entry) => entry.agent));
        if (!result.pageInfo.hasMore) break;
        if (!result.pageInfo.nextCursor || page === 9) throw new Error("agent_listing_incomplete");
        cursor = result.pageInfo.nextCursor;
      }
      if (candidates.length > 1) throw new Error("agent_candidates_ambiguous");
      const recovered = candidates[0];
      if (recovered) {
        if (recovered.cwd !== runtime.treePath || recovered.labels["workspace-workbench.parent"] !== input.parentAgentId || recovered.labels["workspace-workbench.handoff"] !== handoffHash) throw new Error("agent_identity_changed");
        const now = new Date().toISOString();
        saved = { workspaceId: input.workspaceId, agentId: recovered.id, parentAgentId: input.parentAgentId, paseoWorkspaceId: recovered.workspaceId || "", cwd: recovered.cwd, provider: selectedProvider, createdAt: now, updatedAt: now, handoff: input.handoff, handoffHash, delivery: "sent" };
        putAgentBinding(saved);
      } else if (readState(creationKey)) throw new Error("agent_creation_uncertain");
    } catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_recovery_required", message: (error as Error).message } }; }
  }
  if (saved) {
    try {
      const current = await context.paseo.agents.ref(saved.agentId).refresh();
      if (current?.agent && current.agent.status !== "closed" && !current.agent.archivedAt) {
        if (saved.parentAgentId !== input.parentAgentId || current.agent.id !== saved.agentId || current.agent.cwd !== runtime.treePath || saved.cwd !== runtime.treePath || saved.workspaceId !== input.workspaceId) {
          return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_identity_changed", message: "Agent placement does not match the workspace" } };
        }
        if (saved.delivery === "pending") throw new Error("handoff_delivery_uncertain");
        const mode = current.agent.features?.find((feature) => feature.id === "plan_mode");
        if (providerFromAgent(current.agent) !== selectedProvider || !mode || mode.type !== "toggle" || mode.value !== (input.handoff.startMode === "plan-first")) {
          return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_mode_mismatch", message: copy.agentModeUnconfirmed } };
        }
        if (current.agent.status === "running" || current.agent.status === "initializing") {
          if (saved.handoffHash !== handoffHash) return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_busy_different_task", message: copy.agentBusyOtherTask } };
          return { ok: true, action: "already-running" as const, workspaceId: input.workspaceId, agentId: current.agent.id, status: current.agent.status };
        }
        if (saved.handoffHash === handoffHash) return { ok: true, action: "reused" as const, workspaceId: input.workspaceId, agentId: current.agent.id, status: current.agent.status };
        putAgentBinding({ ...saved, handoff: input.handoff, handoffHash, delivery: "pending", updatedAt: new Date().toISOString() });
        await context.paseo.agents.ref(saved.agentId).send(handoffPrompt(input.workspaceId, input.handoff, runtime), { messageId: handoffHash });
        putAgentBinding({ ...saved, handoff: input.handoff, handoffHash, delivery: "sent", updatedAt: new Date().toISOString() });
        return { ok: true, action: "reused" as const, workspaceId: input.workspaceId, agentId: current.agent.id, status: current.agent.status || "idle" };
      }
      if (!current?.agent) throw new Error("agent unavailable");
      return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_closed", message: copy.agentClosedRecovery } };
    } catch {
      return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "agent_refresh_failed", message: "Cannot confirm the existing Agent; retry later" } };
    }
  }
  let paseoWorkspace;
  try {
    paseoWorkspace = await context.paseo.workspaces.open(runtime.treePath);
    if (project) writeState(creationKey, { handoffHash, parentAgentId: input.parentAgentId, stage: "creating" });
    const created = await paseoWorkspace.agents.create({
      parent: input.parentAgentId,
      env: { WORKBENCH_WORKER_WORKSPACE: input.workspaceId },
      title: input.title || `${input.workspaceId} worker`,
      config: { ...childConfig, provider: selectedProvider },
      clientMessageId: handoffHash,
      prompt: handoffPrompt(input.workspaceId, input.handoff, runtime),
      labels: {
        "workspace-workbench.role": "workspace-worker",
        "workspace-workbench.workspace-id": input.workspaceId,
        "workspace-workbench.project": digest(project?.configPath || ""),
        "workspace-workbench.parent": input.parentAgentId,
        "workspace-workbench.handoff": handoffHash,
      },
    });
    const now = new Date().toISOString();
    const binding: AgentBinding = {
      workspaceId: input.workspaceId,
      agentId: created.id,
      parentAgentId: input.parentAgentId,
      paseoWorkspaceId: paseoWorkspace.id,
      cwd: runtime.treePath,
      provider: selectedProvider,
      createdAt: now,
      updatedAt: now,
      handoff: input.handoff,
      handoffHash,
      delivery: "sent",
    };
    putAgentBinding(binding);
    return { ok: true, action: "created" as const, workspaceId: input.workspaceId, agentId: created.id, status: created.current()?.status || "initializing" };
  } catch (error) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "agent_create_failed", message: error instanceof Error ? error.message : "Agent creation failed" } };
  }
}

export function registerAgentProvider(server: PluginServerContext): void {
  server.handle(agentStatusQuery, handleAgentStatus);
  server.handle(agentDelegate, handleAgentDelegate);
  server.handle(workspaceBindingQuery, handleWorkspaceBinding);
  server.handle(workspaceDelegate, handleWorkspaceDelegate);
}
