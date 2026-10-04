import { executionReport, reviewerRead, reviewerResult, reviewModels, reviewPreview, reviewSessionControl, reviewSessionEvents, reviewSessionList, reviewSessionQuery, reviewSessionStart, reviewSettingsGet, reviewSettingsUpdate, type ReviewLocale, type ReviewModelOverride, type ReviewPreferencePatch, type ReviewSession } from "../../shared/agent-review.ts";
import type { AgentContext } from "../agent-provider.ts";
import { availableCodexModels } from "../review-host.ts";
import { withReviewTransitionLock } from "../review-state-transitions.ts";
import { withWorkspaceScope } from "../workspace-scope.ts";
import type { ReviewAuthorization } from './authorization.ts';
import type { ReviewDispatch } from './dispatch.ts';
import { authKey, errorInfo } from './identity.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { ReviewRecovery } from './recovery.ts';
import type { ReviewSettings } from './settings.ts';
import type { ReviewTransitions } from './transitions.ts';
import type { ExecutionReportRpcInput, ReviewerReadRpcInput, ReviewerResultRpcInput } from './types.ts';
type Dependencies = {
    recovery: Pick<ReviewRecovery, "coordinatorContext">;
    settings: Pick<ReviewSettings, "preferenceLayers" | "updateReviewSettings">;
    authorization: Pick<ReviewAuthorization, "authorizeReviewCaller" | "currentRuntime" | "runtimeAgentCwdMatches">;
    dispatch: Pick<ReviewDispatch, "recoverReviewerMonitor" | "startReviewer" | "stopReview" | "sendRepair">;
    transitions: Pick<ReviewTransitions, "startReview" | "acceptExecutionReport" | "readReviewerSnapshot" | "recordReviewerResult">;
    storage: Pick<ReviewInfrastructure["storage"], "readSession" | "sessionIndex" | "removeReviewState" | "persistSession">;
    backend: Pick<ReviewInfrastructure["backend"], "queryObserver">;
    projects: Pick<ReviewInfrastructure["projects"], "currentProject">;
};
export class ReviewRequests {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async handleReviewSessionQuery(input: {
        projectConfig: string;
        workspaceId: string;
        sessionId?: string;
        token?: string;
    }, context?: AgentContext): Promise<ReturnType<typeof reviewSessionQuery.output.parse>> {
        if (context)
            this.deps.recovery.coordinatorContext = context;
        const layers = this.deps.settings.preferenceLayers();
        if (context)
            await this.deps.authorization.authorizeReviewCaller(input.token, context);
        const session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
        if (session && context)
            void this.deps.dispatch.recoverReviewerMonitor(session, context);
        // A running flow is immutable with respect to its settings. Return its
        // snapshot here so reconnecting clients do not show current preferences as
        // if they had governed an already-started review.
        return { ok: true, session, preferences: session?.preferences || layers.effective, sources: layers.sources };
    }
    async handleReviewSessionList(input: {
        projectConfig: string;
        workspaceId: string;
    }): Promise<ReturnType<typeof reviewSessionList.output.parse>> {
        const index = this.deps.storage.sessionIndex(input.workspaceId);
        const sessions = index.sessionIds.map((id) => this.deps.storage.readSession(input.workspaceId, id)).filter((session): session is ReviewSession => Boolean(session)).map((session) => ({ ...session, snapshot: null }));
        return { ok: true, sessions, activeSessionId: index.activeSessionId };
    }
    async handleReviewSessionEvents(input: {
        projectConfig: string;
        workspaceId: string;
        sessionId: string;
        after: number;
        limit: number;
    }): Promise<ReturnType<typeof reviewSessionEvents.output.parse>> {
        const session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
        if (!session)
            return { ok: false, events: [], next: null, error: { code: "review_session_not_found", message: "Review session not found" } };
        const events = session.events.filter((event) => event.sequence > input.after).slice(0, input.limit);
        return { ok: true, events, next: events.length ? events[events.length - 1].sequence : null };
    }
    async handleReviewSettingsGet(input: {
        projectConfig: string;
    }): Promise<ReturnType<typeof reviewSettingsGet.output.parse>> {
        const layers = this.deps.settings.preferenceLayers();
        return { ok: true, effective: layers.effective, project: layers.project, global: layers.global, models: layers.models, sources: layers.sources };
    }
    async handleReviewSettingsUpdate(input: {
        projectConfig: string;
        scope: "project" | "global" | "project-model";
        patch: ReviewPreferencePatch | ReviewModelOverride;
        resetFields: string[];
    }): Promise<ReturnType<typeof reviewSettingsUpdate.output.parse>> {
        this.deps.settings.updateReviewSettings(input.scope, input.patch, input.resetFields);
        return this.handleReviewSettingsGet(input);
    }
    async handleReviewModels(input: {
        projectConfig: string;
        workspaceId?: string;
    }, context: AgentContext): Promise<ReturnType<typeof reviewModels.output.parse>> {
        try {
            // Model discovery needs a validated working directory, not a content digest.
            const metadata = input.workspaceId ? await (context.query || this.deps.backend.queryObserver)({ method: "workspace.detail", params: { workspaceId: input.workspaceId, mode: "roster" } }) : null;
            if (metadata && !metadata.ok)
                throw new Error(metadata.error?.code || "workspace_metadata_unavailable");
            const workspace = (metadata?.result as {
                workspace?: {
                    id?: string;
                    treePath?: string;
                };
            } | undefined)?.workspace;
            if (input.workspaceId && workspace?.id !== input.workspaceId)
                throw new Error("workspace_metadata_identity_changed");
            const cwd = workspace?.treePath || this.deps.projects.currentProject()?.sourceRoot;
            if (!cwd)
                throw new Error("reviewer_workspace_unavailable");
            return { ok: true, provider: "codex", models: await availableCodexModels(context, cwd) };
        }
        catch (error) {
            return { ok: false, provider: "codex", models: [], error: errorInfo(error, "Codex models are unavailable") };
        }
    }
    async handleReviewPreview(input: {
        projectConfig: string;
        workspaceId: string;
        token?: string;
    }, context: AgentContext): Promise<ReturnType<typeof reviewPreview.output.parse>> {
        const preferences = this.deps.settings.preferenceLayers().effective;
        try {
            await this.deps.authorization.authorizeReviewCaller(input.token, context);
            const runtime = await this.deps.authorization.currentRuntime(input.workspaceId, context);
            return {
                ok: true,
                session: this.deps.storage.readSession(input.workspaceId),
                workspace: {
                    workspaceId: runtime.workspaceId,
                    treePath: runtime.treePath!,
                    repositories: runtime.repositories.map((repo) => ({ id: repo.id, worktreePath: repo.worktreePath, branch: repo.branch, baseSha: repo.baseSha, head: repo.head, dirtyPaths: repo.dirtyPaths })),
                },
                preferences,
            };
        }
        catch (error) {
            return { ok: false, session: this.deps.storage.readSession(input.workspaceId), workspace: null, preferences, error: errorInfo(error, "Review preview is unavailable") };
        }
    }
    async handleReviewSessionStart(input: {
        projectConfig: string;
        workspaceId: string;
        executionAgentId?: string;
        locale?: ReviewLocale;
        instructions?: string;
        token?: string;
    }, context: AgentContext): Promise<ReturnType<typeof reviewSessionStart.output.parse>> {
        return withWorkspaceScope(input.workspaceId, async () => {
            try {
                await this.deps.authorization.authorizeReviewCaller(input.token, context);
                return { ok: true, session: await this.deps.transitions.startReview(input, context) };
            }
            catch (error) {
                return { ok: false, session: this.deps.storage.readSession(input.workspaceId), error: errorInfo(error, "Review could not start") };
            }
        });
    }
    async handleReviewSessionControl(input: {
        projectConfig: string;
        workspaceId: string;
        sessionId?: string;
        action: "stop" | "resume" | "review" | "repair" | "independent";
        token?: string;
    }, context: AgentContext): Promise<ReturnType<typeof reviewSessionControl.output.parse>> {
        await this.deps.authorization.authorizeReviewCaller(input.token, context);
        return withReviewTransitionLock(input.workspaceId, async () => {
            const session = this.deps.storage.readSession(input.workspaceId, input.sessionId);
            if (!session)
                throw new Error("review_session_not_found");
            if (input.action === "review" && !["ready_for_review", "queued", "reviewing"].includes(session.status)) {
                return { ok: false, session, error: errorInfo(new Error(session.status === "waiting_execution" ? "execution_not_ready" : "review_not_ready")) };
            }
            if (input.action === "repair" && session.status !== "changes_requested") {
                return { ok: false, session, error: errorInfo(new Error("review_not_waiting_for_repair")) };
            }
            if (input.action === "repair" && !session.executionAgentId) {
                return { ok: false, session, error: { code: "main_workspace_review_read_only", message: "Main workspace reviews are read-only; apply fixes in a separate development turn" } };
            }
            if (input.action === "independent" && !(session.status === "queued" && session.coordinator?.phase === "waiting") && session.status !== "stopped" && session.status !== "ready_for_review") {
                return { ok: false, session, error: { code: "stop_review_before_switch", message: "Stop or resolve the current review before switching reviewer" } };
            }
            try {
                if (input.action === "independent") {
                    if (!(session.status === "queued" && session.coordinator?.phase === "waiting") && session.status !== "stopped" && session.status !== "ready_for_review")
                        throw new Error("stop_review_before_switch");
                    this.deps.storage.removeReviewState(authKey(session.id));
                    const next = this.deps.storage.persistSession({ ...session, roundTarget: "independent", coordinator: null, status: "queued", reviewerAgentId: null, reviewerTurnId: null, pendingReviewerResult: null }, { kind: "review_queued", summary: "Independent reviewer selected for this round", details: {} });
                    return { ok: true, session: await this.deps.dispatch.startReviewer(next, context) };
                }
                if (input.action === "stop")
                    return { ok: true, session: await this.deps.dispatch.stopReview(session, context) };
                if (input.action === "repair")
                    return { ok: true, session: await this.deps.dispatch.sendRepair(session, context) };
                if (input.action === "review")
                    return { ok: true, session: await this.deps.dispatch.startReviewer(session, context) };
                if (session.status === "stopped" || session.status === "failed" || session.status === "blocked") {
                    // Execution can stop before a review snapshot exists. Resume the report
                    // gate, not the Reviewer; never redeliver the execution handoff here.
                    if (!session.snapshot) {
                        const runtime = await this.deps.authorization.currentRuntime(session.workspaceId, context);
                        const execution = session.executionAgentId ? await context.paseo.agents.ref(session.executionAgentId).refresh() : null;
                        if (!execution?.agent || execution.agent.archivedAt || !this.deps.authorization.runtimeAgentCwdMatches(runtime, execution.agent.cwd))
                            throw new Error("execution_agent_identity_changed");
                        const resumed = this.deps.storage.persistSession({ ...session, status: "waiting_execution", lastError: null }, { kind: "resumed", summary: "Waiting for a new execution report; no task was resent", details: { phase: "waiting_execution" } });
                        return { ok: true, session: resumed };
                    }
                    if (session.roundTarget === "coordinator")
                        this.deps.storage.removeReviewState(authKey(session.id));
                    const resumed = this.deps.storage.persistSession({ ...session, status: "queued", lastError: null,
                        ...(session.roundTarget === "coordinator" ? { coordinator: null, reviewerAgentId: null, reviewerTurnId: null, pendingReviewerResult: null } : {}),
                    }, { kind: "resumed", summary: "Review resumed", details: {} });
                    return { ok: true, session: await this.deps.dispatch.startReviewer(resumed, context) };
                }
                return { ok: true, session };
            }
            catch (error) {
                const current = this.deps.storage.readSession(input.workspaceId, session.id) || session;
                if (["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(current.status))
                    return { ok: false, session: current, error: errorInfo(error, "Review action failed") };
                const failed = this.deps.storage.persistSession({ ...current, status: "failed", lastError: errorInfo(error, "Review action failed") }, { kind: "failed", summary: "Review action failed", details: errorInfo(error) });
                return { ok: false, session: failed, error: errorInfo(error) };
            }
        });
    }
    async handleExecutionReportRpc(input: ExecutionReportRpcInput, context: AgentContext): Promise<ReturnType<typeof executionReport.output.parse>> {
        try {
            return await this.deps.transitions.acceptExecutionReport(input, context);
        }
        catch (error) {
            return { ok: false, session: this.deps.storage.readSession(input.workspaceId), accepted: false, error: errorInfo(error, "Execution report rejected") };
        }
    }
    async handleReviewerReadRpc(input: ReviewerReadRpcInput, context: AgentContext): Promise<ReturnType<typeof reviewerRead.output.parse>> {
        try {
            return await this.deps.transitions.readReviewerSnapshot(input, context);
        }
        catch (error) {
            return { ok: false, snapshot: null, error: errorInfo(error, "Reviewer snapshot is unavailable") };
        }
    }
    async handleReviewerResultRpc(input: ReviewerResultRpcInput, context: AgentContext): Promise<ReturnType<typeof reviewerResult.output.parse>> {
        try {
            return await this.deps.transitions.recordReviewerResult(input, context);
        }
        catch (error) {
            return { ok: false, session: this.deps.storage.readSession(input.workspaceId, input.sessionId), accepted: false, error: errorInfo(error, "Reviewer result rejected") };
        }
    }
}
