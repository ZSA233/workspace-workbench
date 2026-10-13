import { defineRpc, defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const recoveryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(1).max(3600).default(10),
  maxDurationMinutes: z.number().int().min(1).max(10080).nullable().default(60),
  enabledByAgent: z.record(z.string(), z.boolean()).default({}),
});
export type RecoveryPolicy = z.output<typeof recoveryPolicySchema>;
export const recoverySettings = defineSettings({ id: "workspace-workbench-recovery", scope: "host", version: 1, schema: recoveryPolicySchema });
export const recoverySettingsRpc = settingsRpc(recoverySettings.id);

export const recoveryStatusSchema = z.enum(["ready", "waiting", "sending", "running", "paused", "uncertain", "stopped", "succeeded", "off", "unavailable"]);
export const recoverySessionSchema = z.object({
  agentId: z.string(), workspaceId: z.string().nullable(), workspaceName: z.string(),
  title: z.string(), role: z.string().nullable(), connectedToWorkbench: z.boolean(),
  enabled: z.boolean(), override: z.boolean().nullable(), status: recoveryStatusSchema,
  attempt: z.number().int().nonnegative(), nextAttemptAt: z.number().nullable(), deadlineAt: z.number().nullable(),
  reason: z.string().nullable(), updatedAt: z.number(),
});
export type RecoverySession = z.output<typeof recoverySessionSchema>;
export const sessionRecoveryRpc = defineRpc({
  name: "workspace.workbench.recovery",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("list") }),
    z.object({ action: z.literal("get"), agentId: z.string().min(1) }),
    z.object({ action: z.literal("setEnabled"), agentId: z.string().min(1), enabled: z.boolean().nullable() }),
    z.object({ action: z.literal("cancel"), agentId: z.string().min(1) }),
    z.object({ action: z.literal("retryNow"), agentId: z.string().min(1) }),
  ]),
  output: z.object({ ok: z.boolean(), sessions: z.array(recoverySessionSchema), policy: recoveryPolicySchema,
    available: z.boolean(), error: z.string().optional() }),
});

export function recoveryStatusLabel(session: Pick<RecoverySession, "status" | "attempt" | "enabled">, english = false): string {
  const labels = english ? {
    ready: "Auto recovery enabled", off: "Auto recovery disabled", waiting: `Waiting to recover · ${session.attempt + 1}`,
    sending: `Starting recovery · ${session.attempt}`, running: `Recovering · ${session.attempt}`, paused: "Waiting for session verification",
    uncertain: "Delivery needs verification", stopped: "Recovery stopped", succeeded: "Recovery completed", unavailable: "Recovery unavailable",
  } : {
    ready: "自动恢复已开启", off: "自动恢复已关闭", waiting: `等待恢复 · 第 ${session.attempt + 1} 次`,
    sending: `正在发起恢复 · 第 ${session.attempt} 次`, running: `恢复进行中 · 第 ${session.attempt} 次`, paused: "等待确认会话状态",
    uncertain: "投递结果待确认", stopped: "恢复已停止", succeeded: "恢复已完成", unavailable: "自动恢复不可用",
  };
  return labels[!session.enabled && session.status === "ready" ? "off" : session.status];
}

export function recoveryReasonLabel(reason: string, english = false): string {
  const reasons: Record<string, [string, string]> = {
    stopped_by_user: ["已手动停止本次恢复", "This recovery was stopped manually"],
    automatic_recovery_disabled: ["自动恢复已关闭", "Automatic recovery was disabled"],
    recovery_time_limit: ["已达到本次恢复的最长时间", "The recovery time limit was reached"],
    new_user_turn: ["用户已发起新回合，已取消旧任务的恢复", "New user work canceled the previous recovery"],
    new_user_message: ["用户已发送新消息，已取消旧任务的恢复", "A new user message canceled the previous recovery"],
    session_changed_or_busy: ["会话已变化或正在运行，已停止恢复", "The session changed or is busy; recovery stopped"],
    session_changed_before_delivery: ["发送前发现会话已变化，未发起恢复", "The session changed before delivery; no recovery was sent"],
    session_identity_or_mode_changed: ["会话、模型或模式已变化，已停止恢复", "The session, model or mode changed; recovery stopped"],
    session_closed_or_archived: ["会话已关闭或归档", "The session was closed or archived"],
    archived: ["会话已归档", "The session was archived"],
    permission_requested: ["请先处理会话的权限请求", "Resolve the session's permission request first"],
    turn_canceled: ["回合已取消", "The turn was canceled"],
    delivery_outcome_unknown: ["无法确认恢复消息是否送达，请检查会话；不会重复发送", "Delivery could not be confirmed. Check the session; the message will not be resent"],
    awaiting_turn_identity: ["正在确认恢复回合", "Verifying the recovery turn"],
    delivery_verification_unavailable: ["暂时无法核实恢复消息，请检查会话", "Recovery delivery cannot be verified yet; check the session"],
    review_recovery_unconfirmed: ["正在核实审核恢复状态；不会重复发送", "Verifying review recovery state; the message will not be resent"],
    session_verification_unavailable: ["暂时无法核实会话状态", "Session state cannot be verified yet"],
    session_mode_unconfirmed: ["等待宿主确认当前会话模式", "Waiting for the host to confirm the session mode"],
    task_authorization_changed: ["任务范围、材料或授权已变化，已停止恢复", "Task scope, materials or authorization changed; recovery stopped"],
    task_authorization_unconfirmed: ["无法确认当前任务授权，未发起恢复", "Task authorization could not be confirmed; no recovery was sent"],
    task_materials_changed: ["任务材料已更新，已取消原恢复计划", "Updated task materials canceled the old recovery"],
    review_snapshot_stale: ["审核代码快照已变化，请重新准备审核", "The review snapshot changed; prepare a new review"],
    review_authorization_missing: ["当前审核授权已失效", "Review authorization is no longer available"],
    review_phase_timeout: ["审核或修复阶段已超过执行时间", "The review or repair execution time limit was reached"],
    review_operation_unconfirmed: ["审核操作尚未确认，未发起恢复", "The review operation is unconfirmed; no recovery was sent"],
    worker_identity_changed: ["执行会话不再对应原工作区", "The execution session no longer matches its workspace"],
    handoff_delivery_uncertain: ["首次交接投递尚未确认，不会自动重投递", "Initial handoff delivery is unconfirmed and will not be replayed"],
    handoff_integrity_failed: ["交接材料内容已变化，请检查材料", "Handoff materials changed; check their contents"],
    non_recoverable_failure: ["此错误需要处理，已停止自动恢复", "This error needs attention; automatic recovery stopped"],
    recovery_settings_unavailable: ["无法读取有效的恢复设置", "Recovery settings are unavailable"],
    recovery_starting: ["正在启动恢复服务", "Starting the recovery service"],
  };
  return reasons[reason]?.[english ? 1 : 0] || reason;
}
