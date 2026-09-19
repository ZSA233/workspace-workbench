import { basename, isAbsolute, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Git } from "./git.ts";
import { scanGitRoots } from "./discovery-scan.ts";
import { canonical, inside, WorkbenchError } from "./storage.ts";
import type { Config } from "./config.ts";

export type Gitlink = { path: string; sha: string };

export function childPath(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split("/").some(part => !part || part === "." || part === ".."))
    throw new WorkbenchError("gitlink_path_invalid", "Gitlink path is unsafe");
  const target = canonical(resolve(root, relativePath));
  if (!inside(target, root)) throw new WorkbenchError("gitlink_path_invalid", "Gitlink escapes its outer repository");
  return target;
}

function parseEntries(output: string): Gitlink[] {
  return output.split("\0").filter(Boolean).flatMap(entry => {
    const tab = entry.indexOf("\t");
    if (tab < 0) return [];
    const fields = entry.slice(0, tab).split(" ");
    const sha = fields[1] === "commit" ? fields[2] : fields[1];
    if (fields[0] !== "160000" || !/^[0-9a-f]{40}$/.test(sha)) return [];
    return [{ path: entry.slice(tab + 1), sha }];
  });
}

export async function indexGitlinks(root: string, timeout: number, signal?: AbortSignal): Promise<Gitlink[]> {
  const git = new Git(root, timeout, undefined, signal);
  const output = (await git.run(["ls-files", "--stage", "-z"])).stdout;
  for (const entry of output.split("\0")) {
    if (!entry.startsWith("160000 ")) continue;
    if (entry.slice(0, entry.indexOf("\t")).split(" ")[2] !== "0")
      throw new WorkbenchError("gitlink_index_unmerged", "Gitlink index contains an unresolved merge");
  }
  const links = parseEntries(output);
  if (new Set(links.map(link => link.path)).size !== links.length)
    throw new WorkbenchError("gitlink_index_unmerged", "Gitlink index has duplicate paths");
  for (const link of links) childPath(root, link.path);
  return links;
}

export async function commitGitlinks(root: string, ref: string, timeout: number, signal?: AbortSignal): Promise<Gitlink[]> {
  const git = new Git(root, timeout, undefined, signal);
  const links = parseEntries((await git.run(["ls-tree", "-rz", ref])).stdout);
  for (const link of links) childPath(root, link.path);
  return links;
}

export async function gitlinkDetails(root: string, timeout: number, signal?: AbortSignal) {
  const [committed, indexed] = await Promise.all([
    commitGitlinks(root, "HEAD", timeout, signal), indexGitlinks(root, timeout, signal),
  ]);
  const committedByPath = new Map(committed.map(link => [link.path, link.sha]));
  const indexedByPath = new Map(indexed.map(link => [link.path, link.sha]));
  const paths = [...new Set([...committedByPath.keys(), ...indexedByPath.keys()])].sort();
  const rows: Array<{ path: string; committedSha: string | null; indexSha: string | null; checkoutSha: string | null; issue?: string }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    while (next < paths.length) {
      const path = paths[next++], child = childPath(root, path);
      let checkoutSha: string | null = null, issue: string | undefined;
      try {
        if (!existsSync(child)) issue = "repository_missing";
        else {
          const git = new Git(child, timeout, undefined, signal);
          if (await git.root() !== child) issue = "repository_invalid";
          else checkoutSha = await git.head();
        }
      } catch { issue = "repository_observation_failed"; }
      rows.push({ path, committedSha: committedByPath.get(path) || null,
        indexSha: indexedByPath.get(path) || null, checkoutSha, ...(issue ? { issue } : {}) });
    }
  }));
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export async function linkedCandidates(config: Config) {
  const scan = await scanGitRoots({
    roots: config.discovery.roots, sourceRoot: config.sourceRoot,
    maxDepth: config.discovery.maxDepth, excludeNames: config.discovery.exclude,
    excludePaths: [config.stateRoot, config.recordsRoot, config.treesRoot, config.workspaceRoot],
    followSymlinks: config.discovery.followSymlinks,
  });
  const maxCandidates = 64;
  const roots = scan.roots.filter(root => root !== config.sourceRoot).slice(0, maxCandidates);
  const deadline = Date.now() + 8_000;
  const candidates: Array<{ path: string; name: string; links: Gitlink[] }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
    while (next < roots.length && Date.now() < deadline) {
      const root = roots[next++];
      if (!existsSync(root)) continue;
      try {
        const git = new Git(root, config.gitTimeout);
        if (await git.root() !== canonical(root)) continue;
        const links = await indexGitlinks(root, config.gitTimeout);
        if (links.length) candidates.push({ path: root, name: basename(root), links });
      } catch { /* One candidate cannot hide other Git roots. */ }
    }
  }));
  const candidateLimit = scan.roots.length - (scan.roots.includes(config.sourceRoot) ? 1 : 0) > maxCandidates;
  const timedOut = next < roots.length;
  return { ...scan, incomplete: scan.incomplete || candidateLimit || timedOut,
    ...(!scan.reason && (candidateLimit || timedOut) ? { reason: candidateLimit ? "candidate_limit" : "time_limit" } : {}),
    candidates: candidates.sort((a, b) => a.path.localeCompare(b.path)) };
}
