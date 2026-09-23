import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { McpGatewayManager } from "../server/mcp-gateway.ts";
const ready = async () => ({ ok: true, stage: "ready" });

function postWithoutPooling(url: string, key: string, message: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "POST", agent: false, headers: {
      "content-type": "application/json", "x-workbench-gateway-key": key,
    } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.once("end", () => {
        try { resolve({ status: response.statusCode || 0, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.end(JSON.stringify(message));
  });
}

async function startGateway(home?: string) {
  const root = mkdtempSync(join(tmpdir(), "workbench-gateway-"));
  const key = "test-gateway-key";
  const child = spawn(process.execPath, ["mcp-gateway.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, ...(home ? { PASEO_HOME: home } : {}), WORKBENCH_GATEWAY_PARENT_PID: String(process.pid), WORKBENCH_GATEWAY_PORT: "0", WORKBENCH_GATEWAY_KEY: key, WORKBENCH_GATEWAY_GENERATION: "test-generation", WORKBENCH_DIAGNOSTICS_ROOT: root },
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

test("HTTP queue time counts toward the short read deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-queue-"));
  const sockets = new Set<Socket>();
  const stalledPaseo = createNetServer(socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => stalledPaseo.listen(0, "127.0.0.1", resolve));
  const address = stalledPaseo.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(join(home, "paseo.pid"), JSON.stringify({ listen: `127.0.0.1:${address.port}` }));
  const gateway = await startGateway(home);
  try {
    const calls = Array.from({ length: 20 }, (_, id) => postWithoutPooling(`${gateway.base}/mcp`, gateway.key,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: "workbench_connection_status", arguments: {} } }));
    const results = await Promise.all(calls);
    assert.ok(results.some(result => result.status === 504 && /queue_timeout/.test(result.body.error?.message)),
      "queued reads must expire before dispatch when their receipt deadline passes");
  } finally {
    gateway.child.kill("SIGTERM");
    await once(gateway.child, "exit");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => stalledPaseo.close(() => resolve()));
    rmSync(gateway.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent manager starts share one gateway and close only that child", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-home-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const manager = new McpGatewayManager(join(process.cwd(), "mcp-gateway.mjs"), undefined, ready);
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

test("an unknown occupant does not silently change the saved gateway port", async () => {
  const blocker = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"component":"unrelated"}'); }).listen(0, "127.0.0.1");
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
  const manager = new McpGatewayManager(join(process.cwd(), "mcp-gateway.mjs"), undefined, ready);
  try {
    await assert.rejects(manager.configForRequest("/tmp/project.json", "token", "interactive"), /gateway_port_occupied_unverified/);
    assert.equal(manager.status().port, occupiedPort);
  } finally {
    await manager.close();
    blocker.close();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a crashed gateway and a plugin replacement keep the same URL and key", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-continuity-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const entry = join(process.cwd(), "mcp-gateway.mjs");
  const firstManager = new McpGatewayManager(entry, undefined, ready);
  let secondManager: McpGatewayManager | null = null;
  try {
    const first = await firstManager.configForRequest("/tmp/project.json", "token", "interactive");
    const firstPid = firstManager.status().pid;
    assert.ok(firstPid);
    process.kill(firstPid, "SIGKILL");
    let recovered: Awaited<ReturnType<typeof firstManager.configForRequest>> | null = null;
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      if (firstManager.status().pid && firstManager.status().pid !== firstPid && firstManager.status().state === "ready") {
        recovered = await firstManager.configForRequest("/tmp/project.json", "token", "interactive");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(recovered, "gateway should restart without a new Agent injection");
    assert.equal(recovered.url, first.url);
    assert.equal(recovered.headers["X-Workbench-Gateway-Key"], first.headers["X-Workbench-Gateway-Key"]);
    await firstManager.close();
    secondManager = new McpGatewayManager(entry, undefined, ready);
    const replacement = await secondManager.configForRequest("/tmp/project.json", "token", "interactive");
    assert.equal(replacement.url, first.url);
    assert.equal(replacement.headers["X-Workbench-Gateway-Key"], first.headers["X-Workbench-Gateway-Key"]);
  } finally {
    await firstManager.close();
    await secondManager?.close();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("a new plugin generation waits for its verified predecessor on the reserved port", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbench-gateway-handoff-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const entry = join(process.cwd(), "mcp-gateway.mjs");
  const oldManager = new McpGatewayManager(entry, undefined, ready);
  const newManager = new McpGatewayManager(entry, undefined, ready);
  try {
    const oldConfig = await oldManager.configForRequest("/tmp/project.json", "old", "interactive");
    const next = newManager.configForRequest("/tmp/project.json", "new", "interactive");
    await new Promise(resolve => setTimeout(resolve, 300));
    await oldManager.close();
    const newConfig = await next;
    assert.equal(newConfig.url, oldConfig.url);
    assert.equal(newConfig.headers["X-Workbench-Gateway-Key"], oldConfig.headers["X-Workbench-Gateway-Key"]);
  } finally {
    await newManager.close();
    await oldManager.close();
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
