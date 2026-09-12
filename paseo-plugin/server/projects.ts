import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

export type ProjectRoute = {
  configPath: string;
  sourceRoot: string;
  workspaceRoot: string;
  treesRoot: string;
  recordsRoot: string;
  stateRoot: string;
  socketPath: string;
  displayName: string;
};
const current = new AsyncLocalStorage<ProjectRoute>();

function localProjectConfigs(directory?: string): string[] {
  if (!directory) return [];
  let cursor: string;
  try {
    cursor = realpathSync(directory);
  } catch {
    return [];
  }
  const paths: string[] = [];
  while (true) {
    const candidate = join(cursor, ".workspace-workbench", "project.json");
    if (existsSync(candidate)) paths.push(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return paths;
}

function configuredProjectPaths(directory?: string): string[] {
  const registry = join(homedir(), ".config", "workspace-workbench", "projects.json");
  let paths: string[] = [];
  try {
    const value = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")) : null;
    if (value && Array.isArray(value.configs)) paths = value.configs.filter((path: unknown): path is string => typeof path === "string");
  } catch {
    paths = [];
  }
  const override = process.env.WORKSPACE_WORKBENCH_CONFIG;
  if (override) paths.push(override);
  paths.push(...localProjectConfigs(directory));
  return [...new Set(paths)];
}

export function registeredProjects(options: { directory?: string } = {}): ProjectRoute[] {
  const paths = configuredProjectPaths(options.directory);
  return [...new Set(paths)].flatMap((path) => {
    try {
      const configPath = realpathSync(path);
      const value = JSON.parse(readFileSync(configPath, "utf8"));
      const base = dirname(configPath);
      const expand = (value: string) => value === "auto" ? join(homedir(), ".config", "workspace-workbench", createHash("sha256").update(configPath).digest("hex").slice(0, 12) + ".sock") : value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(base, value);
      const sourceRoot = resolve(base, value.sourceRoot || ".");
      const stateRoot = resolve(base, value.stateRoot || join(sourceRoot, ".workspace-workbench"));
      const workspaceRoot = resolve(base, value.workspaceRoot || join(stateRoot, "workspaces"));
      const recordsRoot = resolve(base, value.recordsRoot || join(workspaceRoot, "records"));
      const treesRoot = resolve(base, value.treesRoot || join(workspaceRoot, "trees"));
      return [{ configPath, sourceRoot, stateRoot, workspaceRoot, recordsRoot, treesRoot, socketPath: expand(value.socketPath || join(stateRoot, "observer.sock")), displayName: value.project?.displayName || value.project?.id || "Workspace" }];
    } catch { return []; }
  });
}

export function resolveProject(input: { projectConfig?: string; directory?: string }, projects = registeredProjects({ directory: input.directory })): ProjectRoute {
  if (input.projectConfig) {
    const configPath = resolve(input.projectConfig!);
    const candidates = projects.some((project) => project.configPath === configPath)
      ? projects
      : [...projects, ...registeredProjects({ directory: dirname(configPath) })];
    const found = candidates.find((p) => p.configPath === configPath);
    if (!found) throw new Error("project_not_registered");
    return found;
  }
  if (input.directory) {
    const directory = realpathSync(input.directory);
    const contains = (root: string) => { const rel = relative(root, directory); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
    const matches = projects.filter((p) => contains(p.sourceRoot) || contains(p.workspaceRoot)).sort((a, b) => b.sourceRoot.length - a.sourceRoot.length);
    if (matches.length) return matches[0];
    throw new Error("project_not_registered");
  }
  if (projects.length === 1) return projects[0];
  throw new Error("project_selection_required");
}

export function currentProject(): ProjectRoute | undefined { return current.getStore(); }
export function withProject<T>(input: { projectConfig?: string; directory?: string }, operation: () => T): T {
  return current.run(resolveProject(input), operation);
}
