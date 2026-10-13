import type { PaseoAgent } from "@getpaseo/client";
import type { ReviewSession } from "../../shared/agent-review.ts";
import { allAgentBindings } from "../agent-store.ts";
import { persistSession, readSession, storedReviewSessions } from "../agent-review-store.ts";
import { digest, readReviewState, writeReviewState, removeReviewState } from "../orchestration-state.ts";
import { registeredProjects, withProject } from "../projects.ts";
import { withReviewTransitionLock } from "../review-state-transitions.ts";
import type { RecoveryRecord } from "../session-recovery/store.ts";
import type { RecoveryReviewBridge } from "../session-recovery/controller.ts";
import type { HostConnection } from "../host-connection.ts";
import type { createReviewLifecycle } from "./lifecycle.ts";
import { authKey, reportKey } from "./identity.ts";
import { assertBundleReady } from "../handoff-bundles.ts";
import type { ExecutionReportRecord } from "./types.ts";

export function reviewPhaseDeadline(session: ReviewSession, now = Date.now()): number | null {
  if (session.phaseDeadlineAt != null) return session.phaseDeadlineAt;
  const phase = session.status === "waiting_recovery" ? session.recovery?.priorStatus : session.status;
  if (phase === "reviewing") {
    if (session.coordinator?.acceptedAt) return Date.parse(session.coordinator.acceptedAt) + session.preferences.reviewerTimeoutMs;
    const started = [...session.events].reverse().find(e => e.kind === "review_started");
    return (started ? Date.parse(started.createdAt) : now) + session.preferences.reviewerTimeoutMs;
  }
  if (phase === "fixing") {
    const started = [...session.events].reverse().find(e => e.kind === "repair_sent");
    return (started ? Date.parse(started.createdAt) : now) + session.preferences.repairTimeoutMs;
  }
  return null;
}

