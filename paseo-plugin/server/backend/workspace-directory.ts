import { dirname, join } from "node:path";
import { type Config } from "./config.ts";
import { childPath, commitGitlinks } from "./gitlinks.ts";
import { RecordCatalog } from './record-catalog.ts';
import { displayRecordPaths, filesystemRecordPaths } from './record-paths.ts';
import { inside, issue, WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceCatalog } from './workspace-catalog.ts';
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync" | "readdirSync">;
    Git: WorkspaceInfrastructure["Git"];
    catalog: Pick<WorkspaceCatalog, "mainSelectionPath" | "linkedSelectionPath" | "mainRepositories" | "linkedSelection" | "linkedWorkspace">;
    records: Pick<WorkspaceRecords, "validateRecord" | "invalidRecord" | "read" | "recordPath">;
    config: () => Config;
};
export class WorkspaceDirectory {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    capabilities() {
        const c = this.deps.config();
        return {
            observe: true,
            create: c.managementEnabled,
            prepare: c.managementEnabled && !!c.toolchain,
            agent: c.agentEnabled,
            cleanup: c.managementEnabled,
            remove: c.managementEnabled,
            restore: c.managementEnabled,
            permanentDelete: c.managementEnabled,
        };
    }
    async previewGitlink(params: Json): Promise<Json> {
        const source = this.get(String(params.sourceWorkspaceId || ""));
        if (source.kind !== "linked-live")
            throw new WorkbenchError("source_workspace_invalid", "Gitlink source is not selected");
        const root = source.sourceRoot, git = new this.deps.Git(root, this.deps.config().gitTimeout);
        const ref = String(params.rootBaseRef || "HEAD"), rootSha = await git.commit(ref);
        const links = await commitGitlinks(root, rootSha, this.deps.config().gitTimeout);
        const entries: Json[] = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, links.length) }, async () => {
            while (next < links.length) {
                const link = links[next++], path = childPath(root, link.path);
                let problem: string | null = null;
                try {
                    if (!this.deps.files.existsSync(path))
                        problem = "repository_missing";
                    else {
                        const child = new this.deps.Git(path, this.deps.config().gitTimeout);
                        if (await child.root() !== path || await child.commit(link.sha) !== link.sha)
                            problem = "repository_invalid";
                    }
                }
                catch (error) {
                    problem = issue(error).code;
                }
                entries.push({ path: link.path, pinnedSha: link.sha, ...(problem ? { issue: problem } : {}) });
            }
        }));
        return { sourceWorkspaceId: source.id, rootBaseRef: ref, rootSha,
            links: entries.sort((a, b) => String(a.path).localeCompare(String(b.path))) };
    }
    private recordCatalog = new RecordCatalog();
    private recordValidationMs = 0;
    recordReadHealth() { return { ...this.recordCatalog.health(), validationMs: this.recordValidationMs }; }
    async roster(): Promise<Json[]> {
        const rows = await this.recordCatalog.read(this.deps.config().recordsRoot, [this.deps.catalog.mainSelectionPath(), this.deps.catalog.linkedSelectionPath()]);
        const start = performance.now();
        try {
            const selections = new Map(rows.map(row => [row.path, row.value]));
            const records = rows.filter(row => dirname(row.path) === this.deps.config().recordsRoot);
            return this.assembleList(records.map(({ path, value }) => value && this.deps.records.validateRecord(path, value, displayRecordPaths) || this.deps.records.invalidRecord(path)), {
                main: selections.get(this.deps.catalog.mainSelectionPath()) || null, linked: selections.get(this.deps.catalog.linkedSelectionPath()) || null,
            }, displayRecordPaths);
        }
        finally {
            this.recordValidationMs = performance.now() - start;
        }
    }
    mainWorkspace(snapshot?: Json | null, paths = filesystemRecordPaths): Json {
        const c = this.deps.config();
        return {
            id: "main",
            displayName: c.mainWorkspaceName,
            kind: "live",
            managed: false,
            description: "Current source checkouts",
            state: "active",
            sourceRoot: c.sourceRoot,
            treePath: c.sourceRoot,
            repositories: this.deps.catalog.mainRepositories(snapshot, paths),
            createdAt: null,
            updatedAt: null,
        };
    }
    list(): Json[] {
        return this.assembleList(this.deps.files.readdirSync(this.deps.config().recordsRoot).filter(path => path.endsWith('.json')).map(name => {
            const path = join(this.deps.config().recordsRoot, name);
            return this.deps.records.read(path) || this.deps.records.invalidRecord(path);
        }));
    }
    assembleList(records: Json[], snapshots?: {
        main: Json | null;
        linked: Json | null;
    }, paths = filesystemRecordPaths): Json[] {
        const main = this.mainWorkspace(snapshots?.main, paths);
        records.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
        const linked = this.deps.catalog.linkedSelection(snapshots?.linked, paths).roots.map((entry: Json) => this.deps.catalog.linkedWorkspace(entry, paths));
        return [main, ...linked, ...records];
    }
    get(id: string): Json {
        if (id === "main")
            return this.mainWorkspace();
        if (id.startsWith("linked-")) {
            const linked = this.deps.catalog.linkedSelection().roots.map((entry: Json) => this.deps.catalog.linkedWorkspace(entry)).find((item: Json) => item.id === id);
            if (linked)
                return linked;
        }
        const path = this.deps.records.recordPath(id), value = this.deps.records.read(path);
        if (!value || value.id !== id)
            throw new WorkbenchError(this.deps.files.existsSync(path) ? "record_invalid" : "workspace_missing", `workspace unavailable: ${id}`);
        return value;
    }
    operationStatus(operationId: string): Json {
        if (!operationId.trim())
            throw new WorkbenchError("operation_id_required", "operationId is required");
        const match = this.list().find(item => item.operationId === operationId || item.id === operationId);
        if (!match)
            throw new WorkbenchError("operation_not_found", "Workspace operation was not found");
        return {
            operationId,
            workspaceId: match.id,
            treePath: match.treePath || null,
            stage: match.state || "unknown",
            result: match,
        };
    }
    identify(directory: string) {
        for (const w of this.list().sort((a, b) => String(b.treePath || "").length - String(a.treePath || "").length))
            if (w.state !== "removed" &&
                w.treePath &&
                inside(directory, w.treePath, true))
                return { matched: true, workspaceId: w.id, repoPath: null };
        return { matched: false, workspaceId: null, repoPath: null };
    }
}
