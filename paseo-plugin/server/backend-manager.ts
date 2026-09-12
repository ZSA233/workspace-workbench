import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { X_OK } from "node:constants";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolveProject, type ProjectRoute } from "./projects.ts";
import type { ProjectBackendStatus } from "../shared/setup.ts";

const execFileAsync = promisify(execFile);
const managed = new Map<string, { child: ChildProcess; error: string }>();
const starting = new Map<string, Promise<ProjectBackendStatus>>();
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
    const preferred = sources.find(([id]) => id === PLUGIN_ID)
      || sources.find(([, source]) => typeof source.path === "string" && existsSync(join(source.path, "paseo-plugin.json")));
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

function pathExecutable(name: string): string | null {
  if (name.includes("/")) {
    try {
      accessSync(name, X_OK);
      return name;
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, X_OK);
      return candidate;
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  return null;
}

function platformKey(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  return `${platform}-${process.arch}`;
}

function bundledBackend(): string | null {
  const root = pluginRoot();
  if (!root) return null;
  const candidate = join(root, "backend", platformKey(), "workspace-workbench");
  return pathExecutable(candidate);
}

function sourceRootFromPlugin(): string | null {
  let cursor = pluginRoot();
  if (!cursor) return null;
  for (let index = 0; index < 5; index += 1) {
    const source = join(cursor, "src", "workspace_workbench", "__main__.py");
    if (existsSync(source)) return join(cursor, "src");
    cursor = dirname(cursor);
  }
  return null;
}

function pluginVersion(): string {
  try {
    const root = pluginRoot();
    if (!root) return "0.1.0";
    const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof value.version === "string" && value.version ? value.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

async function downloadBackend(route: ProjectRoute): Promise<string | null> {
  if (process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD === "1") return null;
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const asset = `workspace-workbench-backend-${platformKey()}-${pluginVersion()}`;
  const cachePath = join(route.stateRoot, "backend", asset);
  if (pathExecutable(cachePath)) return cachePath;
  const base = (process.env.WORKSPACE_WORKBENCH_RELEASE_BASE_URL || `https://github.com/ZSA233/workspace-workbench/releases/download/v${pluginVersion()}`).replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const sums = await fetch(`${base}/SHA256SUMS`, { signal: controller.signal });
    if (!sums.ok) return null;
    const sumText = await sums.text();
    const expected = sumText.split(/\r?\n/).map((line) => line.trim().split(/\s+/, 2)).find((parts) => parts[1] === asset)?.[0];
    if (!expected) return null;
    const response = await fetch(`${base}/${asset}`, { signal: controller.signal });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) return null;
    mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { mode: 0o700 });
    chmodSync(temporary, 0o700);
    renameSync(temporary, cachePath);
    return cachePath;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function pythonEnvironment(sourceRoot: string | null): NodeJS.ProcessEnv {
  if (!sourceRoot) return { ...process.env };
  const current = process.env.PYTHONPATH ? process.env.PYTHONPATH.split(delimiter) : [];
  return { ...process.env, PYTHONPATH: [sourceRoot, ...current.filter((item) => item && item !== sourceRoot)].join(delimiter) };
}

async function pythonModuleAvailable(python: string, sourceRoot: string | null): Promise<boolean> {
  try {
    await execFileAsync(python, ["-c", "import workspace_workbench"], { env: pythonEnvironment(sourceRoot), timeout: 2_000, maxBuffer: 4 * 1024 });
    return true;
  } catch {
    return false;
  }
}

type BackendCommand = { command: string; args: string[]; env?: NodeJS.ProcessEnv };

async function resolveBackendCommand(route: ProjectRoute, allowDownload = true): Promise<BackendCommand | null> {
  const configArgs = ["serve", "--config", route.configPath];
  const explicit = process.env.WORKSPACE_WORKBENCH_BACKEND?.trim();
  const bundled = explicit ? pathExecutable(explicit) : bundledBackend();
  if (bundled) return { command: bundled, args: configArgs };

  const executable = pathExecutable("workspace-workbench");
  if (executable) return { command: executable, args: configArgs };

  const sourceRoot = process.env.WORKSPACE_WORKBENCH_PYTHONPATH?.trim() || sourceRootFromPlugin();
  const candidates = process.env.WORKSPACE_WORKBENCH_PYTHON?.trim()
    ? [process.env.WORKSPACE_WORKBENCH_PYTHON.trim()]
    : ["python3", "python"].map(pathExecutable).filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (await pythonModuleAvailable(candidate, sourceRoot)) {
      return { command: candidate, args: ["-m", "workspace_workbench", ...configArgs], env: pythonEnvironment(sourceRoot) };
    }
  }
  if (allowDownload) {
    const downloaded = await downloadBackend(route);
    if (downloaded) return { command: downloaded, args: configArgs };
  }
  return null;
}

function statusFor(route: ProjectRoute, state: ProjectBackendStatus["state"], message?: string): ProjectBackendStatus {
  return { state, ...(message ? { message } : {}), socketPath: route.socketPath };
}

async function socketReachable(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function removeStaleSocket(socketPath: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // A missing or already-replaced socket needs no further action.
  }
}

function childError(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-8_000);
    };
    child.stderr?.on("data", append);
    child.once("error", (error) => resolve(error.message));
    child.once("exit", (code, signal) => resolve(output.trim() || `backend exited (${signal || code || "unknown"})`));
  });
}

