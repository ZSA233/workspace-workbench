import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createDiagnosticSink, type DiagnosticSink } from "./diagnostics-runtime.mjs";

export type McpGatewayRole = "interactive" | "worker" | "reviewer" | "execution-report";
export type McpGatewayConfig = {
  type: "http";
  url: string;
  headers: Record<string, string>;
  alwaysLoad: true;
};
type GatewayState = { port?: number; key?: string; pid?: number; parentPid?: number; generation?: string };
type ChildEntry = { child: ChildProcess; port: number; key: string; generation: string; startedAt: string; stderr: string };
const MAX_LEASES = 256;
const LEASE_TTL_MS = 30 * 60_000;

function paseoHome(): string { return process.env.PASEO_HOME || join(homedir(), ".paseo"); }
function stateDir(): string { return join(paseoHome(), "workspace-workbench"); }
function statePath(): string { return join(stateDir(), "gateway.json"); }
function diagnosticsRoot(): string { return join(stateDir(), "diagnostics"); }

export function defaultMcpGatewayEntry(): string {
  const candidates = [
    process.env.WORKSPACE_WORKBENCH_PLUGIN_ROOT?.trim() || "",
    (() => {
      try {
        const config = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8")) as { plugins?: Record<string, { path?: unknown }> };
        const value = config.plugins?.["workspace-workbench-paseo"]?.path;
        return typeof value === "string" ? value : "";
      } catch { return ""; }
    })(),
    process.cwd(),
  ].filter(Boolean).map(value => resolve(value));
  const root = candidates.find(candidate => existsSync(join(candidate, "mcp-gateway.mjs"))) || candidates[0] || process.cwd();
  return join(root, "mcp-gateway.mjs");
}

