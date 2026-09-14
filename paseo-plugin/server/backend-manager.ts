import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveProject, type ProjectRoute } from "./projects.ts";
import type { ProjectBackendStatus } from "../shared/setup.ts";
import { BackendSupervisor, backendRequest } from "./backend-supervisor.ts";
import type { Json } from "./backend/storage.ts";
import { loadConfig } from "./backend/config.ts";

const PLUGIN_ID = "workspace-workbench-paseo";

function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim() || "~/.paseo";
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

function pluginRootFromPaseoConfig(): string | null {
  try {
    const value = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8")) as {
      plugins?: Record<string, { path?: unknown }>;
    };
    const sources = Object.entries(value.plugins || {});
    const preferred = sources.find(([id]) => id === PLUGIN_ID);
    const candidate = preferred?.[1]?.path;
    if (typeof candidate === "string" && existsSync(join(candidate, "paseo-plugin.json"))) return candidate;
  } catch {
    // Standalone CLI/server runs may not have a Paseo config; environment and
    // PATH resolution below remain available for those modes.
  }
  return null;
}

function pluginRoot(): string | null {
  const candidates = [
    process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT?.trim() || null,
    pluginRootFromPaseoConfig(),
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(join(candidate, "paseo-plugin.json"))) || null;
}

let supervisor: BackendSupervisor | null = null;
let disposed = false;
function statusFor(
  route: ProjectRoute,
  state: ProjectBackendStatus["state"],
  message?: string,
  health?: Json | null,
): ProjectBackendStatus {
  let timing = health?.timing;
  if (!timing) {
    try { timing = loadConfig(route.configPath).timing; } catch {}
  }
  const instanceId = health?.process?.instanceId || health?.instanceId;
  return {
    state,
    ...(message ? { message } : {}),
    socketPath: route.socketPath,
    ...(timing ? { timing } : {}),
    ...(typeof instanceId === "string" ? { instanceId } : {}),
  };
}
function version(): string { const root = pluginRoot(); return root ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version : "0.1.3"; }
function manager(): BackendSupervisor {
  if (disposed) throw new Error("plugin generation has unloaded");
  if (supervisor) return supervisor;
  const root = pluginRoot();
  if (!root) throw new Error("Workbench plugin root is unavailable");
  const entry = join(root, "server/backend/main.ts");
  if (!existsSync(entry)) throw new Error("Node backend is missing from plugin package");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 14) throw new Error("Workbench requires Node.js 22.14 or newer");
  return supervisor = new BackendSupervisor(entry);
}
export async function backendStatus(projectConfig: string): Promise<ProjectBackendStatus> {
  try {
    const route = resolveProject({ projectConfig });
    const response = await backendRequest(route.socketPath, "observer.health");
    if (response?.ok && response.result?.implementation === "node" && response.result?.version === version() && response.result?.process?.configPath === route.configPath && !response.result?.process?.closing) return statusFor(route, "ready", undefined, response.result);
    manager(); return statusFor(route, "starting", response ? "Backend will be refreshed by the plugin on the next request" : undefined, response?.result);
  } catch (error) { return { state: "failed", message: error instanceof Error ? error.message : String(error) }; }
}
export async function startBackend(projectConfig: string): Promise<ProjectBackendStatus> {
  try {
    const route = resolveProject({ projectConfig });
    await manager().ensure(route, version());
    const response = await backendRequest(route.socketPath, "observer.health").catch(() => null);
    return statusFor(route, "ready", undefined, response?.ok ? response.result : null);
  } catch (error) { return { state: "failed", message: error instanceof Error ? error.message : String(error) }; }
}
export async function closeBackends(): Promise<void> { disposed = true; await supervisor?.close(); supervisor = null; }
