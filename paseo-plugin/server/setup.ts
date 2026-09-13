import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ProjectSetupScan, SetupRepository } from "../shared/setup.ts";
import { backendStatus, startBackend } from "./backend-manager.ts";
import { resolveProject, type ProjectRoute } from "./projects.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDES = new Set([".git", ".workspace-workbench", "node_modules", "vendor", ".venv", "__pycache__", "dist", "build"]);
const EXCLUDE_BLOCK_START = "# workspace-workbench:begin";
const EXCLUDE_BLOCK_END = "# workspace-workbench:end";
const SHARED_CONFIG_MARKER = "# workspace-workbench:shared-config";

type GitResult = { stdout: string };
type ConfigValue = Record<string, unknown>;

type ConfigLayout = {
  sourceRoot: string;
  workspaceRoot: string;
  treesRoot: string;
  recordsRoot: string;
  stateRoot: string;
};

function slug(value: string): string {
  const result = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "project";
}

function unixRelative(root: string, target: string): string {
  const value = relative(root, target).split(sep).join("/");
  return value || ".";
}

function inside(root: string, target: string): boolean {
  const value = unixRelative(root, target);
  return value === "." || (!value.startsWith("../") && value !== ".." && !value.startsWith("/"));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function readConfigValue(path: string): ConfigValue {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as ConfigValue : {};
  } catch {
    return {};
  }
}

function configLayout(configPath: string, raw: ConfigValue, defaultSourceRoot: string): ConfigLayout {
  const base = dirname(configPath);
  const sourceRoot = resolve(base, stringValue(raw.sourceRoot, relative(base, defaultSourceRoot) || "."));
  const stateRoot = resolve(base, stringValue(raw.stateRoot, "state"));
  const hasWorkspaceRoot = typeof raw.workspaceRoot === "string" && Boolean(raw.workspaceRoot.trim());
  const workspaceRoot = resolve(base, stringValue(raw.workspaceRoot, "."));
  const recordsRoot = resolve(base, stringValue(raw.recordsRoot, hasWorkspaceRoot ? join(workspaceRoot, "records") : "state/records"));
  const treesRoot = resolve(base, stringValue(raw.treesRoot, hasWorkspaceRoot ? join(workspaceRoot, "trees") : "worktrees"));
  return { sourceRoot, workspaceRoot, treesRoot, recordsRoot, stateRoot };
}

