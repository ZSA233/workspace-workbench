import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";

export type ScanResult = { roots: string[]; incomplete: boolean; reason?: "directory_limit" | "entry_limit" | "time_limit"; scannedDirectories: number };
export type ScanOptions = {
  roots: string[];
  sourceRoot: string;
  maxDepth: number;
  excludeNames?: readonly string[];
  excludePaths?: readonly string[];
  descendIntoRepositories?: readonly string[];
  followSymlinks?: boolean;
  maxDirectories?: number;
  maxEntries?: number;
  maxDurationMs?: number;
};

function within(path: string, root: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith("../") && !isAbsolute(part));
}

/** Discover Git roots by structure, never by a directory's name or contents. */
export async function scanGitRoots(options: ScanOptions): Promise<ScanResult> {
  const sourceRoot = await realpath(options.sourceRoot);
  const excludedPaths = await Promise.all((options.excludePaths || []).map(async path => {
    try { return await realpath(path); } catch { return resolve(path); }
  }));
  const protectedPaths = excludedPaths
    .filter(path => path !== sourceRoot && within(path, sourceRoot));
  const excludedNames = new Set(options.excludeNames || []);
  const configuredDescendants = await Promise.all((options.descendIntoRepositories || []).map(async path => {
    try { return await realpath(path); } catch { return resolve(path); }
  }));
  const queue = options.roots.map(path => ({ path: resolve(path), depth: 0 }));
  const visited = new Set<string>(), found: string[] = [];
  const deadline = Date.now() + (options.maxDurationMs ?? 10_000);
  const maxDirectories = options.maxDirectories ?? 10_000;
  const maxEntries = options.maxEntries ?? 50_000;
  let reason: ScanResult["reason"];
  let entriesVisited = 0;
  while (queue.length) {
    if (visited.size >= maxDirectories) { reason = "directory_limit"; break; }
    if (Date.now() >= deadline) { reason = "time_limit"; break; }
    const current = queue.shift()!;
    let path: string;
    try { path = await realpath(current.path); } catch { continue; }
    if (!within(path, sourceRoot) || protectedPaths.some(excluded => within(path, excluded)) || visited.has(path)) continue;
    visited.add(path);
    if (visited.size % 100 === 0) await new Promise<void>(done => setImmediate(done));
    let repository = false;
    try { const marker = await lstat(join(path, ".git")); repository = marker.isDirectory() || marker.isFile(); } catch {}
    if (repository) {
      found.push(path);
      // A discovered checkout is a candidate, not a request to inspect its
      // contents. Continue only through roots containing configured children.
      if (path !== sourceRoot && !configuredDescendants.some(child => child !== path && within(child, path))) continue;
    }
    if (current.depth >= options.maxDepth) continue;
    try {
      const directory = await opendir(path);
      for await (const entry of directory) {
        entriesVisited++;
        if (entriesVisited % 100 === 0) await new Promise<void>(done => setImmediate(done));
        if (entriesVisited >= maxEntries) { reason = "entry_limit"; break; }
        if (Date.now() >= deadline) { reason = "time_limit"; break; }
        if (entry.name === ".git" || excludedNames.has(entry.name)) continue;
        if (entry.isDirectory()) queue.push({ path: join(path, entry.name), depth: current.depth + 1 });
        else if (entry.isSymbolicLink() && options.followSymlinks) {
          const candidate = join(path, entry.name);
          try { if ((await stat(candidate)).isDirectory()) queue.push({ path: candidate, depth: current.depth + 1 }); } catch {}
        }
      }
    } catch { continue; }
    if (reason) break;
  }
  return { roots: found.sort((a, b) => a.localeCompare(b)), incomplete: Boolean(reason), ...(reason ? { reason } : {}), scannedDirectories: visited.size };
}