function endpointFromPaseoPid(): string {
  try {
    const record = JSON.parse(readFileSync(join(paseoHome(), "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
    const target = String(record.listen || record.sockPath || "").replace(/^unix:\/\//, "");
    if (target.startsWith("/")) return `ws+unix://${target}:/ws`;
    if (/^(127\.0\.0\.1|localhost):\d+$/.test(target)) return `ws://${target}/ws`;
  } catch {}
  return "";
}

function readState(): GatewayState {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as GatewayState; } catch { return {}; }
}

function persistState(value: GatewayState): void {
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const target = statePath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, target);
  } catch {}
}

export class McpGatewayManager {
  private readonly entryPath: string;
  private entry: ChildEntry | null = null;
  private flight: Promise<McpGatewayConfig> | null = null;
  private closed = false;
  private readonly diagnostics: DiagnosticSink;
  private readonly pluginGeneration: string;
  private activeLeases = new Map<string, { role: McpGatewayRole; projectConfig: string; lastSeen: number }>();
  private restarts = 0;
  private cleanupFailures = 0;
  private lastSuccessAt: string | null = null;

  constructor(entryPath: string, generation = `plugin:${process.pid}:${randomUUID()}`) {
    this.entryPath = entryPath;
    this.pluginGeneration = generation;
    this.diagnostics = createDiagnosticSink({ root: diagnosticsRoot(), component: "plugin", generation });
  }

  async ensure(): Promise<McpGatewayConfig> {
    if (this.closed) throw new Error("plugin_unloaded");
    if (this.flight) return this.flight;
    if (this.entry && this.entry.port > 0 && this.entry.child.exitCode === null && !this.entry.child.killed) {
      this.diagnostics.record({ event: "gateway_reused", phase: "connect", transport: "http", gatewayPid: this.entry.child.pid, port: this.entry.port, generation: this.entry.generation });
      return this.configFor(this.entry.port, this.entry.key);
    }
    this.flight = this.start().finally(() => { this.flight = null; });
    return this.flight;
  }

  async configForRequest(projectConfig: string, token: string, role: McpGatewayRole, workspaceId?: string): Promise<McpGatewayConfig> {
    const config = await this.ensure();
    if (token) {
      this.activeLeases.delete(token);
      while (this.activeLeases.size >= MAX_LEASES) {
        const oldest = this.activeLeases.keys().next().value;
        if (!oldest) break;
        this.activeLeases.delete(oldest);
      }
      this.activeLeases.set(token, { role, projectConfig, lastSeen: Date.now() });
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Workbench-Gateway-Key": config.headers["X-Workbench-Gateway-Key"],
      "X-Workbench-Project": projectConfig,
      "X-Workbench-Role": role,
    };
    if (workspaceId) headers["X-Workbench-Workspace"] = workspaceId;
    return { ...config, headers };
  }

  revokeToken(token: string): void { if (token) this.activeLeases.delete(token); }

  private configFor(port: number, key = readState().key || ""): McpGatewayConfig {
    return { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { "X-Workbench-Gateway-Key": key }, alwaysLoad: true };
  }

  private async start(portOverride?: number): Promise<McpGatewayConfig> {
    const state = readState();
    const port = portOverride ?? (Number.isInteger(state.port) ? Number(state.port) : 0);
    const key = state.key || randomUUID();
    const generation = `gateway:${process.pid}:${randomUUID()}`;
    const env = {
      ...process.env,
      WORKBENCH_GATEWAY_PARENT_PID: String(process.pid),
      WORKBENCH_GATEWAY_PORT: String(port),
      WORKBENCH_GATEWAY_KEY: key,
      WORKBENCH_GATEWAY_GENERATION: generation,
      WORKBENCH_PLUGIN_GENERATION: this.pluginGeneration,
      WORKBENCH_PASEO_ENDPOINT: endpointFromPaseoPid(),
      WORKBENCH_DIAGNOSTICS_ROOT: diagnosticsRoot(),
    };
    this.diagnostics.record({ event: this.restarts ? "gateway_restart_started" : "gateway_starting", phase: "connect", transport: "http", generation });
    const child = spawn(process.execPath, [this.entryPath], { cwd: dirname(this.entryPath), env, stdio: ["ignore", "pipe", "pipe"] });
    const entry: ChildEntry = { child, port, key, generation, startedAt: new Date().toISOString(), stderr: "" };
    this.entry = entry;
    child.stderr?.on("data", chunk => { entry.stderr = (entry.stderr + String(chunk)).slice(-8_000); });
    let readyPort: number | null = null;
    let buffer = "";
    const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("gateway_start_timeout")), 8_000);
      child.stdout?.on("data", chunk => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const value = JSON.parse(line) as { event?: string; port?: number };
            if (value.event === "ready" && Number.isInteger(value.port)) { readyPort = value.port!; clearTimeout(timer); resolveReady(); }
          } catch {}
        }
      });
      child.once("error", error => { clearTimeout(timer); rejectReady(error); });
      child.once("exit", (code, signal) => { if (readyPort === null) { clearTimeout(timer); rejectReady(new Error(`gateway_exit:${code ?? signal ?? "unknown"}`)); } });
    });
    try {
      await readyPromise;
      if (readyPort === null) throw new Error("gateway_ready_missing");
      if (this.closed) throw new Error("plugin_unloaded");
      entry.port = readyPort;
      persistState({ port: readyPort, key, pid: child.pid || undefined, parentPid: process.pid, generation });
      this.lastSuccessAt = new Date().toISOString();
      this.diagnostics.record({ event: "gateway_ready", phase: "connect", transport: "http", gatewayPid: child.pid, port: readyPort, generation });
      child.once("exit", () => {
        if (this.entry === entry) this.entry = null;
        this.restarts++;
        this.diagnostics.record({ event: "gateway_exit", phase: "cleanup", transport: "http", gatewayPid: child.pid, reason: `exit:${child.exitCode ?? "signal"}` });
      });
      return this.configFor(readyPort, key);
    } catch (error) {
      this.entry = null;
      this.diagnostics.record({ event: "gateway_start_failed", phase: "connect", transport: "http", errorCode: "gateway_start_failed", reason: error instanceof Error ? error.message : String(error) });
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      // A stale port can be occupied by an unrelated local process after a
      // crash. Do not touch it; fall back once to an OS-assigned loopback
      // port and publish the new owner state.
      if (port > 0 && /EADDRINUSE|address already in use/i.test(entry.stderr)) return this.start(0);
      throw error;
    }
  }

  status() {
    for (const [token, lease] of this.activeLeases) if (Date.now() - lease.lastSeen > LEASE_TTL_MS) this.activeLeases.delete(token);
    const entry = this.entry;
    return {
      state: this.closed ? "closed" : entry && entry.child.exitCode === null ? "ready" : this.flight ? "starting" : "idle",
      transport: "http",
      scope: "plugin-generation",
      legacyStdio: "external-session-owned",
      pid: entry?.child.pid || null,
      parentPid: process.pid,
      port: entry?.port || readState().port || null,
      generation: entry?.generation || readState().generation || null,
      startedAt: entry?.startedAt || null,
      activeLeases: this.activeLeases.size,
      restartCount: this.restarts,
      cleanupFailures: this.cleanupFailures,
      lastSuccessAt: this.lastSuccessAt,
      diagnostics: this.diagnostics.status(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const starting = this.flight;
    this.diagnostics.record({ event: "gateway_shutdown_started", phase: "cleanup", transport: "http", gatewayPid: this.entry?.child.pid });
    const entry = this.entry;
    if (entry && entry.child.exitCode === null && !entry.child.killed) {
      entry.child.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2_500);
        entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (entry.child.exitCode === null && !entry.child.killed) { this.cleanupFailures++; entry.child.kill("SIGKILL"); }
    }
    // A reload can race the first Agent creation. Wait for that single-flight
    // to settle after the owned child has been asked to exit, so no late
    // startup continuation can publish a live endpoint after shutdown.
    if (starting) await starting.catch(() => {});
    this.entry = null;
    this.activeLeases.clear();
    const state = readState();
    if (entry && state.pid === entry.child.pid) persistState({ port: state.port, key: state.key });
    this.diagnostics.record({ event: "gateway_shutdown_finished", phase: "cleanup", transport: "http" });
    await this.diagnostics.close();
  }
}

