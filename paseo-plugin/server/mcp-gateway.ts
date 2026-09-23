import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
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

function readState(): GatewayState {
  try { return JSON.parse(readFileSync(statePath(), "utf8")) as GatewayState; } catch { return {}; }
}

function persistState(value: GatewayState): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const target = statePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, target);
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const childRunning = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
async function fetchBounded(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { headers, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
async function acquireStateLock(): Promise<() => void> {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const path = join(stateDir(), "gateway.lock");
  const nonce = randomUUID();
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          const owner = JSON.parse(readFileSync(path, "utf8")) as { nonce?: string };
          if (owner.nonce === nonce) unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
        if (owner.pid && owner.pid !== process.pid) {
          try { process.kill(owner.pid, 0); } catch { unlinkSync(path); continue; }
        }
      } catch {}
      await pause(100);
    }
  }
  throw new Error("gateway_state_lock_busy");
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
  private readiness: { stage: string; code?: string } = { stage: "starting" };
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private readonly readinessProbe: (port: number, key: string) => Promise<{ ok: boolean; stage: string; code?: string }>;

  constructor(entryPath: string, generation = `plugin:${process.pid}:${randomUUID()}`,
    readinessProbe?: (port: number, key: string) => Promise<{ ok: boolean; stage: string; code?: string }>) {
    this.entryPath = entryPath;
    this.pluginGeneration = generation;
    this.diagnostics = createDiagnosticSink({ root: diagnosticsRoot(), component: "plugin", generation });
    this.readinessProbe = readinessProbe || (async (port, key) => {
      try {
        const response = await fetchBounded(`http://127.0.0.1:${port}/ready`, { "X-Workbench-Gateway-Key": key }, 3_500);
        return await response.json() as { ok: boolean; stage: string; code?: string };
      } catch { return { ok: false, stage: "gateway", code: "gateway_unavailable" }; }
    });
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(10_000, 250 * 2 ** Math.min(this.consecutiveFailures++, 6));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.closed) void this.ensure().catch(() => {});
    }, delay);
    this.restartTimer.unref();
  }

  private async waitReady(port: number, key: string): Promise<void> {
    const until = Date.now() + 8_000;
    while (!this.closed && Date.now() < until) {
      const result = await this.readinessProbe(port, key);
      this.readiness = { stage: result.stage, ...(result.code ? { code: result.code } : {}) };
      if (result.ok) return;
      await pause(150);
    }
    throw new Error(this.closed ? "plugin_unloaded" : `gateway_not_ready:${this.readiness.code || this.readiness.stage}`);
  }

  async ensure(): Promise<McpGatewayConfig> {
    if (this.closed) throw new Error("plugin_unloaded");
    if (this.flight) return this.flight;
    if (this.entry && this.entry.port > 0 && childRunning(this.entry.child)) {
      this.diagnostics.record({ event: "gateway_reused", phase: "connect", transport: "http", gatewayPid: this.entry.child.pid, port: this.entry.port, generation: this.entry.generation });
      return this.configFor(this.entry.port, this.entry.key);
    }
    this.flight = this.start().catch(error => { this.scheduleRestart(); throw error; }).finally(() => { this.flight = null; });
    return this.flight;
  }

  async configForRequest(projectConfig: string, token: string, role: McpGatewayRole, workspaceId?: string): Promise<McpGatewayConfig> {
    const config = await this.ensure();
    await this.waitReady(Number(new URL(config.url).port), config.headers["X-Workbench-Gateway-Key"]);
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

  private async waitForOwnedPort(port: number, state: GatewayState): Promise<void> {
    const until = Date.now() + 8_000;
    let verified = false;
    while (Date.now() < until) {
      let owner: { component?: string; pid?: number; generation?: string } | null = null;
      try {
        const response = await fetchBounded(`http://127.0.0.1:${port}/health`, {}, 500);
        owner = await response.json() as { component?: string; pid?: number; generation?: string };
      } catch { if (verified) return; await pause(100); continue; }
      if (owner?.component !== "workbench-mcp-gateway" || owner.pid !== state.pid || owner.generation !== state.generation)
        throw new Error("gateway_port_occupied_unverified");
      verified = true;
      await pause(150);
    }
    throw new Error(verified ? "gateway_previous_generation_still_listening" : "gateway_port_occupied_unverified");
  }

  private async start(): Promise<McpGatewayConfig> {
    const release = await acquireStateLock();
    let released = false;
    try {
    this.readiness = { stage: "starting" };
    const state = readState();
    const port = Number.isInteger(state.port) ? Number(state.port) : 0;
    const key = state.key || randomUUID();
    const generation = `gateway:${process.pid}:${randomUUID()}`;
    const env = {
      ...process.env,
      WORKBENCH_GATEWAY_PARENT_PID: String(process.pid),
      WORKBENCH_GATEWAY_PORT: String(port),
      WORKBENCH_GATEWAY_KEY: key,
      WORKBENCH_GATEWAY_GENERATION: generation,
      WORKBENCH_PLUGIN_GENERATION: this.pluginGeneration,
      WORKBENCH_DIAGNOSTICS_ROOT: diagnosticsRoot(),
    };
    this.diagnostics.record({ event: this.restarts ? "gateway_restart_started" : "gateway_starting", phase: "connect", transport: "http", generation });
    const child = spawn(process.execPath, [this.entryPath], { cwd: dirname(this.entryPath), env, stdio: ["ignore", "pipe", "pipe"] });
    const entry: ChildEntry = { child, port, key, generation, startedAt: new Date().toISOString(), stderr: "" };
    this.entry = entry;
    child.once("exit", () => {
      if (this.entry === entry) this.entry = null;
      this.readiness = { stage: "gateway", code: "gateway_exited" };
      this.restarts++;
      this.diagnostics.record({ event: "gateway_exit", phase: "cleanup", transport: "http", gatewayPid: child.pid, reason: `exit:${child.exitCode ?? "signal"}` });
      if (!this.closed) this.scheduleRestart();
    });
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
      await this.waitReady(readyPort, key);
      if (this.closed || !childRunning(child)) throw new Error("gateway_exited_during_readiness");
      persistState({ port: readyPort, key, pid: child.pid || undefined, parentPid: process.pid, generation });
      this.consecutiveFailures = 0;
      this.lastSuccessAt = new Date().toISOString();
      this.diagnostics.record({ event: "gateway_ready", phase: "connect", transport: "http", gatewayPid: child.pid, port: readyPort, generation });
      return this.configFor(readyPort, key);
    } catch (error) {
      this.entry = null;
      this.diagnostics.record({ event: "gateway_start_failed", phase: "connect", transport: "http", errorCode: "gateway_start_failed", reason: error instanceof Error ? error.message : String(error) });
      if (childRunning(child)) child.kill("SIGTERM");
      if (port > 0 && /EADDRINUSE|address already in use/i.test(entry.stderr)) {
        await this.waitForOwnedPort(port, state);
        release(); released = true;
        return this.start();
      }
      throw error;
    }
    } finally { if (!released) release(); }
  }

  status() {
    for (const [token, lease] of this.activeLeases) if (Date.now() - lease.lastSeen > LEASE_TTL_MS) this.activeLeases.delete(token);
    const entry = this.entry;
    return {
      state: this.closed ? "closed" : entry && childRunning(entry.child) && this.readiness.stage === "ready" ? "ready" : this.flight ? "starting" : "idle",
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
      readiness: this.readiness,
      diagnostics: this.diagnostics.status(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const starting = this.flight;
    this.diagnostics.record({ event: "gateway_shutdown_started", phase: "cleanup", transport: "http", gatewayPid: this.entry?.child.pid });
    const entry = this.entry;
    if (entry && childRunning(entry.child)) {
      entry.child.kill("SIGTERM");
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2_500);
        entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (childRunning(entry.child)) {
        this.cleanupFailures++;
        entry.child.kill("SIGKILL");
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1_000);
          entry.child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    }
    // A reload can race the first Agent creation. Wait for that single-flight
    // to settle after the owned child has been asked to exit, so no late
    // startup continuation can publish a live endpoint after shutdown.
    if (starting) await starting.catch(() => {});
    this.entry = null;
    this.activeLeases.clear();
    const state = readState();
    if (entry && state.pid === entry.child.pid && !childRunning(entry.child)) {
      try { persistState({ port: state.port, key: state.key }); }
      catch (error) {
        this.cleanupFailures++;
        this.diagnostics.record({ event: "gateway_state_cleanup_failed", phase: "cleanup", errorCode: "gateway_state_write_failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
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
export function mcpGatewayStatus(): ReturnType<McpGatewayManager["status"]> { return activeGateway?.status() || { state: "uninitialized", transport: "http", scope: "plugin-generation", legacyStdio: "external-session-owned", pid: null, parentPid: process.pid, port: null, generation: null, startedAt: null, activeLeases: 0, restartCount: 0, cleanupFailures: 0, lastSuccessAt: null, readiness: { stage: "uninitialized" }, diagnostics: { file: "", dropped: 0 } }; }
