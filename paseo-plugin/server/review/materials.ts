import { resolve } from "node:path";
import { reviewSnapshotSchema, type ReviewSnapshot, type ReviewSnapshotArtifact } from "../../shared/agent-review.ts";
import { type ReviewArtifactReference } from "../../shared/review-packet.ts";
import type { AgentContext } from "../agent-provider.ts";
import { artifactSnapshotContent, materializeReviewArtifact, resolveArtifactReference } from "../artifacts.ts";
import type { ReviewAuthorization } from './authorization.ts';
import type { ReviewInfrastructure } from './infrastructure.ts';
import type { Runtime } from './types.ts';
type Dependencies = {
    authorization: Pick<ReviewAuthorization, "safeRelativePath" | "pathHasSymlink" | "currentRuntime" | "runtimeIdentity">;
    git: Pick<ReviewInfrastructure["git"], "exec">;
    files: Pick<ReviewInfrastructure["files"], "lstatSync" | "readFileSync">;
    storage: Pick<ReviewInfrastructure["storage"], "getAgentBinding" | "readState" | "digest">;
    clock: Pick<ReviewInfrastructure["clock"], "now">;
};
export class ReviewMaterials {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async gitOutput(root: string, args: string[], maxBuffer = 768 * 1024): Promise<string | null> {
        try {
            const safeArgs = args[0] === "diff" && !args.includes("--no-ext-diff") ? ["diff", "--no-ext-diff", ...args.slice(1)] : args;
            const result = await this.deps.git.exec("git", ["-c", "core.fsmonitor=false", "-C", root, ...safeArgs], { timeout: 10000, maxBuffer, encoding: "utf8" }) as {
                stdout?: string;
            };
            return String(result.stdout || "");
        }
        catch {
            return null;
        }
    }
    diffNames(value: string): Array<{
        status: string;
        path: string;
        oldPath?: string;
    }> {
        const parts = value.split("\0");
        const result: Array<{
            status: string;
            path: string;
            oldPath?: string;
        }> = [];
        for (let index = 0; index < parts.length; index += 1) {
            const item = parts[index];
            if (!item)
                continue;
            const tab = item.indexOf("\t");
            const status = (tab >= 0 ? item.slice(0, tab) : item).trim();
            let path = tab >= 0 ? item.slice(tab + 1) : parts[++index] || "";
            let oldPath: string | undefined;
            if (/^[RC]/.test(status)) {
                oldPath = path;
                path = parts[++index] || "";
            }
            if (path)
                result.push({ status: status.slice(0, 1) || "M", path, ...(oldPath ? { oldPath } : {}) });
        }
        return result;
    }
    workingNames(value: string): Array<{
        status: string;
        path: string;
        oldPath?: string;
    }> {
        const parts = value.split("\0");
        const result: Array<{
            status: string;
            path: string;
            oldPath?: string;
        }> = [];
        for (let index = 0; index < parts.length; index += 1) {
            const item = parts[index];
            if (!item)
                continue;
            const status = item.slice(0, 2).trim() || "M";
            let path = item.slice(3);
            let oldPath: string | undefined;
            if ((status[0] === "R" || status[0] === "C") && parts[index + 1]) {
                oldPath = path;
                path = parts[++index];
            }
            if (path)
                result.push({ status, path, ...(oldPath ? { oldPath } : {}) });
        }
        return result;
    }
    async fileMaterial(root: string, path: string): Promise<{
        content?: string;
        binary: boolean;
        truncated: boolean;
        issue?: string;
    }> {
        const safe = this.deps.authorization.safeRelativePath(root, path);
        if (!safe)
            return { binary: false, truncated: false, issue: "path_outside_worktree" };
        if (this.deps.authorization.pathHasSymlink(root, safe))
            return { binary: false, truncated: false, issue: "symlink_not_followed" };
        const absolute = resolve(root, safe);
        try {
            const stat = this.deps.files.lstatSync(absolute);
            if (stat.isSymbolicLink())
                return { binary: false, truncated: false, issue: "symlink_not_followed" };
            if (!stat.isFile())
                return { binary: false, truncated: false, issue: "non_regular_file" };
            if (stat.size > 512 * 1024)
                return { binary: false, truncated: true, issue: "file_too_large" };
            const data = this.deps.files.readFileSync(absolute);
            const binary = data.includes(0);
            if (binary)
                return { binary: true, truncated: false };
            return { content: data.toString("utf8"), binary: false, truncated: false };
        }
        catch {
            return { binary: false, truncated: false, issue: "file_unreadable" };
        }
    }
    missingSnapshotArtifact(reference: ReviewArtifactReference, status: "missing" | "unsupported", source: "workspace" | "conversation" = reference.assetId ? "conversation" : "workspace"): ReviewSnapshotArtifact {
        return {
            id: reference.id,
            kind: reference.kind,
            title: reference.title || reference.path || reference.assetId || reference.id,
            ...(reference.purpose ? { purpose: reference.purpose } : {}),
            required: reference.required,
            source,
            ...(reference.repositoryId ? { repositoryId: reference.repositoryId } : {}),
            ...(reference.path ? { path: reference.path } : {}),
            ...(reference.assetId ? { assetId: reference.assetId } : {}),
            mimeType: reference.mimeType || "application/octet-stream",
            size: 0,
            status,
            binary: false,
            truncated: false,
        };
    }
    async captureReferencedArtifacts(before: Runtime, references: ReviewArtifactReference[]): Promise<{
        artifacts: ReviewSnapshotArtifact[];
        unreviewed: string[];
    }> {
        const artifacts: ReviewSnapshotArtifact[] = [];
        const unreviewed: string[] = [];
        for (const reference of references) {
            try {
                const resolved = resolveArtifactReference(reference, { repositories: before.repositories });
                const materialized = materializeReviewArtifact(resolved);
                const material = artifactSnapshotContent(materialized);
                const image = materialized.mimeType.startsWith("image/");
                const status = material.truncated || materialized.mimeType === "application/pdf" ? "unsupported" as const : "ready" as const;
                artifacts.push({
                    id: reference.id,
                    kind: reference.kind,
                    title: materialized.title,
                    ...(materialized.purpose ? { purpose: materialized.purpose } : {}),
                    required: reference.required,
                    source: materialized.source,
                    ...(materialized.repositoryId ? { repositoryId: materialized.repositoryId } : {}),
                    ...(materialized.path ? { path: materialized.path } : {}),
                    assetId: materialized.assetId,
                    mimeType: materialized.mimeType,
                    size: materialized.size,
                    status,
                    binary: material.binary,
                    truncated: material.truncated,
                    ...(material.content !== undefined ? { content: material.content } : {}),
                });
                if (reference.required && (status !== "ready" || (!image && material.binary)))
                    unreviewed.push(`${reference.id}: ${status === "unsupported" ? "material is not supported by the Reviewer" : "material is binary and not readable"}`);
            }
            catch (error) {
                artifacts.push(this.missingSnapshotArtifact(reference, "missing"));
                if (reference.required)
                    unreviewed.push(`${reference.id}: ${error instanceof Error ? error.message : "material unavailable"}`);
            }
        }
        return { artifacts, unreviewed };
    }
    async captureSnapshot(workspaceId: string, before: Runtime, context: AgentContext, references: ReviewArtifactReference[] = []): Promise<ReviewSnapshot> {
        const supplements = this.deps.storage.readState<Array<{
            attachments?: ReviewArtifactReference[];
        }>>(`session-supplements:${workspaceId}:${this.deps.storage.getAgentBinding(workspaceId)?.agentId}`) || [];
        references = [...new Map([...references, ...supplements.flatMap(item => item.attachments || [])].map(reference => [reference.id, reference])).values()];
        // New tasks read immutable originals through their authorized bundle tools.
        // Do not re-resolve previewed source paths against a different worktree.
        if (this.deps.storage.getAgentBinding(workspaceId)?.handoffBundle)
            references = [];
        const files = new Map<string, {
            repositoryId: string;
            path: string;
            oldPath?: string;
            status: string;
            binary: boolean;
            truncated: boolean;
            diff?: string;
            content?: string;
        }>();
        const capturedArtifacts = await this.captureReferencedArtifacts(before, references);
        const unreviewed: string[] = [...(before.issues || []), ...capturedArtifacts.unreviewed];
        for (const repo of before.repositories) {
            const names = new Map<string, {
                status: string;
                oldPath?: string;
            }>();
            const committed = repo.baseSha && repo.head ? await this.gitOutput(repo.worktreePath, ["diff", "--name-status", "-z", "--find-renames", repo.baseSha, repo.head]) : "";
            if (committed === null)
                unreviewed.push(`${repo.id}: committed change list unavailable`);
            for (const entry of this.diffNames(committed || ""))
                names.set(entry.path, entry);
            const status = await this.gitOutput(repo.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
            if (status === null) {
                unreviewed.push(`${repo.id}: Git status unavailable`);
            }
            else {
                for (const entry of this.workingNames(status))
                    names.set(entry.path, entry);
            }
            for (const [path, entry] of names) {
                const safe = this.deps.authorization.safeRelativePath(repo.worktreePath, path);
                if (!safe) {
                    unreviewed.push(`${repo.id}:${path}: path outside worktree`);
                    continue;
                }
                const safeOldPath = entry.oldPath ? this.deps.authorization.safeRelativePath(repo.worktreePath, entry.oldPath) : undefined;
                if (entry.oldPath && !safeOldPath)
                    unreviewed.push(`${repo.id}:${entry.oldPath}: old path is outside worktree`);
                const parts: string[] = [];
                if (repo.baseSha && repo.head) {
                    const committedDiff = await this.gitOutput(repo.worktreePath, ["diff", "--binary", "--find-renames", repo.baseSha, repo.head, "--", safe]);
                    if (committedDiff === null)
                        unreviewed.push(`${repo.id}:${safe}: committed diff unavailable`);
                    else if (committedDiff)
                        parts.push(committedDiff);
                }
                const workingDiff = repo.head ? await this.gitOutput(repo.worktreePath, ["diff", "--binary", "HEAD", "--", safe]) : "";
                if (workingDiff === null)
                    unreviewed.push(`${repo.id}:${safe}: working diff unavailable`);
                else if (workingDiff)
                    parts.push(workingDiff);
                const material = await this.fileMaterial(repo.worktreePath, safe);
                // A deleted file or an unreadable working-tree copy can still be fully
                // reviewed when Git supplied a complete patch. Binary and truncated
                // material remain explicitly unreviewed as required by the protocol.
                if (material.binary)
                    unreviewed.push(`${repo.id}:${safe}: binary content is not included`);
                else if (material.truncated)
                    unreviewed.push(`${repo.id}:${safe}: file exceeds the review size limit`);
                else if (material.issue && (!parts.length || ["file_too_large", "symlink_not_followed", "non_regular_file", "path_outside_worktree"].includes(material.issue)))
                    unreviewed.push(`${repo.id}:${safe}: ${material.issue}`);
                const key = `${repo.id}:${safe}`;
                files.set(key, {
                    repositoryId: repo.id, path: safe, ...(safeOldPath ? { oldPath: safeOldPath } : {}), status: entry.status,
                    binary: material.binary, truncated: material.truncated, ...(parts.length ? { diff: parts.join("\n") } : {}),
                    ...(material.content !== undefined ? { content: material.content } : {}),
                });
                if (material.binary || material.truncated || material.issue)
                    continue;
                if (!parts.length && material.content === undefined)
                    unreviewed.push(`${repo.id}:${safe}: no readable material`);
            }
        }
        const repositories = before.repositories.map((repo) => ({ ...repo, dirtyPaths: [...repo.dirtyPaths].sort() })).sort((left, right) => left.id.localeCompare(right.id));
        const fileList = [...files.values()].sort((left, right) => `${left.repositoryId}:${left.path}`.localeCompare(`${right.repositoryId}:${right.path}`));
        const snapshotId = this.deps.storage.digest({ workspaceId, repositories });
        const diffId = this.deps.storage.digest({ snapshotId, files: fileList, artifacts: capturedArtifacts.artifacts, unreviewed: [...unreviewed].sort() });
        const snapshot = reviewSnapshotSchema.parse({ workspaceId, treePath: before.treePath, snapshotId, diffId, capturedAt: this.deps.clock.now(), repositories, files: fileList, artifacts: capturedArtifacts.artifacts, unreviewed });
        const after = await this.deps.authorization.currentRuntime(workspaceId, context);
        if (this.deps.authorization.runtimeIdentity(before) !== this.deps.authorization.runtimeIdentity(after))
            throw new Error("workspace_changed_during_snapshot");
        return snapshot;
    }
}