let activeGateway: McpGatewayManager | null = null;
export function setMcpGateway(manager: McpGatewayManager | null): void { activeGateway = manager; }
export function getMcpGateway(): McpGatewayManager {
  if (!activeGateway) throw new Error("mcp_gateway_uninitialized");
  return activeGateway;
}
export async function mcpGatewayConfig(projectConfig: string, token: string, role: McpGatewayRole, workspaceId?: string): Promise<McpGatewayConfig> {
  // Pure unit tests exercise Agent configuration without booting a Paseo
  // plugin process. Production always installs the manager in index.server.
  if (!activeGateway) return {
    type: "http",
    url: "http://127.0.0.1:0/mcp",
    headers: { Authorization: `Bearer ${token}`, "X-Workbench-Gateway-Key": "test", "X-Workbench-Project": projectConfig, "X-Workbench-Role": role, ...(workspaceId ? { "X-Workbench-Workspace": workspaceId } : {}) },
    alwaysLoad: true,
  };
  return activeGateway.configForRequest(projectConfig, token, role, workspaceId);
}
export function mcpGatewayStatus(): ReturnType<McpGatewayManager["status"]> { return activeGateway?.status() || { state: "uninitialized", transport: "http", scope: "plugin-generation", legacyStdio: "external-session-owned", pid: null, parentPid: process.pid, port: null, generation: null, startedAt: null, activeLeases: 0, restartCount: 0, cleanupFailures: 0, lastSuccessAt: null, diagnostics: { file: "", dropped: 0 } }; }
