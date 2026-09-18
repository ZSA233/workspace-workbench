import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { HostConnection } from "../server/host-connection.ts";
import { RpcMetrics } from "../server/rpc-metrics.ts";

test("one host connection recovers reads, never replays uncertain writes, and closes once", async () => {
  let state: "disconnected" | "connected" | "disposed" = "disconnected";
  let connects = 0, closes = 0, constructions = 0;
  const connection = new HostConnection(() => "ws://127.0.0.1:6767/ws", () => {
    constructions++;
    return {
      endpoint: "ws://127.0.0.1:6767/ws",
      api: {} as PaseoApi,
      client: {
        connect: async () => { connects++; await Promise.resolve(); state = "connected"; },
        close: async () => { closes++; state = "disposed"; },
        getConnectionState: () => ({ status: state }),
      },
    } as ConstructorParameters<typeof HostConnection>[1] extends (...args: never[]) => infer Result ? Result : never;
  });
  try {
    await Promise.all(Array.from({ length: 20 }, () => connection.api()));
    assert.equal(constructions, 1);
    assert.equal(connects, 1, "parallel calls share the same connect task");
    let readCalls = 0;
    const result = await connection.run(async () => {
      if (++readCalls === 1) { state = "disconnected"; throw new Error("Transport not connected (status: disconnected)"); }
      return "recovered";
    }, true);
    assert.equal(result, "recovered");
    assert.equal(readCalls, 2);
    let writeCalls = 0;
    await assert.rejects(connection.run(async () => {
      writeCalls++; state = "disconnected";
      throw new Error("Transport not connected (status: disconnected)");
    }), /request_uncertain_retry_same_identity/);
    assert.equal(writeCalls, 1, "a lost write is never replayed");
    for (let i = 0; i < 100; i++) { state = "disconnected"; await connection.api(); }
    assert.equal(constructions, 1, "recovery reuses one SDK client");
    assert.equal(connection.status().state, "connected");
  } finally { await connection.close(); }
  assert.equal(closes, 1);
  assert.equal(connection.status().active, 0);
});

test("RPC diagnostics retain only a bounded current window and omit inputs", async () => {
  const metrics = new RpcMetrics();
  await metrics.track("workspace.workbench.query", () => ({ sensitive: "not recorded" }));
  await assert.rejects(metrics.track("workspace.workbench.orchestrate", () => { throw new Error("test failure"); }));
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.methods["workspace.workbench.query"].count, 1);
  assert.equal(snapshot.methods["workspace.workbench.orchestrate"].failures, 1);
  assert.equal(JSON.stringify(snapshot).includes("not recorded"), false);
});

test("timed-out host connection keeps one SDK recovery instead of accumulating waiters", async () => {
  let state: "connecting" | "connected" | "disposed" = "connecting";
  let connects = 0;
  let resolveConnect!: () => void;
  const pending = new Promise<void>(resolve => { resolveConnect = resolve; });
  const connection = new HostConnection(() => "ws://127.0.0.1:6767/ws", () => ({
    endpoint: "ws://127.0.0.1:6767/ws",
    api: {} as PaseoApi,
    client: {
      connect: () => { connects++; return pending; },
      close: async () => { state = "disposed"; },
      getConnectionState: () => ({ status: state }),
    },
  }) as ConstructorParameters<typeof HostConnection>[1] extends (...args: never[]) => infer Result ? Result : never, 20);
  try {
    await assert.rejects(connection.api(), /host_transport_unavailable/);
    for (let i = 0; i < 100; i++) {
      await assert.rejects(connection.api(), /host_transport_unavailable/);
    }
    assert.equal(connects, 1, "timed-out requests must not attach new SDK connect attempts");
    state = "connected";
    resolveConnect();
    await connection.api();
    assert.equal(connection.status().state, "connected");
    assert.equal(connects, 1);
  } finally { await connection.close(); }
});
