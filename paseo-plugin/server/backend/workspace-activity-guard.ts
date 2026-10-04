import { join } from "node:path";
import { type Config } from "./config.ts";
import { WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync" | "readdirSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "readJson" | "optionalJson">;
    preparationActive: (id: string) => boolean;
    config: () => Config;
};
export class WorkspaceActivity {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    assertIdle(id: string) {
        if (this.deps.preparationActive(id))
            throw new WorkbenchError("workspace_task_active", "Runtime preparation is active");
        try {
            const bindings = this.deps.storage.optionalJson(join(this.deps.config().stateRoot, "agent-bindings.json"))
                .bindings || [];
            if (!Array.isArray(bindings))
                throw new Error("invalid bindings");
            if (bindings.some((item: Json) => item.workspaceId === id &&
                ![
                    "completed",
                    "failed",
                    "cancelled",
                    "stopped",
                    "idle",
                    "archived",
                    "closed",
                    "error",
                ].includes(item.status)))
                throw new WorkbenchError("workspace_task_active", "finish execution before changing workspace scope");
            const reviews = join(this.deps.config().stateRoot, "reviews");
            if (this.deps.files.existsSync(reviews))
                for (const path of this.deps.files.readdirSync(reviews).filter((path) => path.endsWith(".json"))) {
                    const item = this.deps.storage.readJson(join(reviews, path));
                    // Review result receipts are stored beside review sessions and have
                    // no lifecycle `status`. They are historical evidence, not an
                    // active task, so they must not keep a removed workspace from being
                    // cleaned up.
                    if (typeof item.status !== "string")
                        continue;
                    if (item.workspaceId === id &&
                        ![
                            "approved",
                            "stopped",
                            "failed",
                            "blocked",
                            "limit_reached",
                        ].includes(item.status))
                        throw new WorkbenchError("workspace_task_active", "finish review before changing workspace scope");
                }
        }
        catch (error) {
            if (error instanceof WorkbenchError)
                throw error;
            throw new WorkbenchError("workspace_task_status_unavailable", "persisted task state could not be checked");
        }
    }
}
