import { basename, join } from "node:path";
import { repositoryPath, type Config, type Repository } from "./config.ts";
import { childPath, commitGitlinks } from "./gitlinks.ts";
import { canonical, hash, inside, issue, slug, WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceActivity } from './workspace-activity-guard.ts';
import type { WorkspaceCatalog } from './workspace-catalog.ts';
import type { WorkspaceDirectory } from './workspace-directory.ts';
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
import { pythonJson } from './workspace-record-encoding.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
function createRequestParams(params: Json): Json {
    const { requestId: _requestId, operationId: _operationId, ...stableParams } = params;
    return stableParams;
}
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync" | "readFileSync" | "writeFileSync" | "mkdirSync" | "readdirSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "now">;
    Git: WorkspaceInfrastructure["Git"];
    records: Pick<WorkspaceRecords, "recordPath" | "read" | "save" | "sourceRecord" | "select">;
    catalog: Pick<WorkspaceCatalog, "orphanPreview">;
    directory: Pick<WorkspaceDirectory, "get">;
    activity: Pick<WorkspaceActivity, "assertIdle">;
    config: () => Config;
};
export class WorkspaceCreation {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async adoptOrphan(params: Json): Promise<Json> {
        const id = String(params.workspaceId || "");
        if (!id || slug(id) !== id || id === "main")
            throw new WorkbenchError("workspace_id_invalid", "Invalid Workspace ID");
        const requestedBranches = params.branches || {};
        if (!requestedBranches || typeof requestedBranches !== "object" || Array.isArray(requestedBranches))
            throw new WorkbenchError("request_invalid", "branches must map repository IDs to names");
        const requestHash = hash(pythonJson({ id, fingerprint: params.fingerprint, branches: requestedBranches }));
        const requestedBranch = (repoId: string): string | undefined => Object.prototype.hasOwnProperty.call(requestedBranches, repoId) ? requestedBranches[repoId] : undefined;
        let record: Json;
        const possibleRecord = this.deps.files.existsSync(this.deps.records.recordPath(id)) ? this.deps.records.read(this.deps.records.recordPath(id)) : null;
        const existingRecord = possibleRecord && canonical(possibleRecord.treePath) === canonical(join(this.deps.config().treesRoot, id)) ? possibleRecord : null;
        if (existingRecord) {
            record = existingRecord;
            if (record.origin !== "adopted" || record.adoption?.requestHash !== requestHash)
                throw new WorkbenchError("workspace_exists", "Workspace record already exists");
            if (record.state === "active")
                return record;
            if (!["adopting", "adopt_failed"].includes(record.state))
                throw new WorkbenchError("workspace_state_invalid", "Workspace cannot resume adoption");
        }
        else {
            const preview = await this.deps.catalog.orphanPreview(id);
            if (!preview.eligible || preview.fingerprint !== params.fingerprint)
                throw new WorkbenchError("orphan_changed", "Workspace changed after preview; refresh before adopting", preview.issues);
            const byId = new Map<string, Json>(preview.repositories.map((repo: Json) => [repo.id, repo]));
            for (const [repoId, name] of Object.entries(requestedBranches)) {
                const repo = byId.get(repoId);
                if (!repo || repo.branch || typeof name !== "string" || !name.trim())
                    throw new WorkbenchError("branch_invalid", "Only detached repositories can receive an adoption branch");
                await new this.deps.Git(repo.worktreePath, this.deps.config().operationTimeout).run(["check-ref-format", "--branch", name]);
                const existing = await new this.deps.Git(repo.sourcePath, this.deps.config().operationTimeout).run(["show-ref", "--verify", `refs/heads/${name}`], false);
                if (!existing.code)
                    throw new WorkbenchError("branch_exists", `Branch already exists: ${name}`);
            }
            let existingRecordBackup: string | null = null;
            if (this.deps.files.existsSync(this.deps.records.recordPath(id))) {
                const bytes = this.deps.files.readFileSync(this.deps.records.recordPath(id));
                const directory = join(this.deps.config().stateRoot, "orphan-record-backups");
                this.deps.files.mkdirSync(directory, { recursive: true, mode: 0o700 });
                existingRecordBackup = join(directory, `${id}-${hash(bytes.toString("base64")).slice(0, 16)}.json`);
                try {
                    this.deps.files.writeFileSync(existingRecordBackup, bytes, { mode: 0o600, flag: "wx" });
                }
                catch (error) {
                    if (!this.deps.files.existsSync(existingRecordBackup) || !this.deps.files.readFileSync(existingRecordBackup).equals(bytes))
                        throw error;
                }
            }
            record = {
                schemaVersion: 1, id, displayName: id, kind: "managed", managed: true,
                origin: "adopted", state: "adopting", description: "Recovered from existing Git worktrees",
                sourceRoot: this.deps.config().sourceRoot, treePath: preview.treePath,
                repositoryIds: preview.repositories.map((repo: Json) => repo.id),
                repositories: preview.repositories.map((repo: Json) => ({
                    id: repo.id, name: repo.name, repoPath: repo.repoPath, role: repo.role,
                    sourcePath: repo.sourcePath, worktreePath: repo.worktreePath,
                    branch: repo.branch, baseRef: null, baseSha: null, adoptionHead: repo.head,
                    mode: "managed",
                })),
                adoption: { requestHash, fingerprint: params.fingerprint, branches: requestedBranches, adoptedAt: this.deps.storage.now(), originalBaseUnknown: true,
                    unmanagedPaths: preview.unmanagedPaths || [],
                    ...(existingRecordBackup ? { existingRecordBackup } : {}) },
            };
            this.deps.records.save(record, false);
        }
        try {
            for (const repo of record.repositories) {
                const git = new this.deps.Git(repo.worktreePath, this.deps.config().operationTimeout);
                const desired = requestedBranch(repo.id) || repo.branch || null;
                if (await git.root() !== canonical(repo.worktreePath) ||
                    !await new this.deps.Git(repo.sourcePath, this.deps.config().operationTimeout).registered(repo.worktreePath) ||
                    await git.head() !== repo.adoptionHead)
                    throw new WorkbenchError("worktree_identity_changed", "Worktree changed during adoption");
                const actual = await git.branch();
                if (actual !== desired) {
                    if (actual !== null || !requestedBranch(repo.id))
                        throw new WorkbenchError("worktree_identity_changed", "Branch changed during adoption");
                    const source = new this.deps.Git(repo.sourcePath, this.deps.config().operationTimeout);
                    const existing = await source.run(["show-ref", "--verify", `refs/heads/${desired}`], false);
                    if (!existing.code && existing.stdout.trim().split(/\s+/)[0] !== repo.adoptionHead)
                        throw new WorkbenchError("branch_exists", `Branch changed: ${desired}`);
                    await git.run(existing.code ? ["switch", "-c", desired] : ["switch", desired]);
                }
                repo.branch = desired;
                this.deps.records.save(record, false);
            }
            record.state = "active";
            delete record.issues;
            return this.deps.records.save(record, false);
        }
        catch (error) {
            record.state = "adopt_failed";
            record.issues = [issue(error)];
            this.deps.records.save(record, false);
            throw error;
        }
    }
    async plan(repo: Repository, workspace: Json, ref: string | null, template = "obs/{workspace}/{repository}"): Promise<Json> {
        const source = repositoryPath(this.deps.config(), repo), git = new this.deps.Git(source, this.deps.config().operationTimeout);
        if (!(await git.valid()))
            throw new WorkbenchError("repository_invalid", "configured source is not a Git repository");
        const branch = template
            .replaceAll("{workspace}", workspace.id)
            .replaceAll("{repository}", repo.id);
        if (!/^[A-Za-z0-9._/-]+$/.test(branch) ||
            branch.includes("..") ||
            branch.startsWith("/"))
            throw new WorkbenchError("branch_invalid", "invalid branch template");
        await git.run(["check-ref-format", "--branch", branch]);
        const worktreePath = canonical(join(workspace.treePath, repo.id));
        if (!inside(worktreePath, workspace.treePath))
            throw new WorkbenchError("path_invalid", "invalid repository worktree path");
        const baseRef = ref || repo.defaultBase || (await git.branch()) || "HEAD";
        if (this.deps.files.existsSync(worktreePath) ||
            (await git.run(["show-ref", "--verify", `refs/heads/${branch}`], false))
                .code === 0)
            throw new WorkbenchError("branch_exists", "target path or branch already exists");
        return {
            ...this.deps.records.sourceRecord(repo),
            worktreePath,
            branch,
            baseRef,
            baseSha: await git.commit(baseRef),
            mode: "managed",
        };
    }
    async materialize(plan: Json, workspace: Json) {
        const configured = this.deps.config().repositories.find((repo) => repo.id === plan.id);
        if (!configured ||
            canonical(plan.sourcePath) !== repositoryPath(this.deps.config(), configured) ||
            canonical(plan.worktreePath) !==
                canonical(join(workspace.treePath, plan.id)) ||
            !inside(plan.worktreePath, workspace.treePath))
            throw new WorkbenchError("worktree_identity_changed", "invalid operation journal identity");
        const git = new this.deps.Git(plan.sourcePath, this.deps.config().operationTimeout);
        if ((await git.commit(plan.baseSha)) !== plan.baseSha)
            throw new WorkbenchError("worktree_identity_changed", "invalid journal base");
        await git.run(["check-ref-format", "--branch", plan.branch]);
        if (await git.completed(plan.worktreePath, plan.branch, plan.baseSha))
            return;
        if (this.deps.files.existsSync(plan.worktreePath))
            throw new WorkbenchError("worktree_identity_changed", "existing worktree changed; preserved for inspection");
        const ref = await git.run(["show-ref", "--verify", `refs/heads/${plan.branch}`], false);
        if (!ref.code && ref.stdout.split(/\s+/)[0] !== plan.baseSha)
            throw new WorkbenchError("worktree_identity_changed", "branch changed; preserved");
        try {
            await git.run(ref.code
                ? [
                    "worktree",
                    "add",
                    "-b",
                    plan.branch,
                    plan.worktreePath,
                    plan.baseSha,
                ]
                : ["worktree", "add", plan.worktreePath, plan.branch]);
        }
        catch (error) {
            if (!(error instanceof WorkbenchError) ||
                error.code !== "git_timeout" ||
                !(await git.completed(plan.worktreePath, plan.branch, plan.baseSha)))
                throw error;
        }
    }
    async materializeGitlink(plan: Json, workspace: Json) {
        const isRoot = plan.role === "gitlink-root";
        const expectedSource = isRoot ? workspace.sourceRoot : childPath(workspace.sourceRoot, plan.repoPath);
        const expectedTarget = isRoot ? workspace.treePath : childPath(workspace.treePath, plan.repoPath);
        if (canonical(plan.sourcePath) !== expectedSource || canonical(plan.worktreePath) !== expectedTarget || plan.branch !== workspace.branchName)
            throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree identity changed");
        const git = new this.deps.Git(expectedSource, this.deps.config().operationTimeout);
        if (await git.commit(plan.baseSha) !== plan.baseSha)
            throw new WorkbenchError("worktree_identity_changed", "Gitlink base commit changed");
        if (await git.completed(expectedTarget, plan.branch, plan.baseSha))
            return;
        if (this.deps.files.existsSync(expectedTarget) && (isRoot || this.deps.files.readdirSync(expectedTarget).length))
            throw new WorkbenchError("worktree_identity_changed", "Existing Gitlink worktree path changed; preserved");
        const ref = await git.run(["show-ref", "--verify", `refs/heads/${plan.branch}`], false);
        if (!ref.code && ref.stdout.split(/\s+/)[0] !== plan.baseSha)
            throw new WorkbenchError("worktree_identity_changed", "Gitlink branch changed; preserved");
        try {
            await git.run(ref.code
                ? ["worktree", "add", "-b", plan.branch, expectedTarget, plan.baseSha]
                : ["worktree", "add", expectedTarget, plan.branch]);
        }
        catch (error) {
            if (!(error instanceof WorkbenchError) || error.code !== "git_timeout" ||
                !(await git.completed(expectedTarget, plan.branch, plan.baseSha)))
                throw error;
        }
    }
    async createGitlink(params: Json) {
        if (!params.name?.trim())
            throw new WorkbenchError("workspace_name_required", "workspace name is required");
        if (params.repositories !== undefined)
            throw new WorkbenchError("request_invalid", "Gitlink members are fixed by the outer commit");
        const id = slug(params.id || params.name), requestHash = hash(pythonJson(createRequestParams(params)));
        if (id === "main" || id.startsWith("linked-"))
            throw new WorkbenchError("workspace_id_reserved", "reserved workspace id");
        const branch = String(params.branchName || `feature/${id}`);
        if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/"))
            throw new WorkbenchError("branch_invalid", "invalid shared branch name");
        const record = this.deps.records.recordPath(id);
        let workspace: Json;
        if (this.deps.files.existsSync(record)) {
            workspace = this.deps.directory.get(id);
            if (workspace.layout !== "gitlink" || !["active", "creating", "create_failed"].includes(workspace.state))
                throw new WorkbenchError("workspace_exists", "workspace already exists");
            if (workspace.requestHash !== requestHash) {
                if (params.requestId && workspace.operationId === String(params.requestId))
                    throw new WorkbenchError("request_identity_conflict", "The saved Workspace operation has different Git inputs", { operationId: params.requestId, workspaceId: workspace.id, stage: workspace.state });
                throw new WorkbenchError("workspace_exists", "workspace already exists");
            }
            if (params.requestId && !workspace.operationId) {
                workspace.operationId = String(params.requestId);
                this.deps.records.save(workspace, false);
            }
            if (workspace.state === "active")
                return { ...workspace, operationId: workspace.operationId || params.requestId || id, reused: true };
        }
        else {
            const source = this.deps.directory.get(String(params.sourceWorkspaceId || ""));
            if (source.kind !== "linked-live" || !inside(source.sourceRoot, this.deps.config().sourceRoot))
                throw new WorkbenchError("source_workspace_invalid", "Select an observed Gitlink Workspace as the source");
            const root = source.sourceRoot, treePath = canonical(join(this.deps.config().treesRoot, id));
            if (!inside(treePath, this.deps.config().treesRoot) || this.deps.files.existsSync(treePath))
                throw new WorkbenchError("path_invalid", "workspace target already exists");
            const rootGit = new this.deps.Git(root, this.deps.config().operationTimeout);
            if (await rootGit.root() !== root)
                throw new WorkbenchError("repository_invalid", "Gitlink source is not an exact Git root");
            await rootGit.run(["check-ref-format", "--branch", branch]);
            const rootBaseRef = String(params.rootBaseRef || "HEAD"), rootBaseSha = await rootGit.commit(rootBaseRef);
            const links = await commitGitlinks(root, rootBaseSha, this.deps.config().operationTimeout);
            if (!links.length)
                throw new WorkbenchError("gitlinks_empty", "source commit has no Gitlinks");
            const overrides = params.baseRefs ?? {};
            if (!overrides || Array.isArray(overrides) || typeof overrides !== "object" ||
                Object.keys(overrides).some(key => !links.some(link => link.path === key)))
                throw new WorkbenchError("request_invalid", "invalid child base refs");
            const plans: Json[] = [
                { id: "@root", name: basename(root), repoPath: ".", role: "gitlink-root", mode: "managed",
                    sourcePath: root, worktreePath: treePath, branch, baseRef: rootBaseRef, baseSha: rootBaseSha },
            ];
            for (const link of links) {
                const sourcePath = childPath(root, link.path), childGit = new this.deps.Git(sourcePath, this.deps.config().operationTimeout);
                if (!this.deps.files.existsSync(sourcePath) || await childGit.root() !== sourcePath)
                    throw new WorkbenchError("repository_missing", `Gitlink checkout unavailable: ${link.path}`);
                const baseRef = String(overrides[link.path] || link.sha);
                plans.push({ id: link.path, name: link.path, repoPath: link.path, role: "gitlink-child", mode: "managed",
                    sourcePath, worktreePath: childPath(treePath, link.path), branch, baseRef,
                    baseSha: await childGit.commit(baseRef), pinnedSha: link.sha });
            }
            for (const plan of plans) {
                const git = new this.deps.Git(plan.sourcePath, this.deps.config().operationTimeout);
                if ((await git.run(["show-ref", "--verify", `refs/heads/${branch}`], false)).code === 0)
                    throw new WorkbenchError("branch_exists", `branch already exists in ${plan.repoPath}`);
            }
            workspace = { schemaVersion: 1, requestHash, ...(params.requestId ? { operationId: String(params.requestId) } : {}), id, displayName: params.name.trim(), kind: "managed",
                layout: "gitlink", managed: true, state: "creating", sourceWorkspaceId: source.id,
                sourceRoot: root, treePath, branchName: branch, repositories: plans,
                repositoryIds: plans.map(plan => plan.id), createdAt: this.deps.storage.now() };
            this.deps.records.save(workspace, false);
        }
        try {
            for (const plan of workspace.repositories)
                await this.materializeGitlink(plan, workspace);
            workspace.state = "active";
            delete workspace.issues;
            return { ...this.deps.records.save(workspace, false), operationId: workspace.operationId || params.requestId || id };
        }
        catch (error) {
            workspace.state = "create_failed";
            workspace.issues = [issue(error)];
            this.deps.records.save(workspace, false);
            throw new WorkbenchError("create_failed", "Gitlink creation failed; retry the same request to recover", workspace.issues);
        }
    }
    async create(params: Json) {
        if (params.sourceWorkspaceId)
            return this.createGitlink(params);
        if (!params.name?.trim())
            throw new WorkbenchError("workspace_name_required", "workspace name is required");
        const id = slug(params.id || params.name), requestHash = hash(pythonJson(createRequestParams(params)));
        if (id === "main")
            throw new WorkbenchError("workspace_id_reserved", "reserved workspace id");
        const selected = this.deps.records.select(params), path = this.deps.records.recordPath(id);
        let workspace: Json;
        if (this.deps.files.existsSync(path)) {
            workspace = this.deps.directory.get(id);
            if (!["active", "creating", "create_failed"].includes(workspace.state))
                throw new WorkbenchError("workspace_exists", "workspace already exists");
            if (workspace.requestHash !== requestHash) {
                if (params.requestId && workspace.operationId === String(params.requestId))
                    throw new WorkbenchError("request_identity_conflict", "The saved Workspace operation has different Git inputs", { operationId: params.requestId, workspaceId: workspace.id, stage: workspace.state });
                throw new WorkbenchError("workspace_exists", "workspace already exists");
            }
            if (params.requestId && !workspace.operationId) {
                workspace.operationId = String(params.requestId);
                this.deps.records.save(workspace, false);
            }
            if (workspace.state === "active")
                return { ...this.deps.records.save(workspace), operationId: workspace.operationId || params.requestId || id, reused: true };
        }
        else {
            const treePath = canonical(join(this.deps.config().treesRoot, id));
            if (!inside(treePath, this.deps.config().treesRoot) || this.deps.files.existsSync(treePath))
                throw new WorkbenchError("path_invalid", "workspace target already exists");
            workspace = {
                schemaVersion: 1,
                requestHash,
                ...(params.requestId ? { operationId: String(params.requestId) } : {}),
                id,
                displayName: params.name.trim(),
                kind: "managed",
                managed: true,
                description: params.description || "",
                state: "creating",
                sourceRoot: this.deps.config().sourceRoot,
                treePath,
                repositoryIds: selected.map((item) => item.repo.id),
                repositories: [],
                createdAt: this.deps.storage.now(),
            };
            for (const item of selected)
                workspace.repositories.push(await this.plan(item.repo, workspace, item.baseRef, params.branchTemplate));
            this.deps.files.mkdirSync(treePath, { recursive: true, mode: 0o700 });
            this.deps.records.save(workspace, false);
        }
        try {
            for (const item of selected) {
                let plan = workspace.repositories.find((repo: Json) => repo.id === item.repo.id);
                if (!plan) {
                    plan = await this.plan(item.repo, workspace, item.baseRef, params.branchTemplate);
                    workspace.repositories.push(plan);
                    this.deps.records.save(workspace, false);
                }
                await this.materialize(plan, workspace);
            }
            workspace.state = "active";
            delete workspace.issues;
            return { ...this.deps.records.save(workspace), operationId: workspace.operationId || params.requestId || id };
        }
        catch (error) {
            workspace.state = "create_failed";
            workspace.issues = [issue(error)];
            this.deps.records.save(workspace, false);
            throw new WorkbenchError("create_failed", "creation failed; retry the same request to recover", workspace.issues);
        }
    }
    async add(params: Json) {
        const workspace = this.deps.directory.get(String(params.workspaceId || ""));
        if (workspace.layout === "gitlink")
            throw new WorkbenchError("workspace_layout_invalid", "Gitlink members come from the outer repository; flat additions are unavailable");
        if (!workspace.managed || workspace.state !== "active")
            throw new WorkbenchError("workspace_state_invalid", "only active managed workspaces can add repositories");
        if (!Array.isArray(params.repositories) || !params.repositories.length)
            throw new WorkbenchError("request_invalid", "select repositories to add");
        const journal = Object.assign(Object.create(null), workspace.repositoryAdditions || {}), plans: Json[] = [], existingRepositories: string[] = [], addedRepositories: string[] = [];
        for (const { repo, baseRef } of this.deps.records.select(params)) {
            const existing = workspace.repositories.find((item: Json) => item.id === repo.id), pending = journal[repo.id];
            if (existing) {
                if (baseRef && baseRef !== existing.baseRef)
                    throw new WorkbenchError("repository_base_conflict", "repository already added with a different base");
                existingRepositories.push(repo.id);
                continue;
            }
            if (pending && pending.branch !== `obs/${workspace.id}/${repo.id}`)
                throw new WorkbenchError("worktree_identity_changed", "addition branch identity changed; preserved");
            if (pending && baseRef && baseRef !== pending.baseRef)
                throw new WorkbenchError("repository_base_conflict", "retry with the original base ref");
            plans.push(pending || (await this.plan(repo, workspace, baseRef || repo.defaultBase || "HEAD")));
        }
        if (!plans.length)
            return { ...workspace, addedRepositories, existingRepositories };
        this.deps.activity.assertIdle(workspace.id);
        workspace.repositoryAdditions = journal;
        for (const plan of plans) {
            journal[plan.id] = plan;
            this.deps.records.save(workspace);
            try {
                await this.materialize(plan, workspace);
                workspace.repositories.push(plan);
                addedRepositories.push(plan.id);
                workspace.repositoryIds = workspace.repositories.map((repo: Json) => repo.id);
                delete journal[plan.id];
                delete workspace.repositoryAdditionError;
                this.deps.records.save(workspace);
            }
            catch (error) {
                workspace.repositoryAdditionError = issue(error);
                this.deps.records.save(workspace);
                throw error;
            }
        }
        return {
            ...this.deps.records.save(workspace),
            addedRepositories,
            existingRepositories,
        };
    }
}