async function waitForSocket(route: ProjectRoute, child: ChildProcess): Promise<ProjectBackendStatus> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await socketReachable(route.socketPath)) return statusFor(route, "ready");
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const entry = managed.get(route.configPath);
  const message = entry?.error || `Workbench backend did not open its socket: ${route.socketPath}`;
  return statusFor(route, "failed", message);
}

function stopManaged(route: ProjectRoute): void {
  const entry = managed.get(route.configPath);
  if (entry && entry.child.exitCode === null && !entry.child.signalCode) entry.child.kill("SIGTERM");
  managed.delete(route.configPath);
  if (existsSync(route.socketPath)) removeStaleSocket(route.socketPath);
}

export async function backendStatus(projectConfig: string): Promise<ProjectBackendStatus> {
  try {
    const route = resolveProject({ projectConfig });
    if (await socketReachable(route.socketPath)) return statusFor(route, "ready");
    const entry = managed.get(route.configPath);
    if (entry && entry.child.exitCode === null && !entry.child.signalCode) return statusFor(route, "starting");
    if (existsSync(route.socketPath)) removeStaleSocket(route.socketPath);
    const command = await resolveBackendCommand(route, false);
    if (!command) {
      return statusFor(
        route,
        process.platform === "darwin" || process.platform === "linux" ? "missing" : "unsupported",
        "尚未找到 Workbench 后端。请更新插件，或安装 Workspace Workbench 服务。",
      );
    }
    return statusFor(route, "starting");
  } catch (error) {
    return { state: "failed", message: error instanceof Error ? error.message : "project configuration is unavailable" };
  }
}

async function startBackendOnce(route: ProjectRoute): Promise<ProjectBackendStatus> {
  if (await socketReachable(route.socketPath)) return statusFor(route, "ready");
  const existing = managed.get(route.configPath);
  if (existing && existing.child.exitCode === null && !existing.child.signalCode) return waitForSocket(route, existing.child);
  if (existing) managed.delete(route.configPath);
  if (existsSync(route.socketPath)) removeStaleSocket(route.socketPath);
  const command = await resolveBackendCommand(route);
  if (!command) {
    return statusFor(
      route,
      process.platform === "darwin" || process.platform === "linux" ? "missing" : "unsupported",
      "尚未找到 Workbench 后端。请更新插件，或安装 Workspace Workbench 服务。",
    );
  }
  const child = spawn(command.command, command.args, {
    cwd: route.sourceRoot,
    env: command.env || process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const entry = { child, error: "" };
  managed.set(route.configPath, entry);
  void childError(child).then((message) => {
    entry.error = message;
    if (managed.get(route.configPath)?.child === child && child.exitCode !== null) managed.delete(route.configPath);
  });
  child.once("error", (error) => { entry.error = error.message; });
  return waitForSocket(route, child);
}

export async function startBackend(projectConfig: string): Promise<ProjectBackendStatus> {
  let route: ProjectRoute;
  try {
    route = resolveProject({ projectConfig });
  } catch (error) {
    return { state: "failed", message: error instanceof Error ? error.message : "project configuration is unavailable" };
  }
  const pending = starting.get(route.configPath);
  if (pending) return pending;
  const flight = (async () => {
    const first = await startBackendOnce(route);
    if (first.state !== "failed") return first;
    // A stale socket or a worker that exited during startup gets one clean,
    // bounded retry. Persistent failures remain visible to the caller.
    stopManaged(route);
    return startBackendOnce(route);
  })().finally(() => { starting.delete(route.configPath); });
  starting.set(route.configPath, flight);
  return flight;
}

export function closeBackends(): void {
  for (const { child } of managed.values()) child.kill("SIGTERM");
  managed.clear();
  starting.clear();
}
