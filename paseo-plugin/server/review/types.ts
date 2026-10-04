import { type ReviewModelOverride, type ReviewPreferences } from "../../shared/agent-review.ts";
export type RuntimeRepository = {
    id: string;
    repoPath: string;
    worktreePath: string;
    branch: string | null;
    baseRef?: string | null;
    baseSha: string | null;
    head: string | null;
    indexDigest: string;
    worktreeDigest: string;
    statusDigest: string;
    dirtyPaths: string[];
};
export type ExecutionReportRpcInput = {
    projectConfig: string;
    workspaceId: string;
    executionAgentId: string;
    token: string;
    turnId?: string;
    report: ExecutionReportRecord["report"];
};
export type ReviewerReadRpcInput = {
    projectConfig: string;
    workspaceId: string;
    sessionId: string;
    reviewerAgentId: string;
    token: string;
};
export type ReviewerResultRpcInput = ReviewerReadRpcInput & {
    result: unknown;
};
export type Runtime = {
    workspaceId: string;
    managed: boolean;
    treePath: string | null;
    repositories: RuntimeRepository[];
    issues?: string[];
};
export type StoredGlobalSettings = {
    version: 1;
    defaults: Partial<ReviewPreferences>;
    projects: Record<string, ReviewModelOverride>;
    agentSession?: {
        defaults?: unknown;
        projects?: Record<string, unknown>;
    };
};
export type ExecutionReportRecord = {
    workspaceId: string;
    executionAgentId: string;
    turnId: string | null;
    report: {
        status: "ready_for_review" | "needs_input" | "failed";
        summary: string;
        changes: string[];
        tests: string[];
        knownLimitations: string[];
        handoffId?: string;
        materialsVersion?: number;
    };
    createdAt: string;
    consumedAt?: string;
};
export type ReviewAuth = {
    token: string;
    workspaceId: string;
    reviewerAgentId: string;
};
export type ReviewWorkspaceState = {
    sessionCount: number;
    activeSessionId: string | null;
};
