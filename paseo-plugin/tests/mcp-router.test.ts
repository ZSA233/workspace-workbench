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

test("workspace create uses the direct Git operation RPC instead of Agent orchestration", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args);
    return { ok: true, operationId: "create-direct-1", workspaceId: "direct" };
  };
  try {
    const response = await handle({ method: "tools/call", params: {
      name: "workbench_workspace_create",
      arguments: { requestId: "create-direct-1", name: "direct", repositories: ["one"] },
    } });
    assert.equal(response.isError, false);
    assert.equal((seen.at(-1) as unknown[])[1], "workspace.workbench.workspace-create");
    assert.equal(((seen.at(-1) as unknown[])[2] as { requestId: string }).requestId, "create-direct-1");
  } finally {
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});

test("workspace preview uses the local plugin RPC instead of the Paseo host orchestration path", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args);
    return { ok: true, action: "create", requiresExecution: true };
  };
  const previousToken = process.env.WORKBENCH_AGENT_TOKEN;
  process.env.WORKBENCH_AGENT_TOKEN = "preview-token";
  try {
    const response = await handle({ method: "tools/call", params: {
      name: "workbench_workspace_preview",
      arguments: { requestId: "preview-direct-1", name: "direct", repositories: ["one"], handoff: { goal: "inspect" } },
    } });
    assert.equal(response.isError, false);
    assert.equal((seen.at(-1) as unknown[])[1], "workspace.workbench.workspace-preview");
    const payload = (seen.at(-1) as unknown[])[2] as { token: string; request: { requestId: string } };
    assert.equal(payload.token, "preview-token");
    assert.equal(payload.request.requestId, "preview-direct-1");
  } finally {
    if (previousToken === undefined) delete process.env.WORKBENCH_AGENT_TOKEN;
    else process.env.WORKBENCH_AGENT_TOKEN = previousToken;
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});

test("workspace add repositories uses the direct Git operation RPC", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args);
    return { ok: true, workspaceId: "existing", addedRepositories: ["schema"] };
  };
  const previousToken = process.env.WORKBENCH_AGENT_TOKEN;
  delete process.env.WORKBENCH_AGENT_TOKEN;
  try {
    const response = await handle({ method: "tools/call", params: {
      name: "workbench_workspace_add_repositories",
      arguments: { workspaceId: "existing", repositories: ["schema"] },
    } });
    assert.equal(response.isError, false);
    assert.equal((seen.at(-1) as unknown[])[1], "workspace.workbench.workspace-add-repositories");
  } finally {
    if (previousToken === undefined) delete process.env.WORKBENCH_AGENT_TOKEN;
    else process.env.WORKBENCH_AGENT_TOKEN = previousToken;
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});

test("workspace delegate is explicit and preserves the handoff boundary", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args);
    return { ok: true, action: "created", workspaceId: "existing", agentId: "worker" };
  };
  const previousToken = process.env.WORKBENCH_AGENT_TOKEN;
  process.env.WORKBENCH_AGENT_TOKEN = "delegate-token";
  try {
    const response = await handle({ method: "tools/call", params: {
      name: "workbench_workspace_delegate",
      arguments: { workspaceId: "existing", parentAgentId: "parent", handoff: { goal: "inspect" } },
    } });
    assert.equal(response.isError, false);
    assert.equal((seen.at(-1) as unknown[])[1], "workspace.workbench.delegate");
    assert.equal(((seen.at(-1) as unknown[])[2] as { parentAgentId: string }).parentAgentId, "parent");
  } finally {
    if (previousToken === undefined) delete process.env.WORKBENCH_AGENT_TOKEN;
    else process.env.WORKBENCH_AGENT_TOKEN = previousToken;
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});

test("workspace status reports the missing requestId instead of orchestration union errors", async () => {
  const response = await handle({ method: "tools/call", params: {
    name: "workbench_workspace_status",
    arguments: { workspaceId: "existing" },
  } });
  assert.equal(response.isError, true);
  assert.match(String((response.content as Array<{ text?: string }>)[0]?.text), /workspace_status_request_id_required/);
});

test("workspace status with requestId keeps the handoff status route", async () => {
  const originalConnect = DaemonClient.prototype.connect;
  const originalClose = DaemonClient.prototype.close;
  const originalInvoke = DaemonClient.prototype.invokePluginRpc;
  const seen: unknown[] = [];
  DaemonClient.prototype.connect = async function () {};
  DaemonClient.prototype.close = async function () {};
  DaemonClient.prototype.invokePluginRpc = async function (...args: unknown[]) {
    seen.push(args);
    return { ok: true, requestId: "handoff-1", state: "active" };
  };
  try {
    const response = await handle({ method: "tools/call", params: {
      name: "workbench_workspace_status",
      arguments: { requestId: "handoff-1", workspaceId: "existing" },
    } });
    assert.equal(response.isError, false);
    assert.equal((seen.at(-1) as unknown[])[1], "workspace.workbench.orchestrate");
    assert.equal(((seen.at(-1) as unknown[])[2] as { request: { requestId: string } }).request.requestId, "handoff-1");
  } finally {
    DaemonClient.prototype.connect = originalConnect;
    DaemonClient.prototype.close = originalClose;
    DaemonClient.prototype.invokePluginRpc = originalInvoke;
  }
});
