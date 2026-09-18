import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { nativeWebSocketFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";

type Client = Pick<DaemonClient, "connect" | "close" | "getConnectionState">;
type Managed = { client: Client; api: PaseoApi; endpoint: string };
type Factory = (endpoint: string) => Managed;

function localEndpoint(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const record = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
  const target = String(record.listen || record.sockPath || "").replace(/^unix:\/\//, "");
  if (target.startsWith("/")) return `ws+unix://${target}:/ws`;
  if (/^(127\.0\.0\.1|localhost):\d+$/.test(target)) return `ws://${target}/ws`;
  throw new Error("paseo_local_endpoint_required");
}

function createManaged(endpoint: string): Managed {
  const client = new DaemonClient({
    url: endpoint,
    clientId: `workbench-plugin-${randomUUID()}`,
    clientType: "cli",
    reconnect: { enabled: true, baseDelayMs: 250, maxDelayMs: 5_000 },
    connectTimeoutMs: 5_000,
    webSocketFactory: nativeWebSocketFactory,
  });
  return { client, api: createPaseoApi(client), endpoint };
}

const transportFailure = (error: unknown) => /Transport not connected|Connection lost|Daemon client closed|WebSocket not open|Timed out waiting for connection/i.test(String(error instanceof Error ? error.message : error));

/** One recoverable local Paseo session per plugin generation. No operation is replayed unless its caller marked it read-only. */
export class HostConnection {
  private readonly endpoint: () => string;
  private readonly factory: Factory;
  private managed: Managed | null = null;
  private connecting: Promise<PaseoApi> | null = null;
  private closed = false;
  private active = 0;
  private failures = 0;
  private reconnects = 0;
  private lastSuccessfulAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(endpoint = localEndpoint, factory: Factory = createManaged) {
    this.endpoint = endpoint;
    this.factory = factory;
  }

  async api(): Promise<PaseoApi> {
    if (this.closed) throw new Error("host_transport_closed");
    if (this.connecting) return this.connecting;
    if (this.managed?.client.getConnectionState().status === "connected") return this.managed.api;
    const endpoint = this.endpoint();
    if (this.managed && this.managed.endpoint !== endpoint && this.active === 0) {
      const old = this.managed;
      this.managed = null;
      void old.client.close().catch(() => {});
    }
    const managed = this.managed || (this.managed = this.factory(endpoint));
    if (managed.client.getConnectionState().status === "connected") return managed.api;
    const wasConnected = this.lastSuccessfulAt !== null;
    const flight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          managed.client.connect(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host_transport_connect_timeout")), 6_000); }),
        ]);
        if (managed.client.getConnectionState().status !== "connected") throw new Error("host_transport_connect_incomplete");
        if (this.closed || managed !== this.managed) throw new Error("host_transport_closed");
        if (wasConnected) this.reconnects++;
        this.lastSuccessfulAt = new Date().toISOString();
        this.lastFailure = null;
        return managed.api;
      } catch (error) {
        this.failures++;
        this.lastFailure = error instanceof Error ? error.message : String(error);
        throw new Error("host_transport_unavailable");
      } finally { clearTimeout(timer); }
    })();
    this.connecting = flight;
    try { return await flight; }
    finally { if (this.connecting === flight) this.connecting = null; }
  }

  async run<T>(operation: (api: PaseoApi) => Promise<T> | T, readOnly = false): Promise<T> {
    const api = await this.api();
    this.active++;
    try {
      try {
        const result = await operation(api);
        this.lastSuccessfulAt = new Date().toISOString();
        return result;
      } catch (error) {
        if (!transportFailure(error)) throw error;
        this.failures++;
        this.lastFailure = error instanceof Error ? error.message : String(error);
        if (!readOnly) throw new Error("workbench_request_uncertain_retry_same_identity:host_transport_lost");
        const recovered = await this.api();
        const result = await operation(recovered);
        this.lastSuccessfulAt = new Date().toISOString();
        return result;
      }
    } finally { this.active--; }
  }

  status() {
    return { state: this.closed ? "closed" : this.managed?.client.getConnectionState().status || "idle",
      active: this.active, reconnects: this.reconnects, failures: this.failures,
      lastSuccessfulAt: this.lastSuccessfulAt, lastFailure: this.lastFailure ? "host_transport_unavailable" : null };
  }

  async close(): Promise<void> {
    this.closed = true;
    const managed = this.managed;
    this.managed = null;
    await managed?.client.close().catch(() => {});
  }
}