async function runGit(repository: string | null, args: string[], timeout = 3_000): Promise<string | null> {
  try {
    const command = repository ? ["-C", repository, ...args] : args;
    const result = await execFileAsync("git", command, { timeout, maxBuffer: 256 * 1024, encoding: "utf8" }) as GitResult;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function resolveGitRoot(directory: string): Promise<string | null> {
  const value = await runGit(directory, ["rev-parse", "--show-toplevel"]);
  if (!value) return null;
  try {
    const root = realpathSync(value);
    return existsSync(join(root, ".git")) ? root : null;
  } catch {
    return null;
  }
}

function hasGitMarker(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}

function nestedGitRoots(root: string): string[] {
  const found: string[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.directory !== root && hasGitMarker(current.directory)) {
      found.push(current.directory);
      continue;
    }
    if (current.depth >= 3) continue;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || DEFAULT_EXCLUDES.has(entry.name)) continue;
      queue.push({ directory: join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

async function inspectRepository(projectRoot: string, repositoryRoot: string, kind: SetupRepository["kind"], id: string): Promise<SetupRepository> {
  const repoPath = unixRelative(projectRoot, repositoryRoot);
  const branch = await runGit(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const head = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  const status = await runGit(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const valid = (await runGit(repositoryRoot, ["rev-parse", "--is-inside-work-tree"])) === "true";
  return {
    id,
    name: basename(repositoryRoot) || id,
    repoPath,
    kind,
    branch,
    head,
    dirty: status === null ? null : Boolean(status),
    changedFiles: status === null ? null : status ? status.split("\n").length : 0,
    valid,
    selectedByDefault: false,
    ...(valid ? {} : { issue: "This directory is not a valid Git checkout." }),
  };
}

function repositoryId(projectRoot: string, repositoryRoot: string, used: Set<string>): string {
  const path = unixRelative(projectRoot, repositoryRoot);
  const base = slug(path === "." ? basename(projectRoot) : path.replaceAll("/", "-"));
  let value = base;
  let suffix = 2;
  while (used.has(value)) value = `${base}-${suffix++}`;
  used.add(value);
  return value;
}

export async function scanProject(directory: string): Promise<ProjectSetupScan> {
  let current: string;
  try {
    current = realpathSync(directory);
  } catch {
    throw new Error("当前工作目录不可用。");
  }
  const gitAvailable = (await runGit(null, ["--version"], 2_000)) !== null;
  const gitRoot = gitAvailable ? await resolveGitRoot(current) : null;
  const projectRoot = gitRoot || current;
  const displayName = basename(projectRoot) || "Workspace";
  const used = new Set<string>();
  const repositoryRoots = new Map<string, { root: string; kind: SetupRepository["kind"] }>();
  if (gitAvailable) {
    if (gitRoot) repositoryRoots.set(gitRoot, { root: gitRoot, kind: "root" });
    for (const nested of nestedGitRoots(projectRoot)) {
      if (nested !== gitRoot && inside(projectRoot, nested)) repositoryRoots.set(nested, { root: nested, kind: "nested" });
    }
  }
  const repositories = await Promise.all([...repositoryRoots.values()].map(async ({ root, kind }) => {
    const item = await inspectRepository(projectRoot, root, kind, repositoryId(projectRoot, root, used));
    return { ...item, selectedByDefault: kind === "root" || !gitRoot };
  }));
  repositories.sort((left, right) => left.repoPath.localeCompare(right.repoPath));
  return {
    projectRoot,
    displayName,
    configPath: join(projectRoot, ".workspace-workbench", "project.json"),
    configRelativePath: ".workspace-workbench/project.json",
    gitAvailable,
    gitRoot,
    repositories,
    defaultRepositoryPaths: repositories.filter((item) => item.selectedByDefault && item.valid).map((item) => item.repoPath),
    configExists: existsSync(join(projectRoot, ".workspace-workbench", "project.json")),
  };
}

function atomicWrite(path: string, value: string, mode = 0o600): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode });
  renameSync(temporary, path);
}

async function gitExcludePath(projectRoot: string): Promise<string | null> {
  const value = await runGit(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!value) return null;
  return value.startsWith("/") ? value : join(projectRoot, value);
}

async function isIgnored(projectRoot: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", projectRoot, "check-ignore", "--no-index", "-q", path], { timeout: 2_000, maxBuffer: 8 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function ignoreEntry(projectRoot: string, target: string, directory: boolean): string | null {
  if (!inside(projectRoot, target)) return null;
  const value = unixRelative(projectRoot, target);
  if (value === ".") return null;
  return `/${value}${directory ? "/" : ""}`;
}

function runtimeIgnoreEntries(projectRoot: string, configPath: string, layout: ConfigLayout): string[] {
  const entries = [
    ignoreEntry(projectRoot, layout.stateRoot, true),
    ignoreEntry(projectRoot, layout.treesRoot, true),
    ignoreEntry(projectRoot, join(layout.workspaceRoot, ".workspace.lock"), false),
    ignoreEntry(projectRoot, join(layout.stateRoot, "backend"), true),
  ];
  return [...new Set(entries.filter((entry): entry is string => Boolean(entry)))].filter((entry) => entry !== ignoreEntry(projectRoot, configPath, false));
}

async function makeConfigShareable(projectRoot: string, configPath: string, runtimeIgnores: string[]): Promise<void> {
  const path = join(projectRoot, ".gitignore");
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* A repository may not have a project ignore file yet. */ }
  const lines = current.split(/\r?\n/);
  const configRelative = ignoreEntry(projectRoot, configPath, false) || "/.workspace-workbench/project.json";
  const desired = [SHARED_CONFIG_MARKER, `!${configRelative.slice(0, configRelative.lastIndexOf("/")) || "/"}/`, `!${configRelative}`, ...runtimeIgnores];
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.includes(SHARED_CONFIG_MARKER)) lines.push(...desired);
  else for (const entry of desired.slice(1)) if (!lines.includes(entry)) lines.push(entry);
  lines.push("");
  atomicWrite(path, `${lines.join("\n")}\n`, 0o644);
}

function makeConfigPrivate(projectRoot: string, configPath: string): void {
  const path = join(projectRoot, ".gitignore");
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { return; }
  const configRelative = ignoreEntry(projectRoot, configPath, false) || "/.workspace-workbench/project.json";
  const generatedRules = new Set([
    SHARED_CONFIG_MARKER,
    `!${configRelative.slice(0, configRelative.lastIndexOf("/")) || "/"}/`,
    `!${configRelative}`,
  ]);
  const sourceLines = current.split(/\r?\n/);
  if (!sourceLines.some((line) => generatedRules.has(line.trim()))) return;
  const lines = sourceLines.filter((line) => !generatedRules.has(line.trim()));
  while (lines.length && !lines.at(-1)) lines.pop();
  atomicWrite(path, `${lines.join("\n")}\n`, 0o644);
}

async function updateLocalExclude(projectRoot: string, configPath: string, shareConfig: boolean, runtimeIgnores: string[]): Promise<void> {
  const path = await gitExcludePath(projectRoot);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch { /* Git creates this file lazily. */ }
  const lines = current.split(/\r?\n/);
  const start = lines.indexOf(EXCLUDE_BLOCK_START);
  const end = start >= 0 ? lines.indexOf(EXCLUDE_BLOCK_END, start + 1) : -1;
  if (start >= 0 && end >= 0) lines.splice(start, end - start + 1);
  while (lines.length && !lines.at(-1)) lines.pop();
  lines.push(EXCLUDE_BLOCK_START);
  const configEntry = ignoreEntry(projectRoot, configPath, false);
  if (!shareConfig && configEntry) lines.push(configEntry);
  lines.push(...runtimeIgnores);
  lines.push(EXCLUDE_BLOCK_END, "");
  atomicWrite(path, `${lines.join("\n")}\n`, 0o600);
}

function registryPath(): string {
  return join(homedir(), ".config", "workspace-workbench", "projects.json");
}

function registerProject(configPath: string): void {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let configs: string[] = [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { configs?: unknown };
    if (Array.isArray(value.configs)) configs = value.configs.filter((item): item is string => typeof item === "string");
  } catch { /* A missing or damaged index is rebuilt from this project. */ }
  if (!configs.includes(configPath)) configs.push(configPath);
  atomicWrite(path, `${JSON.stringify({ configs }, null, 2)}\n`);
}

export async function saveProjectSetup(input: { directory: string; repositories: string[]; shareConfig: boolean }) {
  const scan = await scanProject(input.directory);
  const available = new Map(scan.repositories.map((repository) => [repository.repoPath, repository]));
  const selectedPaths = [...new Set(input.repositories)];
  const selected = selectedPaths.map((path) => available.get(path));
  if (selected.some((repository) => !repository || !repository.valid)) throw new Error("请选择有效的 Git 仓库。");
  if (!selected.length) throw new Error("至少选择一个 Git 仓库。");
  const configDirectory = join(scan.projectRoot, ".workspace-workbench");
  const configPath = join(configDirectory, "project.json");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  const previous = existsSync(configPath) ? readConfigValue(configPath) : {};
  const layout = configLayout(configPath, previous, scan.projectRoot);
  const previousProject = previous.project && typeof previous.project === "object" && !Array.isArray(previous.project)
    ? previous.project as ConfigValue
    : {};
  const previousDiscovery = previous.discovery && typeof previous.discovery === "object" && !Array.isArray(previous.discovery)
    ? previous.discovery as ConfigValue
    : {};
  const value = {
    // Setup is also used to refresh an existing project. Keep every unknown
    // but valid extension (agent bridge, toolchain, limits, review, adapter)
    // instead of silently replacing it with a minimal config.
    ...previous,
    schemaVersion: 1,
    project: { ...previousProject, id: slug(stringValue(previousProject.id, scan.displayName)), displayName: scan.displayName },
    sourceRoot: stringValue(previous.sourceRoot, relative(configDirectory, scan.projectRoot) || "."),
    workspaceRoot: stringValue(previous.workspaceRoot, "."),
    recordsRoot: stringValue(previous.recordsRoot, unixRelative(configDirectory, layout.recordsRoot)),
    treesRoot: stringValue(previous.treesRoot, unixRelative(configDirectory, layout.treesRoot)),
    stateRoot: stringValue(previous.stateRoot, unixRelative(configDirectory, layout.stateRoot)),
    socketPath: stringValue(previous.socketPath, "auto"),
    discovery: {
      ...previousDiscovery,
      mode: "hybrid",
      roots: ["."],
      maxDepth: 3,
      exclude: [...DEFAULT_EXCLUDES],
      followSymlinks: false,
    },
    repositories: selected.map((repository) => ({
      id: repository!.id,
      path: repository!.repoPath,
      displayName: repository!.name,
      enabled: true,
    })),
    mainWorkspace: { displayName: "Main workspace" },
    management: { enabled: true },
  };
  atomicWrite(configPath, `${JSON.stringify(value, null, 2)}\n`);
  const runtimeIgnores = runtimeIgnoreEntries(scan.projectRoot, configPath, layout);
  if (input.shareConfig) await makeConfigShareable(scan.projectRoot, configPath, runtimeIgnores);
  else makeConfigPrivate(scan.projectRoot, configPath);
  await updateLocalExclude(scan.projectRoot, configPath, input.shareConfig, runtimeIgnores);
  registerProject(configPath);
  const backend = await startBackend(configPath);
  return {
    project: {
      configPath,
      sourceRoot: layout.sourceRoot,
      workspaceRoot: layout.workspaceRoot,
      displayName: scan.displayName,
    },
    backend,
  };
}

function describeStoragePath(projectRoot: string, target: string, location?: "project" | "external" | "user") {
  const path = resolve(target);
  const relativeValue = unixRelative(projectRoot, path);
  const inProject = inside(projectRoot, path);
  return {
    path,
    relativePath: location === "user" || !inProject ? null : relativeValue,
    location: location || (inProject ? "project" : "external"),
  };
}

async function projectIgnoreMode(route: ProjectRoute): Promise<"local" | "shared" | "ignored" | "external" | "unavailable"> {
  if (!inside(route.sourceRoot, route.configPath)) return "external";
  const excludePath = await gitExcludePath(route.sourceRoot);
  if (!excludePath) return "unavailable";
  const configRelative = unixRelative(route.sourceRoot, route.configPath);
  if (!(await isIgnored(route.sourceRoot, configRelative))) return "shared";
  try {
    const exclude = readFileSync(excludePath, "utf8").split(/\r?\n/).map((line) => line.trim());
    if (exclude.includes(`/${configRelative}`) || exclude.includes(configRelative) || exclude.includes(EXCLUDE_BLOCK_START)) return "local";
  } catch {
    // A Git repository may expose an exclude path before the file exists.
  }
  return "ignored";
}

export async function handleProjectStorage(input: { projectConfig: string }) {
  const route = resolveProject({ projectConfig: input.projectConfig });
  return {
    projectRoot: route.sourceRoot,
    config: describeStoragePath(route.sourceRoot, route.configPath),
    workspaces: describeStoragePath(route.sourceRoot, route.workspaceRoot),
    worktrees: describeStoragePath(route.sourceRoot, route.treesRoot),
    records: describeStoragePath(route.sourceRoot, route.recordsRoot),
    state: describeStoragePath(route.sourceRoot, route.stateRoot),
    socket: describeStoragePath(route.sourceRoot, route.socketPath, "user"),
    ignoreMode: await projectIgnoreMode(route),
  };
}

export async function handleProjectSetupScan(input: { directory: string }): Promise<ProjectSetupScan> {
  return scanProject(input.directory);
}

export async function handleProjectSetupSave(input: { directory: string; repositories: string[]; shareConfig: boolean }) {
  return saveProjectSetup(input);
}

export async function handleProjectBackendStart(input: { projectConfig: string }) {
  return startBackend(input.projectConfig);
}

export async function handleProjectBackendStatus(input: { projectConfig: string }) {
  return backendStatus(input.projectConfig);
}
