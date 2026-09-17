import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Config, repositoryPath } from "./config.ts";
import { Git } from "./git.ts";
import { canonical, inside, issue, type Json } from "./storage.ts";

/** Discover only immediate tree containers. Detailed Git work runs on preview. */
export function orphanCandidates(config: Config, validRecord: (path: string, treePath: string) => boolean = () => true): Json[] {
  if (!existsSync(config.treesRoot)) return [];
  const candidates: Json[] = [];
  for (const entry of readdirSync(config.treesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const treePath = canonical(join(config.treesRoot, entry.name));
    const recordPath = join(config.recordsRoot, `${entry.name}.json`);
    if (!inside(treePath, config.treesRoot) || existsSync(recordPath) && validRecord(recordPath, treePath)) continue;
    let repositories = 0;
    try {
      for (const child of readdirSync(treePath, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const gitPath = join(treePath, child.name, ".git");
        if (existsSync(gitPath)) repositories++;
        else for (const nested of readdirSync(join(treePath, child.name), { withFileTypes: true }))
          if (nested.isDirectory() && !nested.isSymbolicLink() && existsSync(join(treePath, child.name, nested.name, ".git"))) repositories++;
      }
    } catch { continue; }
    if (repositories) candidates.push({ id: entry.name, name: entry.name, treePath, repositoryCount: repositories, recordInvalid: existsSync(recordPath) });
  }
  return candidates.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function commonDirectory(path: string, timeout: number): Promise<string> {
  const git = new Git(path, timeout), common = (await git.text(["rev-parse", "--git-common-dir"])).trim();
  return canonical(resolve(path, common));
}

export async function orphanPreview(config: Config, id: string): Promise<Json> {
  const treePath = canonical(join(config.treesRoot, id));
  if (!id || basename(treePath) !== id || !inside(treePath, config.treesRoot) || !existsSync(treePath))
    return { id, treePath, eligible: false, repositories: [], issues: [{ code: "workspace_missing", message: "Workspace tree is unavailable" }] };
  const issues: Json[] = [], warnings: Json[] = [], repositories: Json[] = [];
  if (existsSync(join(config.recordsRoot, `${id}.json`)))
    warnings.push({ code: "record_invalid", message: "Existing invalid record will be preserved before adoption" });
  const sourceCommons = new Map<string, Json[]>();
  for (const repo of config.repositories) {
    const sourcePath = repositoryPath(config, repo);
    try {
      const common = await commonDirectory(sourcePath, config.gitTimeout);
      const group = sourceCommons.get(common) || [];
      group.push({ id: repo.id, name: repo.name, repoPath: repo.path, role: repo.role, sourcePath });
      sourceCommons.set(common, group);
    } catch { /* Unavailable sources cannot prove ownership. */ }
  }
  const paths: string[] = [];
  const configuredPaths = config.repositories.map(repo => repo.id);
  const visit = (directory: string, depth: number) => {
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
      const git = new Git(path, config.gitTimeout);
      if (await git.root() !== path) throw new Error("Not an exact Git worktree root");
      const matches = sourceCommons.get(await commonDirectory(path, config.gitTimeout)) || [];
      if (matches.length !== 1 || !await new Git(matches[0].sourcePath, config.gitTimeout).registered(path))
        throw new Error("Source repository could not be identified uniquely");
      const source = matches[0], head = await git.head(), branch = await git.branch();
      if (!head) throw new Error("HEAD is unavailable");
      const dirtyPaths = (await git.status()).map(([, file]) => file);
      repositories.push({ ...source, worktreePath: path, head, branch: branch || null, dirty: dirtyPaths.length > 0, dirtyPaths });
    } catch (error) {
      issues.push({ path, ...issue(error), code: "worktree_identity_unverified" });
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
  const fingerprint = repositories.map(repo => `${repo.id}:${repo.worktreePath}:${repo.head}:${repo.branch || "detached"}:${repo.dirtyPaths.join(",")}`).sort().join("\n");
  return { id, name: id, treePath, eligible: !issues.length, repositories, issues, warnings, fingerprint };
}
