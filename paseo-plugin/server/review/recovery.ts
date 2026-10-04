import type { PaseoAgentHandle } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { type ReviewSession } from "../../shared/agent-review.ts";
import { coordinatorReview, sessionLimits } from "../../shared/session-tools.ts";
import type { AgentContext } from "../agent-provider.ts";
import { inspectCoordinatorTurn } from "../review-host.ts";
import { ReviewRecoveryClock } from "../review-recovery-clock.ts";
import { withReviewTransitionLock } from "../review-state-transitions.ts";
import type { ReviewAuthorization } from './authorization.ts';
import type { ReviewDispatch } from './dispatch.ts';
import { authKey, errorInfo, turnKey } from './identity.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { ReviewTransitions } from './transitions.ts';
import type { ReviewAuth } from './types.ts';
type Dependencies = {
    dispatch: Pick<ReviewDispatch, "recoverReviewerMonitor" | "cancelAgentIfSupported">;
    authorization: Pick<ReviewAuthorization, "authorizeReviewCaller" | "currentRuntime" | "runtimeIdentity" | "runtimeIdentityFromSnapshot" | "pathWithin">;
    transitions: Pick<ReviewTransitions, "recordReviewerResultInternal" | "handleReviewTurnEnded">;
    storage: Pick<ReviewInfrastructure["storage"], "getAgentBinding" | "activeReviewSessions" | "readState" | "readSession" | "removeReviewState" | "persistSession" | "writeReviewState" | "readReviewState" | "onReviewChanged">;
    identity: Pick<ReviewInfrastructure["identity"], "randomUUID">;
    clock: Pick<ReviewInfrastructure["clock"], "now" | "millis">;
    projects: Pick<ReviewInfrastructure["projects"], "registeredProjects" | "withProject" | "currentProject">;
};
export class ReviewRecovery {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async recoverReviewerForAgent(agentId: string, context: AgentContext): Promise<void> {
        for (const session of this.deps.storage.activeReviewSessions()) {
            if (session.status === "reviewing" && session.reviewerAgentId === agentId)
                await this.deps.dispatch.recoverReviewerMonitor(session, context);
        }
    }
    async handleCoordinatorReview(input: typeof coordinatorReview.input._output, context: AgentContext): Promise<unknown> {
        this.coordinatorContext = context;
        await this.deps.authorization.authorizeReviewCaller(input.token, context);
        const identity = this.deps.storage.readState<{
            agentId: string;
        }>(`context:${input.token}`);
        return withReviewTransitionLock(input.workspaceId, async () => {
            let session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
            if (!session || session.round !== input.round || session.roundTarget !== "coordinator" || !session.coordinator || session.coordinator.messageId !== input.assignmentId || session.coordinator.agentId !== identity?.agentId)
                throw new Error("coordinator_review_not_authorized");
            if (!["queued", "reviewing"].includes(session.status) || !["sent", "uncertain", "accepted"].includes(session.coordinator.phase))
                throw new Error("coordinator_review_revoked");
            const agent = (await context.paseo.agents.ref(identity.agentId).refresh())?.agent;
            const turnId = agent?.activeTurn?.turnId;
            if (!turnId)
                throw new Error("coordinator_review_turn_required");
            if (session.reviewerTurnId && session.reviewerTurnId !== turnId)
                throw new Error("coordinator_review_turn_changed");
            const runtime = await this.deps.authorization.currentRuntime(session.workspaceId, context);
            if (!session.snapshot || this.deps.authorization.runtimeIdentity(runtime) !== this.deps.authorization.runtimeIdentityFromSnapshot(session.snapshot)) {
                this.deps.storage.removeReviewState(authKey(session.id));
                this.deps.storage.persistSession({ ...session, status: "waiting_execution", snapshot: null, snapshotId: null, diffId: null, pendingReviewerResult: null, coordinator: { ...session.coordinator, phase: "revoked" } }, { kind: "expired", summary: "Code changed; waiting for a new execution report", details: {} });
                throw new Error("review_snapshot_stale");
            }
            if (input.action === "read") {
                if (session.coordinator.phase !== "accepted") {
                    const token = this.deps.identity.randomUUID();
                    this.deps.storage.writeReviewState(authKey(session.id), { token, workspaceId: session.workspaceId, reviewerAgentId: identity.agentId });
                    session = this.deps.storage.persistSession({ ...session, status: "reviewing", reviewerAgentId: identity.agentId, reviewerTurnId: turnId,
                        coordinator: { ...session.coordinator, phase: "accepted", acceptedAt: this.deps.clock.now(), timeoutAt: null, hardTimeoutAt: null } }, { kind: "review_started", summary: "Coordinator accepted review", details: { turnId } });
                }
                return { ok: true, snapshot: session.snapshot, handoff: session.handoff, materials: session.materials, supplements: session.materials ? [] : this.deps.storage.readState(`session-supplements:${session.workspaceId}:${session.executionAgentId}`) || [],
                    instructions: `${session.materials ? "First use workbench_handoff_read with the returned materials bundle to read HANDOFF.md, SOURCES.md and required originals. " : ""}Review only. Do not edit files. Submit workbench_review_result for this round, then end this turn; the worker handles required repairs.` };
            }
            if (session.coordinator.phase !== "accepted")
                throw new Error("read_review_before_result");
            const auth = this.deps.storage.readReviewState<ReviewAuth>(authKey(session.id));
            if (!auth)
                throw new Error("coordinator_review_revoked");
            return this.deps.transitions.recordReviewerResultInternal({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: identity.agentId, token: auth.token, result: input.result }, context);
        });
    }
    coordinatorTimeoutWindow(session: ReviewSession): {
        timeoutAt: string;
        hardTimeoutAt: string;
    } | null {
        const acceptedAt = session.coordinator?.acceptedAt ? Date.parse(session.coordinator.acceptedAt) : NaN;
        if (!Number.isFinite(acceptedAt))
            return null;
        const configuredTimeoutAt = session.coordinator?.timeoutAt ? Date.parse(session.coordinator.timeoutAt) : NaN;
        const softTimeout = Number.isFinite(configuredTimeoutAt) ? configuredTimeoutAt : acceptedAt + session.preferences.reviewerTimeoutMs;
        const configuredHardTimeoutAt = session.coordinator?.hardTimeoutAt ? Date.parse(session.coordinator.hardTimeoutAt) : NaN;
        const hardTimeout = Number.isFinite(configuredHardTimeoutAt) ? configuredHardTimeoutAt : softTimeout + session.preferences.reviewerTimeoutMs;
        return { timeoutAt: new Date(softTimeout).toISOString(), hardTimeoutAt: new Date(hardTimeout).toISOString() };
    }
    failReviewSession(session: ReviewSession, code: string, message: string, details: Record<string, unknown> = {}): ReviewSession {
        this.deps.storage.removeReviewState(authKey(session.id));
        return this.deps.storage.persistSession({ ...session, status: "failed", pendingReviewerResult: null, stopAgentIds: [], pendingOperation: null,
            coordinator: session.coordinator ? { ...session.coordinator, phase: "revoked" } : null, lastError: { code, message } }, { kind: "failed", summary: message, details });
    }
    async stopTimedOutReviewer(session: ReviewSession, context: AgentContext): Promise<void> {
        const agentId = session.reviewerAgentId;
        const pending = session.coordinator;
        if (!agentId || session.reviewerTurnId === null || (session.roundTarget === "coordinator" && (!pending || pending.agentId !== agentId)))
            return;
        const stopping = this.deps.storage.persistSession({ ...session, status: "stopping", stopAgentIds: [agentId],
            pendingOperation: { kind: "cancel", requestId: this.deps.identity.randomUUID(), createdAt: this.deps.clock.now() },
            coordinator: pending ? { ...pending, phase: "stopping" } : null,
            lastError: { code: "reviewer_timeout", message: "Reviewer exceeded its time limit; stopping the review" } });
        try {
            await this.deps.dispatch.cancelAgentIfSupported(context, agentId);
        }
        catch (error) {
            const latest = this.deps.storage.readSession(stopping.workspaceId, stopping.id);
            if (latest?.status === "stopping" && (latest.roundTarget !== "coordinator" || latest.coordinator?.phase === "stopping")) {
                this.deps.storage.persistSession({ ...latest, lastError: errorInfo(error, "Timed-out Reviewer could not be cancelled") });
            }
        }
    }
    async tickCoordinatorReviews(context: AgentContext): Promise<void> {
        if (this.coordinatorTickRunning)
            return;
        const generation = this.coordinatorGeneration;
        this.coordinatorTickRunning = true;
        try {
            const candidates: Array<{
                config: string;
                session: ReviewSession;
            }> = [];
            for (const project of this.deps.projects.registeredProjects())
                await this.deps.projects.withProject({ projectConfig: project.configPath }, () => {
                    for (const session of this.deps.storage.activeReviewSessions())
                        if (session.roundTarget === "coordinator" && ["queued", "reviewing"].includes(session.status))
                            candidates.push({ config: project.configPath, session });
                });
            candidates.sort((a, b) => (a.session.coordinator?.queuedAt || "").localeCompare(b.session.coordinator?.queuedAt || ""));
            const occupied = new Set(candidates.filter(c => c.session.coordinator?.phase !== "waiting").map(c => c.session.coordinator?.agentId));
            for (const candidate of candidates)
                await this.deps.projects.withProject({ projectConfig: candidate.config }, async () => {
                    await withReviewTransitionLock(candidate.session.workspaceId, async () => {
                        const session = this.deps.storage.readSession(candidate.session.workspaceId, candidate.session.id);
                        if (!session || !["queued", "reviewing"].includes(session.status) || !session.coordinator)
                            return;
                        const pending = session.coordinator;
                        if (pending.phase === "accepted") {
                            const ended = session.reviewerAgentId && session.reviewerTurnId ? this.deps.storage.readReviewState<{
                                outcome: string;
                            }>(turnKey(session.reviewerAgentId, session.reviewerTurnId)) : null;
                            const auth = this.deps.storage.readReviewState<ReviewAuth>(authKey(session.id));
                            if (ended?.outcome === "completed" && session.pendingReviewerResult && auth && session.reviewerAgentId) {
                                await this.deps.transitions.recordReviewerResultInternal({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId, token: auth.token, result: session.pendingReviewerResult, finalize: true }, context);
                                return;
                            }
                            if (ended) {
                                this.failReviewSession(session, ended.outcome === "completed" ? "coordinator_review_incomplete" : "reviewer_turn_failed", ended.outcome === "completed" ? "Review turn ended without a completed structured result" : `Coordinator review ended with ${ended.outcome}`, { outcome: ended.outcome, turnId: session.reviewerTurnId });
                                return;
                            }
                            const timeoutWindow = this.coordinatorTimeoutWindow(session);
                            if (!timeoutWindow || this.deps.clock.millis() < Date.parse(timeoutWindow.timeoutAt))
                                return;
                            const inspection = await inspectCoordinatorTurn(session, context);
                            if (inspection === "unknown" || inspection === "ended")
                                return;
                            if (inspection === "changed") {
                                this.failReviewSession(session, "reviewer_turn_changed", "Coordinator review turn changed before the review completed", { expectedTurnId: session.reviewerTurnId });
                                return;
                            }
                            if (!pending.timeoutAt || !pending.hardTimeoutAt) {
                                this.deps.storage.persistSession({ ...session, coordinator: { ...pending, timeoutAt: timeoutWindow.timeoutAt, hardTimeoutAt: timeoutWindow.hardTimeoutAt } });
                                return;
                            }
                            if (this.deps.clock.millis() >= Date.parse(timeoutWindow.hardTimeoutAt))
                                await this.stopTimedOutReviewer(session, context);
                            return;
                        }
                        if (pending.phase === "uncertain" && pending.agentId) {
                            const page = await context.paseo.agents.ref(pending.agentId).timeline.refetch({ limit: sessionLimits.maxHistoryItems });
                            if (!page.error && page.entries.some(entry => entry.item.type === "user_message" && (entry.item.messageId === pending.messageId || entry.item.clientMessageId === pending.messageId))) {
                                this.deps.storage.persistSession({ ...session, coordinator: { ...pending, phase: "sent" } }, { kind: "review_queued", summary: "Coordinator delivery confirmed from history", details: {} });
                            }
                            return;
                        }
                        if (pending.phase !== "waiting")
                            return;
                        if (!pending.agentId) {
                            if (session.lastError?.code !== "coordinator_missing")
                                this.deps.storage.persistSession({ ...session, lastError: { code: "coordinator_missing", message: "原主控无法恢复，请手动选择独立 Reviewer" } });
                            return;
                        }
                        if (occupied.has(pending.agentId))
                            return;
                        const agent = (await context.paseo.agents.ref(pending.agentId).refresh())?.agent;
                        const worker = session.executionAgentId ? (await context.paseo.agents.ref(session.executionAgentId).refresh())?.agent : null;
                        if (!agent || agent.archivedAt) {
                            if (session.lastError?.code !== "coordinator_unavailable")
                                this.deps.storage.persistSession({ ...session, lastError: { code: "coordinator_unavailable", message: "主控不可用，等待恢复或手动选择独立 Reviewer" } });
                            return;
                        }
                        if (agent.status !== "idle" || agent.activeTurn || !worker || worker.activeTurn || worker.status !== "idle")
                            return;
                        if (agent.id !== pending.agentId || ![this.deps.projects.currentProject()!.sourceRoot, this.deps.projects.currentProject()!.workspaceRoot].some(root => this.deps.authorization.pathWithin(root, agent.cwd)))
                            return;
                        const binding = this.deps.storage.getAgentBinding(session.workspaceId);
                        if ((binding?.parentAgentId || binding?.requestedByAgentId) !== pending.agentId)
                            return;
                        const current = (await context.paseo.agents.ref(pending.agentId).refresh())?.agent;
                        if (generation !== this.coordinatorGeneration || !current || current.activeTurn || current.status !== "idle")
                            return;
                        const sending = this.deps.storage.persistSession({ ...session, lastError: null, coordinator: { ...pending, phase: "uncertain" } }, { kind: "review_queued", summary: "Coordinator review delivery pending", details: {} });
                        occupied.add(pending.agentId);
                        try {
                            await context.paseo.agents.ref(pending.agentId).send(`Workspace ${session.workspaceId} is ready for review. Read workbench_review_read with workspaceId=${session.workspaceId}, sessionId=${session.id}, round=${session.round}, assignmentId=${pending.messageId}. Use the same identity for workbench_review_result. Review without editing and end the turn after submitting. Task: ${(session.handoff?.goal || "").slice(0, 500)}`, { messageId: pending.messageId, activeTurnBehavior: "steer" } as Parameters<PaseoAgentHandle["send"]>[1]);
                            this.deps.storage.persistSession({ ...sending, coordinator: { ...pending, phase: "sent" } }, { kind: "review_queued", summary: "Waiting for coordinator to accept review", details: {} });
                        }
                        catch { /* Uncertain delivery is never automatically resent. */ }
                    });
                }).catch(error => { console.warn("coordinator_review_retry_pending", errorInfo(error).code); });
        }
        finally {
            this.coordinatorTickRunning = false;
        }
    }
    registerReviewLifecycle(server: PluginServerContext): () => void {
        const cleanup = server.on("agent.turn_ended", async (event, context) => {
            this.coordinatorContext = context;
            for (const project of this.deps.projects.registeredProjects()) {
                try {
                    await this.deps.projects.withProject({ projectConfig: project.configPath }, async () => {
                        await this.deps.transitions.handleReviewTurnEnded(event, context);
                        for (const session of this.deps.storage.activeReviewSessions()) {
                            if (session.roundTarget !== "coordinator" || !["reviewing", "stopping"].includes(session.status) || session.reviewerAgentId !== event.agent.id || session.reviewerTurnId !== event.turnId)
                                continue;
                            await withReviewTransitionLock(session.workspaceId, async () => {
                                const latest = this.deps.storage.readSession(session.workspaceId, session.id);
                                if (!latest || !["reviewing", "stopping"].includes(latest.status))
                                    return;
                                const auth = this.deps.storage.readReviewState<ReviewAuth>(authKey(latest.id));
                                if (event.outcome.kind === "completed" && latest.pendingReviewerResult && auth) {
                                    await this.deps.transitions.recordReviewerResultInternal({ workspaceId: latest.workspaceId, sessionId: latest.id, reviewerAgentId: event.agent.id, token: auth.token, result: latest.pendingReviewerResult, finalize: true }, context);
                                }
                                else if (latest.status === "stopping" && latest.coordinator?.phase === "stopping") {
                                    this.failReviewSession(latest, "reviewer_timeout", "Coordinator review timed out before it produced a completed result", { outcome: event.outcome.kind, turnId: event.turnId });
                                }
                                else
                                    this.deps.storage.persistSession({ ...latest, status: "failed", lastError: { code: "coordinator_review_incomplete", message: "Review turn ended without a completed structured result" } }, { kind: "failed", summary: "Coordinator review incomplete", details: {} });
                            });
                        }
                        for (const session of this.deps.storage.activeReviewSessions()) {
                            if (session.roundTarget !== "independent" || session.status !== "stopping" || session.lastError?.code !== "reviewer_timeout" || session.reviewerAgentId !== event.agent.id || session.reviewerTurnId !== event.turnId)
                                continue;
                            await withReviewTransitionLock(session.workspaceId, async () => {
                                const latest = this.deps.storage.readSession(session.workspaceId, session.id);
                                if (!latest || latest.status !== "stopping" || latest.lastError?.code !== "reviewer_timeout")
                                    return;
                                const auth = this.deps.storage.readReviewState<ReviewAuth>(authKey(latest.id));
                                if (event.outcome.kind === "completed" && latest.pendingReviewerResult && auth) {
                                    await this.deps.transitions.recordReviewerResultInternal({ workspaceId: latest.workspaceId, sessionId: latest.id, reviewerAgentId: event.agent.id, token: auth.token, result: latest.pendingReviewerResult, finalize: true }, context);
                                }
                                else
                                    this.failReviewSession(latest, "reviewer_timeout", "Reviewer timed out before it produced a completed result", { outcome: event.outcome.kind, turnId: event.turnId });
                            });
                        }
                        // A daemon/plugin restart can lose the in-memory monitor. The
                        // lifecycle event is enough to reattach it even when no UI tab is
                        // open, and a persisted candidate can then be finalized normally.
                        await this.recoverReviewerForAgent(event.agent.id, context);
                    });
                }
                catch (error) {
                    console.warn("workspace_workbench_review_lifecycle_failed", errorInfo(error));
                }
            }
            await this.tickCoordinatorReviews(context);
        });
        const cleanupStarted = server.on("agent.turn_started", async (event, context) => {
            for (const project of this.deps.projects.registeredProjects()) {
                try {
                    await this.deps.projects.withProject({ projectConfig: project.configPath }, () => this.recoverReviewerForAgent(event.agent.id, context));
                }
                catch (error) {
                    console.warn("workspace_workbench_review_recovery_failed", errorInfo(error));
                }
            }
        });
        const clock = new ReviewRecoveryClock(async () => {
            if (this.coordinatorContext)
                await this.tickCoordinatorReviews(this.coordinatorContext);
        });
        const updateClock = (session: ReviewSession) => {
            const window = this.coordinatorTimeoutWindow(session);
            const deadline = window ? Date.parse(this.deps.clock.millis() < Date.parse(window.timeoutAt) ? window.timeoutAt : window.hardTimeoutAt) : undefined;
            clock.update(`${session.projectConfig}:${session.id}`, ["queued", "reviewing", "stopping"].includes(session.status), deadline);
        };
        const unsubscribe = this.deps.storage.onReviewChanged(updateClock);
        for (const project of this.deps.projects.registeredProjects())
            void this.deps.projects.withProject({ projectConfig: project.configPath }, () => {
                for (const session of this.deps.storage.activeReviewSessions())
                    updateClock(session);
            });
        return () => { this.coordinatorGeneration++; clock.close(); unsubscribe(); this.coordinatorContext = null; cleanup(); cleanupStarted(); };
    }
    coordinatorContext: AgentContext | null = null;
    coordinatorTickRunning = false;
    coordinatorGeneration = 0;
}
