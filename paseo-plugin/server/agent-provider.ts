import { withWorkspaceScope } from "./workspace-scope.ts";
import type { BundleRef } from "../shared/handoff-materials.ts";
import { assertBundleReady } from "./handoff-bundles.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { currentProject } from "./projects.ts";
import { digest, readState, writeState } from "./orchestration-state.ts";
import { childExecutionConfig, assertCoordinatorExecution, assertInitialWorkerMode, actualPlanningState, ExecutionPolicyError } from "./execution-policy.ts";
import { copy } from "../shared/copy.ts";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import { queryObserver } from "./observer.ts";
import { getAgentBinding, putAgentBinding, type AgentBinding } from "./agent-store.ts";
import { configuredExecutionModel, readReviewSession, recordExecutionHandoff } from "./agent-review.ts";
import { resolveAgentRelationship } from "./agent-session.ts";
import { getWorkbenchCopy } from "../shared/copy.ts";
import type { AgentRelationship } from "../shared/agent-session.ts";
import { artifactSnapshotContent, resolveArtifactReference, resolvedArtifactImageAttachments, type ResolvedWorkbenchArtifact } from "./artifacts.ts";
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
  toolchain?: {
    environment?: { pathEntries?: unknown; variables?: unknown };
    preparedRepositories?: unknown;
  };
};

export type AgentContext = { paseo: PaseoApi; query?: typeof queryObserver };

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  try { return realpathSync(left) === realpathSync(right); }
  catch { return resolve(left) === resolve(right); }
}

function runtimeAgentCwdMatches(runtime: RuntimeResult, cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return [runtime.treePath, ...(runtime.repositories || []).map((repository) => repository.worktreePath)]
    .some((candidate) => samePath(cwd, candidate));
}

function runtimeEnvironment(runtime: RuntimeResult): Record<string, string> {
  const environment = runtime.toolchain?.environment;
  const rawPathEntries = Array.isArray(environment?.pathEntries) ? environment.pathEntries : [];
  const pathEntries = rawPathEntries.filter((value): value is string => typeof value === "string" && isAbsolute(value));
  const variables: Record<string, string> = {};
  const allowedVariables = new Set(["GOCACHE", "GOMODCACHE", "NPM_CONFIG_CACHE", "PIP_CACHE_DIR", "MISE_DATA_DIR", "MISE_CACHE_DIR", "GOTOOLCHAIN"]);
  if (environment?.variables && typeof environment.variables === "object" && !Array.isArray(environment.variables)) {
    for (const [key, value] of Object.entries(environment.variables as Record<string, unknown>)) {
      if (allowedVariables.has(key) && typeof value === "string" && (key === "GOTOOLCHAIN" || isAbsolute(value))) variables[key] = value;
    }
  }
  if (pathEntries.length) variables.PATH = [...pathEntries, process.env.PATH || ""].filter(Boolean).join(delimiter);
  return variables;
}

function workerBridge(configPath: string): { endpoint: string; script: string } | null {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const agent = raw.agent && typeof raw.agent === "object" && !Array.isArray(raw.agent) ? raw.agent as Record<string, unknown> : null;
    const bridge = agent?.bridge && typeof agent.bridge === "object" && !Array.isArray(agent.bridge) ? agent.bridge as Record<string, unknown> : null;
    const script = bridge?.script;
    const configured = bridge?.endpoint;
    if (typeof script !== "string" || typeof configured !== "string") return null;
    let target = configured;
    if (configured === "auto") {
      const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
      const record = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
      target = record.listen || record.sockPath || "";
    }
    target = target.replace(/^unix:\/\//, "");
    const endpoint = target.startsWith("/") ? `ws+unix://${target}:/ws` : /^(127\.0\.0\.1|localhost):\d+$/.test(target) ? `ws://${target}/ws` : "";
    return endpoint ? { endpoint, script: resolve(dirname(configPath), script) } : null;
  } catch {
    return null;
  }
}

