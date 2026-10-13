import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { recoveryPolicySchema, type RecoveryPolicy, type RecoverySession } from "../../shared/session-recovery.ts";
import { actualPlanningState } from "../execution-policy.ts";
import { recoverableFailure, type RecoveryFailure } from "./errors.ts";
import type { RecoveryRecord, RecoveryStorage } from "./store.ts";
import { recoveryIdentity } from "./identity.ts";
import type { NativeAttempt, NativeReceipt, NativeOutcome } from "./native-contract.ts";
export { recoveryIdentity } from "./identity.ts";

const activeStatuses = new Set(["waiting", "sending", "running", "paused", "uncertain"]);
export interface RecoveryReviewBridge {
  inspect(agent: PaseoAgent): Promise<string | null>;
  suspend(record: RecoveryRecord): Promise<void>;
  resume(record: RecoveryRecord, turnId: string): Promise<void>;
  stop(record: RecoveryRecord): Promise<void>;
}
const noReview: RecoveryReviewBridge = { inspect: async () => null, suspend: async () => {}, resume: async () => {}, stop: async () => {} };
type Dependencies = {
  api(): Promise<PaseoApi>;
  send(agentId: string, message: string, messageId: string): Promise<void>;
  retry?(attempt: NativeAttempt): Promise<NativeReceipt | null>;
  receipt?(agentId: string, attemptId: string): Promise<NativeReceipt | null>;
  nativeAvailable?(): boolean;
  store: RecoveryStorage;
  review?: RecoveryReviewBridge;
  now?: () => number;
  random?: () => number;
};
function confirmedMode(agent: PaseoAgent): boolean {
  return Boolean(agent.currentModeId && actualPlanningState(agent) !== "unknown");
}
export class SessionRecoveryController {
  readonly records = new Map<string, RecoveryRecord>();
  private policy = recoveryPolicySchema.parse({});
  private available = false;
  private closed = false;
  private queues = new Map<string, Promise<unknown>>();
  private cancellations = new Map<string, { reason: string }>();
  private review: RecoveryReviewBridge;
  private now: () => number;
  private random: () => number;
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.review = deps.review || noReview; this.now = deps.now || Date.now; this.random = deps.random || Math.random;
    for (const record of deps.store.load()) this.records.set(record.agentId, record);
  }
  private async lock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (this.closed) throw new Error("recovery_generation_retired"); return operation(); });
    this.queues.set(agentId, next);
    try { return await next; } finally { if (this.queues.get(agentId) === next) this.queues.delete(agentId); }
  }
  private persist(record?: RecoveryRecord): void {
    if (this.closed) throw new Error("recovery_generation_retired");
    if (record) { record.updatedAt = this.now(); this.records.set(record.agentId, record); }
    this.deps.store.save([...this.records.values()]);
  }
  enabled(agentId: string): boolean { return this.available && (this.policy.enabledByAgent[agentId] ?? this.policy.enabled); }
  getPolicy(): RecoveryPolicy { return structuredClone(this.policy); }
  isNativeAvailable(): boolean { return Boolean(this.deps.retry && this.deps.receipt && (this.deps.nativeAvailable?.() ?? true)); }
  private deliveryKind(): "message" | "native" { return this.policy.method === "auto" && this.isNativeAvailable() ? "native" : "message"; }
  isAvailable(): boolean { return this.available && !this.closed; }
  async setPolicy(policy: RecoveryPolicy | null): Promise<void> {
    this.available = policy !== null;
    if (policy) this.policy = recoveryPolicySchema.parse(policy);
    for (const record of [...this.records.values()]) await this.lock(record.agentId, async () => {
      if (!activeStatuses.has(record.status)) return;
      if (!this.enabled(record.agentId)) { await this.stop(record, policy ? "automatic_recovery_disabled" : "recovery_settings_unavailable"); return; }
      record.deadlineAt = this.policy.maxDurationMinutes === null || record.firstFailureAt === null ? null : record.firstFailureAt + this.policy.maxDurationMinutes * 60000;
      if (["waiting", "paused"].includes(record.status)) record.nextAttemptAt = Math.min(record.nextAttemptAt || Infinity, this.now() + this.policy.intervalSeconds * 1000);
      this.persist(record);
    });
  }
  register(agent: PaseoAgent, workspaceName?: string): void {
    if (this.closed || agent.provider !== "codex") return;
    const previous = this.records.get(agent.id);
    const record: RecoveryRecord = previous ? { ...previous } : {
      agentId: agent.id, status: "ready", attempt: 0, nextAttemptAt: null, deadlineAt: null, reason: null,
      updatedAt: this.now(), episodeId: null, firstFailureAt: null, failedTurnId: null, recoveryTurnId: null,
      messageId: null, attemptStartedAt: null, deliveryKind: "native", identity: null, lastUserMessageAt: null, taskGuard: null,
      workspaceId: null, workspaceName: "", title: "", role: null, connectedToWorkbench: false, archived: false,
    };
    record.workspaceId = agent.workspaceId || null; record.workspaceName = workspaceName || record.workspaceName || agent.cwd;
    record.title = agent.title || agent.id; record.role = agent.labels?.["workspace-workbench.role"] || null;
    record.archived = Boolean(agent.archivedAt);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(record)) this.persist(record);
  }
  markWorkbenchConnection(agentId: string, connected: boolean): void {
    const record = this.records.get(agentId);
    if (record && record.connectedToWorkbench !== connected) this.persist({ ...record, connectedToWorkbench: connected });
  }
  list(agentId?: string): RecoverySession[] {
    return [...this.records.values()].filter(r => !r.archived && (!agentId || r.agentId === agentId)).map(r => ({
      agentId: r.agentId, workspaceId: r.workspaceId, workspaceName: r.workspaceName, title: r.title, role: r.role,
      connectedToWorkbench: r.connectedToWorkbench, enabled: this.enabled(r.agentId), override: this.policy.enabledByAgent[r.agentId] ?? null,
      status: !this.isAvailable() ? "unavailable" : !this.enabled(r.agentId) && !activeStatuses.has(r.status) ? "off" : r.status,
      attempt: r.attempt, nextAttemptAt: r.nextAttemptAt, deadlineAt: r.deadlineAt, reason: r.reason, updatedAt: r.updatedAt,
      deliveryKind: r.messageId ? r.deliveryKind : this.deliveryKind(),
    }));
  }
  private expired(record: RecoveryRecord): boolean { return record.deadlineAt !== null && this.now() >= record.deadlineAt; }
  private async stop(record: RecoveryRecord, reason: string): Promise<void> {
    this.persist({ ...record, status: "stopped", nextAttemptAt: null, reason });
    await this.review.stop(this.records.get(record.agentId)!);
  }
  async cancel(agentId: string, reason = "stopped_by_user"): Promise<void> {
    const cancellation = { reason };
    if (activeStatuses.has(this.records.get(agentId)?.status || "")) this.cancellations.set(agentId, cancellation);
    try { await this.lock(agentId, async () => { const r = this.records.get(agentId); if (r && activeStatuses.has(r.status)) await this.stop(r, reason); }); }
    finally { if (this.cancellations.get(agentId) === cancellation) this.cancellations.delete(agentId); }
  }
  async archive(agentId: string): Promise<void> {
    await this.lock(agentId, async () => {
      const r = this.records.get(agentId); if (!r) return;
      if (activeStatuses.has(r.status)) await this.stop(r, "archived");
      this.persist({ ...this.records.get(agentId)!, archived: true });
    });
  }
  async reconcileListing(seen: Set<string>, startedAt: number): Promise<void> {
    for (const record of [...this.records.values()]) if (!record.archived && !seen.has(record.agentId) && record.updatedAt < startedAt) await this.archive(record.agentId);
  }
  async retryNow(agentId: string): Promise<void> {
    await this.lock(agentId, async () => {
      const r = this.records.get(agentId);
      if (!r || r.status !== "waiting" || !this.enabled(agentId)) throw new Error("recovery_not_waiting");
      if (this.expired(r)) { await this.stop(r, "recovery_time_limit"); return; }
      this.persist({ ...r, nextAttemptAt: this.now() });
    });
    await this.tickAgent(agentId);
  }
  async claimFailure(agentId: string, turnId: string | null, error: RecoveryFailure): Promise<boolean> {
    if (!turnId || !this.enabled(agentId)) return false;
    return this.lock(agentId, async () => {
      let r = this.records.get(agentId);
      if (r?.failedTurnId === turnId) return ["waiting", "paused", "sending", "running", "uncertain"].includes(r.status);
      if (r?.status === "stopped" && r.recoveryTurnId === turnId) return false;
      if (r?.status === "stopped" && r.messageId) {
        // A missed start event must not turn the canceled dispatch's eventual
        // failure into a new episode. Only a proven newer user turn can do so.
        try {
          const proof = await this.delivery(await this.deps.api(), r);
          if (!proof.found || !proof.newerUser) {
            if (proof.found && proof.turnId === turnId) this.persist({ ...r, recoveryTurnId: turnId });
            return false;
          }
        } catch { return false; }
      }
      if (r && ["sending", "running", "uncertain"].includes(r.status) && r.recoveryTurnId !== turnId) return false;
      if (!recoverableFailure(error)) {
        if (r && activeStatuses.has(r.status)) await this.stop(r, "non_recoverable_failure");
        else if (r) this.persist({ ...r, status: "stopped", failedTurnId: turnId, reason: error.message.slice(0, 1000) });
        return false;
      }
      const api = await this.deps.api();
      const agent = (await api.agents.ref(agentId).refresh())?.agent;
      if (!agent || agent.provider !== "codex" || agent.archivedAt || agent.status === "closed" || agent.pendingPermissions?.length || !confirmedMode(agent)) return false;
      if (agent.activeTurn && agent.activeTurn.turnId !== turnId) return false;
      if (!r) { this.register(agent); r = this.records.get(agentId)!; }
      if (r.episodeId && activeStatuses.has(r.status) && r.identity !== recoveryIdentity(agent)) { await this.stop(r, "session_identity_or_mode_changed"); return false; }
      let taskGuard: string | null;
      try { taskGuard = await this.review.inspect(agent); }
      catch { await this.stop(r, "task_authorization_unconfirmed"); return false; }
      if (r.episodeId && activeStatuses.has(r.status) && r.taskGuard !== taskGuard) { await this.stop(r, "task_authorization_changed"); return false; }
      const continuing = r.episodeId !== null && activeStatuses.has(r.status);
      const firstFailureAt = continuing ? r.firstFailureAt! : this.now();
      const next: RecoveryRecord = { ...r, status: "waiting", episodeId: continuing ? r.episodeId : randomUUID(), firstFailureAt,
        attempt: continuing ? r.attempt : 0, failedTurnId: turnId, recoveryTurnId: null, messageId: null, attemptStartedAt: null,
        identity: recoveryIdentity(agent), lastUserMessageAt: agent.lastUserMessageAt, taskGuard,
        deadlineAt: this.policy.maxDurationMinutes === null ? null : firstFailureAt + this.policy.maxDurationMinutes * 60000,
        nextAttemptAt: this.now() + this.policy.intervalSeconds * 1000 + Math.floor(this.random() * 2000), reason: error.message.slice(0, 1000) };
      if (this.expired(next)) { await this.stop(next, "recovery_time_limit"); return false; }
      this.persist(next);
      try { await this.review.suspend(next); }
      catch { await this.stop(next, "review_recovery_unconfirmed"); return false; }
      return true;
    });
  }
  private async delivery(api: PaseoApi, record: RecoveryRecord): Promise<{ found: boolean; turnId: string | null; newerUser: boolean; outcome?: NativeOutcome | null }> {
    if (record.deliveryKind === "native") {
      if (!this.deps.receipt) throw new Error("native_recovery_host_unavailable");
      const receipt = record.messageId ? await this.deps.receipt(record.agentId, record.messageId) : null;
      const agent = (await api.agents.ref(record.agentId).refresh())?.agent;
      if (!agent) throw new Error("session_verification_unavailable");
      const known = receipt && ["accepted", "finished"].includes(receipt.status) && receipt.turnId;
      return { found: Boolean(known), turnId: known ? receipt!.turnId : null,
        newerUser: agent.lastUserMessageAt !== record.lastUserMessageAt, outcome: receipt?.outcome };
    }
    const history = await api.agents.ref(record.agentId).timeline.refetch({ direction: "tail", limit: 200 });
    let found = false, turnId: string | null = null, newerUser = false;
    for (const entry of history.entries) {
      if (entry.item.type !== "user_message") continue;
      if (entry.item.clientMessageId === record.messageId || entry.item.messageId === record.messageId) { found = true; turnId = entry.turnId || null; newerUser = false; }
      else if (found) newerUser = true;
    }
    return { found, turnId, newerUser };
  }
  private async acceptStarted(record: RecoveryRecord, turnId: string): Promise<void> {
    this.persist({ ...record, status: "running", recoveryTurnId: turnId, nextAttemptAt: null });
    try { await this.review.resume(this.records.get(record.agentId)!, turnId); }
    catch (error) {
      if (!this.closed) this.persist({ ...this.records.get(record.agentId)!, status: "uncertain", reason: "review_recovery_unconfirmed" });
      throw error;
    }
  }
  async turnStarted(agentId: string, turnId: string | null): Promise<void> {
    if (!turnId) return;
    await this.lock(agentId, async () => {
      const r = this.records.get(agentId); if (!r) return;
      if (r.status === "stopped" && r.messageId) {
        // A dispatch already accepted by the host may start after the user
        // cancels its recovery queue. That start must not re-arm the queue.
        try {
          const proof = await this.delivery(await this.deps.api(), r);
          if (proof.found && !proof.newerUser && (!proof.turnId || proof.turnId === turnId)) {
            this.persist({ ...r, recoveryTurnId: turnId }); return;
          }
        } catch { return; }
      }
      if (["sending", "running", "uncertain"].includes(r.status) && r.messageId) {
        if (r.status === "running" && r.recoveryTurnId === turnId) return;
        try {
          const api = await this.deps.api(), proof = await this.delivery(api, r);
          if (proof.found && !proof.newerUser && proof.turnId === turnId) {
            const snapshot = (await api.agents.ref(agentId).refresh())?.agent;
            if (snapshot) r.lastUserMessageAt = snapshot.lastUserMessageAt;
            await this.acceptStarted(r, turnId); return;
          }
          if (r.deliveryKind === "native" && !proof.newerUser) {
            this.persist({ ...r, status: "uncertain", reason: "awaiting_turn_identity" }); return;
          }
        } catch { this.persist({ ...r, status: "uncertain", reason: "delivery_verification_unavailable" }); return; }
      }
      if (activeStatuses.has(r.status)) await this.stop(r, "new_user_turn");
      else this.persist({ ...r, status: "ready", episodeId: null, firstFailureAt: null, deadlineAt: null, nextAttemptAt: null, reason: null, attempt: 0, recoveryTurnId: null, messageId: null, attemptStartedAt: null });
    });
  }
  async turnEnded(agentId: string, turnId: string | null, outcome: { kind: string; error?: RecoveryFailure }): Promise<void> {
    if (outcome.kind === "failed") { await this.claimFailure(agentId, turnId, outcome.error || { message: "Unknown failure" }); return; }
    await this.lock(agentId, async () => {
      const r = this.records.get(agentId);
      if (!r || !activeStatuses.has(r.status) || r.recoveryTurnId !== turnId) return;
      if (outcome.kind === "completed") this.persist({ ...r, status: "succeeded", nextAttemptAt: null, reason: null });
      else await this.stop(r, "turn_canceled");
    });
  }
  private async tickAgent(agentId: string): Promise<void> {
    await this.lock(agentId, async () => {
      const r = this.records.get(agentId);
      if (!r || !activeStatuses.has(r.status)) return;
      if (!this.enabled(agentId)) { await this.stop(r, "automatic_recovery_disabled"); return; }
      if (["sending", "uncertain", "running"].includes(r.status)) {
        if (this.now() - (this.lastObserved.get(agentId) || 0) < 5000) return;
        this.lastObserved.set(agentId, this.now());
        // Read-only reconciliation never replays an uncertain message.
        if (!r.messageId) return;
        try {
          const api = await this.deps.api(), proof = await this.delivery(api, r);
          const agent = (await api.agents.ref(agentId).refresh())?.agent;
          if (!agent || agent.archivedAt || agent.status === "closed") { await this.stop(r, "session_closed_or_archived"); return; }
          if (r.identity !== recoveryIdentity(agent)) { await this.stop(r, "session_identity_or_mode_changed"); return; }
          if (proof.newerUser) { await this.stop(r, "new_user_message"); return; }
          if (proof.found && proof.turnId) {
            if (proof.outcome) {
              if (r.status !== "running") await this.review.resume(r, proof.turnId);
              this.persist({ ...r, recoveryTurnId: proof.turnId, status: "running" });
              const outcome = proof.outcome, turnId = proof.turnId;
              queueMicrotask(() => { void this.turnEnded(agentId, turnId, outcome).catch(() => {}); });
              return;
            }
            if (agent.activeTurn?.turnId === proof.turnId && r.status !== "running") { r.lastUserMessageAt = agent.lastUserMessageAt; await this.acceptStarted(r, proof.turnId); }
            if (r.deliveryKind === "native") {
              if (!agent.activeTurn) this.persist({ ...this.records.get(agentId)!, status: "uncertain", reason: "native_recovery_terminal_unconfirmed" });
              return; // Native receipts own terminal evidence, including across reload.
            }
            // A terminal lifecycle event may have been lost during reload. Only
            // explicit terminal history evidence may continue the recovery chain.
            const history = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 });
            const terminal = history.entries.filter(e => e.turnId === proof.turnId).find(e => e.item.type === "error");
            if (!agent.activeTurn && terminal?.item.type === "error") {
              this.persist({ ...r, recoveryTurnId: proof.turnId, status: "running", lastUserMessageAt: agent.lastUserMessageAt });
              // Leave the lock before invoking the shared failure admission.
              queueMicrotask(() => { void this.claimFailure(agentId, proof.turnId, { message: terminal.item.type === "error" ? terminal.item.message : "" }).catch(() => {}); });
            } else if (!agent.activeTurn && agent.status === "idle" && !agent.lastError) {
              if (r.status !== "running") await this.review.resume(r, proof.turnId);
              this.persist({ ...r, status: "succeeded", recoveryTurnId: proof.turnId, nextAttemptAt: null, reason: null });
            }
          } else if (r.status === "sending") this.persist({ ...r, status: "uncertain", reason: "delivery_outcome_unknown" });
        } catch { /* Keep uncertainty visible; never assume a negative history read proves no delivery. */ }
        return;
      }
      if (this.expired(r)) { await this.stop(r, "recovery_time_limit"); return; }
      if (r.nextAttemptAt !== null && this.now() < r.nextAttemptAt) return;
      try {
        const api = await this.deps.api();
        const agent = (await api.agents.ref(agentId).refresh())?.agent;
        if (!agent) throw new Error("session_verification_unavailable");
        if (agent.archivedAt || agent.status === "closed" || agent.provider !== "codex") { await this.stop(r, "session_closed_or_archived"); return; }
        if (!confirmedMode(agent)) throw new Error("session_mode_unconfirmed");
        if (r.identity !== recoveryIdentity(agent) || agent.lastUserMessageAt !== r.lastUserMessageAt || agent.pendingPermissions?.length || agent.activeTurn) {
          await this.stop(r, "session_changed_or_busy"); return;
        }
        if (await this.review.inspect(agent) !== r.taskGuard) { await this.stop(r, "task_authorization_changed"); return; }
        // Recheck after potentially slow review/runtime inspection.
        const last = (await api.agents.ref(agentId).refresh())?.agent;
        if (!last || last.archivedAt || last.status === "closed" || last.activeTurn || last.pendingPermissions?.length || recoveryIdentity(last) !== r.identity || last.lastUserMessageAt !== r.lastUserMessageAt) {
          await this.stop(r, "session_changed_before_delivery"); return;
        }
        if (this.closed) return;
        const cancellation = this.cancellations.get(agentId);
        if (cancellation) { await this.stop(r, cancellation.reason); return; }
        if (!this.enabled(agentId)) { await this.stop(r, "automatic_recovery_disabled"); return; }
        r.deadlineAt = this.policy.maxDurationMinutes === null ? null : r.firstFailureAt! + this.policy.maxDurationMinutes * 60000;
        if (this.expired(r)) { await this.stop(r, "recovery_time_limit"); return; }
        const sending: RecoveryRecord = { ...r, status: "sending", attempt: r.attempt + 1,
          deliveryKind: this.deliveryKind(), messageId: `workbench-recovery:${r.episodeId}:${r.attempt + 1}`, attemptStartedAt: this.now(), nextAttemptAt: null };
        this.persist(sending);
        try {
          if (sending.deliveryKind === "message") {
            await this.deps.send(agentId, this.policy.continueMessage, sending.messageId!);
            if (this.closed) return;
            this.persist({ ...sending, status: "uncertain", reason: "awaiting_turn_identity" });
            const proof = await this.delivery(api, sending);
            if (proof.newerUser) { await this.stop(sending, "new_user_message"); return; }
            if (proof.found && proof.turnId) {
              const snapshot = (await api.agents.ref(agentId).refresh())?.agent;
              if (snapshot) sending.lastUserMessageAt = snapshot.lastUserMessageAt;
              await this.acceptStarted(sending, proof.turnId);
            }
            return;
          }
          const receipt = await this.deps.retry!({ agentId, attemptId: sending.messageId!, identity: sending.identity!, lastUserMessageAt: sending.lastUserMessageAt, failedTurnId: sending.failedTurnId! });
          if (this.closed) return;
          if (receipt?.status === "rejected") { await this.stop(sending, receipt.error || "native_recovery_rejected"); return; }
          if (receipt?.turnId && ["accepted", "finished"].includes(receipt.status)) await this.acceptStarted(sending, receipt.turnId);
          else this.persist({ ...sending, status: "uncertain", reason: "awaiting_turn_identity" });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "delivery_outcome_unknown";
          if (!this.closed && /native_recovery_session_changed|native_recovery_session_unavailable|native_recovery_attempt_conflict/.test(reason)) await this.stop(sending, reason);
          else if (!this.closed) this.persist({ ...this.records.get(agentId)!, status: "uncertain", reason: "delivery_outcome_unknown" });
        }
      } catch (error) {
        if (!this.closed) {
          const reason = error instanceof Error ? error.message : "session_verification_unavailable";
          if (/review_snapshot_stale|review_authorization_missing|review_phase_timeout|review_operation_unconfirmed|worker_identity_changed|handoff_delivery_uncertain|coordinator_delivery_unconfirmed|handoff_integrity_failed|handoff_required_materials_unavailable|handoff_bundle_invalid/.test(reason)) await this.stop(r, reason);
          else this.persist({ ...r, status: "paused", nextAttemptAt: this.now() + Math.max(10000, this.policy.intervalSeconds * 1000), reason });
        }
      }
    });
  }
  private ticking = false;
  private lastObserved = new Map<string, number>();
  async tick(): Promise<void> {
    if (this.closed || this.ticking || !this.available) return;
    this.ticking = true;
    try {
      // Bound observation concurrency as well as per-agent dispatch.
      const ids = [...this.records.values()].filter(r => activeStatuses.has(r.status)).map(r => r.agentId);
      for (let i = 0; i < ids.length && !this.closed; i += 4) await Promise.allSettled(ids.slice(i, i + 4).map(id => this.tickAgent(id)));
    } finally { this.ticking = false; }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
    this.deps.store.close();
  }
}
