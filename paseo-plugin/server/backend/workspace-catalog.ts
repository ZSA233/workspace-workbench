import { basename, join } from "node:path";
import { discover, repositoryPath, type Config } from "./config.ts";
import { indexGitlinks, linkedCandidates, type Gitlink } from "./gitlinks.ts";
import { orphanCandidates, orphanPreview } from "./orphans.ts";
import { filesystemRecordPaths } from './record-paths.ts';
import { canonical, hash, inside, issue, slug, WorkbenchError, type Json } from "./storage.ts";
import type { WorkspaceInfrastructure } from './workspace-infrastructure.ts';
import type { WorkspaceRecords } from './workspace-records.ts';
type OrphanScanSnapshot = {
    state: "ready" | "scanning" | "stale" | "failed";
    candidates: Json[];
    scannedDirectories: number;
    startedAt?: string;
    completedAt?: string;
    reason?: string;
    promise?: Promise<void>;
};
type DiscoveryScanSnapshot = {
    state: "ready" | "scanning" | "stale" | "failed";
    repositories: Json[];
    incomplete: boolean;
    scannedDirectories: number;
    reason?: string;
    startedAt?: string;
    completedAt?: string;
    promise?: Promise<void>;
};
type Dependencies = {
    files: Pick<WorkspaceInfrastructure["files"], "existsSync">;
    storage: Pick<WorkspaceInfrastructure["storage"], "atomicJson" | "readJson" | "now">;
    clock: WorkspaceInfrastructure["clock"];
    records: Pick<WorkspaceRecords, "sourceRecord" | "read" | "recordPath">;
    config: () => Config;
    onDiscoveryChanged?: () => void;
    onOrphanScanChanged?: () => void;
};
export class WorkspaceCatalog {
    private deps: Dependencies;
    constructor(deps: Dependencies) { this.deps = deps; }
    private orphanScan: OrphanScanSnapshot = { state: "stale", candidates: [], scannedDirectories: 0 };
    private orphanScanRevision = 0;
    private discoveryScans = new Map<boolean, DiscoveryScanSnapshot>();
    mainSelectionPath() {
        return join(this.deps.config().stateRoot, "main-observation.json");
    }
    linkedSelectionPath() { return join(this.deps.config().stateRoot, "linked-workspaces.json"); }
    linkedSelection(snapshot?: Json | null, paths = filesystemRecordPaths): Json {
        const { canonical, inside } = paths;
        try {
            const value = snapshot === undefined ? this.deps.storage.readJson(this.linkedSelectionPath()) : snapshot;
            return value?.schemaVersion === 1 && Array.isArray(value.roots)
                ? { ...value, roots: value.roots.filter((entry: Json) => typeof entry.path === "string" && inside(canonical(entry.path), this.deps.config().sourceRoot)) }
                : { schemaVersion: 1, revision: 0, roots: [] };
        }
        catch {
            return { schemaVersion: 1, revision: 0, roots: [] };
        }
    }
    linkedId(path: string, paths = filesystemRecordPaths) { return `linked-${hash(paths.canonical(path)).slice(0, 16)}`; }
    linkedRepositories(root: string, links: Gitlink[], treePath = root, paths = filesystemRecordPaths): Json[] {
        const { childPath } = paths;
        return [
            { id: "@root", name: basename(root), repoPath: ".", sourcePath: root, worktreePath: treePath, mode: "live", role: "gitlink-root", baseRef: null, baseSha: null },
            ...links.map(link => ({ id: link.path, name: link.path, repoPath: link.path,
                sourcePath: childPath(root, link.path), worktreePath: childPath(treePath, link.path),
                mode: "live", role: "gitlink-child", pinnedSha: link.sha, baseRef: null, baseSha: null })),
        ];
    }
    linkedWorkspace(entry: Json, paths = filesystemRecordPaths): Json {
        const { canonical, childPath } = paths;
        const root = canonical(String(entry.path));
        const links = (Array.isArray(entry.links) ? entry.links : []).filter((link: Json) => {
            try {
                childPath(root, String(link.path));
                return /^[0-9a-f]{40}$/.test(String(link.sha));
            }
            catch {
                return false;
            }
        });
        return { id: this.linkedId(root, paths), displayName: String(entry.name || basename(root)), kind: "linked-live", layout: "gitlink",
            managed: false, state: "active", sourceRoot: root, treePath: root,
            repositories: this.linkedRepositories(root, links, root, paths),
            description: "Gitlink workspace", createdAt: null, updatedAt: entry.updatedAt || null };
    }
    async linkedCandidates(): Promise<Json> {
        const scan = await linkedCandidates(this.deps.config()), saved = this.linkedSelection();
        const byPath = new Map<string, Json>(scan.candidates.map(item => [canonical(item.path), { ...item, exists: true }]));
        for (const item of saved.roots)
            if (!byPath.has(canonical(String(item.path))))
                byPath.set(canonical(String(item.path)), { ...item, exists: this.deps.files.existsSync(String(item.path)), missing: !this.deps.files.existsSync(String(item.path)) });
        const selected = new Set<string>(saved.roots.map((item: Json) => canonical(String(item.path))));
        return { schemaVersion: 1, revision: saved.revision, sourceRoot: this.deps.config().sourceRoot,
            scan: { incomplete: scan.incomplete, reason: scan.reason, scannedDirectories: scan.scannedDirectories },
            repositories: [...byPath.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)))
                .map(item => ({ ...item, selected: selected.has(canonical(String(item.path))) })) };
    }
    async saveLinkedSelection(params: Json): Promise<Json> {
        const current = await this.linkedCandidates();
        if (Number(params.revision) !== current.revision)
            throw new WorkbenchError("selection_conflict", "Gitlink Workspace selection changed", current);
        if (!Array.isArray(params.repositories))
            throw new WorkbenchError("request_invalid", "repositories must be an array");
        const available = new Map<string, Json>(current.repositories.map((item: Json) => [canonical(String(item.path)), item]));
        const roots: Json[] = [];
        for (const requested of new Set(params.repositories.map(String))) {
            const path = canonical(requested), candidate = available.get(path);
            if (!candidate || !inside(path, this.deps.config().sourceRoot) || !Array.isArray(candidate.links))
                throw new WorkbenchError("repository_not_discovered", "Gitlink root is not available in this project");
            roots.push({ path, name: candidate.name, links: candidate.links, updatedAt: this.deps.storage.now() });
        }
        this.deps.storage.atomicJson(this.linkedSelectionPath(), { schemaVersion: 1, revision: current.revision + 1, roots });
        return this.linkedCandidates();
    }
    async refreshLinked(workspace: Json, signal?: AbortSignal): Promise<Json> {
        if (workspace.kind !== "linked-live")
            return workspace;
        try {
            const root = workspace.sourceRoot;
            const links = await indexGitlinks(root, this.deps.config().gitTimeout, signal);
            return { ...workspace, repositories: this.linkedRepositories(root, links) };
        }
        catch (error) {
            return { ...workspace, issues: [issue(error)] };
        }
    }
    mainSelection(snapshot?: Json | null): Json | null {
        try {
            const value = snapshot === undefined ? this.deps.storage.readJson(this.mainSelectionPath()) : snapshot;
            return value?.schemaVersion === 1 && Array.isArray(value.repositories) ? value : null;
        }
        catch {
            return null;
        }
    }
    async mainCandidates(): Promise<Json> {
        const configured = this.deps.config().repositories.map((repo) => ({
            id: repo.id, name: repo.name, path: repositoryPath(this.deps.config(), repo),
            configured: true, exists: this.deps.files.existsSync(repositoryPath(this.deps.config(), repo)),
        }));
        const scan = await this.discoverySnapshot(true, 250);
        const found = scan.repositories.map((repo) => ({
            id: String(repo.id), name: String(repo.display_name || repo.id), path: canonical(String(repo.path)),
            configured: false, exists: this.deps.files.existsSync(String(repo.path)),
        }));
        const byPath = new Map<string, Json>();
        for (const repo of [...configured, ...found])
            byPath.set(canonical(repo.path), repo);
        const selection = this.mainSelection();
        for (const repo of selection?.repositories || []) {
            const path = canonical(String(repo.path || ""));
            if (path && !byPath.has(path))
                byPath.set(path, {
                    id: String(repo.id || slug(basename(path))), name: String(repo.name || basename(path)),
                    path, configured: false, exists: this.deps.files.existsSync(path), missing: !this.deps.files.existsSync(path),
                });
        }
        const selected = new Set<string>((selection?.repositories || this.deps.config().repositories.filter(repo => repo.enabled).map(repo => ({ path: repositoryPath(this.deps.config(), repo) }))).map((repo: Json) => canonical(String(repo.path))));
        return {
            schemaVersion: 1,
            revision: Number(selection?.revision || 0),
            sourceRoot: this.deps.config().sourceRoot,
            scan: { incomplete: scan.incomplete, ...(scan.reason ? { reason: scan.reason } : {}), scannedDirectories: scan.scannedDirectories },
            repositories: [...byPath.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))).map(repo => ({
                ...repo, selected: selected.has(canonical(String(repo.path))), missing: !repo.exists,
            })),
        };
    }
    startDiscoveryScan(includeManual: boolean, force = false): void {
        const previous = this.discoveryScans.get(includeManual) || { state: "stale", repositories: [], incomplete: false, scannedDirectories: 0 };
        if (previous.promise)
            return;
        if (!force && previous.state === "ready" && previous.completedAt && this.deps.clock.millis() - Date.parse(previous.completedAt) < 300000)
            return;
        const startedAt = this.deps.storage.now();
        this.discoveryScans.set(includeManual, {
            ...previous,
            state: previous.repositories.length ? "stale" : "scanning",
            startedAt,
            ...(previous.completedAt ? { completedAt: previous.completedAt } : {}),
        });
        const promise = discover(this.deps.config(), includeManual).then((scan) => {
            this.discoveryScans.set(includeManual, {
                state: "ready",
                repositories: scan.repositories,
                incomplete: scan.incomplete,
                scannedDirectories: scan.scannedDirectories,
                ...(scan.reason ? { reason: String(scan.reason) } : {}),
                startedAt,
                completedAt: this.deps.storage.now(),
            });
            this.deps.onDiscoveryChanged?.();
        }).catch((error) => {
            this.discoveryScans.set(includeManual, {
                state: "failed",
                repositories: previous.repositories,
                incomplete: previous.incomplete,
                scannedDirectories: previous.scannedDirectories,
                ...(previous.reason ? { reason: previous.reason } : {}),
                startedAt,
                ...(previous.completedAt ? { completedAt: previous.completedAt } : {}),
                reason: issue(error).code,
            });
            this.deps.onDiscoveryChanged?.();
        }).finally(() => {
            const current = this.discoveryScans.get(includeManual);
            if (current?.promise === promise) {
                const { promise: _promise, ...snapshot } = current;
                this.discoveryScans.set(includeManual, snapshot);
            }
        });
        this.discoveryScans.set(includeManual, { ...this.discoveryScans.get(includeManual)!, promise });
    }
    async discoverySnapshot(includeManual = false, waitMs = 0, signal?: AbortSignal): Promise<Omit<DiscoveryScanSnapshot, "promise">> {
        this.startDiscoveryScan(includeManual);
        const current = this.discoveryScans.get(includeManual)!;
        if (current.promise && waitMs > 0) {
            const wait = new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const onAbort = () => {
                    if (timer)
                        clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(new WorkbenchError("observer_cancelled", "observation cancelled"));
                };
                if (signal?.aborted)
                    return onAbort();
                signal?.addEventListener("abort", onAbort, { once: true });
                timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, waitMs);
            });
            await Promise.race([current.promise, wait]);
        }
        const { promise: _promise, ...snapshot } = this.discoveryScans.get(includeManual)!;
        return snapshot;
    }
    async saveMainSelection(params: Json): Promise<Json> {
        const current = await this.mainCandidates();
        if (Number(params.revision) !== current.revision)
            throw new WorkbenchError("selection_conflict", "Main workspace repository selection changed; reload and retry", current);
        if (!Array.isArray(params.repositories))
            throw new WorkbenchError("request_invalid", "repositories must be an array");
        const available = new Map<string, Json>(current.repositories.map((repo: Json) => [canonical(String(repo.path)), repo] as [
            string,
            Json
        ]));
        const selected: Json[] = [];
        for (const value of params.repositories) {
            const path = canonical(String(value));
            const repo = available.get(path);
            if (!repo)
                throw new WorkbenchError("repository_not_discovered", "Repository is outside the discovered project scope");
            selected.push({ id: repo.id, name: repo.name, path: repo.path });
        }
        this.deps.storage.atomicJson(this.mainSelectionPath(), { schemaVersion: 1, revision: current.revision + 1, repositories: selected, updatedAt: this.deps.storage.now() });
        const selectedPaths = new Set(selected.map(repo => canonical(String(repo.path))));
        return { ...current, revision: current.revision + 1,
            repositories: current.repositories.map((repo: Json) => ({ ...repo, selected: selectedPaths.has(canonical(String(repo.path))) })) };
    }
    mainRepositories(snapshot?: Json | null, paths = filesystemRecordPaths): Json[] {
        const saved = this.mainSelection(snapshot);
        if (!saved)
            return this.deps.config().repositories.filter(repo => repo.enabled).map(repo => this.deps.records.sourceRecord(repo, paths));
        return saved.repositories.map((repo: Json) => this.deps.records.sourceRecord({ id: String(repo.id), name: String(repo.name), path: String(repo.path), enabled: true, role: null, defaultBase: null }, paths));
    }
    startOrphanScan(force = false): void {
        if (this.orphanScan.promise)
            return;
        if (!force && this.orphanScan.state === "ready" && this.orphanScan.completedAt && this.deps.clock.millis() - Date.parse(this.orphanScan.completedAt) < 300000)
            return;
        const previous = this.orphanScan;
        const revision = this.orphanScanRevision;
        const startedAt = this.deps.storage.now();
        this.orphanScan = {
            state: previous.candidates.length ? "stale" : "scanning",
            candidates: previous.candidates,
            scannedDirectories: previous.scannedDirectories,
            startedAt,
            ...(previous.completedAt ? { completedAt: previous.completedAt } : {}),
        };
        const promise = orphanCandidates(this.deps.config(), (path, treePath) => {
            const record = this.deps.records.read(path);
            return !!record && canonical(record.treePath) === treePath &&
                !(record.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state));
        }).then((scan) => {
            const candidates = scan.candidates.map(candidate => {
                const record = this.deps.records.read(this.deps.records.recordPath(candidate.id));
                return { ...candidate, recordInvalid: !!candidate.recordInvalid && !record,
                    resume: record?.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state) };
            });
            if (revision !== this.orphanScanRevision) {
                this.orphanScan = { state: "stale", candidates: this.orphanScan.candidates, scannedDirectories: scan.scannedDirectories, startedAt, completedAt: this.orphanScan.completedAt, reason: "mutation" };
                this.deps.onOrphanScanChanged?.();
                return;
            }
            this.orphanScan = { state: "ready", candidates, scannedDirectories: scan.scannedDirectories, startedAt, completedAt: this.deps.storage.now() };
            this.deps.onOrphanScanChanged?.();
        }).catch((error) => {
            if (error instanceof WorkbenchError && error.code === "observer_cancelled")
                return;
            this.orphanScan = { state: "failed", candidates: previous.candidates, scannedDirectories: previous.scannedDirectories, startedAt, completedAt: previous.completedAt, reason: issue(error).code };
            this.deps.onOrphanScanChanged?.();
        }).finally(() => {
            if (this.orphanScan.promise === promise)
                delete this.orphanScan.promise;
        });
        this.orphanScan.promise = promise;
    }
    async orphanSnapshot(force = false, waitMs = 250, signal?: AbortSignal): Promise<OrphanScanSnapshot> {
        const waitForFresh = force || this.orphanScan.reason === "mutation";
        this.startOrphanScan(force);
        const pending = this.orphanScan.promise;
        if (pending && (waitForFresh || this.orphanScan.candidates.length === 0) && waitMs > 0) {
            const boundedWait = new Promise<void>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const onAbort = () => {
                    if (timer)
                        clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    reject(new WorkbenchError("observer_cancelled", "observation cancelled"));
                };
                if (signal?.aborted)
                    return onAbort();
                signal?.addEventListener("abort", onAbort, { once: true });
                timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, waitMs);
            });
            await Promise.race([pending, boundedWait]);
        }
        const { promise: _promise, ...snapshot } = this.orphanScan;
        return snapshot;
    }
    invalidateOrphanScan(): void {
        this.orphanScanRevision++;
        this.orphanScan = { ...this.orphanScan, state: this.orphanScan.promise ? "scanning" : "stale", completedAt: undefined, reason: "mutation" };
    }
    async orphanCandidates(): Promise<Json[]> { return (await this.orphanSnapshot()).candidates; }
    observationSupplementSnapshot(): Json {
        const { promise: _orphanPromise, ...orphanScan } = this.orphanScan;
        const { promise: _discoveryPromise, ...discovered } = this.discoveryScans.get(false) || { state: 'stale', repositories: [], incomplete: true, scannedDirectories: 0 };
        return { orphanScan, discovered };
    }
    async orphanPreview(id: string, signal?: AbortSignal) {
        const preview = await orphanPreview(this.deps.config(), id, signal);
        const record = this.deps.records.read(this.deps.records.recordPath(id));
        if (record?.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state))
            return { ...preview, fingerprint: record.adoption.fingerprint, plannedBranches: record.adoption.branches,
                warnings: preview.warnings.filter((item: Json) => item.code !== "record_invalid"), resume: true };
        return preview;
    }
}
