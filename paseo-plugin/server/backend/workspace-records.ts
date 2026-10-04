import { basename, join, resolve } from "node:path";
import { type Config, type Repository } from "./config.ts";
import { displayRecordPaths, filesystemRecordPaths } from './record-paths.ts';
import { canonical, slug, WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "atomicJson" | "readJson" | "now">;
    config: () => Config;
};
export class WorkspaceRecords {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    sourceRecord(repo: Repository, paths = filesystemRecordPaths): Json {
        const path = paths.repositoryPath(this.deps.config(), repo);
        return {
            id: repo.id,
            name: repo.name,
            repoPath: repo.path,
            sourcePath: path,
            worktreePath: path,
            baseRef: null,
            baseSha: null,
            branch: null,
            mode: "live",
            role: repo.role,
        };
    }
    recordPath(id: string) {
        return join(this.deps.config().recordsRoot, `${slug(id)}.json`);
    }
    read(path: string): Json | null {
        try {
            return this.validateRecord(path, this.deps.storage.readJson(path));
        }
        catch {
            return null;
        }
    }
    validateRecord(path: string, value: Json, paths = filesystemRecordPaths): Json | null {
        const { canonical, inside, repositoryPath, childPath } = paths;
        try {
            if (value.schemaVersion !== 1 ||
                value.id !== basename(path, ".json") ||
                !Array.isArray(value.repositories) ||
                !inside(value.treePath, this.deps.config().treesRoot))
                return null;
            if (value.layout === "gitlink") {
                if (!inside(value.sourceRoot, this.deps.config().sourceRoot) || value.repositories[0]?.role !== "gitlink-root" ||
                    canonical(value.repositories[0]?.sourcePath || "") !== canonical(value.sourceRoot) ||
                    canonical(value.repositories[0]?.worktreePath || "") !== canonical(value.treePath))
                    return null;
                for (const repo of value.repositories.slice(1)) {
                    if (repo.role !== "gitlink-child" || !repo.repoPath ||
                        canonical(repo.sourcePath) !== childPath(value.sourceRoot, repo.repoPath) ||
                        canonical(repo.worktreePath) !== childPath(value.treePath, repo.repoPath))
                        return null;
                }
                return value;
            }
            for (const repo of value.repositories) {
                const configured = this.deps.config().repositories.find((item) => item.id === repo.id);
                const configuredSourceMatches = configured && (canonical(repo.sourcePath) === repositoryPath(this.deps.config(), configured) ||
                    // Saved source paths are canonical, whereas configuration may retain
                    // an in-root alias. Display can retain its identity without resolving
                    // that alias; authoritative reads below still use filesystem paths.
                    paths === displayRecordPaths && repo.repoPath === configured.path && inside(repo.sourcePath, this.deps.config().sourceRoot, true));
                const adoptedSourceMatches = value.origin === "adopted" && repo.repoPath &&
                    canonical(repo.sourcePath) === canonical(join(this.deps.config().sourceRoot, repo.repoPath)) &&
                    inside(repo.sourcePath, this.deps.config().sourceRoot) &&
                    canonical(repo.worktreePath) === canonical(join(value.treePath, repo.repoPath));
                if (!configuredSourceMatches && !adoptedSourceMatches ||
                    !inside(repo.worktreePath, value.treePath))
                    return null;
            }
            return value;
        }
        catch {
            return null;
        }
    }
    invalidRecord(path: string): Json {
        return { id: basename(path, '.json'), displayName: basename(path, '.json'), kind: 'managed', managed: true, state: 'record_invalid', repositories: [] };
    }
    save(value: Json, manifest = true): Json {
        const record: Json = { ...value, updatedAt: this.deps.storage.now() };
        this.deps.storage.atomicJson(this.recordPath(record.id), record);
        // The durable record owns recovery. A manifest failure is visible and a
        // repeated request reconciles it without repeating Git mutations.
        if (manifest && record.layout !== "gitlink" && this.deps.files.existsSync(record.treePath))
            this.deps.storage.atomicJson(join(record.treePath, ".workspace/manifest.json"), record);
        return record;
    }
    matches(repo: Json, ref: unknown) {
        if (typeof ref !== "string" || !ref.trim())
            return false;
        return ([
            repo.id,
            repo.name,
            repo.repoPath,
            repo.sourcePath,
            repo.worktreePath,
        ].includes(ref) ||
            [repo.sourcePath, repo.worktreePath]
                .filter(Boolean)
                .some((path) => canonical(resolve(this.deps.config().sourceRoot, ref)) === canonical(path)));
    }
    repository(workspace: Json, ref: unknown): Json {
        const matches = workspace.repositories.filter((repo: Json) => this.matches(repo, ref));
        if (matches.length !== 1)
            throw new WorkbenchError(matches.length ? "repository_ambiguous" : "repository_missing", "repository reference is unavailable or ambiguous");
        return matches[0];
    }
    select(params: Json): Array<{
        repo: Repository;
        baseRef: string | null;
    }> {
        const candidates = this.deps.config().repositories.filter((repo) => repo.enabled);
        if (params.repositories !== undefined &&
            !Array.isArray(params.repositories))
            throw new WorkbenchError("request_invalid", "repositories must be an array");
        const selected: Repository[] = [];
        for (const requested of params.repositories ??
            candidates.map((repo) => repo.id)) {
            const matches = candidates.filter((repo) => this.matches(this.sourceRecord(repo), requested));
            if (matches.length !== 1)
                throw new WorkbenchError("repository_invalid", "unknown, disabled or ambiguous repository");
            if (!selected.includes(matches[0]))
                selected.push(matches[0]);
        }
        if (!selected.length)
            throw new WorkbenchError("repositories_empty", "select at least one repository");
        const bases = params.baseRefs ?? {};
        if (!bases || typeof bases !== "object" || Array.isArray(bases))
            throw new WorkbenchError("request_invalid", "baseRefs must be an object");
        for (const [key, value] of Object.entries(bases))
            if (typeof value !== "string" ||
                !value.trim() ||
                !selected.some((repo) => this.matches(this.sourceRecord(repo), key)))
                throw new WorkbenchError("request_invalid", "invalid base ref mapping");
        return selected.map((repo) => {
            const refs = Object.entries(bases)
                .filter(([key]) => this.matches(this.sourceRecord(repo), key))
                .map(([, value]) => String(value));
            if (new Set(refs).size > 1)
                throw new WorkbenchError("request_invalid", "conflicting base refs");
            return { repo, baseRef: refs[0] || null };
        });
    }
}
