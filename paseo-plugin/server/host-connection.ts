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
  private readonly connectBudgetMs: number;
  private managed: Managed | null = null;
  private connecting: Promise<PaseoApi> | null = null;
  // The SDK keeps this attempt alive while it reconnects. After our bounded
  // wait expires, later calls must not attach more waiters to that promise.
  private sdkConnecting: Promise<void> | null = null;
  private closed = false;
  private active = 0;
  private failures = 0;
  private cleanupFailures = 0;
  private reconnects = 0;
  private lastSuccessfulAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(endpoint = localEndpoint, factory: Factory = createManaged, connectBudgetMs = 6_000) {
    this.endpoint = endpoint;
    this.factory = factory;
    this.connectBudgetMs = connectBudgetMs;
  }

  async api(): Promise<PaseoApi> {
    if (this.closed) throw new Error("host_transport_closed");
    if (this.connecting) return this.connecting;
    if (this.managed?.client.getConnectionState().status === "connected") return this.managed.api;
    const endpoint = this.endpoint();
    if (this.managed && this.managed.endpoint !== endpoint && this.active === 0) {
      const old = this.managed;
      this.managed = null;
      this.sdkConnecting = null;
      void this.dispose(old);
    }
    const managed = this.managed || (this.managed = this.factory(endpoint));
    if (managed.client.getConnectionState().status === "connected") return managed.api;
    if (this.sdkConnecting) throw new Error("host_transport_unavailable");
    const wasConnected = this.lastSuccessfulAt !== null;
    const sdkConnecting = Promise.resolve().then(() => managed.client.connect());
    this.sdkConnecting = sdkConnecting;
    void sdkConnecting.then(() => {
      if (this.sdkConnecting !== sdkConnecting || managed !== this.managed || this.closed) return;
      this.sdkConnecting = null;
      if (managed.client.getConnectionState().status !== "connected") return;
      if (wasConnected) this.reconnects++;
      this.lastSuccessfulAt = new Date().toISOString();
      this.lastFailure = null;
    }, () => {
      if (this.sdkConnecting === sdkConnecting) this.sdkConnecting = null;
    });
    const flight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sdkConnecting,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host_transport_connect_timeout")), this.connectBudgetMs); }),
        ]);
        if (managed.client.getConnectionState().status !== "connected") throw new Error("host_transport_connect_incomplete");
        if (this.closed || managed !== this.managed) throw new Error("host_transport_closed");
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
      active: this.active, reconnects: this.reconnects, failures: this.failures, cleanupFailures: this.cleanupFailures,
      lastSuccessfulAt: this.lastSuccessfulAt, lastFailure: this.lastFailure ? "host_transport_unavailable" : null };
  }

  async injectDisconnectForIsolatedTest(): Promise<void> {
    if (process.env.WORKBENCH_TEST_HOST_DROP !== "1") throw new Error("host_fault_injection_disabled");
    await this.api();
    const client = this.managed!.client as DaemonClient;
    const transport = (client as unknown as { transport?: { close(code: number, reason: string): void } }).transport;
    if (!transport) throw new Error("host_transport_not_connected");
    let unsubscribe = () => {};
    const disconnected = new Promise<void>((resolveDisconnected, rejectDisconnected) => {
      const timer = setTimeout(() => { unsubscribe(); rejectDisconnected(new Error("host_disconnect_not_observed")); }, 5_000);
      unsubscribe = client.subscribeConnectionStatus(state => {
        if (state.status === "connected") return;
        clearTimeout(timer); unsubscribe(); resolveDisconnected();
      });
    });
    transport.close(1000, "isolated fault injection");
    await disconnected;
  }

  async close(): Promise<void> {
    this.closed = true;
    const managed = this.managed;
    this.managed = null;
    this.sdkConnecting = null;
    if (managed) await this.dispose(managed);
  }

  private async dispose(managed: Managed): Promise<void> {
    try { await managed.client.close(); }
    catch { this.cleanupFailures++; }
  }
}
