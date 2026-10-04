import { WorkbenchError, issue, type Json } from './storage.ts';
import type { WorkspaceCreation } from './workspace-creation.ts';
import type { WorkspaceDirectory } from './workspace-directory.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
import type { WorkspaceActivity } from './workspace-activity-guard.ts';
type Dependencies = {
    creation: Pick<WorkspaceCreation, 'plan' | 'materialize'>;
    directory: Pick<WorkspaceDirectory, 'get'>;
    records: Pick<WorkspaceRecords, 'select' | 'save'>;
    activity: Pick<WorkspaceActivity, 'assertIdle'>;
};
/** Scope changes have their own journal and cannot expand active execution. */
export class WorkspaceScope {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
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
            plans.push(pending || (await this.deps.creation.plan(repo, workspace, baseRef || repo.defaultBase || "HEAD")));
        }
        if (!plans.length)
            return { ...workspace, addedRepositories, existingRepositories };
        this.deps.activity.assertIdle(workspace.id);
        workspace.repositoryAdditions = journal;
        for (const plan of plans) {
            journal[plan.id] = plan;
            this.deps.records.save(workspace);
            try {
                await this.deps.creation.materialize(plan, workspace);
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
