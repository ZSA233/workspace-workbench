import assert from "node:assert/strict";
import test from "node:test";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

process.env.WORKBENCH_PASEO_ENDPOINT = "ws://127.0.0.1:1/ws";
process.env.WORKBENCH_PROJECT_CONFIG = "/tmp/workbench-mcp-router-test.json";
process.env.WORKBENCH_AGENT_TOKEN = "workbench-mcp-router-test";
// @ts-expect-error The router is an intentionally untyped MCP JavaScript entrypoint.
const { handle } = await import("../shared/mcp-router.mjs");

test("workspace submit preserves task across MCP argument envelopes", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args[2]);
    return { ok: true };
  };
  try {
    for (const [envelope, task] of [
      [{ arguments: { task: "standard", requestId: "r1" } }, "standard"],
      [{ args: { task: "args", requestId: "r2" } }, "args"],
      [{ task: "direct", requestId: "r3" }, "direct"],
    ] as const) {
      const response = await handle({ method: "tools/call", params: { name: "workbench_workspace_submit", ...envelope } });
      assert.equal(response.isError, false);
      assert.equal((seen.at(-1) as { request: { task: string } }).request.task, task);
    }
  } finally {
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});
