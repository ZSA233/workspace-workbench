import { readerGeneration } from "./reader-identity.ts";
import { EventLoopMetrics } from "./event-loop-metrics.ts";
import { DIFF_READ_BUILD } from "../shared/diff-read.ts";
import { boundedDeadline } from "../shared/request-deadline.mjs";
import { sessionRevision } from "./session-observation.ts";
import { reviewRevision } from "./agent-review-store.ts";
import { withWorkspaceScope } from "./workspace-scope.ts";
import type { AgentContext } from "./agent-provider.ts";
import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { currentProject, withProject } from "./projects.ts";
import { recordBackendFailure, recordBackendSuccess, startBackend } from "./backend-manager.ts";
import { loadConfig } from "./backend/config.ts";
import {
  DEFAULT_OBSERVATION_TIMING,
  OBSERVATION_TIMING_DEFAULTS,
  readBudgetMs,
} from "../shared/observation-timing.ts";

import {
  observerMethods,
  observerQuery,
  type ObserverResponse,
} from "../shared/observer.ts";
import type { Json } from "./backend/storage.ts";

type QueryInput = {
  projectConfig?: string;
  directory?: string;
  method: (typeof observerMethods)[number];
  params: Record<string, unknown>;
};

type SocketRequest = {
  id: string;
  deadline?: number;
  method: QueryInput["method"];
  params: Record<string, unknown>;
};

const allowedMethods = new Set<string>(observerMethods);
const versionedMethods = new Set<string>(["workspace.environment", "workspace.prepare.task", "observer.versions", "workspace.activity", "workspace.detail", "workspace.operation.status", "repository.compare", "repository.graph", "repository.changes", "repository.diff", "repository.diff.read", "observer.refresh", "repository.summary"]);
const mutationMethods = new Set<string>([
  "observer.reload", "workspace.create", "workspace.orphan.adopt", "workspace.addRepositories",
  "workspace.prepare", "workspace.cleanup", "workspace.remove", "workspace.restore", "workspace.delete",
  "main.repositories.save", "linked.workspaces.save",
]);
const BRIDGE_CACHE_ENTRIES = 128;
const BRIDGE_CACHE_BYTES = 8 * 1024 * 1024;
const BRIDGE_IN_FLIGHT = 16;
const READ_METHODS = new Set<string>([
  "observer.versions", "workspace.list", "workspace.activity", "workspace.detail", "workspace.identify",
  "workspace.operation.status",
  "workspace.orphan.preview", "repository.compare", "repository.graph", "repository.changes", "repository.diff", "repository.diff.read", "observer.refresh", "repository.summary",
  "review-set.compare", "review-set.brief",
]);
// Paseo currently gives plugin RPC calls a shorter host budget than the
// backend's historical observation timeout.  Read calls must finish (or close
// their socket and cancel backend work) before that host budget expires.
// Keep this value free of Node-only imports: the Paseo plugin server bundle is
// also analyzed as a shared module by the native host. The package build ID
// is reported by the backend; this generation identifies the observer bridge
// process itself.
const SERVER_BUILD_ID = "observer-bridge-v2";
// Environment preparation uses a durable, declaration-scoped request identity.
const replayableMethods = new Set<string>(["workspace.environment", "observer.health", "observer.versions", "workspace.list", "workspace.activity", "workspace.detail", "workspace.identify", "workspace.operation.status", "workspace.orphan.preview", "repository.compare", "repository.graph", "repository.changes", "repository.diff", "repository.diff.read", "observer.refresh", "repository.summary", "review-set.compare", "review-set.brief"]);

function configuredBridgeTimeoutMs(method?: string): number {
  if (method === "workspace.environment") return 2_000;
  if (method === "workspace.prepare.task" || method === "workspace.prepare" || method === "repository.diff.read" || method === "observer.refresh") return 2_000;
  const project = currentProject();
  let timing = DEFAULT_OBSERVATION_TIMING;
  try { if (project) timing = loadConfig(project.configPath).timing; } catch {
    // The backend reports config_invalid through its normal startup path.
    // Keep the bridge bounded while that error is surfaced to the panel.
  }
  const configured = timing.bridgeTimeoutMs;
  return method && READ_METHODS.has(method)
    ? Math.min(configured, readBudgetMs(method, timing) + OBSERVATION_TIMING_DEFAULTS.bridgeGraceMs)
    : configured;
}

