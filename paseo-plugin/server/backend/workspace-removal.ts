import { WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceDirectory } from './workspace-directory.ts';
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "now">;
    directory: Pick<WorkspaceDirectory, "get">;
    records: Pick<WorkspaceRecords, "save">;
};
export class WorkspaceRemoval {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    async remove(params: Json) {
        const w = this.deps.directory.get(String(params.workspaceId || ""));
        if (!w.managed ||
            !["active", "create_failed", "deletion_pending", "removed"].includes(w.state))
            throw new WorkbenchError("workspace_state_invalid", "workspace cannot be removed");
        const tasks = Array.isArray(params.activeTasks) ? params.activeTasks : [];
        if (w.state === "removed")
            return {
                workspaceId: w.id,
                removed: true,
                pending: false,
                state: w.state,
                activeTasks: [],
            };
        w.state = params.lockOnly || tasks.length ? "deletion_pending" : "removed";
        if (w.state === "deletion_pending")
            w.deletion = {
                requestedAt: w.deletion?.requestedAt || this.deps.storage.now(),
                activeTasks: tasks,
                blocksNewTasks: true,
            };
        else
            delete w.deletion;
        this.deps.records.save(w);
        return {
            workspaceId: w.id,
            removed: w.state === "removed",
            pending: w.state === "deletion_pending",
            state: w.state,
            activeTasks: tasks,
        };
    }
    restore(params: Json) {
        const w = this.deps.directory.get(String(params.workspaceId || ""));
        if (w.permanentDeletion?.status === "in_progress")
            throw new WorkbenchError("workspace_delete_in_progress", "A previous permanent deletion must be retried before restoring this Workspace");
        if (!w.managed ||
            !["active", "removed", "deletion_pending"].includes(w.state))
            throw new WorkbenchError("workspace_state_invalid", "workspace cannot be restored");
        if (!this.deps.files.existsSync(w.treePath))
            throw new WorkbenchError("workspace_restore_unavailable", "worktree no longer exists");
        w.state = "active";
        delete w.deletion;
        this.deps.records.save(w);
        return { workspaceId: w.id, restored: true, state: w.state };
    }
}
