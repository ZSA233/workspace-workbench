import { join } from "node:path";
import { reviewSessionSchema, type ReviewPreferences, type ReviewSession } from "../../shared/agent-review.ts";
import type { Handoff } from "../../shared/handoff.ts";
import { reviewPacketSchema } from "../../shared/review-packet.ts";
import { withReviewTransitionLock } from "../review-state-transitions.ts";
import { authKey, reportKey, turnKey } from './identity.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { ReviewSettings } from './settings.ts';
import type { ReviewWorkspaceState } from './types.ts';
type Dependencies = {
    settings: Pick<ReviewSettings, "preferenceLayers">;
    storage: Pick<ReviewInfrastructure["storage"], "getAgentBinding" | "readSession" | "persistSession" | "removeReviewState" | "sessionIndex" | "readReviewState" | "sessionKey" | "indexKey" | "forgetReviewWorkspace" | "digest">;
    projects: Pick<ReviewInfrastructure["projects"], "currentProject">;
    files: Pick<ReviewInfrastructure["files"], "readdirSync" | "readFileSync">;
    identity: Pick<ReviewInfrastructure["identity"], "randomUUID">;
    clock: Pick<ReviewInfrastructure["clock"], "now">;
};
export class ReviewSessions {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    handoffSnapshot(handoff: Handoff): NonNullable<ReviewSession["handoff"]> {
        const packet = handoff.reviewPacket || reviewPacketSchema.parse({});
        return {
            goal: handoff.goal,
            decisions: [...handoff.decisions],
            inScope: [...handoff.inScope],
            outOfScope: [...handoff.outOfScope],
            steps: [...handoff.steps],
            acceptance: [...handoff.acceptance],
            constraints: [...handoff.constraints],
            ambiguities: [...handoff.ambiguities],
            reviewPacket: {
                requirementUnderstanding: packet.requirementUnderstanding,
                plan: [...packet.plan],
                acceptanceCriteria: packet.acceptanceCriteria.map((criterion) => ({ ...criterion })),
                references: packet.references.map((reference) => ({ ...reference })),
                instructions: packet.instructions,
            },
            startMode: handoff.startMode,
            ...(handoff.handoffId ? { handoffId: handoff.handoffId } : {}),
            ...(handoff.relationship ? { relationship: handoff.relationship } : {}),
            ...(handoff.reviewLocale ? { reviewLocale: handoff.reviewLocale } : {}),
            expected: {
                branchByRepository: { ...handoff.expected.branchByRepository },
                baseByRepository: { ...handoff.expected.baseByRepository },
                ...(handoff.expected.dirty === undefined ? {} : { dirty: handoff.expected.dirty }),
            },
        };
    }
    boundHandoff(workspaceId: string): ReviewSession["handoff"] {
        const handoff = this.deps.storage.getAgentBinding(workspaceId)?.handoff;
        if (!handoff)
            return null;
        return this.handoffSnapshot(handoff);
    }
    async prepareSessionSupplement(workspaceId: string): Promise<void> {
        await withReviewTransitionLock(workspaceId, async () => {
            const session = this.deps.storage.readSession(workspaceId);
            if (!session)
                return;
            if (["reviewing", "stopping"].includes(session.status) || session.status === "queued" && session.coordinator?.phase !== "waiting")
                throw new Error("stop_review_before_supplement");
            this.deps.storage.persistSession({ ...session, status: "waiting_execution", snapshot: null, snapshotId: null, diffId: null,
                pendingReviewerResult: null, latestResult: null, pendingOperation: null, coordinator: null }, { kind: "resumed", summary: "Supplement received; waiting for a new execution report", details: {} });
            // A report submitted before the supplement must not start review at turn end
            // or prevent the worker from submitting its updated report in the same turn.
            if (session.executionAgentId)
                this.deps.storage.removeReviewState(reportKey(session.executionAgentId));
        });
    }
    reviewSessionIdsForWorkspace(workspaceId: string): Set<string> {
        const ids = new Set<string>();
        const index = this.deps.storage.sessionIndex(workspaceId);
        for (const id of index.sessionIds)
            if (typeof id === "string" && id)
                ids.add(id);
        const project = this.deps.projects.currentProject();
        if (!project)
            return ids;
        try {
            for (const entry of this.deps.files.readdirSync(join(project.stateRoot, "reviews"), { withFileTypes: true })) {
                if (!entry.isFile() || !entry.name.endsWith(".json"))
                    continue;
                try {
                    const parsed = reviewSessionSchema.safeParse(JSON.parse(this.deps.files.readFileSync(join(project.stateRoot, "reviews", entry.name), "utf8")));
                    if (parsed.success && parsed.data.workspaceId === workspaceId)
                        ids.add(parsed.data.id);
                }
                catch {
                    // Ignore unrelated or partially written review records.
                }
            }
        }
        catch {
            // The state directory may not exist for a workspace without Review history.
        }
        return ids;
    }
    getReviewWorkspaceState(workspaceId: string): ReviewWorkspaceState {
        const index = this.deps.storage.sessionIndex(workspaceId);
        const ids = this.reviewSessionIdsForWorkspace(workspaceId);
        return {
            sessionCount: ids.size,
            activeSessionId: typeof index.activeSessionId === "string" && ids.has(index.activeSessionId) ? index.activeSessionId : null,
        };
    }
    clearReviewWorkspaceState(workspaceId: string): {
        sessionsRemoved: number;
        indexRemoved: boolean;
        authRecordsRemoved: number;
        runtimeRecordsRemoved: number;
    } {
        const ids = this.reviewSessionIdsForWorkspace(workspaceId);
        let sessionsRemoved = 0;
        let authRecordsRemoved = 0;
        let runtimeRecordsRemoved = 0;
        for (const id of ids) {
            let session: ReviewSession | null = null;
            try {
                const parsed = reviewSessionSchema.safeParse(this.deps.storage.readReviewState<unknown>(this.deps.storage.sessionKey(workspaceId, id)));
                if (parsed.success)
                    session = parsed.data;
            }
            catch { /* cleanup remains best effort for malformed records */ }
            if (session?.executionAgentId) {
                if (this.deps.storage.removeReviewState(reportKey(session.executionAgentId)))
                    runtimeRecordsRemoved += 1;
                if (session.executionTurnId && this.deps.storage.removeReviewState(turnKey(session.executionAgentId, session.executionTurnId)))
                    runtimeRecordsRemoved += 1;
            }
            if (session?.reviewerAgentId && session.reviewerTurnId && this.deps.storage.removeReviewState(turnKey(session.reviewerAgentId, session.reviewerTurnId)))
                runtimeRecordsRemoved += 1;
            if (this.deps.storage.removeReviewState(this.deps.storage.sessionKey(workspaceId, id)))
                sessionsRemoved += 1;
            if (this.deps.storage.removeReviewState(authKey(id)))
                authRecordsRemoved += 1;
        }
        const indexRemoved = this.deps.storage.removeReviewState(this.deps.storage.indexKey(workspaceId));
        this.deps.storage.forgetReviewWorkspace(workspaceId);
        return { sessionsRemoved, indexRemoved, authRecordsRemoved, runtimeRecordsRemoved };
    }
    newSession(input: {
        workspaceId: string;
        projectConfig: string;
        executionAgentId: string | null;
        preferences: ReviewPreferences;
        status?: ReviewSession["status"];
        handoff?: ReviewSession["handoff"];
    }): ReviewSession {
        const handoff = input.handoff === undefined ? this.boundHandoff(input.workspaceId) : input.handoff;
        return reviewSessionSchema.parse({
            version: 2,
            materials: this.deps.storage.getAgentBinding(input.workspaceId)?.handoffBundle,
            roundTarget: input.preferences.reviewerTarget,
            id: this.deps.identity.randomUUID(),
            revision: 0,
            workspaceId: input.workspaceId,
            projectConfig: input.projectConfig,
            paseoWorkspaceId: null,
            handoffHash: handoff ? this.deps.storage.digest(handoff) : null,
            handoff,
            executionAgentId: input.executionAgentId,
            executionModelId: null,
            executionTurnId: null,
            reviewerAgentId: null,
            reviewerModelId: null,
            reviewerTurnId: null,
            status: input.status || "waiting_execution",
            round: 0,
            maxRounds: input.preferences.maxRounds,
            snapshotId: null,
            diffId: null,
            snapshot: null,
            preferences: input.preferences,
            events: [],
            pendingReviewerResult: null,
            latestResult: null,
            stopAgentIds: [],
            pendingOperation: null,
            lastError: null,
            updatedAt: this.deps.clock.now(),
        });
    }
    recordExecutionHandoff(input: {
        workspaceId: string;
        projectConfig: string;
        executionAgentId: string;
        handoff: Handoff;
    }): ReviewSession {
        const handoff = this.handoffSnapshot(input.handoff);
        const existing = this.deps.storage.readSession(input.workspaceId);
        const sameTask = existing
            && existing.executionAgentId === input.executionAgentId
            && this.deps.storage.digest(existing.handoff) === this.deps.storage.digest(handoff);
        if (sameTask)
            return existing;
        if (existing && existing.preferences.mode !== "off" && this.activeReviewStatuses.includes(existing.status as (typeof this.activeReviewStatuses)[number])) {
            throw new Error("review_active_different_task");
        }
        const session = this.newSession({
            workspaceId: input.workspaceId,
            projectConfig: input.projectConfig,
            executionAgentId: input.executionAgentId,
            preferences: {
                ...this.deps.settings.preferenceLayers().effective,
                ...(handoff.reviewLocale ? { locale: handoff.reviewLocale } : {}),
            },
            status: "waiting_execution",
            handoff,
        });
        return this.deps.storage.persistSession({ ...session, handoffHash: this.deps.storage.digest(input.handoff) }, {
            kind: "started",
            summary: "Execution handoff recorded",
            details: { executionAgentId: input.executionAgentId, goal: input.handoff?.goal || "", handoffId: input.handoff?.handoffId || null },
        });
    }
    acceptanceCriteriaFor(session: ReviewSession): Array<{
        id: string;
        text: string;
        required: boolean;
    }> {
        const packetCriteria = session.handoff?.reviewPacket.acceptanceCriteria || [];
        if (packetCriteria.length)
            return packetCriteria;
        return (session.handoff?.acceptance || []).map((text, index) => ({ id: `AC-${index + 1}`, text, required: true }));
    }
    activeReviewStatuses = ["waiting_execution", "ready_for_review", "queued", "reviewing", "changes_requested", "fixing", "stopping"] as const;
}
