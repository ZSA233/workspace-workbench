import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { canonical, inside, WorkbenchError, type Json } from "./storage.ts";
import { command } from "./process.ts";

export type GitFile = {
  path: string;
  status: string;
  oldPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};
let running = 0;
const priority = new AsyncLocalStorage<number>();
let commands = 0, timedOut = 0;
export const gitDiagnostics = () => ({ running, queued: waiting.length, commands, timedOut });
export const withBackgroundGit = <T>(operation: () => Promise<T>): Promise<T> => priority.run(1, operation);
type GitWaiter = {
  priority: number;
  resolve: () => void;
  reject: (error: WorkbenchError) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
};
const waiting: GitWaiter[] = [];
function observationTimeout(): WorkbenchError {
  return new WorkbenchError(
    "observation_timeout",
    "observation deadline exceeded while waiting for a Git slot",
  );
}
function removeWaiter(waiter: GitWaiter): void {
  const index = waiting.indexOf(waiter);
  if (index >= 0) waiting.splice(index, 1);
}
async function acquireGitSlot(deadline?: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw new WorkbenchError("observer_cancelled", "observation cancelled");
  if (deadline !== undefined && Date.now() >= deadline)
    throw observationTimeout();
  if (running < 4) {
    running++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: GitWaiter = {
      priority: priority.getStore() || 0,
      resolve,
      reject,
      signal,
      settled: false,
    };
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) {
      waiter.settled = true;
      reject(observationTimeout());
      return;
    }
    waiting.push(waiter);
    waiting.sort((a, b) => a.priority - b.priority);
    if (remaining !== undefined)
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        removeWaiter(waiter);
        waiter.settled = true;
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        waiter.reject(observationTimeout());
      }, remaining);
    const onAbort = () => {
      if (waiter.settled) return;
      removeWaiter(waiter);
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new WorkbenchError("observer_cancelled", "observation cancelled"));
    };
    waiter.onAbort = onAbort;
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function releaseGitSlot(): void {
  while (waiting.length) {
    const waiter = waiting.shift()!;
    if (waiter.settled) continue;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    waiter.resolve();
    return;
  }
  running--;
}
async function gitSlot<T>(operation: () => Promise<T>, deadline?: number, signal?: AbortSignal): Promise<T> {
  let acquired = false;
  await acquireGitSlot(deadline, signal);
  acquired = true;
  try {
    if (deadline !== undefined && Date.now() >= deadline)
      throw observationTimeout();
    return await operation();
  } finally {
    if (acquired) releaseGitSlot();
  }
}
export class Git {
  path: string;
  timeout: number;
  deadline?: number;
  signal?: AbortSignal;
  constructor(path: string, timeout = 3000, deadline?: number, signal?: AbortSignal) {
    this.path = canonical(path);
    this.timeout = timeout;
    this.deadline = deadline;
    this.signal = signal;
  }
  async run(args: string[], check = true) {
    if (this.signal?.aborted) throw new WorkbenchError("observer_cancelled", "Git request cancelled");
    let result;
    try {
      result = await gitSlot(() =>
        {
          const remaining = this.deadline === undefined
            ? this.timeout
            : this.deadline - Date.now();
          if (remaining <= 0) throw observationTimeout();
          commands++;
          return command(
            "git",
            ["-c", "core.fsmonitor=false", "-C", this.path, ...args],
            {
              cwd: this.path,
              timeout: Math.max(1, Math.min(this.timeout, remaining)),
              env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
                GIT_EXTERNAL_DIFF: "",
              },
              signal: this.signal,
            },
          );
        },
        this.deadline,
        this.signal,
      );
      if (this.deadline !== undefined && Date.now() >= this.deadline)
        throw observationTimeout();
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === "observation_timeout")
        throw new WorkbenchError("observation_timeout", error.message, {
          repository: this.path,
          args,
        });
      if (error instanceof WorkbenchError && error.code === "process_timeout") {
        timedOut++;
        throw new WorkbenchError(
          this.deadline !== undefined && Date.now() >= this.deadline
            ? "observation_timeout"
            : "git_timeout",
          error.message,
          { repository: this.path, args },
        );
      }
      throw error;
    }
    if (check && result.code !== 0)
      throw new WorkbenchError(
        "git_command_failed",
        result.stderr.trim() || "Git command failed",
        { repository: this.path, args, returncode: result.code },
      );
    return result;
  }
  async text(args: string[], check = true) {
    return (await this.run(args, check)).stdout.trim();
  }
  async valid() {
    return (
      existsSync(this.path) &&
      (await this.text(["rev-parse", "--is-inside-work-tree"], false)) ===
        "true"
    );
  }
  async root() {
    return canonical(await this.text(["rev-parse", "--show-toplevel"]));
  }
  async head() {
    const r = await this.run(["rev-parse", "--verify", "HEAD"], false);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async branch() {
    return (
      (await this.text(
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        false,
      )) || null
    );
  }
  async refsAtHead(head: string): Promise<string[]> {
    if (!head) return [];
    const result = await this.run([
      "for-each-ref",
      "--format=%(refname:short)",
      "--points-at",
      head,
      "refs/heads",
      "refs/remotes",
    ], false);
    if (result.code !== 0) return [];
    return [...new Set(result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
  }
  async upstream(): Promise<[string | null, string | null]> {
    const name = await this.run(
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        false,
      ),
      sha = await this.run(["rev-parse", "--verify", "@{upstream}"], false);
    return [
      name.code === 0 ? name.stdout.trim() : null,
      sha.code === 0 ? sha.stdout.trim() : null,
    ];
  }
  async commit(value: string) {
    const r = await this.run(
      ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`],
      false,
    );
    if (r.code)
      throw new WorkbenchError("commit_missing", "commit is unavailable");
    return r.stdout.trim();
  }
  async status(ignoreSubmoduleContent: boolean | "all" = false, includeIgnored = false): Promise<Array<[string, string]>> {
    const values = (
        await this.run([
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          ...(includeIgnored ? ["--ignored=matching"] : []),
          ...(ignoreSubmoduleContent ? [`--ignore-submodules=${ignoreSubmoduleContent === "all" ? "all" : "dirty"}`] : []),
        ])
      ).stdout.split("\0"),
      result: Array<[string, string]> = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!value) continue;
      const code = value.slice(0, 2),
        path = value.slice(3);
      result.push([
        code,
        /[RC]/.test(code[0]) && values[i + 1]
          ? `${path}\0${values[++i]}`
          : path,
      ]);
    }
    return result;
  }
  async worktrees(): Promise<Json[]> {
    return (await this.text(["worktree", "list", "--porcelain"]))
      .split(/\n\n/)
      .filter(Boolean)
      .map((entry) =>
        Object.fromEntries(
          entry.split("\n").map((line) => {
            const space = line.indexOf(" ");
            return space < 0
              ? [line, true]
              : [line.slice(0, space), line.slice(space + 1)];
          }),
        ),
      );
  }
  async registered(path: string) {
    return (await this.worktrees()).find(
      (entry) =>
        entry.worktree && canonical(entry.worktree) === canonical(path),
    );
  }
  async completed(path: string, branch: string, sha: string) {
    const entry = await this.registered(path);
    return (
      existsSync(path) &&
      entry &&
      !entry.locked &&
      entry.branch === `refs/heads/${branch}` &&
      entry.HEAD === sha
    );
  }
  async refs(head?: string | null): Promise<Json[]> {
    const lines = (
      await this.text([
        "for-each-ref",
        ...(head ? [`--merged=${head}`] : []),
        "--format=%(objectname)\t%(refname)\t%(symref)\t%(*objectname)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ])
    ).split("\n");
    return lines
      .filter(Boolean)
      .map((line) => {
        const [sha, name, , peeled] = line.split("\t");
        const kind = name.startsWith("refs/tags/")
          ? "tag"
          : name.startsWith("refs/remotes/")
            ? "remote"
            : "local";
        return {
          sha: kind === "tag" && peeled ? peeled : sha,
          name,
          shortName: name.replace(/^refs\/(heads|remotes|tags)\//, ""),
          kind,
        };
      })
      .sort((a, b) =>
        `${a.kind}:${a.shortName}`.localeCompare(`${b.kind}:${b.shortName}`),
      );
  }
  async range(
    scope: string,
    base?: string | null,
    commit?: string | null,
  ): Promise<{ args: string[]; left: string | null; right: string | null }> {
    if (scope === "working")
      return { args: ["diff", "HEAD"], left: "HEAD", right: null };
    if (scope === "branch") {
      if (!base) throw new WorkbenchError("base_missing", "base is required");
      const left = await this.commit(base),
        right = await this.head();
      return { args: ["diff", left, right || "HEAD"], left, right };
    }
    if (scope !== "commit")
      throw new WorkbenchError("scope_invalid", "unsupported scope");
    if (!commit)
      throw new WorkbenchError("commit_required", "commit is required");
    const right = await this.commit(commit),
      parents = (await this.text(["rev-list", "--parents", "-n", "1", right]))
        .split(/\s+/)
        .slice(1);
    return {
      args: parents.length
        ? ["diff", parents[0], right]
        : ["diff-tree", "--root", "--no-commit-id", "-r", right],
      left: parents[0] || null,
      right,
    };
  }
  async files(
    scope: string,
    base?: string | null,
    commit?: string | null,
    ignoreSubmoduleContent = false,
  ): Promise<GitFile[]> {
    const hasHead = await this.head(),
      range = await this.range(scope, base, commit);
    const diffArgs = scope === "working" && ignoreSubmoduleContent
      ? [...range.args, "--ignore-submodules=dirty"] : range.args;
    const empty = scope === "working" && !hasHead;
    const names = empty
      ? []
      : (
          await this.run([
            ...diffArgs,
            "--no-ext-diff",
            "--name-status",
            "-z",
            "--find-renames",
          ])
        ).stdout.split("\0");
    const result: GitFile[] = [];
    for (let i = 0; i < names.length; ) {
      const status = names[i++];
      if (!status) continue;
      let path = names[i++],
        oldPath: string | null = null;
      if (/^[RC]/.test(status)) {
        oldPath = path;
        path = names[i++];
      }
      result.push({
        path,
        status: status[0],
        oldPath,
        additions: null,
        deletions: null,
        binary: false,
      });
    }
    const stats = empty
      ? []
      : (
          await this.run([...diffArgs, "--no-ext-diff", "--numstat", "-z"])
        ).stdout.split("\0");
    for (let i = 0; i < stats.length; ) {
      const fields = stats[i++].split("\t");
      if (fields.length < 3) continue;
      let path = fields.slice(2).join("\t");
      if (!path) {
        i++;
        path = stats[i++];
      }
      const file = result.find((item) => item.path === path);
      if (file)
        Object.assign(file, {
          additions: fields[0] === "-" ? null : Number(fields[0]),
          deletions: fields[1] === "-" ? null : Number(fields[1]),
          binary: fields[0] === "-",
        });
    }
    if (scope === "working")
      for (const [status, path] of await this.status())
        if (status === "??" && !result.some((item) => item.path === path)) {
          let additions: number | null = null;
          try {
            const target = join(this.path, path);
            if (!inside(target, this.path)) throw new Error("outside");
            const data = lstatSync(target).isSymbolicLink()
              ? Buffer.from(readlinkSync(target))
              : readFileSync(target);
            const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
            if (!data.includes(0))
              additions = text
                ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
                : 0;
          } catch {}
          result.push({
            path,
            status: "A",
            oldPath: null,
            additions,
            deletions: 0,
            binary: additions === null,
          });
        }
    return result;
  }
  async diff(
    scope: string,
    path: string,
    base?: string | null,
    commit?: string | null,
  ) {
    if (isAbsolute(path) || path.split("/").includes(".."))
      throw new WorkbenchError("path_invalid", "diff path must be relative");
    const file = (await this.files(scope, base, commit)).find(
      (item) => item.path === path,
    );
    if (!file)
      throw new WorkbenchError(
        "file_not_changed",
        "file is not in selected changes",
      );
    const range = await this.range(scope, base, commit);
    const untracked =
      scope === "working" &&
      (!(await this.head()) ||
        (await this.status()).some(
          ([code, name]) => code === "??" && name === path,
        ));
    if (untracked && !inside(join(this.path, path), this.path))
      throw new WorkbenchError(
        "path_invalid",
        "untracked file points outside repository",
      );
    const args = untracked
      ? [
          "diff",
          "--no-ext-diff",
          "--no-index",
          "--unified=80",
          "--",
          "/dev/null",
          path,
        ]
      : [
          ...range.args,
          "--no-ext-diff",
          "--unified=80",
          "--",
          ...(file.oldPath ? [file.oldPath] : []),
          path,
        ];
    const result = await this.run(args, false);
    if (result.code !== 0 && !(untracked && result.code === 1))
      throw new WorkbenchError("git_diff_failed", result.stderr);
    return {
      patch: result.stdout,
      left: untracked ? null : range.left,
      right: range.right,
    };
  }
  async graph(mode: string, base: string | null, limit: number) {
    const head = await this.head();
    if (!head)
      return {
        nodes: [],
        refs: [],
        hasOlder: false,
        loadedCount: 0,
        baseLoaded: false,
        historyMode: mode,
      };
    if (!["branch", "full"].includes(mode))
      throw new WorkbenchError("history_mode_invalid", "invalid history mode");
    if (mode === "branch" && !base)
      throw new WorkbenchError("base_missing", "base is required");
    const safeBase = base ? await this.commit(base) : null;
    const lines = (
      await this.text([
        "log",
        "--topo-order",
        "--date-order",
        `--max-count=${limit + 1}`,
        "--pretty=format:%H%x00%P%x00%h%x00%s%x00%an%x00%aI",
        ...(mode === "branch" ? [`${safeBase}..${head}`] : []),
      ])
    )
      .split("\n")
      .filter(Boolean);
    const nodes: Json[] = lines.slice(0, limit).map((line) => {
      const [sha, parents, shortSha, subject, author, authoredAt] =
        line.split("\0");
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        shortSha,
        subject,
        author,
        authoredAt,
        isBase: sha === safeBase,
      };
    });
    if (
      mode === "branch" &&
      safeBase &&
      !nodes.some((node) => node.sha === safeBase)
    )
      nodes.push({
        sha: safeBase,
        shortSha: safeBase.slice(0, 8),
        parents: [],
        subject:
          (await this.text(["show", "-s", "--format=%s", safeBase], false)) ||
          "base",
        author: "",
        authoredAt: "",
        isBase: true,
      });
    const refs = (await this.refs(head)).filter((ref) =>
      nodes.some((node) => node.sha === ref.sha),
    );
    const branch = await this.branch(),
      [upstream] = await this.upstream();
    refs.forEach((ref) =>
      Object.assign(ref, {
        isHead: ref.kind === "local" && ref.shortName === branch,
        isUpstream: ref.shortName === upstream,
      }),
    );
    nodes.forEach((node) => {
      node.refs = refs.filter((ref) => ref.sha === node.sha);
      node.decorations = [
        ...(node.sha === head ? ["HEAD"] : []),
        ...node.refs.map((ref: Json) => ref.shortName),
      ];
      if (node.parents.length > 1)
        node.mergeSources = node.parents
          .slice(1)
          .map((parentSha: string) => ({
            parentSha,
            refs: refs.filter((ref) => ref.sha === parentSha),
          }));
    });
    return {
      nodes,
      refs,
      hasOlder: lines.length > limit,
      loadedCount:
        mode === "full"
          ? nodes.length
          : nodes.filter((node) => !node.isBase).length,
      baseLoaded: nodes.some((node) => node.isBase),
      historyMode: mode,
    };
  }
}