export function createReviewRecoveryBridge(lifecycle: ReturnType<typeof createReviewLifecycle>, host: HostConnection): RecoveryReviewBridge {
  async function each(agentId: string, operation: (session: ReviewSession) => Promise<void>): Promise<void> {
    for (const project of registeredProjects()) await withProject({ projectConfig: project.configPath }, async () => {
      for (const session of storedReviewSessions()) {
        if (session.executionAgentId === agentId || session.reviewerAgentId === agentId || session.coordinator?.agentId === agentId)
          await operation(session);
      }
    });
  }
  return {
    async inspect(agent: PaseoAgent) {
      const guards: unknown[] = [];
      for (const project of registeredProjects()) await withProject({ projectConfig: project.configPath }, async () => {
        const sessions = storedReviewSessions();
        const bindings = allAgentBindings().filter(b => b.agentId === agent.id);
        for (const binding of bindings) {
          if (binding.delivery !== "sent") throw new Error("handoff_delivery_uncertain");
          if (binding.handoffBundle) assertBundleReady(binding.handoffBundle);
          const context = { paseo: await host.api() };
          const runtime = await lifecycle.authorization.currentRuntime(binding.workspaceId, context);
          if (!lifecycle.authorization.runtimeAgentCwdMatches(runtime, agent.cwd)) throw new Error("worker_identity_changed");
          guards.push({ project: project.configPath, workspace: binding.workspaceId, handoff: binding.handoffHash,
            materials: binding.handoffBundle, delivery: binding.delivery,
            scope: runtime.repositories.map(r => [r.id, r.worktreePath, r.branch, r.baseRef]) });
        }
        for (const session of sessions) {
          const phase = session.status === "waiting_recovery" ? session.recovery?.priorStatus : session.status;
          const reviewer = session.reviewerAgentId === agent.id && phase === "reviewing";
          const worker = session.executionAgentId === agent.id && ["waiting_execution", "fixing"].includes(phase || "");
          if (session.status === "queued" && session.coordinator?.agentId === agent.id && session.coordinator.phase !== "waiting") throw new Error("coordinator_delivery_unconfirmed");
          if (!reviewer && !worker) continue;
          if (session.materials) assertBundleReady(session.materials);
          if (session.pendingOperation || (session.status === "waiting_recovery" && session.recovery?.agentId !== agent.id)) throw new Error("review_operation_unconfirmed");
          if (reviewer) {
            if (!session.snapshot || !readReviewState(authKey(session.id))) throw new Error("review_authorization_missing");
            const runtime = await lifecycle.authorization.currentRuntime(session.workspaceId, { paseo: await host.api() });
            if (lifecycle.authorization.runtimeIdentity(runtime) !== lifecycle.authorization.runtimeIdentityFromSnapshot(session.snapshot)) throw new Error("review_snapshot_stale");
          }
          const deadline = session.status === "waiting_recovery" ? null : reviewPhaseDeadline(session);
          if (deadline !== null && Date.now() >= deadline) throw new Error("review_phase_timeout");
          guards.push({ project: project.configPath, session: session.id, round: session.round, phase,
            handoff: session.handoffHash, materials: session.materials, snapshot: reviewer ? session.snapshotId : null,
            diff: reviewer ? session.diffId : null, executor: session.executionAgentId, reviewer: session.reviewerAgentId });
        }
      });
      return guards.length ? digest(guards) : null;
    },
    async suspend(record: RecoveryRecord) {
      await each(record.agentId, async session => {
        if (session.status === "waiting_recovery" && session.recovery?.agentId === record.agentId) return;
        const phase = session.status;
        if (!(["waiting_execution", "fixing"].includes(phase) && session.executionAgentId === record.agentId)
          && !(phase === "reviewing" && session.reviewerAgentId === record.agentId)) return;
        await withReviewTransitionLock(session.workspaceId, async () => {
          const latest = readSession(session.workspaceId, session.id);
          if (!latest || latest.revision !== session.revision) throw new Error("review_state_conflict");
          const deadline = reviewPhaseDeadline(latest), now = Date.now();
          const report = readReviewState<ExecutionReportRecord>(reportKey(record.agentId));
          if (report?.turnId === record.failedTurnId && !report.consumedAt) writeReviewState(reportKey(record.agentId), { ...report, consumedAt: new Date(now).toISOString() });
          persistSession({ ...latest, status: "waiting_recovery", pendingReviewerResult: null,
            recovery: { agentId: record.agentId, failedTurnId: record.failedTurnId!, priorStatus: phase as "waiting_execution" | "fixing" | "reviewing", suspendedAt: now, remainingMs: deadline === null ? null : Math.max(0, deadline - now) },
          }, { kind: "recovery_waiting", summary: "Waiting for automatic session recovery", details: { agentId: record.agentId, turnId: record.failedTurnId } });
        });
      });
    },
    async resume(record: RecoveryRecord, turnId: string) {
      await each(record.agentId, async session => {
        if (session.status !== "waiting_recovery" || session.recovery?.agentId !== record.agentId) return;
        await withReviewTransitionLock(session.workspaceId, async () => {
          const latest = readSession(session.workspaceId, session.id);
          if (!latest || latest.revision !== session.revision || !latest.recovery) throw new Error("review_state_conflict");
          const recovery = latest.recovery, resumedAt = Math.max(recovery.suspendedAt, Math.min(Date.now(), record.attemptStartedAt ?? Date.now()));
          const elapsed = resumedAt - recovery.suspendedAt;
          const shift = (date: string | null) => date ? new Date(Date.parse(date) + elapsed).toISOString() : null;
          const restored = persistSession({ ...latest, status: recovery.priorStatus, recovery: null,
            phaseDeadlineAt: recovery.remainingMs === null ? null : resumedAt + recovery.remainingMs,
            ...(recovery.priorStatus === "reviewing" ? { reviewerTurnId: turnId, coordinator: latest.coordinator ? { ...latest.coordinator, acceptedAt: shift(latest.coordinator.acceptedAt), timeoutAt: shift(latest.coordinator.timeoutAt), hardTimeoutAt: shift(latest.coordinator.hardTimeoutAt) } : null } : { executionTurnId: turnId }),
          }, { kind: "recovery_resumed", summary: "Session recovery started in the same review round", details: { agentId: record.agentId, turnId } });
          if (restored.status === "reviewing") {
            // Reattach after a previous monitor's finally has released its key.
            queueMicrotask(() => { void host.api().then(paseo => lifecycle.dispatch.recoverReviewerMonitor(restored, { paseo })).catch(() => {}); });
          }
        });
      });
    },
    async stop(record: RecoveryRecord) {
      await each(record.agentId, async session => {
        if (session.status !== "waiting_recovery" || session.recovery?.agentId !== record.agentId) return;
        await withReviewTransitionLock(session.workspaceId, async () => {
          const latest = readSession(session.workspaceId, session.id);
          if (!latest || latest.status !== "waiting_recovery" || latest.recovery?.agentId !== record.agentId) return;
          removeReviewState(authKey(latest.id));
          const canceled = ["stopped_by_user", "automatic_recovery_disabled", "new_user_turn", "permission_requested", "archived"].includes(record.reason || "");
          persistSession({ ...latest, status: canceled ? "stopped" : "failed", recovery: null, pendingReviewerResult: null,
            coordinator: latest.coordinator ? { ...latest.coordinator, phase: "revoked" } : null,
            lastError: { code: record.reason || "session_recovery_stopped", message: `Session recovery stopped: ${record.reason}` },
          }, { kind: canceled ? "stopped" : "failed", summary: "Automatic session recovery stopped", details: { reason: record.reason } });
        });
      });
    },
  };
}
