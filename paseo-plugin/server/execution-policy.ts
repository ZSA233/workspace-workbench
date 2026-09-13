import type { PaseoAgent, PaseoAgentConfig } from "@getpaseo/client";
import { resolveAgentPermissionMode } from "./agent-session.ts";
import type { AgentPermissionMode } from "../shared/agent-session.ts";

export type PlanningState = "plan" | "execute" | "unknown";
export function actualPlanningState(agent: PaseoAgent): PlanningState {
  // Paseo 0.8 exposes the mutable next-turn feature, not the effective mode of
  // an active turn. A refreshed toggle is not evidence of that turn's mode.
  if (agent.activeTurn || agent.status === "running") return "unknown";
  const feature = agent.features?.find((item) => item.id === "plan_mode");
  if (feature?.type !== "toggle" || typeof feature.value !== "boolean") return "unknown";
  return feature.value ? "plan" : "execute";
}

export class ExecutionPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function assertCoordinatorExecution(parent: PaseoAgent): void {
  if ((parent.runtimeInfo?.provider || parent.provider) !== "codex") {
    throw new ExecutionPolicyError("execution_provider_unverified", "主控提供方不是已验证的 Codex；请检查宿主会话提供方。");
  }
  if (parent.activeTurn || parent.status === "running") throw new ExecutionPolicyError("coordinator_active_mode_unavailable", "Paseo 未提供活动 turn 的有效计划模式；开关可能仅适用于下一轮。请等待该轮结束后从界面执行，或升级支持有效模式校验的宿主。已暂停后续创建和任务投递。");
  const state = actualPlanningState(parent);
  if (state === "plan") throw new ExecutionPolicyError("coordinator_planning", "主控仍在计划模式。请在宿主明确授权并切换到执行，等待同步后重试。");
  if (state === "unknown") throw new ExecutionPolicyError("coordinator_mode_unknown", "宿主未返回主控实际计划状态。请刷新会话并等待模式同步；权限预设不能证明执行模式。");
  if (parent.pendingPermissions?.length) throw new ExecutionPolicyError("execution_permission_pending", "主控有待处理的权限请求，请先在宿主处理。");
}

export function assertInitialWorkerMode(worker: PaseoAgent, planFirst: boolean): void {
  const state = actualPlanningState(worker);
  if (state === "unknown") throw new ExecutionPolicyError("worker_mode_unknown", "子会话尚未返回实际计划状态，未投递任务。请等待宿主同步后检查该会话。");
  if ((state === "plan") !== planFirst) throw new ExecutionPolicyError("worker_mode_not_synchronized", "子会话实际模式与首次启动意图不一致，未投递任务。请在宿主检查模式同步；Workbench 不自动切换模式。");
}

/** Permission presets and the initial planning intent are independent. */
export function childExecutionConfig(parent: PaseoAgent, planFirst: boolean, configuredPermissionMode?: AgentPermissionMode): PaseoAgentConfig {
  assertCoordinatorExecution(parent);
  const provider = parent.runtimeInfo?.provider || parent.provider;
  const currentMode = parent.currentModeId;
  if (!currentMode || !parent.availableModes?.some((item) => item.id === currentMode)) throw new ExecutionPolicyError("execution_permission_unconfirmed", "宿主未确认主控权限预设，请刷新权限状态后重试。");
  const permissionMode = configuredPermissionMode || resolveAgentPermissionMode();
  const mode = permissionMode === "inherit" ? currentMode : permissionMode;
  if (!parent.availableModes.some((item) => item.id === mode)) throw new ExecutionPolicyError("execution_permission_unavailable", "宿主不支持所选权限预设，请调整会话权限设置。");
  return {
    provider: `${provider}${parent.model ? `/${parent.model}` : ""}`,
    modeId: mode,
    featureValues: { plan_mode: planFirst },
    ...(parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
  };
}