function requestParams(input: QueryInput): Record<string, unknown> {
  if (!READ_METHODS.has(input.method) || !["workspace.detail", "repository.summary", "repository.compare", "repository.graph", "repository.changes", "repository.diff"].includes(input.method))
    return input.params || {};
  const project = currentProject();
  const timing = project ? (() => { try { return loadConfig(project.configPath).timing; } catch { return DEFAULT_OBSERVATION_TIMING; } })() : DEFAULT_OBSERVATION_TIMING;
  const configured = Number(input.params?.observationBudgetMs);
  const budget = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, readBudgetMs(input.method, timing))
    : readBudgetMs(input.method, timing);
  return { ...(input.params || {}), observationBudgetMs: budget };
}

class BridgeError extends Error {
  requestId?: string;
  elapsedMs?: number;
  readonly code: string;
  readonly stage: string;

  constructor(code: string, message: string, stage = "bridge") {
    super(message);
    this.name = "BridgeError";
    this.stage = stage;
    this.code = code;
  }
}

function configuredSocketPath(): string {
  const project = currentProject();
  if (project) return project.socketPath;
  const override = process.env.WORKSPACE_WORKBENCH_SOCKET?.trim();
  if (override) return resolve(override);
  const configPath = process.env.WORKSPACE_WORKBENCH_CONFIG?.trim();
  if (configPath && existsSync(configPath)) {
    try {
      const value = JSON.parse(readFileSync(configPath, "utf8")) as { socketPath?: unknown };
      if (typeof value.socketPath === "string" && value.socketPath.trim()) return resolve(value.socketPath);
    } catch {
      // The request below reports the unavailable service instead of exposing
      // config parsing details in the panel.
    }
  }
  return join(homedir(), ".config", "workspace-workbench", "observer.sock");
}

function cacheable(response: ObserverResponse): boolean {
  if (!response.ok) return false;
  const result = response.result;
  if (!result || typeof result !== "object") return true;
  const observation = (result as { observation?: { state?: unknown } }).observation;
  return !observation?.state || observation.state === "ready";
}

function withObservationMetadata(response: ObserverResponse): ObserverResponse {
  if (!response.ok || !response.result || typeof response.result !== "object") return response;
  const result = response.result as Record<string, unknown>;
  const processInfo = result.process && typeof result.process === "object" ? result.process as Record<string, unknown> : null;
  const backendInstanceId = typeof processInfo?.instanceId === "string"
    ? processInfo.instanceId
    : typeof result.instanceId === "string" ? result.instanceId : undefined;
  return {
    ...response,
    result: {
      ...result,
      pluginBuildId: SERVER_BUILD_ID,
      pluginGeneration: readerGeneration,
      ...(backendInstanceId ? { backendInstanceId } : {}),
      observedAt: new Date().toISOString(),
      ...(Array.isArray(result.issues) ? { issues: result.issues } : {}),
    },
  };
}

export class ObserverBridge {
  private sequence = 0;
  private readonly cancellations = new Set<() => void>();
  private readonly inFlight = new Map<string, Promise<ObserverResponse>>();
  private readonly cache = new Map<string, { expiresAt: number; response: ObserverResponse; bytes: number }>();
  private readonly methodStats = new Map<string, { requests: number; completed: number; failures: number; maxMs: number }>();
  private totalRequests = 0;
  private completedRequests = 0;
  private failedRequests = 0;
  private timeoutRequests = 0;
  private failures: Array<{ requestId: string; method: string; code: string; stage: string; at: string; durationMs: number; readRequestId?: string; action?: string }> = [];

