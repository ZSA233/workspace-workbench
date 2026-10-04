import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type Config } from "./config.ts";
import { Git } from "./git.ts";
import { childPath, commitGitlinks, indexGitlinks } from "./gitlinks.ts";
import { canonical, hash, inside, issue, WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceActivity } from './workspace-activity-guard.ts';
import type { WorkspaceDirectory } from './workspace-directory.ts';
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
import { pythonJson } from './workspace-record-encoding.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
type WorkspaceDeletionTarget = {
    git: Git;
    path: string;
    repositoryId: string;
    relativePath?: string;
};
type WorkspaceDeletionWarning = {
    repositoryId: string;
    code: "worktree_branch_changed" | "worktree_cleanup_skipped" | "worktree_path_outside_workspace";
    recordedBranch?: string | null;
    currentBranch?: string | null;
};
type WorkspaceDeletionPlan = {
    targets: WorkspaceDeletionTarget[];
    warnings: WorkspaceDeletionWarning[];
};
function makeWorkspaceDirectoriesRemovable(root: string, files: Pick<WorkspaceInfrastructure["files"], "lstatSync" | "chmodSync" | "readdirSync">): () => void {
    const changed: Array<{
        path: string;
        mode: number;
        dev: number;
        ino: number;
    }> = [];
    const restore = () => {
        for (const item of [...changed].reverse()) {
            try {
                const current = files.lstatSync(item.path);
                if (current.isDirectory() && !current.isSymbolicLink() && current.dev === item.dev && current.ino === item.ino)
                    files.chmodSync(item.path, item.mode);
            }
            catch { /* A partially removed tree may no longer contain this directory. */ }
        }
    };
    const visit = (path: string) => {
        const stat = files.lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            return;
        const mode = stat.mode & 0o7777;
        const removableMode = mode | 0o700;
        if (mode !== removableMode) {
            files.chmodSync(path, removableMode);
            changed.push({ path, mode, dev: stat.dev, ino: stat.ino });
        }
        for (const entry of files.readdirSync(path))
            visit(join(path, entry));
    };
    try {
        visit(root);
    }
    catch (error) {
        restore();
        throw error;
    }
    return restore;
}
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "chmodSync" | "existsSync" | "lstatSync" | "mkdirSync" | "readdirSync" | "unlinkSync" | "rmdirSync" | "rmSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "now">;
    Git: WorkspaceInfrastructure["Git"];
    records: Pick<WorkspaceRecords, "recordPath" | "save">;
    activity: Pick<WorkspaceActivity, "assertIdle">;
    directory: Pick<WorkspaceDirectory, "get">;
    config: () => Config;
};
export class WorkspaceDeletion {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    assertDeletionBoundary(workspace: Json) {
        const treePath = String(workspace.treePath || "");
        if (!treePath || !inside(treePath, this.deps.config().treesRoot) ||
            (this.deps.files.existsSync(treePath) && this.deps.files.lstatSync(treePath).isSymbolicLink()))
            throw new WorkbenchError("workspace_path_invalid", "Workspace path is outside its managed tree");
        const protectedPaths = [this.deps.config().cacheRoot, join(this.deps.config().stateRoot, "toolchains")];
        for (const protectedPath of protectedPaths) {
            if (inside(protectedPath, treePath, true) || inside(treePath, protectedPath, true))
                throw new WorkbenchError("workspace_cache_overlap", "A protected cache path overlaps the Workspace tree");
        }
        if (inside(this.deps.records.recordPath(workspace.id), treePath, true))
            throw new WorkbenchError("workspace_path_invalid", "Workspace record overlaps its managed tree");
    }
    workspaceExtraEntries(workspace: Json): {
        count: number;
        paths: string[];
        scanIncomplete: boolean;
    } {
        const treePath = String(workspace.treePath || "");
        if (!this.deps.files.existsSync(treePath))
            return { count: 0, paths: [], scanIncomplete: false };
        try {
            const rootStat = this.deps.files.lstatSync(treePath);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
                return { count: 0, paths: [], scanIncomplete: true };
        }
        catch {
            return { count: 0, paths: [], scanIncomplete: true };
        }
        // A Gitlink root is itself a repository; Git status covers its top-level files.
        if (workspace.repositories.some((repo: Json) => resolve(repo.worktreePath) === resolve(treePath)))
            return { count: 0, paths: [], scanIncomplete: false };
        const allowed = new Map<string, Set<string>>();
        const allow = (parent: string, name: string) => {
            const names = allowed.get(parent) || new Set<string>();
            names.add(name);
            allowed.set(parent, names);
        };
        for (const repo of workspace.repositories) {
            const relativePath = relative(resolve(treePath), resolve(String(repo.worktreePath || "")));
            if (!relativePath || relativePath === ".")
                continue;
            if (relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\") || isAbsolute(relativePath))
                continue;
            const parts = relativePath.split(/[\\/]/).filter(Boolean);
            let parent = treePath;
            for (const part of parts) {
                allow(parent, part);
                parent = join(parent, part);
            }
        }
        if (workspace.layout !== "gitlink") {
            allow(treePath, ".workspace");
            allow(join(treePath, ".workspace"), "manifest.json");
        }
        const paths: string[] = [];
        let count = 0;
        let scanIncomplete = false;
        for (const [directory, names] of allowed) {
            if (!this.deps.files.existsSync(directory))
                continue;
            try {
                const stat = this.deps.files.lstatSync(directory);
                if (!stat.isDirectory() || stat.isSymbolicLink()) {
                    count++;
                    if (paths.length < 20)
                        paths.push(relative(treePath, directory) || ".");
                    continue;
                }
                for (const name of this.deps.files.readdirSync(directory)) {
                    if (names.has(name))
                        continue;
                    count++;
                    if (paths.length < 20)
                        paths.push(relative(treePath, join(directory, name)));
                }
            }
            catch {
                scanIncomplete = true;
            }
        }
        return { count, paths, scanIncomplete };
    }
    async impact(workspace: Json) {
        const repositories: Json[] = [], externalReferences: Json[] = [];
        let scanIncomplete = false;
        let boundaryValid = true;
        try {
            this.assertDeletionBoundary(workspace);
        }
        catch {
            boundaryValid = false;
            scanIncomplete = true;
        }
        for (const repo of workspace.repositories) {
            const exists = this.deps.files.existsSync(repo.worktreePath);
            let dirtyPaths: string[] = [], dirtyPathCount = 0, unavailable = false;
            try {
                if (exists) {
                    if (!boundaryValid || !inside(repo.worktreePath, workspace.treePath, true))
                        throw new Error("worktree path outside Workspace tree");
                    const statuses = await new this.deps.Git(repo.worktreePath, this.deps.config().gitTimeout).status(repo.role === "gitlink-root", true);
                    dirtyPathCount = statuses.length;
                    dirtyPaths = statuses.slice(0, 20).map(([, path]) => path.split("\0").join(" → "));
                }
            }
            catch {
                unavailable = true;
                scanIncomplete = true;
            }
            repositories.push({
                ...repo,
                worktreeExists: exists,
                dirty: dirtyPathCount > 0 || unavailable,
                dirtyPaths,
                dirtyPathCount,
            });
        }
        const extra = this.workspaceExtraEntries(workspace);
        scanIncomplete ||= extra.scanIncomplete;
        const detachedSafetyRefs: Json[] = [];
        for (const repo of (boundaryValid ? workspace.repositories : []).filter((item: Json) => this.deps.files.existsSync(item.worktreePath))) {
            try {
                const worktreePath = String(repo.worktreePath || "");
                if (!inside(worktreePath, workspace.treePath, true) || this.deps.files.lstatSync(worktreePath).isSymbolicLink())
                    continue;
                const target = new this.deps.Git(worktreePath, this.deps.config().gitTimeout);
                const source = new this.deps.Git(String(repo.sourcePath || ""), this.deps.config().gitTimeout);
                const [root, branch, registered] = await Promise.all([
                    target.root(), target.branch(), source.registered(worktreePath),
                ]);
                if (root !== canonical(worktreePath) || branch || !registered || registered.locked)
                    continue;
                const head = await target.head() || repo.adoptionHead;
                if (head) {
                    const ref = this.safetyRefForHead(workspace, repo, head);
                    if (!detachedSafetyRefs.some((item) => item.ref === ref))
                        detachedSafetyRefs.push({ repositoryId: repo.id, ref, head });
                }
                if (repo.adoptionHead && repo.adoptionHead !== head) {
                    const ref = this.safetyRefForHead(workspace, repo, repo.adoptionHead);
                    if (!detachedSafetyRefs.some((item) => item.ref === ref))
                        detachedSafetyRefs.push({ repositoryId: repo.id, ref, head: repo.adoptionHead });
                }
            }
            catch {
                scanIncomplete = true;
            }
        }
        const dirtyRepositories = repositories.filter((repo) => repo.dirty).map((repo) => ({
            repositoryId: String(repo.id),
            pathCount: Number(repo.dirtyPathCount || 0),
            paths: repo.dirtyPaths,
            scanUnavailable: !repo.worktreeExists ? false : Number(repo.dirtyPathCount || 0) === 0 && Boolean(repo.dirty),
        }));
        const requiresDataLossConfirmation = dirtyRepositories.length > 0 || extra.count > 0 || scanIncomplete;
        return {
            workspaceId: workspace.id,
            treePath: workspace.treePath,
            repositories,
            repositoryCount: repositories.length,
            dirtyRepositoryCount: repositories.filter((repo) => repo.dirty).length,
            branchesPreserved: workspace.repositories.map((repo: Json) => repo.branch).filter(Boolean),
            ...(detachedSafetyRefs.length ? { detachedSafetyRefs } : {}),
            dirtyRepositories: repositories.filter((repo) => repo.dirty).length,
            requiresDataLossConfirmation,
            dataLossSummary: {
                repositories: dirtyRepositories,
                extraPathCount: extra.count,
                extraPaths: extra.paths,
                scanIncomplete,
            },
            irreversible: true,
            preserves: ["commits", "local branches", "external references", "Workbench caches"],
            loses: ["workspace record", "managed worktree files"],
            externalReferences,
            recordPath: this.deps.records.recordPath(workspace.id),
            preview: true,
            canDelete: workspace.state === "removed",
        };
    }
    async deletionTargets(w: Json, permanent = false): Promise<WorkspaceDeletionPlan> {
        this.deps.activity.assertIdle(w.id);
        this.assertDeletionBoundary(w);
        // Use Git only when it proves the exact managed path is registered to the
        // expected source. For permanent deletion, Git metadata drift is a warning:
        // the confirmed Workspace tree remains the filesystem deletion boundary.
        const targets: WorkspaceDeletionTarget[] = [];
        const warnings: WorkspaceDeletionWarning[] = [];
        const blockers: Array<{
            code: string;
            message: string;
            repositoryId: string;
        }> = [];
        for (const repo of w.repositories) {
            const worktreePath = String(repo.worktreePath || "");
            const source = new this.deps.Git(String(repo.sourcePath || ""), this.deps.config().operationTimeout);
            if (worktreePath && !inside(worktreePath, w.treePath, true)) {
                if (permanent)
                    warnings.push({ repositoryId: String(repo.id), code: "worktree_path_outside_workspace" });
                else if (this.deps.files.existsSync(worktreePath))
                    blockers.push({ code: "worktree_identity_changed", message: "worktree path is outside the Workspace tree", repositoryId: String(repo.id) });
                continue;
            }
            if (!this.deps.files.existsSync(worktreePath)) {
                if (permanent) {
                    try {
                        if (await source.registered(worktreePath))
                            warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                    }
                    catch {
                        warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                    }
                }
                continue;
            }
            const target = new this.deps.Git(worktreePath, this.deps.config().operationTimeout);
            try {
                if (this.deps.files.lstatSync(worktreePath).isSymbolicLink() || !inside(worktreePath, w.treePath, true))
                    throw new WorkbenchError("worktree_identity_changed", "worktree path is outside the Workspace tree");
                const [root, currentBranch, registered] = await Promise.all([
                    target.root(), target.branch(), source.registered(worktreePath),
                ]);
                if (registered?.locked)
                    throw new WorkbenchError("worktree_locked", "worktree is locked");
                if (root !== canonical(worktreePath) || !registered)
                    throw new WorkbenchError("worktree_identity_changed", "worktree identity or registration changed");
                if (currentBranch !== repo.branch) {
                    if (!permanent)
                        throw new WorkbenchError("worktree_identity_changed", "worktree branch changed");
                    warnings.push({
                        repositoryId: String(repo.id),
                        code: "worktree_branch_changed",
                        recordedBranch: repo.branch || null,
                        currentBranch,
                    });
                }
                if (!permanent) {
                    if ((await target.status(repo.role === "gitlink-root", true)).length)
                        throw new WorkbenchError("workspace_dirty", "worktree has user changes");
                    const head = await target.head();
                    if (head !== (w.origin === "adopted" ? repo.adoptionHead : repo.baseSha)) {
                        const retainedBranch = repo.branch
                            ? await source.run(["show-ref", "--verify", "--hash", `refs/heads/${repo.branch}`], false)
                            : null;
                        if (!retainedBranch || retainedBranch.code !== 0 || retainedBranch.stdout.trim() !== head)
                            throw new WorkbenchError("workspace_has_commits", "worktree contains commits not protected by a retained branch");
                    }
                }
                targets.push({ git: source, path: worktreePath, repositoryId: String(repo.id) });
            }
            catch (error) {
                const problem = issue(error);
                if (permanent && problem.code !== "worktree_locked")
                    warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                else
                    blockers.push({ code: problem.code, message: problem.message, repositoryId: String(repo.id) });
            }
        }
        if (blockers.length) {
            throw new WorkbenchError(blockers[0].code, blockers[0].message, { issues: blockers });
        }
        if (!permanent) {
            const extra = this.workspaceExtraEntries(w);
            if (extra.count || extra.scanIncomplete) {
                const metadataOnly = extra.paths.length > 0 && extra.paths.every((path) => path.startsWith(".workspace/"));
                throw new WorkbenchError("workspace_dirty", metadataOnly ? "workspace metadata contains user files" : "workspace contains extra files", extra);
            }
        }
        return { targets, warnings };
    }
    safetyRef(workspace: Json, repo: Json) {
        return `refs/workbench/recovered/${workspace.id}/${hash(repo.id).slice(0, 16)}`;
    }
    safetyRefForHead(workspace: Json, repo: Json, head: string) {
        return `${this.safetyRef(workspace, repo)}-${head}`;
    }
    journalPermanentDeletion(workspace: Json, fields: Json) {
        workspace.permanentDeletion = {
            ...(workspace.permanentDeletion || {}),
            ...fields,
            startedAt: workspace.permanentDeletion?.startedAt || this.deps.storage.now(),
            updatedAt: this.deps.storage.now(),
            status: "in_progress",
        };
        const saved = this.deps.records.save(workspace, false);
        workspace.updatedAt = saved.updatedAt;
    }
    async preserveDetachedHeads(workspace: Json, journal = true, eligibleRepositories?: Set<string>) {
        for (const repo of workspace.repositories) {
            if ((eligibleRepositories && !eligibleRepositories.has(String(repo.id))) || !this.deps.files.existsSync(repo.worktreePath))
                continue;
            const target = new this.deps.Git(repo.worktreePath, this.deps.config().operationTimeout);
            const source = new this.deps.Git(repo.sourcePath, this.deps.config().operationTimeout);
            if (await target.branch())
                continue;
            const currentHead = await target.head();
            const heads = [...new Set([repo.adoptionHead, currentHead].filter((head): head is string => typeof head === "string" && !!head))];
            for (const head of heads) {
                const ref = this.safetyRefForHead(workspace, repo, head);
                const current = await source.run(["show-ref", "--verify", "--hash", ref], false);
                if (!current.code) {
                    if (current.stdout.trim() !== head)
                        throw new WorkbenchError("safety_ref_conflict", "Detached HEAD recovery reference changed");
                    continue;
                }
                if (journal)
                    this.journalPermanentDeletion(workspace, { phase: "preserve_detached_head", repositoryId: repo.id, ref, head });
                await source.run(["update-ref", ref, head, "0000000000000000000000000000000000000000"]);
            }
        }
    }
    async gitlinkDeletionTargets(workspace: Json, permanent: boolean): Promise<WorkspaceDeletionPlan> {
        this.deps.activity.assertIdle(workspace.id);
        this.assertDeletionBoundary(workspace);
        const targets: WorkspaceDeletionTarget[] = [];
        const warnings: WorkspaceDeletionWarning[] = [];
        const blockers: Array<{
            code: string;
            message: string;
            repositoryId: string;
        }> = [];
        for (const repo of [...workspace.repositories].reverse()) {
            const worktreePath = String(repo.worktreePath || "");
            const source = new this.deps.Git(String(repo.sourcePath || ""), this.deps.config().operationTimeout);
            if (worktreePath && !inside(worktreePath, workspace.treePath, true)) {
                if (permanent)
                    warnings.push({ repositoryId: String(repo.id), code: "worktree_path_outside_workspace" });
                else if (this.deps.files.existsSync(worktreePath))
                    blockers.push({ code: "worktree_identity_changed", message: "Gitlink worktree path is outside the Workspace tree", repositoryId: String(repo.id) });
                continue;
            }
            if (!this.deps.files.existsSync(worktreePath)) {
                if (permanent) {
                    try {
                        if (await source.registered(worktreePath))
                            warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                    }
                    catch {
                        warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                    }
                }
                continue;
            }
            const target = new this.deps.Git(worktreePath, this.deps.config().operationTimeout);
            try {
                if (this.deps.files.lstatSync(worktreePath).isSymbolicLink() || !inside(worktreePath, workspace.treePath, true))
                    throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree path is outside the Workspace tree");
                const [root, currentBranch, registered] = await Promise.all([
                    target.root(), target.branch(), source.registered(worktreePath),
                ]);
                if (registered?.locked)
                    throw new WorkbenchError("worktree_locked", "Gitlink worktree is locked");
                if (root !== canonical(worktreePath) || !registered)
                    throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree identity or registration changed");
                if (currentBranch !== repo.branch) {
                    if (!permanent)
                        throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree branch changed");
                    warnings.push({ repositoryId: String(repo.id), code: "worktree_branch_changed", recordedBranch: repo.branch || null, currentBranch });
                }
                if (!permanent) {
                    if ((await target.status(repo.role === "gitlink-root" ? "all" : false, true)).length)
                        throw new WorkbenchError("workspace_dirty", "Gitlink worktree has user changes");
                    const head = await target.head();
                    if (head !== repo.baseSha) {
                        const retainedBranch = repo.branch
                            ? await source.run(["show-ref", "--verify", "--hash", `refs/heads/${repo.branch}`], false)
                            : null;
                        if (!retainedBranch || retainedBranch.code !== 0 || retainedBranch.stdout.trim() !== head)
                            throw new WorkbenchError("workspace_has_commits", "Gitlink worktree contains commits not protected by a retained branch");
                    }
                    if (repo.role === "gitlink-root") {
                        const [committed, indexed] = await Promise.all([
                            commitGitlinks(worktreePath, "HEAD", this.deps.config().operationTimeout),
                            indexGitlinks(worktreePath, this.deps.config().operationTimeout),
                        ]);
                        if (pythonJson(committed) !== pythonJson(indexed))
                            throw new WorkbenchError("workspace_dirty", "Gitlink pointers are staged");
                    }
                }
                targets.push({ git: source, path: worktreePath, relativePath: String(repo.repoPath || "."), repositoryId: String(repo.id) });
            }
            catch (error) {
                const problem = issue(error);
                if (permanent && problem.code !== "worktree_locked")
                    warnings.push({ repositoryId: String(repo.id), code: "worktree_cleanup_skipped" });
                else
                    blockers.push({ code: problem.code, message: problem.message, repositoryId: String(repo.id) });
            }
        }
        if (blockers.length)
            throw new WorkbenchError(blockers[0].code, blockers[0].message, { issues: blockers });
        return { targets, warnings };
    }
    async cleanupGitlink(w: Json, params: Json, permanent: boolean) {
        if (permanent && w.state !== "removed") {
            if (!params.confirm)
                return { ...(await this.impact(w)), canDelete: false, deleted: false,
                    blockedReason: w.state === "deletion_pending" ? "workspace_task_active" : "workspace_must_be_removed" };
            throw new WorkbenchError("workspace_must_be_removed", "remove workspace before permanent deletion");
        }
        const impact = permanent ? await this.impact(w) : null;
        let plan: WorkspaceDeletionPlan;
        try {
            plan = await this.gitlinkDeletionTargets(w, permanent);
        }
        catch (error) {
            if (permanent && !params.confirm)
                return { ...(impact || await this.impact(w)), canDelete: false,
                    deleted: false, blockedReason: issue(error).code, issues: [issue(error)] };
            throw error;
        }
        if (!params.confirm)
            return permanent
                ? { ...(impact || await this.impact(w)), canDelete: true, deleted: false, ...(plan.warnings.length ? { gitIdentityWarnings: plan.warnings } : {}) }
                : { workspaceId: w.id, preview: true, canDelete: true, repositories: plan.targets.length, removed: false };
        if (permanent) {
            const freshImpact = await this.impact(w);
            if (freshImpact.requiresDataLossConfirmation && params.confirmDataLoss !== true)
                throw new WorkbenchError("workspace_data_loss_confirmation_required", "Explicit data-loss confirmation is required", freshImpact.dataLossSummary);
            plan = await this.gitlinkDeletionTargets(w, true);
        }
        await this.preserveDetachedHeads(w, permanent, new Set(plan.targets.map((target) => target.repositoryId)));
        for (const target of plan.targets) {
            if (permanent)
                this.journalPermanentDeletion(w, { phase: "remove_worktree", repositoryId: target.repositoryId });
            await target.git.run(["worktree", "remove", ...(permanent && params.confirmDataLoss === true ? ["--force"] : []), target.path]);
            if (!permanent && target.relativePath && target.relativePath !== "." && this.deps.files.existsSync(w.treePath))
                this.deps.files.mkdirSync(childPath(w.treePath, target.relativePath), { recursive: true });
            if (permanent) {
                const completed = new Set<string>(w.permanentDeletion?.completedRepositories || []);
                completed.add(target.repositoryId);
                this.journalPermanentDeletion(w, { phase: "remove_worktree", completedRepositories: [...completed], repositoryId: null });
            }
        }
        if (permanent) {
            this.assertDeletionBoundary(w);
            this.journalPermanentDeletion(w, { phase: "remove_tree", repositoryId: null });
            if (this.deps.files.existsSync(w.treePath)) {
                const restorePermissions = makeWorkspaceDirectoriesRemovable(w.treePath, this.deps.files);
                try {
                    this.deps.files.rmSync(w.treePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
                }
                catch (error) {
                    restorePermissions();
                    throw error;
                }
            }
            this.deps.files.unlinkSync(this.deps.records.recordPath(w.id));
        }
        else {
            w.state = "removed";
            this.deps.records.save(w, false);
        }
        return { workspaceId: w.id, preview: false, ...(permanent
                ? {
                    deleted: true,
                    branchesPreserved: [...w.repositories.map((repo: Json) => repo.branch).filter(Boolean), ...plan.warnings.map((warning) => warning.currentBranch).filter(Boolean)],
                    externalReferences: [],
                    ...(plan.warnings.length ? { gitIdentityWarnings: plan.warnings } : {}),
                }
                : { removed: true }) };
    }
    async cleanup(params: Json, permanent = false) {
        const w = this.deps.directory.get(String(params.workspaceId || ""));
        if (!w.managed)
            throw new WorkbenchError("workspace_not_managed", "live workspace cannot be deleted");
        if (w.layout === "gitlink")
            return this.cleanupGitlink(w, params, permanent);
        const impact = await this.impact(w);
        if (permanent && w.state !== "removed") {
            if (!params.confirm)
                return {
                    ...impact,
                    canDelete: false,
                    state: w.state,
                    blockedReason: w.state === "deletion_pending"
                        ? "workspace_task_active"
                        : "workspace_must_be_removed",
                    requiresRemoval: true,
                    deleted: false,
                };
            throw new WorkbenchError(w.state === "deletion_pending"
                ? "workspace_task_active"
                : "workspace_must_be_removed", "remove workspace after finishing tasks before permanent deletion");
        }
        let plan: WorkspaceDeletionPlan;
        try {
            plan = await this.deletionTargets(w, permanent);
        }
        catch (error) {
            if (permanent && !params.confirm) {
                const problem = issue(error);
                const details = problem.details && typeof problem.details === "object" ? problem.details as Record<string, unknown> : {};
                const issues = Array.isArray(details.issues) ? details.issues : [problem];
                return {
                    ...impact,
                    canDelete: false,
                    deleted: false,
                    blockedReason: problem.code,
                    issues,
                };
            }
            throw error;
        }
        if (!params.confirm)
            return permanent
                ? { ...impact, canDelete: true, deleted: false, ...(plan.warnings.length ? { gitIdentityWarnings: plan.warnings } : {}) }
                : {
                    workspaceId: w.id,
                    preview: true,
                    removed: false,
                    repositories: plan.targets.length,
                    ...(impact.detachedSafetyRefs ? { detachedSafetyRefs: impact.detachedSafetyRefs } : {}),
                };
        if (permanent) {
            const freshImpact = await this.impact(w);
            if (freshImpact.requiresDataLossConfirmation && params.confirmDataLoss !== true)
                throw new WorkbenchError("workspace_data_loss_confirmation_required", "Explicit data-loss confirmation is required", freshImpact.dataLossSummary);
            // Recheck ownership after the confirmation preview and immediately before Git mutations.
            plan = await this.deletionTargets(w, true);
        }
        await this.preserveDetachedHeads(w, permanent, new Set(plan.targets.map((target) => target.repositoryId)));
        for (const target of plan.targets) {
            if (permanent)
                this.journalPermanentDeletion(w, { phase: "remove_worktree", repositoryId: target.repositoryId });
            await target.git.run(["worktree", "remove", ...(permanent && params.confirmDataLoss === true ? ["--force"] : []), target.path]);
            if (!permanent) {
                let parent = dirname(target.path);
                while (inside(parent, w.treePath)) {
                    try {
                        this.deps.files.rmdirSync(parent);
                    }
                    catch {
                        break;
                    }
                    parent = dirname(parent);
                }
            }
            else {
                const completed = new Set<string>(w.permanentDeletion?.completedRepositories || []);
                completed.add(target.repositoryId);
                this.journalPermanentDeletion(w, { phase: "remove_worktree", completedRepositories: [...completed], repositoryId: null });
            }
        }
        if (permanent) {
            this.assertDeletionBoundary(w);
            this.journalPermanentDeletion(w, { phase: "remove_tree", repositoryId: null });
            if (this.deps.files.existsSync(w.treePath)) {
                const restorePermissions = makeWorkspaceDirectoriesRemovable(w.treePath, this.deps.files);
                try {
                    this.deps.files.rmSync(w.treePath, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
                }
                catch (error) {
                    restorePermissions();
                    throw error;
                }
            }
            this.deps.files.unlinkSync(this.deps.records.recordPath(w.id));
        }
        else {
            const metadata = join(w.treePath, ".workspace");
            if (this.deps.files.existsSync(join(metadata, "manifest.json")))
                this.deps.files.unlinkSync(join(metadata, "manifest.json"));
            if (this.deps.files.existsSync(metadata))
                this.deps.files.rmdirSync(metadata);
            if (this.deps.files.existsSync(w.treePath))
                this.deps.files.rmdirSync(w.treePath);
            w.state = "removed";
            this.deps.records.save(w, false);
        }
        return {
            workspaceId: w.id,
            preview: false,
            ...(permanent
                ? {
                    deleted: true,
                    branchesPreserved: [...(impact.branchesPreserved || []), ...plan.warnings.map((warning) => warning.currentBranch).filter(Boolean)],
                    externalReferences: [],
                    ...(plan.warnings.length ? { gitIdentityWarnings: plan.warnings } : {}),
                }
                : { removed: true }),
        };
    }
}
