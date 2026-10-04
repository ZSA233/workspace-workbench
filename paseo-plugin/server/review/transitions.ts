import { reviewResultSchema, type ReviewLocale, type ReviewSession, type ReviewSnapshot } from "../../shared/agent-review.ts";
import type { AgentContext } from "../agent-provider.ts";
import { withReviewTransitionLock } from "../review-state-transitions.ts";
import type { ReviewAuthorization } from './authorization.ts';
import type { ReviewDispatch } from './dispatch.ts';
import { authKey, errorInfo, reportKey, turnKey } from './identity.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { ReviewMaterials } from './materials.ts';
import type { ReviewSessions } from './sessions.ts';
import type { ReviewSettings } from './settings.ts';
import type { ExecutionReportRecord, ReviewAuth } from './types.ts';
type Dependencies = {
    authorization: Pick<ReviewAuthorization, "validateReportMaterials" | "currentRuntime" | "validateExecutionToken" | "runtimeAgentCwdMatches" | "reviewerContextMatches" | "runtimeIdentity" | "runtimeIdentityFromSnapshot" | "safeRelativePath">;
    settings: Pick<ReviewSettings, "preferenceLayers">;
    sessions: Pick<ReviewSessions, "newSession" | "boundHandoff" | "acceptanceCriteriaFor">;
    materials: Pick<ReviewMaterials, "captureSnapshot">;
    dispatch: Pick<ReviewDispatch, "startReviewer" | "sendRepair">;
    storage: Pick<ReviewInfrastructure["storage"], "getAgentBinding" | "readSession" | "persistSession" | "writeReviewState" | "readReviewState" | "digest">;
    clock: Pick<ReviewInfrastructure["clock"], "now">;
    projects: Pick<ReviewInfrastructure["projects"], "currentProject">;
};
export class ReviewTransitions {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async createOrUpdateReadySession(input: {
        workspaceId: string;
        projectConfig: string;
        executionAgentId: string;
        executionTurnId: string | null;
        report: ExecutionReportRecord["report"];
    }, context: AgentContext): Promise<ReviewSession> {
        this.deps.authorization.validateReportMaterials(input.workspaceId, input.report.materialsVersion);
        const layers = this.deps.settings.preferenceLayers();
        const existing = this.deps.storage.readSession(input.workspaceId);
        if (existing && ["approved", "blocked", "failed", "stopped", "limit_reached", "stopping"].includes(existing.status))
            return existing;
        if (existing && !["waiting_execution", "fixing"].includes(existing.status))
            return existing;
        let session = existing;
        if (!session)
            session = this.deps.storage.persistSession(this.deps.sessions.newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId: input.executionAgentId, preferences: layers.effective }), { kind: "started", summary: "Execution handoff recorded", details: { executionAgentId: input.executionAgentId } });
        if (session.executionAgentId !== input.executionAgentId)
            throw new Error("execution_agent_mismatch");
        const runtime = await this.deps.authorization.currentRuntime(input.workspaceId, context);
        const snapshot = await this.deps.materials.captureSnapshot(input.workspaceId, runtime, context, session?.handoff?.reviewPacket.references || this.deps.sessions.boundHandoff(input.workspaceId)?.reviewPacket.references || []);
        const current = this.deps.storage.readSession(input.workspaceId, session.id);
        if (!current || current.revision !== session.revision || ["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(current.status))
            throw new Error("review_state_conflict");
        session = current;
        if (session.snapshotId && session.round > 0 && session.snapshotId === snapshot.snapshotId && session.diffId === snapshot.diffId && session.status === "fixing") {
            return this.deps.storage.persistSession({ ...session, status: "blocked", lastError: { code: "repair_no_progress", message: "修复后代码快照没有变化" } }, { kind: "blocked", summary: "Repair produced no new code snapshot", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } });
        }
        session = this.deps.storage.persistSession({ ...session, executionTurnId: input.executionTurnId }, { kind: "execution_turn_ended", summary: "Execution turn completed", details: { turnId: input.executionTurnId, executionAgentId: input.executionAgentId } });
        session = { ...session, materials: this.deps.storage.getAgentBinding(input.workspaceId)?.handoffBundle, status: "ready_for_review", coordinator: null, roundTarget: session.preferences.reviewerTarget, executionTurnId: input.executionTurnId, round: Math.max(1, session.round + (session.status === "fixing" ? 1 : 0)), snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, snapshot, latestResult: null, pendingOperation: null, lastError: null };
        session = this.deps.storage.persistSession(session, { kind: "ready_for_review", summary: input.report.summary, details: { executionAgentId: input.executionAgentId, turnId: input.executionTurnId, changes: input.report.changes, tests: input.report.tests, knownLimitations: input.report.knownLimitations, snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } });
        if (session.preferences.mode === "automatic")
            return this.deps.dispatch.startReviewer(session, context);
        return session;
    }
    async handleExecutionTurnEnded(event: {
        agent: {
            id: string;
        };
        turnId: string | null;
        outcome: {
            kind: string;
        };
    }, context: AgentContext): Promise<void> {
        if (!event.turnId)
            return;
        this.deps.storage.writeReviewState(turnKey(event.agent.id, event.turnId), { outcome: event.outcome.kind, endedAt: this.deps.clock.now() });
        const pending = this.deps.storage.readReviewState<ExecutionReportRecord>(reportKey(event.agent.id));
        if (!pending || pending.consumedAt || pending.turnId !== event.turnId)
            return;
        await withReviewTransitionLock(pending.workspaceId, async () => {
            const currentPending = this.deps.storage.readReviewState<ExecutionReportRecord>(reportKey(event.agent.id));
            if (!currentPending || currentPending.consumedAt || currentPending.turnId !== event.turnId)
                return;
            if (event.outcome.kind !== "completed") {
                const session = this.deps.storage.readSession(currentPending.workspaceId);
                if (session && ["waiting_execution", "ready_for_review", "queued", "fixing"].includes(session.status))
                    this.deps.storage.persistSession({ ...session, status: "failed", lastError: { code: "execution_turn_failed", message: `Execution turn ended with ${event.outcome.kind}` } }, { kind: "failed", summary: "Execution turn did not complete", details: { turnId: event.turnId, outcome: event.outcome.kind } });
                this.deps.storage.writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: this.deps.clock.now() });
                return;
            }
            if (currentPending.report.status !== "ready_for_review") {
                this.deps.storage.writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: this.deps.clock.now() });
                return;
            }
            try {
                await this.createOrUpdateReadySession({ ...currentPending, projectConfig: this.deps.projects.currentProject()?.configPath || "", executionTurnId: currentPending.turnId }, context);
                this.deps.storage.writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: this.deps.clock.now() });
            }
            catch (error) {
                const session = this.deps.storage.readSession(currentPending.workspaceId);
                if (session && !["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(session.status))
                    this.deps.storage.persistSession({ ...session, status: "failed", lastError: errorInfo(error, "Review could not be started") }, { kind: "failed", summary: "Review could not be started", details: errorInfo(error) });
            }
        });
    }
    async acceptExecutionReport(input: {
        projectConfig: string;
        workspaceId: string;
        executionAgentId: string;
        token: string;
        turnId?: string;
        report: ExecutionReportRecord["report"];
    }, context: AgentContext): Promise<{
        ok: boolean;
        session: ReviewSession | null;
        accepted: boolean;
        error?: {
            code: string;
            message: string;
        };
    }> {
        const executionAgentId = this.deps.authorization.validateExecutionToken(input);
        if (input.report.status === "ready_for_review")
            this.deps.authorization.validateReportMaterials(input.workspaceId, input.report.materialsVersion);
        const agent = await context.paseo.agents.ref(executionAgentId).refresh();
        if (!agent?.agent || agent.agent.cwd === null)
            throw new Error("execution_agent_unavailable");
        const runtime = await this.deps.authorization.currentRuntime(input.workspaceId, context);
        if (!this.deps.authorization.runtimeAgentCwdMatches(runtime, agent.agent.cwd))
            throw new Error("execution_agent_identity_changed");
        if (input.turnId && agent.agent.activeTurn?.turnId && input.turnId !== agent.agent.activeTurn.turnId)
            throw new Error("execution_turn_mismatch");
        const turnId = input.turnId || agent.agent.activeTurn?.turnId || null;
        const record: ExecutionReportRecord = { workspaceId: input.workspaceId, executionAgentId, turnId, report: input.report, createdAt: this.deps.clock.now() };
        const existing = this.deps.storage.readSession(input.workspaceId);
        if (existing?.handoff?.handoffId && input.report.handoffId && existing.handoff.handoffId !== input.report.handoffId)
            throw new Error("execution_handoff_mismatch");
        if (existing && ["approved", "blocked", "failed", "stopped", "limit_reached", "stopping"].includes(existing.status))
            return { ok: true, session: existing, accepted: false, error: { code: "execution_report_late", message: "This execution report arrived after the review flow ended" } };
        if (existing && !["waiting_execution", "fixing"].includes(existing.status))
            return { ok: true, session: existing, accepted: false, error: { code: "execution_report_unexpected", message: "This execution report does not belong to the current review phase" } };
        const previousReport = this.deps.storage.readReviewState<ExecutionReportRecord>(reportKey(executionAgentId));
        if (previousReport?.consumedAt && previousReport.turnId === turnId && this.deps.storage.digest(previousReport.report) === this.deps.storage.digest(input.report))
            return { ok: true, session: existing, accepted: true };
        if (previousReport && !previousReport.consumedAt) {
            if (previousReport.turnId !== turnId)
                throw new Error("execution_report_in_progress");
            if (this.deps.storage.digest(previousReport.report) === this.deps.storage.digest(input.report))
                return { ok: true, session: existing, accepted: true };
            throw new Error("execution_report_conflict");
        }
        this.deps.storage.writeReviewState(reportKey(executionAgentId), record);
        if (input.report.status !== "ready_for_review") {
            const layers = this.deps.settings.preferenceLayers();
            const session = existing || this.deps.storage.persistSession(this.deps.sessions.newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences: layers.effective }), { kind: "started", summary: "Execution report received", details: {} });
            const blocked = input.report.status === "needs_input";
            const failed = this.deps.storage.persistSession({ ...session, status: blocked ? "blocked" : "failed", lastError: { code: blocked ? "execution_needs_input" : "execution_failed", message: input.report.summary } }, { kind: blocked ? "blocked" : "failed", summary: input.report.summary, details: { report: input.report } });
            this.deps.storage.writeReviewState(reportKey(executionAgentId), { ...record, consumedAt: this.deps.clock.now() });
            return { ok: true, session: failed, accepted: true };
        }
        const waiting = existing || this.deps.storage.persistSession(this.deps.sessions.newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences: this.deps.settings.preferenceLayers().effective }), { kind: "started", summary: "Execution report received", details: { executionAgentId } });
        const candidate = this.deps.storage.persistSession({ ...waiting, executionAgentId, executionTurnId: turnId }, { kind: "ready_for_review", summary: "Ready-for-review report received; waiting for turn completion", details: { turnId, report: input.report } });
        return { ok: true, session: candidate, accepted: true };
    }
    async startReviewInternal(input: {
        workspaceId: string;
        projectConfig: string;
        executionAgentId?: string;
        locale?: ReviewLocale;
        instructions?: string;
    }, context: AgentContext): Promise<ReviewSession> {
        const existing = this.deps.storage.readSession(input.workspaceId);
        if (this.deps.storage.getAgentBinding(input.workspaceId)?.pendingHandoffBundle || existing?.materials && existing.status === "waiting_execution")
            throw new Error("execution_not_ready");
        const interruptedReviewerOperation = existing?.status === "queued" && (existing.pendingOperation?.kind === "create_reviewer" || existing.pendingOperation?.kind === "send_reviewer");
        if (existing && !interruptedReviewerOperation && existing.status === "ready_for_review")
            return this.deps.dispatch.startReviewer(existing, context);
        if (existing && !interruptedReviewerOperation && ["reviewing", "queued", "fixing", "changes_requested", "stopping"].includes(existing.status))
            return existing;
        if (interruptedReviewerOperation) {
            try {
                return await this.deps.dispatch.startReviewer(existing, context);
            }
            catch (error) {
                const failed = this.deps.storage.persistSession({ ...existing, status: "failed", pendingOperation: null, lastError: errorInfo(error, "Reviewer creation needs recovery") }, { kind: "failed", summary: "Reviewer creation needs recovery", details: errorInfo(error) });
                void failed;
                throw error;
            }
        }
        const layers = this.deps.settings.preferenceLayers();
        // `off` disables automatic lifecycle triggers. An explicit user request is
        // still allowed to start a read-only review; the caller has clearly opted
        // into this operation.
        const preferences = {
            ...layers.effective,
            ...(input.locale ? { locale: input.locale } : {}),
        };
        const runtime = await this.deps.authorization.currentRuntime(input.workspaceId, context);
        if (!runtime.managed) {
            const snapshot = await this.deps.materials.captureSnapshot(input.workspaceId, runtime, context);
            const handoff = {
                goal: "Manual read-only review of the main workspace",
                decisions: [], inScope: runtime.repositories.map(repo => repo.worktreePath), outOfScope: [], steps: [], acceptance: [], constraints: ["Read-only review; do not modify files, commit, push, deploy, or repair."], ambiguities: [],
                reviewPacket: { requirementUnderstanding: "Review the selected main-workspace repositories using the configured project review instructions.", plan: [], acceptanceCriteria: [], references: [], instructions: input.instructions?.trim() || "" },
                startMode: "adaptive" as const,
                expected: { branchByRepository: {}, baseByRepository: {} },
            };
            const mainPreferences = { ...preferences, mode: "manual" as const, autoFix: false, reviewerTarget: "independent" as const };
            let session = this.deps.sessions.newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId: null, preferences: mainPreferences, status: "queued", handoff });
            session = { ...session, roundTarget: "independent", round: 1, snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, snapshot };
            session = this.deps.storage.persistSession(session, { kind: "started", summary: "Manual read-only review started from the main workspace", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, repositories: runtime.repositories.map(repo => ({ id: repo.id, path: repo.worktreePath, head: repo.head })) } });
            return this.deps.dispatch.startReviewer(session, context);
        }
        const executionAgentId = input.executionAgentId || existing?.executionAgentId || null;
        if (!executionAgentId)
            throw new Error("execution_agent_required");
        const execution = await context.paseo.agents.ref(executionAgentId).refresh();
        if (!execution?.agent || execution.agent.archivedAt || !this.deps.authorization.runtimeAgentCwdMatches(runtime, execution.agent.cwd) || (execution.agent.runtimeInfo?.provider && execution.agent.runtimeInfo.provider !== "codex")) {
            throw new Error("execution_agent_identity_changed");
        }
        if (execution.agent.activeTurn)
            throw new Error("execution_agent_busy");
        const executionModelId = execution.agent.runtimeInfo?.model || execution.agent.model || null;
        const snapshot = await this.deps.materials.captureSnapshot(input.workspaceId, runtime, context, existing?.handoff?.reviewPacket.references || this.deps.sessions.boundHandoff(input.workspaceId)?.reviewPacket.references || []);
        const reusable = existing && !["approved", "blocked", "failed", "stopped", "limit_reached"].includes(existing.status) ? existing : null;
        let session = reusable || this.deps.sessions.newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences, status: "queued" });
        session = { ...session, handoff: existing?.handoff || session.handoff, executionAgentId, executionModelId, preferences: existing?.preferences || preferences, status: "queued", round: Math.max(1, existing?.round || 1), snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, snapshot, lastError: null, pendingOperation: null };
        session = this.deps.storage.persistSession(session, reusable ? { kind: "review_queued", summary: "Review queued by user", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } } : { kind: "started", summary: "Review started from the Workspace", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, executionAgentId } });
        return this.deps.dispatch.startReviewer(session, context);
    }
    startReview(input: {
        workspaceId: string;
        projectConfig: string;
        executionAgentId?: string;
        locale?: ReviewLocale;
        instructions?: string;
    }, context: AgentContext): Promise<ReviewSession> {
        const key = `${this.deps.projects.currentProject()?.configPath || input.projectConfig}:${input.workspaceId}`;
        const active = this.reviewStartFlights.get(key);
        if (active)
            return active;
        const flight = withReviewTransitionLock(input.workspaceId, () => this.startReviewInternal(input, context)).finally(() => this.reviewStartFlights.delete(key));
        this.reviewStartFlights.set(key, flight);
        return flight;
    }
    async recordReviewerResultInternal(input: {
        workspaceId: string;
        sessionId: string;
        reviewerAgentId: string;
        token: string;
        result: unknown;
        finalize?: boolean;
    }, context: AgentContext): Promise<{
        ok: boolean;
        session: ReviewSession | null;
        accepted: boolean;
        error?: {
            code: string;
            message: string;
        };
    }> {
        const session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
        if (!session)
            throw new Error("review_session_not_found");
        const auth = this.deps.storage.readReviewState<ReviewAuth>(authKey(session.id));
        if (!this.deps.authorization.reviewerContextMatches(session, auth, { token: input.token, workspaceId: input.workspaceId, reviewerAgentId: input.reviewerAgentId }))
            throw new Error("reviewer_context_invalid");
        const canFinalizeStoppingCoordinator = input.finalize
            && session.status === "stopping"
            && session.roundTarget === "coordinator"
            && session.coordinator?.phase === "stopping";
        const canFinalizeTimedOutReviewer = input.finalize
            && session.status === "stopping"
            && session.lastError?.code === "reviewer_timeout"
            && (session.roundTarget === "independent" || canFinalizeStoppingCoordinator);
        if (session.status !== "reviewing" && !canFinalizeTimedOutReviewer)
            return { ok: true, session, accepted: false, error: { code: "review_not_active", message: "This Reviewer result arrived after the review stopped or completed" } };
        if (session.materials)
            this.deps.authorization.validateReportMaterials(session.workspaceId, session.materials.version);
        const parsed = reviewResultSchema.safeParse(input.result);
        if (!parsed.success)
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } };
        const result = parsed.data;
        if (!session.snapshot)
            throw new Error("review_snapshot_unavailable");
        const runtime = await this.deps.authorization.currentRuntime(session.workspaceId, context);
        const current = this.deps.storage.readSession(session.workspaceId, session.id);
        if (!current || current.revision !== session.revision) {
            if (current && current.status !== "reviewing")
                return { ok: true, session: current, accepted: false, error: { code: "review_not_active", message: "This Reviewer result arrived after the review stopped or completed" } };
            return { ok: false, session: current, accepted: false, error: { code: "review_state_conflict", message: "The review state changed while the result was being checked" } };
        }
        if (this.deps.authorization.runtimeIdentity(runtime) !== this.deps.authorization.runtimeIdentityFromSnapshot(session.snapshot)) {
            const expired = this.deps.storage.persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The Workspace changed before the Reviewer result was accepted" } }, { kind: "expired", summary: "Reviewer result is stale", details: {} });
            return { ok: false, session: expired, accepted: false, error: { code: "review_snapshot_stale", message: "The reviewed code changed" } };
        }
        if (result.snapshotId !== session.snapshotId || result.diffId !== session.diffId) {
            const expired = this.deps.storage.persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The reviewed code changed before the result was accepted" } }, { kind: "expired", summary: "Reviewer result is stale", details: { expectedSnapshotId: session.snapshotId, receivedSnapshotId: result.snapshotId, expectedDiffId: session.diffId, receivedDiffId: result.diffId } });
            return { ok: false, session: expired, accepted: false, error: { code: "review_snapshot_stale", message: "The reviewed code changed" } };
        }
        if (result.verdict === "changes_requested" && !result.findings.some((finding) => finding.needsFix))
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "changes_requested requires at least one finding that needs a fix" } };
        if (result.verdict === "approved" && result.findings.some((finding) => finding.needsFix))
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot contain a required finding" } };
        if (result.verdict === "approved" && result.unreviewed.length)
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot leave review material unreviewed" } };
        if (result.verdict === "approved" && result.checks.some((check) => check.status === "failed"))
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot contain a failed check" } };
        const acceptanceCriteria = this.deps.sessions.acceptanceCriteriaFor(session);
        const criterionIds = new Set(acceptanceCriteria.map((criterion) => criterion.id));
        if (result.criterionChecks.some((check) => !criterionIds.has(check.id)))
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "criterionChecks contains an unknown acceptance criterion" } };
        if (result.verdict === "approved") {
            const checked = new Map(result.criterionChecks.map((check) => [check.id, check.status]));
            const missing = acceptanceCriteria.filter((criterion) => criterion.required && checked.get(criterion.id) !== "passed").map((criterion) => criterion.id);
            if (missing.length)
                return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: `approved must pass every required acceptance criterion: ${missing.join(", ")}` } };
        }
        const repositoryIds = new Set(session.snapshot?.repositories.map((repository) => repository.id) || []);
        const reviewedFiles = new Set(session.snapshot?.files.map((file) => `${file.repositoryId}:${file.path}`) || []);
        if (result.findings.some((finding) => !repositoryIds.has(finding.repositoryId) || !this.deps.authorization.safeRelativePath(session.snapshot?.repositories.find((repository) => repository.id === finding.repositoryId)?.worktreePath || "", finding.path) || !reviewedFiles.has(`${finding.repositoryId}:${finding.path}`)))
            return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "finding points outside the reviewed snapshot" } };
        const resultKey = result.resultId || this.deps.storage.digest(result);
        if (session.latestResult && (session.latestResult.resultId || this.deps.storage.digest(session.latestResult)) === resultKey)
            return { ok: true, session, accepted: true };
        if (session.pendingReviewerResult) {
            const pendingKey = session.pendingReviewerResult.resultId || this.deps.storage.digest(session.pendingReviewerResult);
            if (pendingKey !== resultKey)
                return { ok: false, session, accepted: false, error: { code: "reviewer_result_conflict", message: "A different Reviewer result is already pending for this turn" } };
            if (!input.finalize)
                return { ok: true, session, accepted: true };
        }
        if (!input.finalize) {
            const candidate = this.deps.storage.persistSession({ ...session, pendingReviewerResult: result, lastError: null }, { kind: "review_candidate", summary: "Reviewer submitted a candidate result; waiting for turn completion", details: { verdict: result.verdict, resultId: result.resultId || resultKey, snapshotId: result.snapshotId, diffId: result.diffId } });
            return { ok: true, session: candidate, accepted: true };
        }
        let nextStatus: ReviewSession["status"] = result.verdict === "approved" ? "approved" : result.verdict === "blocked" ? "blocked" : session.round >= session.maxRounds ? "limit_reached" : "changes_requested";
        let next = this.deps.storage.persistSession({ ...session, status: nextStatus, pendingReviewerResult: null, latestResult: result, pendingOperation: null, stopAgentIds: [], lastError: null,
            coordinator: session.coordinator?.phase === "stopping" ? { ...session.coordinator, phase: "revoked" } : session.coordinator }, { kind: "review_result", summary: result.summary, details: { verdict: result.verdict, findings: result.findings, checks: result.checks, criterionChecks: result.criterionChecks, unreviewed: result.unreviewed, snapshotId: result.snapshotId, diffId: result.diffId, formal: true } });
        if (["approved", "blocked", "limit_reached"].includes(nextStatus)) {
            next = this.deps.storage.persistSession(next, {
                kind: "finished",
                summary: nextStatus === "approved" ? "Review approved for this code version" : nextStatus === "limit_reached" ? "Review stopped at the round limit" : "Review cannot continue automatically",
                details: { status: nextStatus, snapshotId: next.snapshotId, diffId: next.diffId },
            });
        }
        if (result.verdict === "changes_requested" && nextStatus === "changes_requested" && session.preferences.autoFix)
            next = await this.deps.dispatch.sendRepair(next, context);
        return { ok: true, session: next, accepted: true };
    }
    recordReviewerResult(input: {
        workspaceId: string;
        sessionId: string;
        reviewerAgentId: string;
        token: string;
        result: unknown;
        finalize?: boolean;
    }, context: AgentContext): Promise<{
        ok: boolean;
        session: ReviewSession | null;
        accepted: boolean;
        error?: {
            code: string;
            message: string;
        };
    }> {
        return withReviewTransitionLock(input.workspaceId, () => this.recordReviewerResultInternal(input, context));
    }
    async readReviewerSnapshot(input: {
        workspaceId: string;
        sessionId: string;
        reviewerAgentId: string;
        token: string;
    }, context: AgentContext): Promise<{
        ok: boolean;
        snapshot: ReviewSnapshot | null;
        error?: {
            code: string;
            message: string;
        };
    }> {
        const session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
        const auth = session ? this.deps.storage.readReviewState<ReviewAuth>(authKey(session.id)) : null;
        if (!session || !this.deps.authorization.reviewerContextMatches(session, auth, { token: input.token, workspaceId: input.workspaceId, reviewerAgentId: input.reviewerAgentId }))
            throw new Error("reviewer_context_invalid");
        if (!session.snapshot)
            throw new Error("review_snapshot_unavailable");
        const runtime = await this.deps.authorization.currentRuntime(session.workspaceId, context);
        if (this.deps.authorization.runtimeIdentity(runtime) !== this.deps.authorization.runtimeIdentityFromSnapshot(session.snapshot)) {
            const expired = this.deps.storage.persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The Workspace changed while the Reviewer was reading" } }, { kind: "expired", summary: "Review snapshot expired", details: {} });
            return { ok: false, snapshot: null, error: { code: expired.lastError!.code, message: expired.lastError!.message } };
        }
        return { ok: true, snapshot: session.snapshot };
    }
    async handleReviewTurnEnded(event: {
        agent: {
            id: string;
        };
        turnId: string | null;
        outcome: {
            kind: string;
        };
    }, context: AgentContext): Promise<void> {
        if (!event.turnId)
            return;
        // Reviewer results normally arrive through the dedicated MCP result tool.
        // A completed turn without that tool is handled by monitorReviewer and never
        // becomes an approval merely because it ended.
        await this.handleExecutionTurnEnded(event, context);
    }
    reviewStartFlights = new Map<string, Promise<ReviewSession>>();
}
