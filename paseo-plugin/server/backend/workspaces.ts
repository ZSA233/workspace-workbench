import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, resolve, basename, dirname, relative } from "node:path";
import { discover, type Config, type Repository, repositoryPath } from "./config.ts";
import { Git } from "./git.ts";
import { childPath, indexGitlinks, commitGitlinks, linkedCandidates, type Gitlink } from "./gitlinks.ts";
import { orphanCandidates, orphanPreview } from "./orphans.ts";
import {
  atomicJson,
  canonical,
  hash,
  inside,
  now,
  optionalJson,
  readJson,
  SerialQueue,
  slug,
  WorkbenchError,
  issue,
  type Json,
} from "./storage.ts";

function pythonJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${pythonJson(key)}: ${pythonJson(value[key])}`)
      .join(", ")}}`;
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export class Workspaces {
  config: Config;
  readonly mutations = new SerialQueue();
  constructor(config: Config) {
    this.config = config;
    for (const root of [
      config.stateRoot,
      config.workspaceRoot,
      config.recordsRoot,
      config.treesRoot,
    ])
      mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  capabilities() {
    const c = this.config;
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
  private mainSelectionPath() {
    return join(this.config.stateRoot, "main-observation.json");
  }
  private linkedSelectionPath() { return join(this.config.stateRoot, "linked-workspaces.json"); }
  private linkedSelection(): Json {
    try {
      const value = readJson(this.linkedSelectionPath());
      return value.schemaVersion === 1 && Array.isArray(value.roots)
        ? { ...value, roots: value.roots.filter((entry: Json) => typeof entry.path === "string" && inside(canonical(entry.path), this.config.sourceRoot)) }
        : { schemaVersion: 1, revision: 0, roots: [] };
    } catch { return { schemaVersion: 1, revision: 0, roots: [] }; }
  }
  linkedId(path: string) { return `linked-${hash(canonical(path)).slice(0, 16)}`; }
  private linkedRepositories(root: string, links: Gitlink[], treePath = root): Json[] {
    return [
      { id: "@root", name: basename(root), repoPath: ".", sourcePath: root, worktreePath: treePath, mode: "live", role: "gitlink-root", baseRef: null, baseSha: null },
      ...links.map(link => ({ id: link.path, name: link.path, repoPath: link.path,
        sourcePath: childPath(root, link.path), worktreePath: childPath(treePath, link.path),
        mode: "live", role: "gitlink-child", pinnedSha: link.sha, baseRef: null, baseSha: null })),
    ];
  }
  private linkedWorkspace(entry: Json): Json {
    const root = canonical(String(entry.path));
    const links = (Array.isArray(entry.links) ? entry.links : []).filter((link: Json) => {
      try { childPath(root, String(link.path)); return /^[0-9a-f]{40}$/.test(String(link.sha)); }
      catch { return false; }
    });
    return { id: this.linkedId(root), displayName: String(entry.name || basename(root)), kind: "linked-live", layout: "gitlink",
      managed: false, state: "active", sourceRoot: root, treePath: root,
      repositories: this.linkedRepositories(root, links),
      description: "Gitlink workspace", createdAt: null, updatedAt: entry.updatedAt || null };
  }
  async linkedCandidates(): Promise<Json> {
    const scan = await linkedCandidates(this.config), saved = this.linkedSelection();
    const byPath = new Map<string, Json>(scan.candidates.map(item => [canonical(item.path), { ...item, exists: true }]));
    for (const item of saved.roots) if (!byPath.has(canonical(String(item.path))))
      byPath.set(canonical(String(item.path)), { ...item, exists: existsSync(String(item.path)), missing: !existsSync(String(item.path)) });
    const selected = new Set<string>(saved.roots.map((item: Json) => canonical(String(item.path))));
    return { schemaVersion: 1, revision: saved.revision, sourceRoot: this.config.sourceRoot,
      scan: { incomplete: scan.incomplete, reason: scan.reason, scannedDirectories: scan.scannedDirectories },
      repositories: [...byPath.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .map(item => ({ ...item, selected: selected.has(canonical(String(item.path))) })) };
  }
  async saveLinkedSelection(params: Json): Promise<Json> {
    const current = await this.linkedCandidates();
    if (Number(params.revision) !== current.revision) throw new WorkbenchError("selection_conflict", "Gitlink Workspace selection changed", current);
    if (!Array.isArray(params.repositories)) throw new WorkbenchError("request_invalid", "repositories must be an array");
    const available = new Map<string, Json>(current.repositories.map((item: Json) => [canonical(String(item.path)), item]));
    const roots: Json[] = [];
    for (const requested of new Set(params.repositories.map(String))) {
      const path = canonical(requested), candidate = available.get(path);
      if (!candidate || !inside(path, this.config.sourceRoot) || !Array.isArray(candidate.links))
        throw new WorkbenchError("repository_not_discovered", "Gitlink root is not available in this project");
      roots.push({ path, name: candidate.name, links: candidate.links, updatedAt: now() });
    }
    atomicJson(this.linkedSelectionPath(), { schemaVersion: 1, revision: current.revision + 1, roots });
    return this.linkedCandidates();
  }
  async refreshLinked(workspace: Json): Promise<Json> {
    if (workspace.kind !== "linked-live") return workspace;
    try {
      const root = workspace.sourceRoot;
      const links = await indexGitlinks(root, this.config.gitTimeout);
      return { ...workspace, repositories: this.linkedRepositories(root, links) };
    } catch (error) { return { ...workspace, issues: [issue(error)] }; }
  }
  async previewGitlink(params: Json): Promise<Json> {
    const source = this.get(String(params.sourceWorkspaceId || ""));
    if (source.kind !== "linked-live") throw new WorkbenchError("source_workspace_invalid", "Gitlink source is not selected");
    const root = source.sourceRoot, git = new Git(root, this.config.gitTimeout);
    const ref = String(params.rootBaseRef || "HEAD"), rootSha = await git.commit(ref);
    const links = await commitGitlinks(root, rootSha, this.config.gitTimeout);
    const entries: Json[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, links.length) }, async () => {
      while (next < links.length) {
        const link = links[next++], path = childPath(root, link.path);
        let problem: string | null = null;
        try {
          if (!existsSync(path)) problem = "repository_missing";
          else {
            const child = new Git(path, this.config.gitTimeout);
            if (await child.root() !== path || await child.commit(link.sha) !== link.sha) problem = "repository_invalid";
          }
        } catch (error) { problem = issue(error).code; }
        entries.push({ path: link.path, pinnedSha: link.sha, ...(problem ? { issue: problem } : {}) });
      }
    }));
    return { sourceWorkspaceId: source.id, rootBaseRef: ref, rootSha,
      links: entries.sort((a, b) => String(a.path).localeCompare(String(b.path))) };
  }
  private mainSelection(): Json | null {
    try {
      const value = readJson(this.mainSelectionPath());
      return value.schemaVersion === 1 && Array.isArray(value.repositories) ? value : null;
    } catch { return null; }
  }
  async mainCandidates(): Promise<Json> {
    const configured = this.config.repositories.map((repo) => ({
      id: repo.id, name: repo.name, path: repositoryPath(this.config, repo),
      configured: true, exists: existsSync(repositoryPath(this.config, repo)),
    }));
    const scan = await discover(this.config, true);
    const found = scan.repositories.map((repo) => ({
      id: String(repo.id), name: String(repo.display_name || repo.id), path: canonical(String(repo.path)),
      configured: false, exists: existsSync(String(repo.path)),
    }));
    const byPath = new Map<string, Json>();
    for (const repo of [...configured, ...found]) byPath.set(canonical(repo.path), repo);
    const selection = this.mainSelection();
    for (const repo of selection?.repositories || []) {
      const path = canonical(String(repo.path || ""));
      if (path && !byPath.has(path)) byPath.set(path, {
        id: String(repo.id || slug(basename(path))), name: String(repo.name || basename(path)),
        path, configured: false, exists: existsSync(path), missing: !existsSync(path),
      });
    }
    const selected = new Set<string>((selection?.repositories || this.config.repositories.filter(repo => repo.enabled).map(repo => ({ path: repositoryPath(this.config, repo) }))).map((repo: Json) => canonical(String(repo.path))));
    return {
      schemaVersion: 1,
      revision: Number(selection?.revision || 0),
      sourceRoot: this.config.sourceRoot,
      scan: { incomplete: scan.incomplete, ...(scan.reason ? { reason: scan.reason } : {}), scannedDirectories: scan.scannedDirectories },
      repositories: [...byPath.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))).map(repo => ({
        ...repo, selected: selected.has(canonical(String(repo.path))), missing: !repo.exists,
      })),
    };
  }
  async saveMainSelection(params: Json): Promise<Json> {
    const current = await this.mainCandidates();
    if (Number(params.revision) !== current.revision)
      throw new WorkbenchError("selection_conflict", "Main workspace repository selection changed; reload and retry", current);
    if (!Array.isArray(params.repositories))
      throw new WorkbenchError("request_invalid", "repositories must be an array");
    const available = new Map<string, Json>(current.repositories.map((repo: Json) => [canonical(String(repo.path)), repo] as [string, Json]));
    const selected: Json[] = [];
    for (const value of params.repositories) {
      const path = canonical(String(value));
      const repo = available.get(path);
      if (!repo) throw new WorkbenchError("repository_not_discovered", "Repository is outside the discovered project scope");
      selected.push({ id: repo.id, name: repo.name, path: repo.path });
    }
    atomicJson(this.mainSelectionPath(), { schemaVersion: 1, revision: current.revision + 1, repositories: selected, updatedAt: now() });
    const selectedPaths = new Set(selected.map(repo => canonical(String(repo.path))));
    return { ...current, revision: current.revision + 1,
      repositories: current.repositories.map((repo: Json) => ({ ...repo, selected: selectedPaths.has(canonical(String(repo.path))) })) };
  }
  private mainRepositories(): Json[] {
    const saved = this.mainSelection();
    if (!saved) return this.config.repositories.filter(repo => repo.enabled).map(repo => this.sourceRecord(repo));
    return saved.repositories.map((repo: Json) => this.sourceRecord({ id: String(repo.id), name: String(repo.name), path: String(repo.path), enabled: true, role: null, defaultBase: null }));
  }
  sourceRecord(repo: Repository): Json {
    const path = repositoryPath(this.config, repo);
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
    return join(this.config.recordsRoot, `${slug(id)}.json`);
  }
  orphanCandidates() { return orphanCandidates(this.config, (path, treePath) => {
    const record = this.read(path);
    return !!record && canonical(record.treePath) === treePath &&
      !(record.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state));
  }).map(candidate => {
    const record = this.read(this.recordPath(candidate.id));
    return { ...candidate, recordInvalid: !!candidate.recordInvalid && !record,
      resume: record?.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state) };
  }); }
  async orphanPreview(id: string) {
    const preview = await orphanPreview(this.config, id);
    const record = this.read(this.recordPath(id));
    if (record?.origin === "adopted" && ["adopting", "adopt_failed"].includes(record.state))
      return { ...preview, fingerprint: record.adoption.fingerprint, plannedBranches: record.adoption.branches,
        warnings: preview.warnings.filter((item: Json) => item.code !== "record_invalid"), resume: true };
    return preview;
  }
  async adoptOrphan(params: Json): Promise<Json> {
    const id = String(params.workspaceId || "");
    if (!id || slug(id) !== id || id === "main") throw new WorkbenchError("workspace_id_invalid", "Invalid Workspace ID");
    const requestedBranches = params.branches || {};
    if (!requestedBranches || typeof requestedBranches !== "object" || Array.isArray(requestedBranches))
      throw new WorkbenchError("request_invalid", "branches must map repository IDs to names");
    const requestHash = hash(pythonJson({ id, fingerprint: params.fingerprint, branches: requestedBranches }));
    const requestedBranch = (repoId: string): string | undefined =>
      Object.prototype.hasOwnProperty.call(requestedBranches, repoId) ? requestedBranches[repoId] : undefined;
    let record: Json;
    const possibleRecord = existsSync(this.recordPath(id)) ? this.read(this.recordPath(id)) : null;
    const existingRecord = possibleRecord && canonical(possibleRecord.treePath) === canonical(join(this.config.treesRoot, id)) ? possibleRecord : null;
    if (existingRecord) {
      record = existingRecord;
      if (record.origin !== "adopted" || record.adoption?.requestHash !== requestHash)
        throw new WorkbenchError("workspace_exists", "Workspace record already exists");
      if (record.state === "active") return record;
      if (!["adopting", "adopt_failed"].includes(record.state))
        throw new WorkbenchError("workspace_state_invalid", "Workspace cannot resume adoption");
    } else {
      const preview = await this.orphanPreview(id);
      if (!preview.eligible || preview.fingerprint !== params.fingerprint)
        throw new WorkbenchError("orphan_changed", "Workspace changed after preview; refresh before adopting", preview.issues);
      const byId = new Map<string, Json>(preview.repositories.map((repo: Json) => [repo.id, repo]));
      for (const [repoId, name] of Object.entries(requestedBranches)) {
        const repo = byId.get(repoId);
        if (!repo || repo.branch || typeof name !== "string" || !name.trim())
          throw new WorkbenchError("branch_invalid", "Only detached repositories can receive an adoption branch");
        await new Git(repo.worktreePath, this.config.operationTimeout).run(["check-ref-format", "--branch", name]);
        const existing = await new Git(repo.sourcePath, this.config.operationTimeout).run(["show-ref", "--verify", `refs/heads/${name}`], false);
        if (!existing.code) throw new WorkbenchError("branch_exists", `Branch already exists: ${name}`);
      }
      let existingRecordBackup: string | null = null;
      if (existsSync(this.recordPath(id))) {
        const bytes = readFileSync(this.recordPath(id));
        const directory = join(this.config.stateRoot, "orphan-record-backups");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        existingRecordBackup = join(directory, `${id}-${hash(bytes.toString("base64")).slice(0, 16)}.json`);
        try { writeFileSync(existingRecordBackup, bytes, { mode: 0o600, flag: "wx" }); }
        catch (error) {
          if (!existsSync(existingRecordBackup) || !readFileSync(existingRecordBackup).equals(bytes)) throw error;
        }
      }
      record = {
        schemaVersion: 1, id, displayName: id, kind: "managed", managed: true,
        origin: "adopted", state: "adopting", description: "Recovered from existing Git worktrees",
        sourceRoot: this.config.sourceRoot, treePath: preview.treePath,
        repositoryIds: preview.repositories.map((repo: Json) => repo.id),
        repositories: preview.repositories.map((repo: Json) => ({
          id: repo.id, name: repo.name, repoPath: repo.repoPath, role: repo.role,
          sourcePath: repo.sourcePath, worktreePath: repo.worktreePath,
          branch: repo.branch, baseRef: null, baseSha: null, adoptionHead: repo.head,
          mode: "managed",
        })),
        adoption: { requestHash, fingerprint: params.fingerprint, branches: requestedBranches, adoptedAt: now(), originalBaseUnknown: true,
          ...(existingRecordBackup ? { existingRecordBackup } : {}) },
      };
      this.save(record, false);
    }
    try {
      for (const repo of record.repositories) {
        const git = new Git(repo.worktreePath, this.config.operationTimeout);
        const desired = requestedBranch(repo.id) || repo.branch || null;
        if (await git.root() !== canonical(repo.worktreePath) ||
          !await new Git(repo.sourcePath, this.config.operationTimeout).registered(repo.worktreePath) ||
          await git.head() !== repo.adoptionHead)
          throw new WorkbenchError("worktree_identity_changed", "Worktree changed during adoption");
        const actual = await git.branch();
        if (actual !== desired) {
          if (actual !== null || !requestedBranch(repo.id))
            throw new WorkbenchError("worktree_identity_changed", "Branch changed during adoption");
          const source = new Git(repo.sourcePath, this.config.operationTimeout);
          const existing = await source.run(["show-ref", "--verify", `refs/heads/${desired}`], false);
          if (!existing.code && existing.stdout.trim().split(/\s+/)[0] !== repo.adoptionHead)
            throw new WorkbenchError("branch_exists", `Branch changed: ${desired}`);
          await git.run(existing.code ? ["switch", "-c", desired] : ["switch", desired]);
        }
        repo.branch = desired;
        this.save(record, false);
      }
      record.state = "active";
      delete record.issues;
      return this.save(record, false);
    } catch (error) {
      record.state = "adopt_failed";
      record.issues = [issue(error)];
      this.save(record, false);
      throw error;
    }
  }
  read(path: string): Json | null {
    try {
      const value = readJson(path);
      if (
        value.schemaVersion !== 1 ||
        value.id !== basename(path, ".json") ||
        !Array.isArray(value.repositories) ||
        !inside(value.treePath, this.config.treesRoot)
      )
        return null;
      if (value.layout === "gitlink") {
        if (!inside(value.sourceRoot, this.config.sourceRoot) || value.repositories[0]?.role !== "gitlink-root" ||
          canonical(value.repositories[0]?.sourcePath || "") !== canonical(value.sourceRoot) ||
          canonical(value.repositories[0]?.worktreePath || "") !== canonical(value.treePath)) return null;
        for (const repo of value.repositories.slice(1)) {
          if (repo.role !== "gitlink-child" || !repo.repoPath ||
            canonical(repo.sourcePath) !== childPath(value.sourceRoot, repo.repoPath) ||
            canonical(repo.worktreePath) !== childPath(value.treePath, repo.repoPath)) return null;
        }
        return value;
      }
      for (const repo of value.repositories) {
        const configured = this.config.repositories.find(
          (item) => item.id === repo.id,
        );
        if (
          !configured ||
          canonical(repo.sourcePath) !==
            repositoryPath(this.config, configured) ||
          !inside(repo.worktreePath, value.treePath)
        )
          return null;
      }
      return value;
    } catch {
      return null;
    }
  }
  list(): Json[] {
    const c = this.config;
    const main = {
      id: "main",
      displayName: c.mainWorkspaceName,
      kind: "live",
      managed: false,
      description: "Current source checkouts",
      state: "active",
      sourceRoot: c.sourceRoot,
      treePath: c.sourceRoot,
      repositories: this.mainRepositories(),
      createdAt: null,
      updatedAt: null,
    };
    const records = readdirSync(c.recordsRoot)
      .filter((path) => path.endsWith(".json"))
      .map(
        (path) =>
          this.read(join(c.recordsRoot, path)) || {
            id: basename(path, ".json"),
            displayName: basename(path, ".json"),
            kind: "managed",
            managed: true,
            state: "record_invalid",
            repositories: [],
          },
      );
    records.sort((a, b) =>
      String(b.updatedAt || b.createdAt || "").localeCompare(
        String(a.updatedAt || a.createdAt || ""),
      ),
    );
    const linked = this.linkedSelection().roots.map((entry: Json) => this.linkedWorkspace(entry));
    return [main, ...linked, ...records];
  }
  get(id: string): Json {
    if (id === "main") return this.list()[0];
    if (id.startsWith("linked-")) {
      const linked = this.list().find((item: Json) => item.id === id && item.kind === "linked-live");
      if (linked) return linked;
    }
    const path = this.recordPath(id),
      value = this.read(path);
    if (!value || value.id !== id)
      throw new WorkbenchError(
        existsSync(path) ? "record_invalid" : "workspace_missing",
        `workspace unavailable: ${id}`,
      );
    return value;
  }
  save(value: Json, manifest = true): Json {
    const record: Json = { ...value, updatedAt: now() };
    atomicJson(this.recordPath(record.id), record);
    // The durable record owns recovery. A manifest failure is visible and a
    // repeated request reconciles it without repeating Git mutations.
    if (manifest && record.layout !== "gitlink" && existsSync(record.treePath))
      atomicJson(join(record.treePath, ".workspace/manifest.json"), record);
    return record;
  }
  matches(repo: Json, ref: unknown) {
    if (typeof ref !== "string" || !ref.trim()) return false;
    return (
      [
        repo.id,
        repo.name,
        repo.repoPath,
        repo.sourcePath,
        repo.worktreePath,
      ].includes(ref) ||
      [repo.sourcePath, repo.worktreePath]
        .filter(Boolean)
        .some(
          (path) =>
            canonical(resolve(this.config.sourceRoot, ref)) === canonical(path),
        )
    );
  }
  repository(workspace: Json, ref: unknown): Json {
    const matches = workspace.repositories.filter((repo: Json) =>
      this.matches(repo, ref),
    );
    if (matches.length !== 1)
      throw new WorkbenchError(
        matches.length ? "repository_ambiguous" : "repository_missing",
        "repository reference is unavailable or ambiguous",
      );
    return matches[0];
  }
  select(params: Json): Array<{ repo: Repository; baseRef: string | null }> {
    const candidates = this.config.repositories.filter((repo) => repo.enabled);
    if (
      params.repositories !== undefined &&
      !Array.isArray(params.repositories)
    )
      throw new WorkbenchError(
        "request_invalid",
        "repositories must be an array",
      );
    const selected: Repository[] = [];
    for (const requested of params.repositories ??
      candidates.map((repo) => repo.id)) {
      const matches = candidates.filter((repo) =>
        this.matches(this.sourceRecord(repo), requested),
      );
      if (matches.length !== 1)
        throw new WorkbenchError(
          "repository_invalid",
          "unknown, disabled or ambiguous repository",
        );
      if (!selected.includes(matches[0])) selected.push(matches[0]);
    }
    if (!selected.length)
      throw new WorkbenchError(
        "repositories_empty",
        "select at least one repository",
      );
    const bases = params.baseRefs ?? {};
    if (!bases || typeof bases !== "object" || Array.isArray(bases))
      throw new WorkbenchError("request_invalid", "baseRefs must be an object");
    for (const [key, value] of Object.entries(bases))
      if (
        typeof value !== "string" ||
        !value.trim() ||
        !selected.some((repo) => this.matches(this.sourceRecord(repo), key))
      )
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
  assertIdle(id: string) {
    try {
      const bindings =
        optionalJson(join(this.config.stateRoot, "agent-bindings.json"))
          .bindings || [];
      if (!Array.isArray(bindings)) throw new Error("invalid bindings");
      if (
        bindings.some(
          (item: Json) =>
            item.workspaceId === id &&
            ![
              "completed",
              "failed",
              "cancelled",
              "stopped",
              "idle",
              "archived",
              "closed",
              "error",
            ].includes(item.status),
        )
      )
        throw new WorkbenchError(
          "workspace_task_active",
          "finish execution before changing workspace scope",
        );
      const reviews = join(this.config.stateRoot, "reviews");
      if (existsSync(reviews))
        for (const path of readdirSync(reviews).filter((path) =>
          path.endsWith(".json"),
        )) {
          const item = readJson(join(reviews, path));
          if (
            item.workspaceId === id &&
            ![
              "approved",
              "stopped",
              "failed",
              "blocked",
              "limit_reached",
            ].includes(item.status)
          )
            throw new WorkbenchError(
              "workspace_task_active",
              "finish review before changing workspace scope",
            );
        }
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError(
        "workspace_task_status_unavailable",
        "persisted task state could not be checked",
      );
    }
  }
  async plan(
    repo: Repository,
    workspace: Json,
    ref: string | null,
    template = "obs/{workspace}/{repository}",
  ): Promise<Json> {
    const source = repositoryPath(this.config, repo),
      git = new Git(source, this.config.operationTimeout);
    if (!(await git.valid()))
      throw new WorkbenchError(
        "repository_invalid",
        "configured source is not a Git repository",
      );
    const branch = template
      .replaceAll("{workspace}", workspace.id)
      .replaceAll("{repository}", repo.id);
    if (
      !/^[A-Za-z0-9._/-]+$/.test(branch) ||
      branch.includes("..") ||
      branch.startsWith("/")
    )
      throw new WorkbenchError("branch_invalid", "invalid branch template");
    await git.run(["check-ref-format", "--branch", branch]);
    const worktreePath = canonical(join(workspace.treePath, repo.id));
    if (!inside(worktreePath, workspace.treePath))
      throw new WorkbenchError(
        "path_invalid",
        "invalid repository worktree path",
      );
    const baseRef = ref || repo.defaultBase || (await git.branch()) || "HEAD";
    if (
      existsSync(worktreePath) ||
      (await git.run(["show-ref", "--verify", `refs/heads/${branch}`], false))
        .code === 0
    )
      throw new WorkbenchError(
        "branch_exists",
        "target path or branch already exists",
      );
    return {
      ...this.sourceRecord(repo),
      worktreePath,
      branch,
      baseRef,
      baseSha: await git.commit(baseRef),
      mode: "managed",
    };
  }
  async materialize(plan: Json, workspace: Json) {
    const configured = this.config.repositories.find(
      (repo) => repo.id === plan.id,
    );
    if (
      !configured ||
      canonical(plan.sourcePath) !== repositoryPath(this.config, configured) ||
      canonical(plan.worktreePath) !==
        canonical(join(workspace.treePath, plan.id)) ||
      !inside(plan.worktreePath, workspace.treePath)
    )
      throw new WorkbenchError(
        "worktree_identity_changed",
        "invalid operation journal identity",
      );
    const git = new Git(plan.sourcePath, this.config.operationTimeout);
    if ((await git.commit(plan.baseSha)) !== plan.baseSha)
      throw new WorkbenchError(
        "worktree_identity_changed",
        "invalid journal base",
      );
    await git.run(["check-ref-format", "--branch", plan.branch]);
    if (await git.completed(plan.worktreePath, plan.branch, plan.baseSha))
      return;
    if (existsSync(plan.worktreePath))
      throw new WorkbenchError(
        "worktree_identity_changed",
        "existing worktree changed; preserved for inspection",
      );
    const ref = await git.run(
      ["show-ref", "--verify", `refs/heads/${plan.branch}`],
      false,
    );
    if (!ref.code && ref.stdout.split(/\s+/)[0] !== plan.baseSha)
      throw new WorkbenchError(
        "worktree_identity_changed",
        "branch changed; preserved",
      );
    try {
      await git.run(
        ref.code
          ? [
              "worktree",
              "add",
              "-b",
              plan.branch,
              plan.worktreePath,
              plan.baseSha,
            ]
          : ["worktree", "add", plan.worktreePath, plan.branch],
      );
    } catch (error) {
      if (
        !(error instanceof WorkbenchError) ||
        error.code !== "git_timeout" ||
        !(await git.completed(plan.worktreePath, plan.branch, plan.baseSha))
      )
        throw error;
    }
  }
  private async materializeGitlink(plan: Json, workspace: Json) {
    const isRoot = plan.role === "gitlink-root";
    const expectedSource = isRoot ? workspace.sourceRoot : childPath(workspace.sourceRoot, plan.repoPath);
    const expectedTarget = isRoot ? workspace.treePath : childPath(workspace.treePath, plan.repoPath);
    if (canonical(plan.sourcePath) !== expectedSource || canonical(plan.worktreePath) !== expectedTarget || plan.branch !== workspace.branchName)
      throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree identity changed");
    const git = new Git(expectedSource, this.config.operationTimeout);
    if (await git.commit(plan.baseSha) !== plan.baseSha)
      throw new WorkbenchError("worktree_identity_changed", "Gitlink base commit changed");
    if (await git.completed(expectedTarget, plan.branch, plan.baseSha)) return;
    if (existsSync(expectedTarget) && (isRoot || readdirSync(expectedTarget).length))
      throw new WorkbenchError("worktree_identity_changed", "Existing Gitlink worktree path changed; preserved");
    const ref = await git.run(["show-ref", "--verify", `refs/heads/${plan.branch}`], false);
    if (!ref.code && ref.stdout.split(/\s+/)[0] !== plan.baseSha)
      throw new WorkbenchError("worktree_identity_changed", "Gitlink branch changed; preserved");
    try {
      await git.run(ref.code
        ? ["worktree", "add", "-b", plan.branch, expectedTarget, plan.baseSha]
        : ["worktree", "add", expectedTarget, plan.branch]);
    } catch (error) {
      if (!(error instanceof WorkbenchError) || error.code !== "git_timeout" ||
        !(await git.completed(expectedTarget, plan.branch, plan.baseSha))) throw error;
    }
  }
  private async createGitlink(params: Json) {
    if (!params.name?.trim()) throw new WorkbenchError("workspace_name_required", "workspace name is required");
    if (params.repositories !== undefined) throw new WorkbenchError("request_invalid", "Gitlink members are fixed by the outer commit");
    const id = slug(params.id || params.name), requestHash = hash(pythonJson(params));
    if (id === "main" || id.startsWith("linked-")) throw new WorkbenchError("workspace_id_reserved", "reserved workspace id");
    const branch = String(params.branchName || `feature/${id}`);
    if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/"))
      throw new WorkbenchError("branch_invalid", "invalid shared branch name");
    const record = this.recordPath(id);
    let workspace: Json;
    if (existsSync(record)) {
      workspace = this.get(id);
      if (workspace.layout !== "gitlink" || workspace.requestHash !== requestHash ||
        !["active", "creating", "create_failed"].includes(workspace.state))
        throw new WorkbenchError("workspace_exists", "workspace already exists");
      if (workspace.state === "active") return workspace;
    } else {
      const source = this.get(String(params.sourceWorkspaceId || ""));
      if (source.kind !== "linked-live" || !inside(source.sourceRoot, this.config.sourceRoot))
        throw new WorkbenchError("source_workspace_invalid", "Select an observed Gitlink Workspace as the source");
      const root = source.sourceRoot, treePath = canonical(join(this.config.treesRoot, id));
      if (!inside(treePath, this.config.treesRoot) || existsSync(treePath))
        throw new WorkbenchError("path_invalid", "workspace target already exists");
      const rootGit = new Git(root, this.config.operationTimeout);
      if (await rootGit.root() !== root) throw new WorkbenchError("repository_invalid", "Gitlink source is not an exact Git root");
      await rootGit.run(["check-ref-format", "--branch", branch]);
      const rootBaseRef = String(params.rootBaseRef || "HEAD"), rootBaseSha = await rootGit.commit(rootBaseRef);
      const links = await commitGitlinks(root, rootBaseSha, this.config.operationTimeout);
      if (!links.length) throw new WorkbenchError("gitlinks_empty", "source commit has no Gitlinks");
      const overrides = params.baseRefs ?? {};
      if (!overrides || Array.isArray(overrides) || typeof overrides !== "object" ||
        Object.keys(overrides).some(key => !links.some(link => link.path === key)))
        throw new WorkbenchError("request_invalid", "invalid child base refs");
      const plans: Json[] = [
        { id: "@root", name: basename(root), repoPath: ".", role: "gitlink-root", mode: "managed",
          sourcePath: root, worktreePath: treePath, branch, baseRef: rootBaseRef, baseSha: rootBaseSha },
      ];
      for (const link of links) {
        const sourcePath = childPath(root, link.path), childGit = new Git(sourcePath, this.config.operationTimeout);
        if (!existsSync(sourcePath) || await childGit.root() !== sourcePath)
          throw new WorkbenchError("repository_missing", `Gitlink checkout unavailable: ${link.path}`);
        const baseRef = String(overrides[link.path] || link.sha);
        plans.push({ id: link.path, name: link.path, repoPath: link.path, role: "gitlink-child", mode: "managed",
          sourcePath, worktreePath: childPath(treePath, link.path), branch, baseRef,
          baseSha: await childGit.commit(baseRef), pinnedSha: link.sha });
      }
      for (const plan of plans) {
        const git = new Git(plan.sourcePath, this.config.operationTimeout);
        if ((await git.run(["show-ref", "--verify", `refs/heads/${branch}`], false)).code === 0)
          throw new WorkbenchError("branch_exists", `branch already exists in ${plan.repoPath}`);
      }
      workspace = { schemaVersion: 1, requestHash, id, displayName: params.name.trim(), kind: "managed",
        layout: "gitlink", managed: true, state: "creating", sourceWorkspaceId: source.id,
        sourceRoot: root, treePath, branchName: branch, repositories: plans,
        repositoryIds: plans.map(plan => plan.id), createdAt: now() };
      this.save(workspace, false);
    }
    try {
      for (const plan of workspace.repositories) await this.materializeGitlink(plan, workspace);
      workspace.state = "active";
      delete workspace.issues;
      return this.save(workspace, false);
    } catch (error) {
      workspace.state = "create_failed";
      workspace.issues = [issue(error)];
      this.save(workspace, false);
      throw new WorkbenchError("create_failed", "Gitlink creation failed; retry the same request to recover", workspace.issues);
    }
  }
  async create(params: Json) {
    if (params.sourceWorkspaceId) return this.createGitlink(params);
    if (!params.name?.trim())
      throw new WorkbenchError(
        "workspace_name_required",
        "workspace name is required",
      );
    const id = slug(params.id || params.name),
      requestHash = hash(pythonJson(params));
    if (id === "main")
      throw new WorkbenchError(
        "workspace_id_reserved",
        "reserved workspace id",
      );
    const selected = this.select(params),
      path = this.recordPath(id);
    let workspace: Json;
    if (existsSync(path)) {
      workspace = this.get(id);
      if (
        workspace.requestHash !== requestHash ||
        !["active", "creating", "create_failed"].includes(workspace.state)
      )
        throw new WorkbenchError(
          "workspace_exists",
          "workspace already exists",
        );
      if (workspace.state === "active") return this.save(workspace);
    } else {
      const treePath = canonical(join(this.config.treesRoot, id));
      if (!inside(treePath, this.config.treesRoot) || existsSync(treePath))
        throw new WorkbenchError(
          "path_invalid",
          "workspace target already exists",
        );
      workspace = {
        schemaVersion: 1,
        requestHash,
        id,
        displayName: params.name.trim(),
        kind: "managed",
        managed: true,
        description: params.description || "",
        state: "creating",
        sourceRoot: this.config.sourceRoot,
        treePath,
        repositoryIds: selected.map((item) => item.repo.id),
        repositories: [],
        createdAt: now(),
      };
      for (const item of selected)
        workspace.repositories.push(
          await this.plan(
            item.repo,
            workspace,
            item.baseRef,
            params.branchTemplate,
          ),
        );
      mkdirSync(treePath, { recursive: true, mode: 0o700 });
      this.save(workspace, false);
    }
    try {
      for (const item of selected) {
        let plan = workspace.repositories.find(
          (repo: Json) => repo.id === item.repo.id,
        );
        if (!plan) {
          plan = await this.plan(
            item.repo,
            workspace,
            item.baseRef,
            params.branchTemplate,
          );
          workspace.repositories.push(plan);
          this.save(workspace, false);
        }
        await this.materialize(plan, workspace);
      }
      workspace.state = "active";
      delete workspace.issues;
      return this.save(workspace);
    } catch (error) {
      workspace.state = "create_failed";
      workspace.issues = [issue(error)];
      this.save(workspace, false);
      throw new WorkbenchError(
        "create_failed",
        "creation failed; retry the same request to recover",
        workspace.issues,
      );
    }
  }
  async add(params: Json) {
    const workspace = this.get(String(params.workspaceId || ""));
    if (workspace.layout === "gitlink")
      throw new WorkbenchError("workspace_layout_invalid", "Gitlink members come from the outer repository; flat additions are unavailable");
    if (!workspace.managed || workspace.state !== "active")
      throw new WorkbenchError(
        "workspace_state_invalid",
        "only active managed workspaces can add repositories",
      );
    this.assertIdle(workspace.id);
    if (!Array.isArray(params.repositories) || !params.repositories.length)
      throw new WorkbenchError("request_invalid", "select repositories to add");
    const journal = Object.assign(
        Object.create(null),
        workspace.repositoryAdditions || {},
      ),
      plans: Json[] = [];
    for (const { repo, baseRef } of this.select(params)) {
      const existing = workspace.repositories.find(
          (item: Json) => item.id === repo.id,
        ),
        pending = journal[repo.id];
      if (existing) {
        if (baseRef && baseRef !== existing.baseRef)
          throw new WorkbenchError(
            "repository_base_conflict",
            "repository already added with a different base",
          );
        continue;
      }
      if (pending && pending.branch !== `obs/${workspace.id}/${repo.id}`)
        throw new WorkbenchError(
          "worktree_identity_changed",
          "addition branch identity changed; preserved",
        );
      if (pending && baseRef && baseRef !== pending.baseRef)
        throw new WorkbenchError(
          "repository_base_conflict",
          "retry with the original base ref",
        );
      plans.push(
        pending || (await this.plan(repo, workspace, baseRef || repo.defaultBase || "HEAD")),
      );
    }
    workspace.repositoryAdditions = journal;
    for (const plan of plans) {
      journal[plan.id] = plan;
      this.save(workspace);
      try {
        await this.materialize(plan, workspace);
        workspace.repositories.push(plan);
        workspace.repositoryIds = workspace.repositories.map(
          (repo: Json) => repo.id,
        );
        delete journal[plan.id];
        delete workspace.repositoryAdditionError;
        this.save(workspace);
      } catch (error) {
        workspace.repositoryAdditionError = issue(error);
        this.save(workspace);
        throw error;
      }
    }
    return this.save(workspace);
  }
  async impact(workspace: Json) {
    const repositories: Json[] = [],
      externalReferences: Json[] = [];
    for (const repo of workspace.repositories) {
      const exists = existsSync(repo.worktreePath);
      let dirtyPaths: string[] = [],
        unavailable = false;
      try {
        if (exists)
          dirtyPaths = (
            await new Git(repo.worktreePath, this.config.gitTimeout).status(repo.role === "gitlink-root")
          ).map(([, path]) => path);
      } catch {
        unavailable = true;
      }
      repositories.push({
        ...repo,
        worktreeExists: exists,
        dirty: !!dirtyPaths.length || unavailable,
        dirtyPaths,
      });
    }
    return {
      workspaceId: workspace.id,
      treePath: workspace.treePath,
      repositories,
      repositoryCount: repositories.length,
      dirtyRepositoryCount: repositories.filter((repo) => repo.dirty).length,
      branchesPreserved: workspace.repositories
        .map((repo: Json) => repo.branch)
        .filter(Boolean),
      ...(workspace.origin === "adopted" ? { detachedSafetyRefs: workspace.repositories
        .filter((repo: Json) => !repo.branch)
        .map((repo: Json) => ({ repositoryId: repo.id, ref: this.safetyRef(workspace, repo), head: repo.adoptionHead })) } : {}),
      dirtyRepositories: repositories.filter((repo) => repo.dirty).length,
      irreversible: true,
      preserves: ["commits", "local branches", "external references"],
      loses: ["workspace record", "managed worktree files"],
      externalReferences,
      recordPath: this.recordPath(workspace.id),
      preview: true,
      canDelete: workspace.state === "removed",
    };
  }
  async remove(params: Json) {
    const w = this.get(String(params.workspaceId || ""));
    if (
      !w.managed ||
      !["active", "create_failed", "deletion_pending", "removed"].includes(
        w.state,
      )
    )
      throw new WorkbenchError(
        "workspace_state_invalid",
        "workspace cannot be removed",
      );
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
        requestedAt: w.deletion?.requestedAt || now(),
        activeTasks: tasks,
        blocksNewTasks: true,
      };
    else delete w.deletion;
    this.save(w);
    return {
      workspaceId: w.id,
      removed: w.state === "removed",
      pending: w.state === "deletion_pending",
      state: w.state,
      activeTasks: tasks,
    };
  }
  restore(params: Json) {
    const w = this.get(String(params.workspaceId || ""));
    if (
      !w.managed ||
      !["active", "removed", "deletion_pending"].includes(w.state)
    )
      throw new WorkbenchError(
        "workspace_state_invalid",
        "workspace cannot be restored",
      );
    if (!existsSync(w.treePath))
      throw new WorkbenchError(
        "workspace_restore_unavailable",
        "worktree no longer exists",
      );
    w.state = "active";
    delete w.deletion;
    this.save(w);
    return { workspaceId: w.id, restored: true, state: w.state };
  }
  private async deletionTargets(w: Json) {
    this.assertIdle(w.id);
    // Check all targets before removing any. Never force-remove user changes,
    // unregistered paths, or commits made after the recorded base.
    const targets: Array<{ git: Git; path: string }> = [];
    for (const repo of w.repositories) {
      if (!existsSync(repo.worktreePath)) continue;
      const target = new Git(repo.worktreePath, this.config.operationTimeout),
        source = new Git(repo.sourcePath, this.config.operationTimeout);
      if (
        (await target.root()) !== canonical(repo.worktreePath) ||
        (await target.branch()) !== repo.branch ||
        !(await source.registered(repo.worktreePath))
      )
        throw new WorkbenchError(
          "worktree_identity_changed",
          "worktree identity changed; preserved",
        );
      if ((await target.status()).length)
        throw new WorkbenchError(
          "workspace_dirty",
          "worktree has user changes; preserved",
        );
      if ((await target.head()) !== (w.origin === "adopted" ? repo.adoptionHead : repo.baseSha))
        throw new WorkbenchError(
          "workspace_has_commits",
          "worktree contains commits; preserved",
        );
      if (w.origin === "adopted" && !repo.branch) {
        const ref = this.safetyRef(w, repo), existing = await source.run(["show-ref", "--verify", ref], false);
        if (!existing.code && existing.stdout.trim().split(/\s+/)[0] !== repo.adoptionHead)
          throw new WorkbenchError("safety_ref_conflict", "Detached HEAD safety ref changed; preserved");
      }
      targets.push({ git: source, path: repo.worktreePath });
    }
    // Refuse unknown files in the workspace container, including cached runtime
    // artifacts. Nothing recursively deletes an uninspected directory.
    const allowed = new Map<string, Set<string>>();
    for (const repo of w.repositories) {
      const parts = relative(w.treePath, repo.worktreePath).split(/[\\/]/);
      let parent = w.treePath;
      for (const part of parts) {
        const names = allowed.get(parent) || new Set<string>();
        names.add(part); allowed.set(parent, names);
        parent = join(parent, part);
      }
    }
    allowed.get(w.treePath)?.add(".workspace");
    for (const [directory, names] of allowed) {
      if (!existsSync(directory)) continue;
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() ||
        readdirSync(directory).some(name => !names.has(name)))
        throw new WorkbenchError("workspace_dirty", "workspace contains extra files; preserved");
    }
    const metadata = join(w.treePath, ".workspace");
    if (
      existsSync(metadata) &&
      (lstatSync(metadata).isSymbolicLink() || !lstatSync(metadata).isDirectory() ||
      readdirSync(metadata).some((name) => name !== "manifest.json"))
    )
      throw new WorkbenchError(
        "workspace_dirty",
        "workspace metadata contains user files; preserved",
      );
    return targets;
  }
  private safetyRef(workspace: Json, repo: Json) {
    return `refs/workbench/recovered/${workspace.id}/${hash(repo.id).slice(0, 16)}`;
  }
  private async preserveDetachedHeads(workspace: Json) {
    if (workspace.origin !== "adopted") return;
    for (const repo of workspace.repositories) {
      if (repo.branch || !existsSync(repo.worktreePath)) continue;
      const git = new Git(repo.sourcePath, this.config.operationTimeout), ref = this.safetyRef(workspace, repo);
      const current = await git.run(["show-ref", "--verify", ref], false);
      if (!current.code) {
        if (current.stdout.trim().split(/\s+/)[0] !== repo.adoptionHead)
          throw new WorkbenchError("safety_ref_conflict", "Detached HEAD safety ref changed; preserved");
      } else await git.run(["update-ref", ref, repo.adoptionHead, "0000000000000000000000000000000000000000"]);
    }
  }
  private async cleanupGitlink(w: Json, params: Json, permanent: boolean) {
    if (permanent && w.state !== "removed") {
      if (!params.confirm) return { ...(await this.impact(w)), canDelete: false, deleted: false,
        blockedReason: w.state === "deletion_pending" ? "workspace_task_active" : "workspace_must_be_removed" };
      throw new WorkbenchError("workspace_must_be_removed", "remove workspace before permanent deletion");
    }
    const targets: Array<{ git: Git; path: string; relativePath: string }> = [];
    try {
      this.assertIdle(w.id);
      for (const repo of [...w.repositories].reverse()) {
        if (!existsSync(repo.worktreePath)) continue;
        const target = new Git(repo.worktreePath, this.config.operationTimeout);
        const source = new Git(repo.sourcePath, this.config.operationTimeout);
        if (await target.root() !== canonical(repo.worktreePath) || await target.branch() !== repo.branch ||
          !(await source.registered(repo.worktreePath)))
          throw new WorkbenchError("worktree_identity_changed", "Gitlink worktree identity changed; preserved");
        if (await target.head() !== repo.baseSha)
          throw new WorkbenchError("workspace_has_commits", "Gitlink worktree contains commits; preserved");
        if ((await target.status(repo.role === "gitlink-root" ? "all" : false)).length)
          throw new WorkbenchError("workspace_dirty", "Gitlink worktree has user changes; preserved");
        if (repo.role === "gitlink-root") {
          const [committed, indexed] = await Promise.all([
            commitGitlinks(repo.worktreePath, "HEAD", this.config.operationTimeout),
            indexGitlinks(repo.worktreePath, this.config.operationTimeout),
          ]);
          if (pythonJson(committed) !== pythonJson(indexed))
            throw new WorkbenchError("workspace_dirty", "Gitlink pointers are staged; preserved");
        }
        targets.push({ git: source, path: repo.worktreePath, relativePath: repo.repoPath });
      }
    } catch (error) {
      if (permanent && !params.confirm) return { ...(await this.impact(w)), canDelete: false,
        deleted: false, blockedReason: issue(error).code, issues: [issue(error)] };
      throw error;
    }
    if (!params.confirm) return { workspaceId: w.id, preview: true, canDelete: true,
      repositories: targets.length, ...(permanent ? { deleted: false } : { removed: false }) };
    for (const target of targets) {
      await target.git.run(["worktree", "remove", target.path]);
      if (target.relativePath !== "." && existsSync(w.treePath))
        mkdirSync(childPath(w.treePath, target.relativePath), { recursive: true });
    }
    if (permanent) unlinkSync(this.recordPath(w.id));
    else { w.state = "removed"; this.save(w, false); }
    return { workspaceId: w.id, preview: false, ...(permanent
      ? { deleted: true, branchesPreserved: w.repositories.map((repo: Json) => repo.branch).filter(Boolean), externalReferences: [] }
      : { removed: true }) };
  }
  async cleanup(params: Json, permanent = false) {
    const w = this.get(String(params.workspaceId || ""));
    if (!w.managed)
      throw new WorkbenchError(
        "workspace_not_managed",
        "live workspace cannot be deleted",
      );
    if (w.layout === "gitlink") return this.cleanupGitlink(w, params, permanent);
    const impact = await this.impact(w);
    if (permanent && w.state !== "removed") {
      if (!params.confirm)
        return {
          ...impact,
          canDelete: false,
          state: w.state,
          blockedReason:
            w.state === "deletion_pending"
              ? "workspace_task_active"
              : "workspace_must_be_removed",
          requiresRemoval: true,
          deleted: false,
        };
      throw new WorkbenchError(
        w.state === "deletion_pending"
          ? "workspace_task_active"
          : "workspace_must_be_removed",
        "remove workspace after finishing tasks before permanent deletion",
      );
    }
    let targets: Array<{ git: Git; path: string }>;
    try {
      targets = await this.deletionTargets(w);
    } catch (error) {
      if (permanent && !params.confirm)
        return {
          ...impact,
          canDelete: false,
          deleted: false,
          blockedReason: issue(error).code,
          issues: [issue(error)],
        };
      throw error;
    }
    if (!params.confirm)
      return permanent
        ? { ...impact, canDelete: true, deleted: false }
        : {
            workspaceId: w.id,
            preview: true,
            removed: false,
            repositories: targets.length,
            ...(impact.detachedSafetyRefs ? { detachedSafetyRefs: impact.detachedSafetyRefs } : {}),
          };
    const metadata = join(w.treePath, ".workspace");
    await this.preserveDetachedHeads(w);
    for (const target of targets)
      {
        await target.git.run(["worktree", "remove", target.path]);
        let parent = dirname(target.path);
        while (inside(parent, w.treePath)) {
          try { rmdirSync(parent); } catch { break; }
          parent = dirname(parent);
        }
      }
    if (existsSync(join(metadata, "manifest.json")))
      unlinkSync(join(metadata, "manifest.json"));
    if (existsSync(metadata)) rmdirSync(metadata);
    if (existsSync(w.treePath)) rmdirSync(w.treePath);
    if (permanent) unlinkSync(this.recordPath(w.id));
    else {
      w.state = "removed";
      this.save(w, false);
    }
    return {
      workspaceId: w.id,
      preview: false,
      ...(permanent
        ? {
            deleted: true,
            branchesPreserved: impact.branchesPreserved,
            externalReferences: [],
          }
        : { removed: true }),
    };
  }
  identify(directory: string) {
    for (const w of this.list().sort(
      (a, b) => String(b.treePath || "").length - String(a.treePath || "").length,
    ))
      if (
        w.state !== "removed" &&
        w.treePath &&
        inside(directory, w.treePath, true)
      )
        return { matched: true, workspaceId: w.id, repoPath: null };
    return { matched: false, workspaceId: null, repoPath: null };
  }
}
