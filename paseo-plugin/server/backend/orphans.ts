import { existsSync, lstatSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { type Config, repositoryPath } from "./config.ts";
import { Git } from "./git.ts";
import { canonical, inside, issue, WorkbenchError, type Json } from "./storage.ts";

export type OrphanCandidateScan = {
  candidates: Json[];
  scannedDirectories: number;
};

type OrphanCandidateScanOptions = {
  signal?: AbortSignal;
  yieldEvery?: number;
};

function cancelled(error: unknown): boolean {
  return error instanceof WorkbenchError && error.code === "observer_cancelled";
}

/** Discover only immediate tree containers. Detailed Git work runs on preview.
 * The scan is deliberately asynchronous: treesRoot can contain many legacy
 * workspaces, and synchronous directory walks block backend health probes. */
export async function orphanCandidates(
  config: Config,
  validRecord: (path: string, treePath: string) => boolean = () => true,
  options: OrphanCandidateScanOptions = {},
): Promise<OrphanCandidateScan> {
  if (!existsSync(config.treesRoot)) return { candidates: [], scannedDirectories: 0 };
  const candidates: Json[] = [];
  let scannedDirectories = 0;
  const yieldEvery = Math.max(1, options.yieldEvery || 8);
  const yieldToLoop = async () => {
    if (options.signal?.aborted) throw new WorkbenchError("observer_cancelled", "orphan scan cancelled");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  let entries;
  try { entries = await readdir(config.treesRoot, { withFileTypes: true }); }
  catch { return { candidates, scannedDirectories }; }
  for (const entry of entries) {
    scannedDirectories++;
    if (scannedDirectories % yieldEvery === 0) await yieldToLoop();
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const treePath = canonical(join(config.treesRoot, entry.name));
    const recordPath = join(config.recordsRoot, `${entry.name}.json`);
    if (!inside(treePath, config.treesRoot) || existsSync(recordPath) && validRecord(recordPath, treePath)) continue;
    let repositories = 0;
    try {
      const children = await readdir(treePath, { withFileTypes: true });
      for (const child of children) {
        scannedDirectories++;
        if (scannedDirectories % yieldEvery === 0) await yieldToLoop();
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const gitPath = join(treePath, child.name, ".git");
        if (existsSync(gitPath)) repositories++;
        else for (const nested of await readdir(join(treePath, child.name), { withFileTypes: true })) {
          scannedDirectories++;
          if (scannedDirectories % yieldEvery === 0) await yieldToLoop();
          if (nested.isDirectory() && !nested.isSymbolicLink() && existsSync(join(treePath, child.name, nested.name, ".git"))) repositories++;
        }
      }
    } catch (error) {
      if (cancelled(error)) throw error;
      continue;
    }
    if (repositories) candidates.push({ id: entry.name, name: entry.name, treePath, repositoryCount: repositories, recordInvalid: existsSync(recordPath) });
  }
  return { candidates: candidates.sort((a, b) => String(a.name).localeCompare(String(b.name))), scannedDirectories };
}

async function commonDirectory(path: string, timeout: number, signal?: AbortSignal): Promise<string> {
  const git = new Git(path, timeout, undefined, signal), common = (await git.text(["rev-parse", "--git-common-dir"])).trim();
  return canonical(resolve(path, common));
}

async function sourceFromWorktrees(config: Config, worktree: Git, common: string, path: string, signal?: AbortSignal): Promise<Json | null> {
  const matches: Json[] = [];
  for (const entry of await worktree.worktrees()) {
    if (typeof entry.worktree !== "string") continue;
    const sourcePath = canonical(entry.worktree);
    if (sourcePath === path || !inside(sourcePath, config.sourceRoot) ||
      inside(sourcePath, config.treesRoot, true)) continue;
    try {
      const source = new Git(sourcePath, config.gitTimeout, undefined, signal);
      const gitDir = canonical(resolve(sourcePath, (await source.text(["rev-parse", "--git-dir"])).trim()));
      if (await source.root() !== sourcePath || gitDir !== common ||
        !await source.registered(path)) continue;
      const repoPath = relative(config.sourceRoot, sourcePath).replaceAll("\\", "/");
      matches.push({ id: repoPath, name: basename(sourcePath), repoPath, role: null,
        sourcePath, configured: false });
    } catch (error) {
      if (cancelled(error)) throw error;
      /* An unverified checkout cannot own this worktree. */
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

export async function orphanPreview(config: Config, id: string, signal?: AbortSignal): Promise<Json> {
  const treePath = canonical(join(config.treesRoot, id));
  if (!id || basename(treePath) !== id || !inside(treePath, config.treesRoot) || !existsSync(treePath))
    return { id, treePath, eligible: false, repositories: [], issues: [{ code: "workspace_missing", message: "Workspace tree is unavailable" }] };
  const issues: Json[] = [], warnings: Json[] = [], repositories: Json[] = [], unmanagedPaths: string[] = [];
  if (existsSync(join(config.recordsRoot, `${id}.json`)))
    warnings.push({ code: "record_invalid", message: "Existing invalid record will be preserved before adoption" });
  const sourceCommons = new Map<string, Json[]>();
  for (const repo of config.repositories) {
    const sourcePath = repositoryPath(config, repo);
    try {
      const common = await commonDirectory(sourcePath, config.gitTimeout, signal);
      const group = sourceCommons.get(common) || [];
      group.push({ id: repo.id, name: repo.name, repoPath: repo.path, role: repo.role, sourcePath });
      sourceCommons.set(common, group);
    } catch (error) {
      if (cancelled(error)) throw error;
      /* Unavailable sources cannot prove ownership. */
    }
  }
  const paths: string[] = [];
  const configuredPaths = config.repositories.map(repo => repo.id);
  const visit = (directory: string, depth: number) => {
    if (signal?.aborted) throw new WorkbenchError("observer_cancelled", "orphan preview cancelled");
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (directory === treePath && child.name === ".workspace") continue;
      const path = canonical(join(directory, child.name));
      const relative = path.slice(treePath.length + 1).replaceAll("\\", "/");
      if (!child.isDirectory() || child.isSymbolicLink() || !inside(path, treePath)) {
        warnings.push({ code: "workspace_extra_path", message: `Extra path will block cleanup: ${path}`, path });
      } else if (existsSync(join(path, ".git"))) paths.push(path);
      else if (depth < 3 && configuredPaths.some(id => id.startsWith(`${relative}/`))) visit(path, depth + 1);
      else warnings.push({ code: "workspace_extra_path", message: `Extra path will block cleanup: ${path}`, path });
    }
  };
  visit(treePath, 0);
  for (const path of paths) {
    try {
      if (signal?.aborted) throw new WorkbenchError("observer_cancelled", "orphan preview cancelled");
      const git = new Git(path, config.gitTimeout, undefined, signal);
      if (await git.root() !== path) throw new Error("Not an exact Git worktree root");
      const common = await commonDirectory(path, config.gitTimeout, signal);
      const matches = sourceCommons.get(common) || [];
      const source = matches.length === 1 ? matches[0] :
        matches.length === 0 ? await sourceFromWorktrees(config, git, common, path, signal) : null;
      if (!source || !await new Git(source.sourcePath, config.gitTimeout, undefined, signal).registered(path))
        throw new Error("Source repository could not be identified uniquely");
      const head = await git.head(), branch = await git.branch();
      if (!head) throw new Error("HEAD is unavailable");
      const dirtyPaths = (await git.status()).map(([, file]) => file);
      repositories.push({ ...source, worktreePath: path, head, branch: branch || null, dirty: dirtyPaths.length > 0, dirtyPaths });
    } catch (error) {
      if (cancelled(error)) throw error;
      warnings.push({ path, ...issue(error), code: "worktree_identity_unverified" });
      unmanagedPaths.push(path);
    }
  }
  if (!repositories.length) issues.push({ code: "repositories_empty", message: "No registered worktrees found" });
  if (existsSync(join(treePath, ".workspace"))) {
    try {
      if (!lstatSync(join(treePath, ".workspace")).isDirectory() || lstatSync(join(treePath, ".workspace")).isSymbolicLink())
        issues.push({ code: "workspace_metadata_unsafe", message: "Workspace metadata is not a local directory" });
      else if (readdirSync(join(treePath, ".workspace")).some(name => name !== "manifest.json"))
        warnings.push({ code: "workspace_metadata_unknown", message: "Workspace metadata must be reviewed before cleanup" });
    } catch { warnings.push({ code: "workspace_metadata_unknown", message: "Workspace metadata is unreadable" }); }
  }
  const fingerprint = [
    ...repositories.map(repo => `${repo.id}:${repo.worktreePath}:${repo.head}:${repo.branch || "detached"}:${repo.dirtyPaths.join(",")}`),
    ...unmanagedPaths.map(path => `unmanaged:${path}`),
  ].sort().join("\n");
  return { id, name: id, treePath, eligible: !issues.length, repositories, issues, warnings, unmanagedPaths, fingerprint };
}
