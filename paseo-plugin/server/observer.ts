import { withWorkspaceScope } from "./workspace-scope.ts";
import type { AgentContext } from "./agent-provider.ts";
import { createConnection, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { currentProject, withProject } from "./projects.ts";
import { startBackend } from "./backend-manager.ts";

import {
  observerMethods,
  observerQuery,
  type ObserverResponse,
} from "../shared/observer.ts";

type QueryInput = {
  projectConfig?: string;
  directory?: string;
  method: (typeof observerMethods)[number];
  params: Record<string, unknown>;
};

type SocketRequest = {
  id: string;
  method: QueryInput["method"];
  params: Record<string, unknown>;
};

const allowedMethods = new Set<string>(observerMethods);
const requestTimeoutMs = 10_000;
const responseCacheTtlMs = 1_000;

class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
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

class ObserverBridge {
  private sequence = 0;
  private readonly inFlight = new Map<string, Promise<ObserverResponse>>();
  private readonly cache = new Map<string, { expiresAt: number; response: ObserverResponse }>();

  private request(request: SocketRequest): Promise<ObserverResponse> {
    return new Promise((resolveResponse, reject) => {
      let settled = false;
      let buffer = "";
      let socket: Socket | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        callback();
        socket?.destroy();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new BridgeError("observer_timeout", "observer request timed out")));
      }, requestTimeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        finish(() => reject(error));
      };
      socket = createConnection(configuredSocketPath());
      socket.setEncoding("utf8");
      socket.on("connect", () => socket?.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string | Buffer) => {
        buffer += String(chunk);
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          finish(() => resolveResponse(JSON.parse(buffer.slice(0, newline)) as ObserverResponse));
        } catch {
          finish(() => reject(new BridgeError("observer_invalid_response", "observer returned invalid JSON")));
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
    const key = `${configuredSocketPath()}:${input.method}:${JSON.stringify(input.params || {})}`;
    const projectPrefix = `${configuredSocketPath()}:`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.response;
    this.cache.delete(key);
    const active = this.inFlight.get(key);
    if (active) return active;
    const request: SocketRequest = { id: String(++this.sequence), method: input.method, params: input.params || {} };
    const pending = this.request(request)
      .then((response) => {
        if (response.ok && ["observer.reload", "workspace.create", "workspace.addRepositories", "workspace.prepare", "workspace.cleanup", "workspace.remove", "workspace.restore", "workspace.delete"].includes(input.method)) {
          for (const cachedKey of this.cache.keys()) if (cachedKey.startsWith(projectPrefix)) this.cache.delete(cachedKey);
        }
        if (!input.method.startsWith("workspace.") || !["workspace.create", "workspace.addRepositories", "workspace.prepare", "workspace.cleanup", "workspace.remove", "workspace.restore", "workspace.delete", "workspace.runtime"].includes(input.method)) {
          if (cacheable(response)) this.cache.set(key, { response, expiresAt: Date.now() + responseCacheTtlMs });
        }
        return response;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  close(): void {
    this.inFlight.clear();
    this.cache.clear();
  }
}

const bridge = new ObserverBridge();

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
          return bridge.call(input);
        });
      }
      try {
        return await bridge.call(input);
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : "";
        const project = currentProject();
        if (!project || !["observer_connection_refused", "observer_unavailable"].includes(code)) throw error;
        const backend = await startBackend(project.configPath);
        if (backend.state !== "ready") throw error;
        return bridge.call(input);
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
    return { ok: false, error: { code, message } };
  }
}

export function queryObserver(input: QueryInput): Promise<ObserverResponse> {
  return handleObserver(input);
}

export function closeObserverBridge(): void {
  bridge.close();
}

export { observerQuery };
import { copy } from "../shared/copy.ts";
