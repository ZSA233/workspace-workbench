import { createReadStream, existsSync, lstatSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { Git } from "./git.ts";
import {
  canonical,
  hash,
  inside,
  WorkbenchError,
  type Json,
} from "./storage.ts";
import { type Config } from "./config.ts";
export async function runtimeIdentity(repo: Json, config: Config, verifyRecordedBranch = true) {
  const path = canonical(repo.worktreePath),
    git = new Git(path, config.gitTimeout),
    ignoreChildContent = repo.role === "gitlink-root";
  if (!existsSync(path))
    throw new WorkbenchError("worktree_missing", "worktree is unavailable");
  const branch = await git.branch(),
    head = await git.head();
  if ((await git.root()) !== path || (verifyRecordedBranch && branch !== repo.branch))
    throw new WorkbenchError(
      "worktree_identity_changed",
      "worktree Git identity changed",
    );
  const status = (
    await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", ...(ignoreChildContent ? ["--ignore-submodules=dirty"] : [])])
  ).stdout;
  const staged = (
    await git.run(["diff", "--no-ext-diff", "--cached", "--binary"])
  ).stdout;
  const working = head
    ? (await git.run(["diff", "--no-ext-diff", "--binary", "HEAD", ...(ignoreChildContent ? ["--ignore-submodules=dirty"] : [])])).stdout
    : "";
  const dirtyPaths: string[] = [],
    fileDigests: string[] = [];
  for (const [, name] of await git.status(ignoreChildContent)) {
    const relative = name.split("\0").at(-1)!;
    dirtyPaths.push(relative);
    if (
      isAbsolute(relative) ||
      relative.split("/").includes("..") ||
      !inside(join(path, relative), path)
    ) {
      fileDigests.push(`${relative}:outside`);
      continue;
    }
    try {
      const candidate = join(path, relative),
        info = lstatSync(candidate);
      let cursor = path,
        symlink = false;
      for (const part of relative.split("/")) {
        cursor = join(cursor, part);
        if (lstatSync(cursor).isSymbolicLink()) {
          symlink = true;
          break;
        }
      }
      if (symlink)
        fileDigests.push(`${relative}:symlink:${readlinkSync(cursor)}`);
      else if (info.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(candidate))
          digest.update(chunk);
        fileDigests.push(
          `${relative}:file:${info.size}:${digest.digest("hex")}`,
        );
      } else fileDigests.push(`${relative}:special:${info.mode}`);
    } catch {
      fileDigests.push(`${relative}:unreadable`);
    }
  }
  if ((await git.head()) !== head || (await git.branch()) !== branch)
    throw new WorkbenchError(
      "git_runtime_changed",
      "Git identity changed while preparing handoff; retry",
    );
  return {
    id: repo.id,
    repoPath: repo.repoPath,
    worktreePath: path,
    branch,
    baseRef: repo.baseRef || null,
    baseSha: repo.baseSha || null,
    head,
    indexDigest: hash(staged),
    worktreeDigest: hash(working + fileDigests.sort().join("\0")),
    statusDigest: hash(status),
    dirtyPaths: dirtyPaths.sort(),
  };
}