function compactAgent(agent: PaseoAgent | null, binding: AgentBinding | null) {
  if (!agent) return null;
  return {
    id: agent.id,
    workspaceId: agent.workspaceId || binding?.paseoWorkspaceId || null,
    cwd: agent.cwd || binding?.cwd || null,
    provider: agent.runtimeInfo?.provider || agent.provider,
    model: agent.runtimeInfo?.model || agent.model || null,
    status: agent.status || null,
    planningState: actualPlanningState(agent),
    permissionModeId: agent.currentModeId || null,
    relationship: binding?.relationship || (agent.labels?.["workspace-workbench.parent"] ? "child" : "independent"),
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
    handoffBundle: saved.handoffBundle,
    workspaceId: saved.workspaceId,
    paseoWorkspaceId: saved.paseoWorkspaceId,
    treePath: saved.cwd,
    agentId: saved.agentId,
    relationship: saved.relationship,
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
    relationship: result.relationship,
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

function handoffPrompt(workspaceId: string, handoff: Handoff, runtime: RuntimeResult, relationship: AgentRelationship, artifacts: ResolvedWorkbenchArtifact[] = [], bundle?: BundleRef): string {
  if (bundle) return [
    "Workspace Workbench execution handoff", `Workspace: ${workspaceId}`, `Directory: ${runtime.treePath}`,
    `Repositories: ${(runtime.repositories || []).map(repo => `${repo.id}: ${repo.worktreePath} (${repo.branch})`).join("; ")}`,
    `Goal: ${handoff.goal.slice(0, 2000)}`, `Start mode: ${handoff.startMode}`,
    `First call workbench_handoff_read with bundle=${JSON.stringify(bundle)}. Read HANDOFF.md, SOURCES.md and all required sources before implementation; search conversation history when context is unclear.`,
    "The Workspace and runtime are prepared. Verify your working directory. Do not create or delegate another Workspace or Agent.",
    "Implementation details may be improved using source material and code evidence. Confirm changes to goals, scope, explicit decisions or acceptance with the coordinator.",
    handoff.startMode === "plan-first" ? "Planning only: do not edit or change host mode; wait for explicit execution authorization." : "Implement the approved task and its constraints from HANDOFF.md.",
    `Report completion through workbench_execution_report with materialsVersion: ${bundle.version}, ready_for_review, changes, tests and limitations. If blocked, report needs_input or failed.`,
    getWorkbenchCopy(handoff.reviewLocale || "zh-CN").reviewPromptLanguage,
  ].join("\n");
  const localized = getWorkbenchCopy(handoff.reviewLocale || "zh-CN");
  const section = (title: string, values: readonly string[]) => values.length ? [`${title}:`, ...values.map((value) => `- ${value}`), ""] : [];
  const packet = handoff.reviewPacket;
  const textAssets = artifacts.flatMap((artifact) => {
    if (artifact.source !== "conversation" || artifact.binary) return [];
    const material = artifactSnapshotContent(artifact);
    return material.content === undefined ? [] : [`${artifact.reference.id}:`, material.content, ""];
  });
  return [
    "Workspace Workbench Agent handoff",
    relationship === "child"
      ? "You are the execution child, not the coordinator. The Workspace has already been created and prepared. Execute this approved task; do not create or delegate another Workspace or Agent, and do not repeat planning unless start mode is plan-first."
      : "You are an independent execution session. The Workspace has already been created and prepared. Execute this approved task; do not create or delegate another Workspace or Agent, and do not repeat planning unless start mode is plan-first.",
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
    ...(packet.requirementUnderstanding ? ["Requirement understanding:", packet.requirementUnderstanding, ""] : []),
    ...section("Implementation plan", packet.plan),
    ...section("Acceptance criteria", packet.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.text}`)),
    ...section("Reference materials", packet.references.map((reference) => `${reference.id}: ${reference.title || reference.path || reference.assetId || "reference"}${reference.path ? ` (${reference.repositoryId ? `${reference.repositoryId}:` : ""}${reference.path})` : reference.assetId ? ` (asset ${reference.assetId})` : ""}${reference.purpose ? ` — ${reference.purpose}` : ""}`)),
    ...section("Attached text reference content", textAssets),
    ...(artifacts.some((artifact) => artifact.mimeType.startsWith("image/")) ? ["Visual references listed above are attached to this handoff; compare against them when the task depends on visual fidelity.", ""] : []),
    ...(packet.instructions ? ["Task-specific review instructions (additional context only):", packet.instructions, ""] : []),
    ...section("Expected branches", Object.entries(handoff.expected.branchByRepository).map(([repo, branch]) => `${repo}: ${branch}`)),
    ...section("Expected bases", Object.entries(handoff.expected.baseByRepository).map(([repo, base]) => `${repo}: ${base}`)),
    `Start mode: ${handoff.startMode}`,
    ...(handoff.startMode === "plan-first" ? ["This handoff authorizes planning only. Do not edit, execute the implementation, or switch out of plan mode. Wait for explicit execution authorization and a confirmed host mode change."] : []),
    "The workspace root is a multi-repository container. Verify the supplied worktree paths and Git branches before editing. The requesting session already completed the runtime preflight; do not delegate or call execute again.",
    "Respect the host permission and sandbox policy. Verify configured runtimes before executing build commands.",
    localized.reviewPromptLanguage,
    "When the approved implementation work is complete, call workbench_execution_report with ready_for_review, a concise change summary, tests and known limitations. A normal turn ending alone is not a completion signal. If input is needed or the task fails, report needs_input or failed instead.",
  ].join("\n");
}

const delegates = new Map<string, { identity: string; promise: Promise<Awaited<ReturnType<typeof delegateAgent>>> }>();

export async function handleAgentDelegate(input: AgentDelegateInput & { bundle?: BundleRef }, context: AgentContext) {
  return withWorkspaceScope(input.workspaceId, () => handleAgentDelegateLocked(input, context));
}
async function handleAgentDelegateLocked(input: AgentDelegateInput & { bundle?: BundleRef }, context: AgentContext) {
  const projectKey = `${currentProject()?.configPath || ""}:${input.workspaceId}`;
  const active = delegates.get(projectKey);
  const identity = JSON.stringify(input);
  if (active) {
    if (active.identity === identity) return active.promise;
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_in_progress", message: "Another handoff is in progress" } };
  }
  const pending = delegateAgent(input, context).then((result) => {
    if (result.ok && result.agentId) {
      const project = currentProject();
      if (project) {
        try {
          recordExecutionHandoff({ workspaceId: input.workspaceId, projectConfig: project.configPath, executionAgentId: result.agentId, handoff: input.handoff });
        } catch (error) {
          // The Agent binding remains authoritative; the review timeline will
          // surface the conflict on the next explicit review action instead
          // of fabricating a second active flow.
          console.warn("workspace_workbench_review_handoff_not_recorded", error instanceof Error ? error.message : "unknown");
        }
      }
    }
    return result;
  }).finally(() => delegates.delete(projectKey));
  delegates.set(projectKey, { identity, promise: pending });
  return pending;
}

async function delegateAgent(
  input: AgentDelegateInput & { bundle?: BundleRef },
  context: AgentContext,
) {
  const handoffHash = digest(input.handoff);
  const lifecycle = await (context.query || queryObserver)({ method: "workspace.list", params: { includeRemoved: true } });
  if (lifecycle.ok) {
    const workspace = (lifecycle.result as { workspaces?: Array<{ id?: string; state?: string }> } | undefined)?.workspaces?.find((item) => item.id === input.workspaceId);
    if (workspace?.state === "deletion_pending" || workspace?.state === "removed" || workspace?.state === "create_failed") {
      const failed = workspace.state === "create_failed";
      return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: failed ? "workspace_create_failed" : "workspace_deletion_pending", message: failed ? "This Workspace failed to create and cannot receive a new task" : "This Workspace is pending deletion and cannot receive a new task" } };
    }
  }
  let existingReview = null;
  try { existingReview = readReviewSession(input.workspaceId); } catch { /* Direct provider tests may not have a project context. */ }
  if (existingReview && existingReview.preferences.mode !== "off" && ["waiting_execution", "ready_for_review", "queued", "reviewing", "changes_requested", "fixing", "stopping"].includes(existingReview.status) && existingReview.handoffHash && existingReview.handoffHash !== handoffHash) {
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "review_active_different_task", message: "This Workspace already has an active Agent Review flow" } };
  }
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
  let handoffArtifacts: ResolvedWorkbenchArtifact[] = [];
  try {
    if (input.bundle) assertBundleReady(input.bundle);
    const artifactReferences = input.bundle ? [] : input.handoff.reviewPacket.references;
    handoffArtifacts = artifactReferences.flatMap((reference) => {
      try { return [resolveArtifactReference(reference, { repositories: runtime.repositories || [] })]; }
      catch (error) {
        if (reference.required) throw new Error(`required_review_artifact_unavailable:${reference.id}:${error instanceof Error ? error.message : "unavailable"}`);
        return [];
      }
    });
  } catch (error) {
    return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "review_artifact_unavailable", message: error instanceof Error ? error.message : "Required review material is unavailable" } };
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
  const existingBinding = getAgentBinding(input.workspaceId);
  try { childConfig = existingBinding ? { provider: providerFromAgent(parentSnapshot.agent) } : childExecutionConfig(parentSnapshot.agent, input.handoff.startMode === "plan-first"); }
  catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: error instanceof ExecutionPolicyError ? error.code : "execution_policy_failed", message: (error as Error).message } }; }
  let configuredProvider: string | null = null;
  const requestedExecutionModel = configuredExecutionModel();
  if (requestedExecutionModel) {
    const model = requestedExecutionModel.startsWith("codex/") ? requestedExecutionModel.slice("codex/".length) : requestedExecutionModel;
    try {
      const models = await context.paseo.providers.listModels("codex", { cwd: runtime.treePath });
      if (!(models.models || []).some((item) => item.id === model && item.isSelectable !== false)) {
        return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "execution_model_unavailable", message: `Configured execution model is unavailable: ${model}` } };
      }
    } catch (error) {
      return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "execution_model_unavailable", message: error instanceof Error ? error.message : "Execution model is unavailable" } };
    }
    configuredProvider = `codex/${model}`;
  }
  const selectedProvider = configuredProvider || input.provider || providerFromAgent(parentSnapshot.agent);
  if (!selectedProvider) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "agent_provider_missing", message: "No Agent provider was resolved" } };
  }
  if (!configuredProvider && selectedProvider !== childConfig.provider) return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_provider_mismatch", message: "Selected provider does not match the verified coordinator" } };
  if (configuredProvider) childConfig = { ...childConfig, provider: configuredProvider };
  let saved = getAgentBinding(input.workspaceId);
  // An existing binding owns the relationship for that execution session.
  // This keeps legacy v1 child bindings compatible even after the project
  // default changes to independent, and prevents settings edits from
  // mutating a live session's identity.
  const relationship = saved?.relationship || resolveAgentRelationship(selectedProvider, input.handoff.relationship);
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
        const recoveredRelationship = recovered.labels["workspace-workbench.relationship"] === "child" || recovered.labels["workspace-workbench.parent"] ? "child" : "independent";
        if (!runtimeAgentCwdMatches(runtime, recovered.cwd) || recoveredRelationship !== relationship || (relationship === "child" && recovered.labels["workspace-workbench.parent"] !== input.parentAgentId) || recovered.labels["workspace-workbench.handoff"] !== handoffHash) throw new Error("agent_identity_changed");
        const now = new Date().toISOString();
        const creation = readState<{ agentId?: string; stage?: string }>(creationKey);
        const delivery = creation?.agentId === recovered.id && creation.stage === "sent" ? "sent" : "pending";
        saved = { workspaceId: input.workspaceId, agentId: recovered.id, handoffBundle: input.bundle, relationship, ...(relationship === "child" ? { parentAgentId: input.parentAgentId } : { requestedByAgentId: input.parentAgentId }), paseoWorkspaceId: recovered.workspaceId || "", cwd: recovered.cwd, provider: selectedProvider, createdAt: now, updatedAt: now, handoff: input.handoff, handoffHash, delivery };
        putAgentBinding(saved);
      } else if (readState(creationKey)) throw new Error("agent_creation_uncertain");
    } catch (error) { return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_recovery_required", message: (error as Error).message } }; }
  }
  if (saved) {
    try {
      const current = await context.paseo.agents.ref(saved.agentId).refresh();
      if (current?.agent && current.agent.status !== "closed" && !current.agent.archivedAt) {
        if (saved.relationship !== relationship || (relationship === "child" && saved.parentAgentId !== input.parentAgentId) || current.agent.id !== saved.agentId || !runtimeAgentCwdMatches(runtime, current.agent.cwd) || !runtimeAgentCwdMatches(runtime, saved.cwd) || saved.workspaceId !== input.workspaceId) {
          return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_identity_changed", message: "Agent placement does not match the workspace" } };
        }
        if (saved.delivery === "pending") return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "handoff_delivery_uncertain", message: "现有子会话已保留，但首次投递尚未确认。请检查该会话；Workbench 不会重复创建或自动重投递。" } };
        // Reuse is read-only: the host owns subsequent authorized mode changes.
        // The original startup intent must never reset or constrain that state.
        if (providerFromAgent(current.agent) !== selectedProvider) {
          return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_mode_mismatch", message: copy.agentModeUnconfirmed } };
        }
        if (current.agent.status === "running" || current.agent.status === "initializing") {
          if (saved.handoffHash !== handoffHash) return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_busy_different_task", message: copy.agentBusyOtherTask } };
          return { ok: true, action: "already-running" as const, workspaceId: input.workspaceId, agentId: current.agent.id, relationship: saved.relationship, status: current.agent.status };
        }
        if (saved.handoffHash === handoffHash) return { ok: true, action: "reused" as const, workspaceId: input.workspaceId, agentId: current.agent.id, relationship: saved.relationship, status: current.agent.status };
        return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "workspace_session_exists", message: "This Workspace already has a different execution session; create a new Workspace for another task" } };
      }
      if (!current?.agent) throw new Error("agent unavailable");
      return { ok: false, action: "blocked" as const, workspaceId: input.workspaceId, error: { code: "agent_closed", message: copy.agentClosedRecovery } };
    } catch {
      return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "agent_refresh_failed", message: "Cannot confirm the existing Agent; retry later" } };
    }
  }
  const verifyCoordinator = async () => {
    const snapshot = (await parent.refresh())?.agent;
    if (!snapshot) throw new ExecutionPolicyError("parent_agent_unavailable", "主控会话不可用，请刷新宿主后重试。");
    assertCoordinatorExecution(snapshot);
  };
  let paseoWorkspace;
  try {
    await verifyCoordinator();
    paseoWorkspace = await context.paseo.workspaces.open(runtime.treePath);
    if (project) writeState(creationKey, { handoffHash, parentAgentId: input.parentAgentId, relationship, stage: "creating" });
    const reportToken = randomUUID();
    const bridge = project ? workerBridge(project.configPath) : null;
    const workerEnv: Record<string, string> = {
      ...runtimeEnvironment(runtime),
      WORKBENCH_WORKER_WORKSPACE: input.workspaceId,
      ...(project ? { WORKBENCH_PROJECT_CONFIG: project.configPath } : {}),
      ...(bridge ? { WORKBENCH_PASEO_ENDPOINT: bridge.endpoint, WORKBENCH_AGENT_TOKEN: reportToken, WORKBENCH_EXECUTION_REPORT_ONLY: "1" } : {}),
    };
    const workerConfig = {
      ...childConfig,
      provider: selectedProvider,
      ...(bridge ? {
        toolPolicy: {
          ...(childConfig.toolPolicy || {}),
          preapproved: [
            ...(childConfig.toolPolicy?.preapproved || []),
            { kind: "mcp" as const, server: "workspace-workbench-report", tool: "workbench_execution_report" },
            ...["workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset"].map(tool => ({ kind: "mcp" as const, server: "workspace-workbench-report", tool })),
          ],
        },
        mcpServers: {
          ...(childConfig.mcpServers || {}),
          "workspace-workbench-report": {
            type: "stdio" as const,
            command: process.execPath,
            args: [bridge.script],
            env: workerEnv,
            alwaysLoad: true,
          },
        },
      } : {}),
    };
    await verifyCoordinator();
    const created = await paseoWorkspace.agents.create({
      ...(relationship === "child" ? { parent: input.parentAgentId } : {}),
      env: workerEnv,
      title: input.title || `${input.workspaceId} worker`,
      config: workerConfig,
      clientMessageId: handoffHash,
      labels: {
        "workspace-workbench.role": "workspace-worker",
        "workspace-workbench.workspace-id": input.workspaceId,
        "workspace-workbench.project": digest(project?.configPath || ""),
        "workspace-workbench.relationship": relationship,
        ...(relationship === "child" ? { "workspace-workbench.parent": input.parentAgentId } : {}),
        "workspace-workbench.handoff": handoffHash,
      },
    });
    if (project && bridge) writeState(`context:${reportToken}`, { agentId: created.id, cwd: runtime.treePath, workspaceId: input.workspaceId });
    if (project) writeState(creationKey, { handoffHash, parentAgentId: input.parentAgentId, relationship, stage: "created", agentId: created.id });
    const now = new Date().toISOString();
    const binding: AgentBinding = {
      handoffBundle: input.bundle,
      workspaceId: input.workspaceId,
      agentId: created.id,
      relationship,
      ...(relationship === "child" ? { parentAgentId: input.parentAgentId } : { requestedByAgentId: input.parentAgentId }),
      paseoWorkspaceId: paseoWorkspace.id,
      cwd: runtime.treePath,
      provider: selectedProvider,
      createdAt: now,
      updatedAt: now,
      handoff: input.handoff,
      handoffHash,
      delivery: "pending",
    };
    putAgentBinding(binding);
    if (project) {
      try {
        // Record the handoff before the first turn starts so a fast child
        // cannot submit a completion report before its durable review session
        // exists. The outer delegate handler repeats this idempotently.
        recordExecutionHandoff({ workspaceId: input.workspaceId, projectConfig: project.configPath, executionAgentId: created.id, handoff: input.handoff });
      } catch (error) {
        return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: "review_handoff_record_failed", message: error instanceof Error ? error.message : "Review handoff could not be recorded" } };
      }
    }
    try {
      await verifyCoordinator();
      const worker = (await context.paseo.agents.ref(created.id).refresh())?.agent;
      if (!worker) throw new ExecutionPolicyError("worker_mode_unknown", "宿主未返回新子会话，任务尚未投递，请检查会话状态。");
      if (worker.id !== created.id || !runtimeAgentCwdMatches(runtime, worker.cwd)) throw new ExecutionPolicyError("agent_identity_changed", "宿主返回的子会话身份不匹配，未投递任务。");
      assertInitialWorkerMode(worker, input.handoff.startMode === "plan-first");
      await verifyCoordinator();
      const images = resolvedArtifactImageAttachments(handoffArtifacts);
      await created.send(handoffPrompt(input.workspaceId, input.handoff, runtime, relationship, handoffArtifacts, input.bundle), { messageId: handoffHash, ...(images.length ? { images } : {}) });
    } catch (error) {
      return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: error instanceof ExecutionPolicyError ? error.code : "handoff_delivery_uncertain", message: error instanceof Error ? error.message : "Agent handoff delivery is uncertain" } };
    }
    if (project) writeState(creationKey, { handoffHash, parentAgentId: input.parentAgentId, relationship, stage: "sent", agentId: created.id });
    putAgentBinding({ ...binding, delivery: "sent", updatedAt: new Date().toISOString() });
    return { ok: true, action: "created" as const, workspaceId: input.workspaceId, agentId: created.id, relationship, status: created.current()?.status || "initializing" };
  } catch (error) {
    return { ok: false, action: "failed" as const, workspaceId: input.workspaceId, error: { code: error instanceof ExecutionPolicyError ? error.code : "agent_create_failed", message: error instanceof Error ? error.message : "Agent creation failed" } };
  }
}

export function registerAgentProvider(server: PluginServerContext): void {
  server.handle(agentStatusQuery, handleAgentStatus);
  server.handle(agentDelegate, handleAgentDelegate);
  server.handle(workspaceBindingQuery, handleWorkspaceBinding);
  server.handle(workspaceDelegate, handleWorkspaceDelegate);
}