  private recordFailure(request: SocketRequest, code: string, startedAt: number, stage: string) {
    this.failures.push({ requestId: request.id, ...(typeof request.params.requestId === "string" ? { readRequestId: request.params.requestId } : {}), method: request.method, ...(typeof request.params.action === 'string' ? {action:request.params.action} : {}), code, stage,
      at: new Date().toISOString(), durationMs: Date.now() - startedAt });
    if (this.failures.length > 32) this.failures.shift();
  }

  private trimCache() {
    for (const [key, value] of this.cache) if (value.expiresAt <= Date.now()) this.cache.delete(key);
    let bytes = [...this.cache.values()].reduce((sum, value) => sum + value.bytes, 0);
    while (this.cache.size > BRIDGE_CACHE_ENTRIES || bytes > BRIDGE_CACHE_BYTES) {
      const key = this.cache.keys().next().value!;
      bytes -= this.cache.get(key)!.bytes;
      this.cache.delete(key);
    }
  }

  health(): Json {
    return {
      activeRequests: this.inFlight.size,
      cacheEntries: this.cache.size,
      totalRequests: this.totalRequests,
      completedRequests: this.completedRequests,
      failedRequests: this.failedRequests,
      timeoutRequests: this.timeoutRequests,
      generation: readerGeneration,
      recentFailures: [...this.failures],
      methods: [...this.methodStats.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 32).map(([method, stats]) => ({ method, ...stats })),
    };
  }

