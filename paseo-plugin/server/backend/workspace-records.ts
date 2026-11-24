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
    private matchesAlias(repo: Json, ref: string) {
        return ([
            repo.name,
            repo.repoPath,
            repo.sourcePath,
            repo.worktreePath,
        ].includes(ref) ||
            [repo.sourcePath, repo.worktreePath]
                .filter(Boolean)
                .some((path) => canonical(resolve(this.deps.config().sourceRoot, ref)) === canonical(path)));
    }
    private matchingRepositories<T extends Json>(repositories: T[], ref: unknown, record: (repo: T) => Json = repo => repo): T[] {
        if (typeof ref !== "string" || !ref.trim())
            return [];
        const exactIds = repositories.filter(repo => repo.id === ref);
        return exactIds.length ? exactIds : repositories.filter(repo => this.matchesAlias(record(repo), ref));
    }
    repository(workspace: Json, ref: unknown): Json {
        const matches = this.matchingRepositories(workspace.repositories, ref);
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
        const sourceRecord = (repo: Repository) => this.sourceRecord(repo);
        const resolveReference = (repositories: Repository[], requested: unknown, field: "repositories" | "baseRefs") => {
            const matches = this.matchingRepositories(repositories, requested, sourceRecord);
            if (matches.length === 1)
                return matches[0];
            const code = field === "repositories" ? "repository_invalid" : "request_invalid";
            if (matches.length > 1)
                throw new WorkbenchError(code, `The ${field} reference ${JSON.stringify(requested)} is ambiguous. Use a configured repository ID or a unique absolute source path.`, {
                    requested,
                    matches: matches.map(repo => ({ id: repo.id, path: sourceRecord(repo).sourcePath })),
                });
            const message = field === "repositories" ? "Unknown or disabled repository. Use an enabled repository ID or absolute source path."
                : "Each baseRefs key must identify a selected repository.";
            throw new WorkbenchError(code, message, { requested });
        };
        const selected: Repository[] = [];
        for (const requested of params.repositories ??
            candidates.map((repo) => repo.id)) {
            const repo = resolveReference(candidates, requested, "repositories");
            if (!selected.includes(repo))
                selected.push(repo);
        }
        if (!selected.length)
            throw new WorkbenchError("repositories_empty", "select at least one repository");
        const bases = params.baseRefs ?? {};
        if (!bases || typeof bases !== "object" || Array.isArray(bases))
            throw new WorkbenchError("request_invalid", "baseRefs must be an object");
        const baseRefByRepository = new Map<Repository, string>();
        for (const [key, value] of Object.entries(bases)) {
            if (typeof value !== "string" || !value.trim())
                throw new WorkbenchError("request_invalid", "Each baseRefs value must be a non-empty Git ref.", { requested: key });
            const repo = resolveReference(selected, key, "baseRefs");
            const previous = baseRefByRepository.get(repo);
            if (previous !== undefined && previous !== value)
                throw new WorkbenchError("request_invalid", `Conflicting base refs for repository ${repo.id}.`);
            baseRefByRepository.set(repo, value);
        }
        return selected.map(repo => ({ repo, baseRef: baseRefByRepository.get(repo) ?? null }));
    }
}
