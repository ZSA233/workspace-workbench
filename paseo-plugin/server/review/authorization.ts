import { join, relative, resolve } from "node:path";
import { type ReviewSession, type ReviewSnapshot } from "../../shared/agent-review.ts";
import { liveAgentIdentity } from "../agent-identity.ts";
import type { AgentContext } from "../agent-provider.ts";
import { assertBundleReady } from "../handoff-bundles.ts";
import { authKey } from './identity.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { ReviewAuth, Runtime, RuntimeRepository } from './types.ts';
type Dependencies = {
    files: Pick<ReviewInfrastructure["files"], "realpathSync" | "lstatSync">;
    backend: Pick<ReviewInfrastructure["backend"], "queryObserver">;
    projects: Pick<ReviewInfrastructure["projects"], "currentProject">;
    storage: Pick<ReviewInfrastructure["storage"], "getAgentBinding" | "digest" | "readState" | "readReviewState">;
};
export class ReviewAuthorization {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    currentRuntimeFromResponse(value: unknown): Runtime {
        if (!value || typeof value !== "object")
            throw new Error("workspace_runtime_invalid");
        const candidate = value as Record<string, unknown>;
        if (typeof candidate.managed !== "boolean" || typeof candidate.treePath !== "string" || !Array.isArray(candidate.repositories))
            throw new Error("workspace_runtime_invalid");
        const repositories: RuntimeRepository[] = [];
        for (const raw of candidate.repositories) {
            if (!raw || typeof raw !== "object")
                throw new Error("workspace_runtime_invalid");
            const item = raw as Record<string, unknown>;
            const required = ["id", "repoPath", "worktreePath", "indexDigest", "worktreeDigest", "statusDigest"];
            if (required.some((key) => typeof item[key] !== "string"))
                throw new Error("workspace_runtime_identity_incomplete");
            repositories.push({
                id: String(item.id), repoPath: String(item.repoPath), worktreePath: this.canonicalPath(String(item.worktreePath)),
                branch: typeof item.branch === "string" ? item.branch : null,
                baseRef: typeof item.baseRef === "string" ? item.baseRef : null,
                baseSha: typeof item.baseSha === "string" ? item.baseSha : null,
                head: typeof item.head === "string" ? item.head : null,
                indexDigest: String(item.indexDigest), worktreeDigest: String(item.worktreeDigest),
                statusDigest: String(item.statusDigest), dirtyPaths: Array.isArray(item.dirtyPaths) ? item.dirtyPaths.filter((path): path is string => typeof path === "string") : [],
            });
        }
        const workspaceId = String(candidate.workspaceId || "");
        if (!workspaceId)
            throw new Error("workspace_runtime_identity_incomplete");
        const issues = Array.isArray(candidate.issues) ? candidate.issues.map(item => {
            const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
            return `${String(value.repositoryId || "repository")}: ${String(value.code || value.message || "unavailable")}`;
        }) : [];
        return { workspaceId, managed: candidate.managed, treePath: this.canonicalPath(String(candidate.treePath)), repositories, ...(issues.length ? { issues } : {}) };
    }
    canonicalPath(value: string): string {
        try {
            return this.deps.files.realpathSync(value);
        }
        catch {
            return resolve(value);
        }
    }
    samePath(left: string | null | undefined, right: string | null | undefined): boolean {
        return Boolean(left && right) && this.canonicalPath(left!) === this.canonicalPath(right!);
    }
    runtimeAgentCwdMatches(runtime: Runtime, cwd: string | null | undefined): boolean {
        if (!cwd)
            return false;
        return [runtime.treePath, ...runtime.repositories.map((repository) => repository.worktreePath)]
            .some((candidate) => this.samePath(cwd, candidate));
    }
    pathWithin(root: string, child: string): boolean {
        const base = this.canonicalPath(root);
        const target = this.canonicalPath(child);
        const relativePath = relative(base, target);
        return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
    }
    reviewerContextMatches(session: ReviewSession, auth: ReviewAuth | null, input: {
        token: string;
        workspaceId: string;
        reviewerAgentId: string;
    }): boolean {
        if (!auth || auth.token !== input.token || auth.workspaceId !== input.workspaceId)
            return false;
        if (input.reviewerAgentId === "pending") {
            // The MCP process starts with a pending id because the host assigns the
            // real Agent id during create. Once the id is known, the same token may
            // continue to use the pending environment value.
            return auth.reviewerAgentId === session.reviewerAgentId
                || (auth.reviewerAgentId === "pending" && session.reviewerAgentId === null);
        }
        return auth.reviewerAgentId === input.reviewerAgentId && session.reviewerAgentId === input.reviewerAgentId;
    }
    async currentRuntime(workspaceId: string, context: AgentContext): Promise<Runtime> {
        const response = await (context.query || this.deps.backend.queryObserver)({ method: "workspace.reviewRuntime", params: { workspaceId } });
        if (!response.ok)
            throw new Error(response.error?.code || "workspace_runtime_unavailable");
        const runtime = this.currentRuntimeFromResponse(response.result);
        if (runtime.workspaceId !== workspaceId)
            throw new Error("workspace_runtime_identity_changed");
        return runtime;
    }
    async authorizeReviewCaller(token: string | undefined, context: AgentContext): Promise<void> {
        if (!token)
            return;
        const project = this.deps.projects.currentProject();
        if (!project)
            throw new Error("project_context_required");
        const identity = await liveAgentIdentity(token, context.paseo);
        if (!identity)
            throw new Error("review_caller_context_invalid");
        const callerCwd = identity.cwd;
        if (!callerCwd || ![project.sourceRoot, project.workspaceRoot].some((root) => this.pathWithin(root, callerCwd)))
            throw new Error("review_caller_project_mismatch");
    }
    runtimeIdentity(runtime: Runtime): string {
        return this.deps.storage.digest({
            workspaceId: runtime.workspaceId,
            treePath: runtime.treePath,
            repositories: runtime.repositories.map((repo) => ({
                id: repo.id, repoPath: repo.repoPath, worktreePath: repo.worktreePath, branch: repo.branch,
                baseRef: repo.baseRef, baseSha: repo.baseSha, head: repo.head, indexDigest: repo.indexDigest,
                worktreeDigest: repo.worktreeDigest, statusDigest: repo.statusDigest, dirtyPaths: [...repo.dirtyPaths].sort(),
            })).sort((left, right) => left.id.localeCompare(right.id)),
        });
    }
    runtimeIdentityFromSnapshot(snapshot: ReviewSnapshot): string {
        return this.deps.storage.digest({
            workspaceId: snapshot.workspaceId,
            treePath: snapshot.treePath,
            repositories: snapshot.repositories.map((repo) => ({ ...repo, baseRef: repo.baseRef || null })).sort((a, b) => a.id.localeCompare(b.id)),
        });
    }
    validateExecutionToken(input: {
        token: string;
        executionAgentId: string;
        workspaceId: string;
    }): string {
        const identity = this.deps.storage.readState<{
            agentId?: string;
            cwd?: string;
            revoked?: boolean;
            workspaceId?: string;
        }>(`context:${input.token}`);
        if (!identity || identity.revoked || (identity.agentId && identity.agentId !== input.executionAgentId && input.executionAgentId !== "pending") || (identity.workspaceId && identity.workspaceId !== input.workspaceId))
            throw new Error("execution_context_invalid");
        const agentId = identity.agentId && identity.agentId !== "pending" ? identity.agentId : input.executionAgentId;
        if (!agentId || agentId === "pending")
            throw new Error("execution_context_unbound");
        return agentId;
    }
    validateReportMaterials(workspaceId: string, version?: number) {
        const binding = this.deps.storage.getAgentBinding(workspaceId);
        if (!binding?.handoffBundle)
            return;
        if (binding.pendingHandoffBundle)
            throw new Error("handoff_supplement_delivery_pending");
        if (version !== binding.handoffBundle.version)
            throw new Error(`handoff_materials_version_required:${binding.handoffBundle.version}`);
        assertBundleReady(binding.handoffBundle);
    }
    safeRelativePath(root: string, value: string): string | null {
        if (!value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0"))
            return null;
        const normalizedValue = value.replaceAll("\\", "/");
        if (normalizedValue.split("/").includes(".."))
            return null;
        const target = resolve(root, normalizedValue);
        const rel = relative(resolve(root), target);
        if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith(".git/") || rel === ".git")
            return null;
        return rel.split("\\").join("/");
    }
    pathHasSymlink(root: string, value: string): boolean {
        let current = resolve(root);
        for (const segment of value.split("/")) {
            if (!segment || segment === ".")
                continue;
            current = join(current, segment);
            try {
                if (this.deps.files.lstatSync(current).isSymbolicLink())
                    return true;
            }
            catch {
                // The final path may have been deleted between status and capture. The
                // caller will report that as unreadable rather than following anything.
                return false;
            }
        }
        return false;
    }
    reviewAuthToken(sessionId: string): string | null {
        return this.deps.storage.readReviewState<ReviewAuth>(authKey(sessionId))?.token || null;
    }
}