  private request(request: SocketRequest, timeoutMs: number): Promise<ObserverResponse> {
    return new Promise((resolveResponse, reject) => {
      let settled = false;
      let connected = false;
      let buffer = "";
      let socket: Socket | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.cancellations.delete(cancel);
        callback();
        socket?.destroy();
      };
      const cancel = () => fail(new BridgeError("observer_unavailable", "observer bridge closed"));
      this.cancellations.add(cancel);
      const timer = setTimeout(() => {
        finish(() => reject(new BridgeError("observer_timeout", "observer request timed out", connected ? "backend-response" : "connect")));
      }, timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        finish(() => reject(error));
      };
      socket = createConnection(configuredSocketPath());
      socket.setEncoding("utf8");
      socket.on("connect", () => { connected = true; socket?.write(`${JSON.stringify(request)}\n`); });
      socket.on("data", (chunk: string | Buffer) => {
        buffer += String(chunk);
        if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) { fail(new BridgeError("observer_output_limit", "observer response exceeded limit")); return; }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as ObserverResponse;
          if (!response || typeof response !== "object" || typeof response.ok !== "boolean" || (response.id !== undefined && response.id !== request.id))
            throw new Error("invalid observer response envelope");
          finish(() => resolveResponse(response));
        } catch {
          fail(new BridgeError("observer_invalid_response", "observer returned invalid JSON"));
        }
      });
      socket.on("error", (error) => {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code || "")
          : "";
        const mapped = code === "ENOENT"
          ? "observer_unavailable"
          : code === "ECONNREFUSED"
            ? "observer_connection_refused"
            : "observer_socket_error";
        fail(new BridgeError(mapped, error instanceof Error ? error.message : "observer socket failed"));
      });
      socket.on("close", () => {
        if (!settled) fail(new BridgeError("observer_unavailable", "observer socket closed before a response"));
      });
    });
  }

  async call(input: QueryInput): Promise<ObserverResponse> {
    if (!allowedMethods.has(input.method)) {
      return { ok: false, error: { code: "method_not_allowed", message: "observer method is not allowed" } };
    }
    const params = requestParams(input);
    this.totalRequests++;
    const statsKey = input.method === 'observer.refresh' ? `${input.method}:${String(input.params.action || 'start')}` : input.method;
    const stats = this.methodStats.get(statsKey) || { requests: 0, completed: 0, failures: 0, maxMs: 0 };
    stats.requests++;
    this.methodStats.set(statsKey, stats);
    if (this.methodStats.size > 64) this.methodStats.delete(this.methodStats.keys().next().value!);
    const startedAt = Date.now();
    const key = `${configuredSocketPath()}:${input.method}:${JSON.stringify(params)}`;
    const projectPrefix = `${configuredSocketPath()}:`;
    this.trimCache();
    const cached = versionedMethods.has(input.method) || mutationMethods.has(input.method) ? undefined : this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    this.cache.delete(key);
    const active = this.inFlight.get(key);
    if (active) return active;
    const control = ["observer.health", "observer.versions"].includes(input.method) || ["observer.refresh", "repository.diff.read", "workspace.prepare.task"].includes(input.method) && ["status", "release"].includes(String(input.params.action));
    if (this.inFlight.size >= (control ? 64 : BRIDGE_IN_FLIGHT))
      return { ok: false, error: { code: "observer_busy", message: "observer request limit reached; retry" } };
    const request: SocketRequest = { id: `${process.pid}:${++this.sequence}`, method: input.method, params };
    const timeout = configuredBridgeTimeoutMs(input.method);
    if (READ_METHODS.has(input.method)) request.deadline = boundedDeadline(undefined, timeout - OBSERVATION_TIMING_DEFAULTS.cleanupReserveMs);
    const pending = this.request(request, timeout)
      .then((response) => {
        this.completedRequests++;
        stats.completed++;
        if (!response.ok) {
          stats.failures++; this.failedRequests++;
          this.recordFailure(request, response.error?.code || 'backend_failed', startedAt,
            response.error?.code === 'git_timeout' ? 'git' : 'backend');
        }
        stats.maxMs = Math.max(stats.maxMs, Date.now() - startedAt);
        if (response.ok && mutationMethods.has(input.method)) {
          for (const cachedKey of this.cache.keys()) if (cachedKey.startsWith(projectPrefix)) this.cache.delete(cachedKey);
        }
        if (!versionedMethods.has(input.method) && !mutationMethods.has(input.method) && (!input.method.startsWith("workspace.") || !["workspace.orphan.preview", "workspace.runtime"].includes(input.method))) {
          if (cacheable(response)) {
            const bytes = Buffer.byteLength(JSON.stringify(response));
            if (bytes <= BRIDGE_CACHE_BYTES) {
              this.cache.set(key, { response, bytes, expiresAt: Date.now() + OBSERVATION_TIMING_DEFAULTS.bridgeResponseCacheTtlMs });
              this.trimCache();
            }
          }
        }
        return withObservationMetadata(response);
      })
      .catch(error => {
        if (error instanceof BridgeError) { error.requestId = request.id; error.elapsedMs = Date.now() - startedAt; }
        this.failedRequests++;
        this.recordFailure(request, error instanceof BridgeError ? error.code : "observer_failed", startedAt, error instanceof BridgeError ? error.stage : "bridge");
        stats.failures++;
        stats.maxMs = Math.max(stats.maxMs, Date.now() - startedAt);
        if (error instanceof BridgeError && error.code === "observer_timeout") this.timeoutRequests++;
        if (!replayableMethods.has(input.method) && error instanceof BridgeError)
          return { ok: false, error: { code: "request_uncertain_retry_same_identity", message: "Response unavailable; reconcile the saved operation before retrying", details: { method: input.method, requestId: input.params.requestId, stage: error.stage, dispatched: error.stage !== "connect", ...(input.method === "workspace.prepare.task" ? { status: { method: "workspace.prepare.task", action: "status", requestId: input.params.requestId, operationId: input.params.operationId, workspaceId: input.params.workspaceId } } : {}) } } };
        throw error;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  close(): void {
    for (const cancel of this.cancellations) cancel();
    this.inFlight.clear();
    this.cache.clear();
  }
}

const bridge = new ObserverBridge();
const eventLoop = new EventLoopMetrics();

export async function handleObserver(input: QueryInput, context?: AgentContext): Promise<ObserverResponse> {
  try {
    const callWithRecovery = async (): Promise<ObserverResponse> => {
      if (input.method === "workspace.addRepositories") {
        return withWorkspaceScope(String(input.params.workspaceId || ""), async () => {
          if (context) {
            const { activeWorkspaceTasks } = await import("./workspace-lifecycle.ts");
            const active = await activeWorkspaceTasks(String(input.params.workspaceId || ""), context);
            if (active.error) return { ok: false, error: active.error };
            if (active.tasks.length) return { ok: false, error: { code: "workspace_task_active", message: "请先结束当前执行或审核，再添加仓库。" } };
          }
          return callObserverWithRecovery(input);
        });
      }
      return callObserverWithRecovery(input);
    };
    const callObserverWithRecovery = async (request: QueryInput): Promise<ObserverResponse> => {
      try {
        // A write must never be sent to a cold or retiring backend. Establish
        // ownership first so a connection refusal can be reported as safely
        // not dispatched instead of an uncertain Git operation.
        if (mutationMethods.has(request.method)) {
          const project = currentProject();
          if (project) {
            const backend = await startBackend(project.configPath);
            if (backend.state !== "ready") return { ok: false, error: {
              code: "backend_unavailable_before_dispatch", message: backend.message || "Backend is not ready; retry with the same request identity",
            } };
          }
        }
        const response = await bridge.call(request);
        if (response.ok) recordBackendSuccess(currentProject()?.configPath);
        if (request.method === "observer.health" && response.ok && response.result && typeof response.result === "object")
          return withObservationMetadata({ ...response, result: { ...response.result, bridge: { ...bridge.health(), buildId: DIFF_READ_BUILD, eventLoop: eventLoop.snapshot() } } });
        if (request.method === "observer.versions" && response.ok && response.result && typeof response.result === "object")
          return withObservationMetadata({ ...response, result: { ...response.result, reviewRevision: reviewRevision(), sessionRevision: sessionRevision() } });
        return response;
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : "";
        const project = currentProject();
        if (project) recordBackendFailure(project.configPath, error instanceof Error ? error.message : String(error));
        if (!replayableMethods.has(request.method) && error instanceof BridgeError)
          return { ok: false, error: { code: "request_uncertain_retry_same_identity", message: "Response unavailable; reconcile the saved operation before retrying", details: { method: input.method, requestId: input.params.requestId, stage: error.stage, dispatched: error.stage !== "connect", ...(input.method === "workspace.prepare.task" ? { status: { method: "workspace.prepare.task", action: "status", requestId: input.params.requestId, operationId: input.params.operationId, workspaceId: input.params.workspaceId } } : {}) } } };
        if (!project || !["observer_connection_refused", "observer_unavailable"].includes(code)) throw error;
        const backend = await startBackend(project.configPath);
        if (backend.state !== "ready") throw error;
        const recovered = await bridge.call(request);
        if (request.method === "observer.health" && recovered.ok && recovered.result && typeof recovered.result === "object")
          return withObservationMetadata({ ...recovered, result: { ...recovered.result, bridge: bridge.health() } });
        return withObservationMetadata(recovered);
      }
    };
    return await (currentProject() ? callWithRecovery() : withProject(input, callWithRecovery));
  } catch (error) {
    const code = error instanceof BridgeError ? error.code : "observer_unavailable";
    const message = code === "observer_timeout"
      ? copy.text_abffafb4f9
      : code === "observer_connection_refused" || code === "observer_unavailable"
        ? copy.text_64c3cc39e8
        : copy.text_83008521f9;
    return { ok: false, error: { code, message, ...(error instanceof BridgeError ? {details:{method:input.method,requestId:error.requestId,stage:error.stage,elapsedMs:error.elapsedMs,dispatched:error.stage !== 'connect'}} : {}) } };
  }
}

export function queryObserver(input: QueryInput): Promise<ObserverResponse> {
  return handleObserver(input);
}

export function closeObserverBridge(): void {
  eventLoop.close();
  bridge.close();
}

export { observerQuery };
import { copy } from "../shared/copy.ts";
