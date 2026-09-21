import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { McpGatewayManager } from "../server/mcp-gateway.ts";

async function startGateway() {
  const root = mkdtempSync(join(tmpdir(), "workbench-gateway-"));
  const key = "test-gateway-key";
  const child = spawn(process.execPath, ["mcp-gateway.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, WORKBENCH_GATEWAY_PARENT_PID: String(process.pid), WORKBENCH_GATEWAY_PORT: "0", WORKBENCH_GATEWAY_KEY: key, WORKBENCH_GATEWAY_GENERATION: "test-generation", WORKBENCH_DIAGNOSTICS_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const ready = new Promise<{ port: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway test start timeout")), 5_000);
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { const message = JSON.parse(buffer.slice(0, newline)); if (message.event === "ready") { clearTimeout(timer); resolve(message); } }
      catch (error) { clearTimeout(timer); reject(error); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const address = await ready;
  return { child, key, root, base: `http://127.0.0.1:${address.port}` };
}

test("the HTTP gateway serves MCP requests through one process and releases it", async () => {
  const gateway = await startGateway();
  try {
    const headers = { "content-type": "application/json", "x-workbench-gateway-key": gateway.key };
    const initialize = await fetch(`${gateway.base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) });
    const initialized = await initialize.json() as { result?: { serverInfo?: { name?: string }; _meta?: { workbench?: { transport?: string } } } };
    assert.equal(initialize.status, 200);
    assert.equal(initialized.result?.serverInfo?.name, "workspace-workbench");
    assert.equal(initialized.result?._meta?.workbench?.transport, "http");
    const tools = await fetch(`${gateway.base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const listed = await tools.json() as { result?: { tools?: Array<{ name: string }> } };
    assert.ok(listed.result?.tools?.some(tool => tool.name === "workbench_workspace_create"));
    const health = await (await fetch(`${gateway.base}/health`)).json() as { active: number; queued: number; generation: string };
    assert.deepEqual({ active: health.active, queued: health.queued, generation: health.generation }, { active: 0, queued: 0, generation: "test-generation" });
  } finally {
    gateway.child.kill("SIGTERM");
    await once(gateway.child, "exit");
    rmSync(gateway.root, { recursive: true, force: true });
  }
});

test("the gateway rejects an invalid key without creating a request", async () => {
  const gateway = await startGateway();
  try {
    const response = await fetch(`${gateway.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", "x-workbench-gateway-key": "wrong" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(response.status, 401);
    assert.match((await response.text()), /gateway key invalid/);
  } finally {
    gateway.child.kill("SIGTERM");
    await once(gateway.child, "exit");
    rmSync(gateway.root, { recursive: true, force: true });
  }
});

test("concurrent manager starts share one gateway and close only that child", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-home-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const manager = new McpGatewayManager(join(process.cwd(), "mcp-gateway.mjs"));
  try {
    const [first, second] = await Promise.all([
      manager.configForRequest("/tmp/project-a.json", "token-a", "interactive"),
      manager.configForRequest("/tmp/project-b.json", "token-b", "worker", "workspace-b"),
    ]);
    assert.equal(first.url, second.url);
    assert.equal(manager.status().activeLeases, 2);
    assert.ok(manager.status().pid);
  } finally {
    await manager.close();
    assert.equal(manager.status().state, "closed");
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an occupied saved port is abandoned and retried without a hanging child", async () => {
  const blocker = createServer().listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const address = blocker.address();
  assert.ok(address && typeof address === "object");
  const occupiedPort = address.port;
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-port-"));
  const stateDir = join(home, "workspace-workbench");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "gateway.json"), JSON.stringify({ port: occupiedPort, key: "occupied-port-key" }));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const manager = new McpGatewayManager(join(process.cwd(), "mcp-gateway.mjs"));
  try {
    const config = await manager.configForRequest("/tmp/project.json", "token", "interactive");
    assert.notEqual(new URL(config.url).port, String(occupiedPort));
    assert.equal(manager.status().state, "ready");
  } finally {
    await manager.close();
    blocker.close();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
