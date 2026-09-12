import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

export type ProjectRoute = { configPath: string; sourceRoot: string; workspaceRoot: string; stateRoot: string; socketPath: string; displayName: string };
const current = new AsyncLocalStorage<ProjectRoute>();

export function registeredProjects(): ProjectRoute[] {
  const registry = join(homedir(), ".config", "workspace-workbench", "projects.json");
  const paths: string[] = existsSync(registry) ? JSON.parse(readFileSync(registry, "utf8")).configs : [];
  const override = process.env.WORKSPACE_WORKBENCH_CONFIG;
  if (override) paths.push(override);
  return [...new Set(paths)].flatMap((path) => {
    try {
      const configPath = realpathSync(path);
      const value = JSON.parse(readFileSync(configPath, "utf8"));
      const base = dirname(configPath);
      const expand = (value: string) => value === "auto" ? join(homedir(), ".config", "workspace-workbench", createHash("sha256").update(configPath).digest("hex").slice(0, 12) + ".sock") : value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(base, value);
      const sourceRoot = resolve(base, value.sourceRoot || ".");
      const stateRoot = resolve(base, value.stateRoot || join(sourceRoot, ".workspace-workbench"));
      return [{ configPath, sourceRoot, stateRoot, workspaceRoot: resolve(base, value.workspaceRoot || join(stateRoot, "workspaces")), socketPath: expand(value.socketPath || join(stateRoot, "observer.sock")), displayName: value.project?.displayName || value.project?.id || "Workspace" }];
    } catch { return []; }
  });
}

export function resolveProject(input: { projectConfig?: string; directory?: string }, projects = registeredProjects()): ProjectRoute {
  if (input.projectConfig) {
    const found = projects.find((p) => p.configPath === resolve(input.projectConfig!));
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
