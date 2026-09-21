import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { handle } from "./shared/mcp-router.mjs";
import { createDiagnosticSink } from "./server/diagnostics-runtime.mjs";
import { createRequire } from "node:module";

const packageMetadata = createRequire(import.meta.url)("./package.json");
const parentPid = Number(process.env.WORKBENCH_GATEWAY_PARENT_PID || 0);
const requestedPort = Number(process.env.WORKBENCH_GATEWAY_PORT || 0);
const key = process.env.WORKBENCH_GATEWAY_KEY || "";
const generation = process.env.WORKBENCH_GATEWAY_GENERATION || `gateway:${process.pid}`;
const pluginGeneration = process.env.WORKBENCH_PLUGIN_GENERATION || "unknown";
const diagnosticsRoot = process.env.WORKBENCH_DIAGNOSTICS_ROOT || "/tmp/workbench-diagnostics";
const diagnostics = createDiagnosticSink({ root: diagnosticsRoot, component: "gateway", generation });
const active = new Set();
const queue = [];
let running = 0;
let closing = false;
const maxConcurrent = 4;
const maxQueue = 16;
const budgetMs = 55_000;
function projectHash(path) { return path ? createHash("sha256").update(path).digest("hex").slice(0, 12) : null; }
function toolName(message) {
  return message?.method === "tools/call" && message?.params && typeof message.params.name === "string"
    ? message.params.name
    : undefined;
}

function json(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const value = body === undefined ? "" : JSON.stringify(body);
  try {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(value);
  } catch {}
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    // Requests contain tool arguments, not source archives. Keep the upper
    // bound small enough that the bounded queue cannot retain hundreds of MB
    // while a backend request is busy.
    if (bytes > 8 * 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requestContext(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const projectConfig = String(req.headers["x-workbench-project"] || "");
  const role = String(req.headers["x-workbench-role"] || "interactive");
  const workspaceId = String(req.headers["x-workbench-workspace"] || "");
  return {
    endpoint: process.env.WORKBENCH_PASEO_ENDPOINT,
    projectConfig,
    token,
    role,
    workspaceId,
  };
}

async function run(item) {
  if (item.canceled) {
    item.controller = null;
    drain();
    return;
  }
  item.phase = "running";
  running++;
  active.add(item);
  const started = Date.now();
  const controller = new AbortController();
  item.controller = controller;
  const timer = setTimeout(() => controller.abort("deadline"), budgetMs);
  diagnostics.record({ event: "mcp_request_started", phase: "dispatch", transport: "http", requestId: item.requestId, method: item.message?.method, tool: toolName(item.message), role: item.context.role, projectHash: projectHash(item.context.projectConfig), queueMs: Math.max(0, started - item.enqueuedAt) });
  try {
    const result = await handle(item.message, {
      signal: controller.signal,
      deadline: Date.now() + budgetMs,
      diagnose: event => diagnostics.record({ ...event, event: event.code === "cleanup_failed" ? "mcp_cleanup_failed" : "mcp_request_phase", requestId: item.requestId, phase: event.phase }),
    }, item.context);
    if (!item.response.writableEnded && !item.response.destroyed) json(item.response, 200, { jsonrpc: "2.0", id: item.message.id ?? null, result: item.message.method === "ping" || item.message.method === "initialize" ? { ...result, _meta: { workbench: { transport: "http", pluginGeneration, gatewayGeneration: generation, gatewayPid: process.pid, version: packageMetadata.version } } } : result });
    diagnostics.record({ event: "mcp_request_finished", phase: "cleanup", transport: "http", requestId: item.requestId, method: item.message?.method, tool: toolName(item.message), projectHash: projectHash(item.context.projectConfig), queueMs: Math.max(0, started - item.enqueuedAt), durationMs: Date.now() - started });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!item.response.writableEnded && !item.response.destroyed) json(item.response, /request_too_large/.test(message) ? 413 : 500, rpcError(item.message?.id, -32603, message));
    diagnostics.record({ event: controller.signal.aborted ? "mcp_request_timeout" : "mcp_request_finished", phase: controller.signal.aborted ? "cleanup" : "dispatch", transport: "http", requestId: item.requestId, method: item.message?.method, tool: toolName(item.message), projectHash: projectHash(item.context.projectConfig), queueMs: Math.max(0, started - item.enqueuedAt), durationMs: Date.now() - started, errorCode: controller.signal.aborted ? "request_timeout" : "request_failed", reason: message });
  } finally {
    clearTimeout(timer);
    active.delete(item);
    running--;
    drain();
  }
}

function drain() {
  while (!closing && running < maxConcurrent && queue.length) {
    const item = queue.shift();
    if (item.canceled) continue;
    void run(item);
  }
}

function cancelQueuedOrActive(item, reason) {
  if (!item || item.canceled) return;
  item.canceled = true;
  item.controller?.abort(reason);
  if (item.phase === "queued") {
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
  }
  diagnostics.record({ event: "mcp_request_canceled", phase: "cleanup", transport: "http", requestId: item.requestId, reason });
  drain();
}

async function onRequest(req, res) {
  if (req.url === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, component: "workbench-mcp-gateway", pluginGeneration, generation, pid: process.pid, parentPid, active: running, queued: queue.length });
    return;
  }
  if (req.url !== "/mcp" || req.method !== "POST") {
    json(res, 405, rpcError(null, -32601, "MCP endpoint accepts POST /mcp"), { allow: "POST" });
    return;
  }
  if (!key || req.headers["x-workbench-gateway-key"] !== key) {
    diagnostics.record({ event: "mcp_request_rejected", phase: "connect", transport: "http", errorCode: "gateway_key_invalid" });
    json(res, 401, rpcError(null, -32001, "workbench gateway key invalid"));
    return;
  }
  let message;
  try { message = await readBody(req); }
  catch (error) { if (!res.destroyed) json(res, 400, rpcError(null, -32700, error instanceof Error ? error.message : "invalid_json")); return; }
  if (!message || typeof message !== "object" || Array.isArray(message)) { if (!res.destroyed) json(res, 400, rpcError(null, -32600, "invalid_jsonrpc_request")); return; }
  if (message.id === undefined) { if (!res.destroyed) json(res, 202, undefined); return; }
  if (closing || running >= maxConcurrent && queue.length >= maxQueue) {
    diagnostics.record({ event: "mcp_request_rejected", phase: "dispatch", transport: "http", requestId: String(message.id || randomUUID()), method: message.method, tool: toolName(message), errorCode: closing ? "gateway_closing" : "queue_full" });
    if (!res.destroyed) json(res, 429, rpcError(message.id, -32004, "workbench_busy_not_dispatched"));
    return;
  }
  const item = { message, response: res, requestId: String(message.id || randomUUID()), context: requestContext(req), controller: null, phase: "queued", canceled: false, enqueuedAt: Date.now() };
  const onDisconnect = () => {
    if (!res.writableEnded) cancelQueuedOrActive(item, "client_disconnected");
  };
  req.once("aborted", onDisconnect);
  res.once("close", onDisconnect);
  queue.push(item);
  drain();
}

const server = createServer((req, res) => { void onRequest(req, res); });
server.on("error", error => { diagnostics.record({ event: "gateway_error", phase: "connect", errorCode: error?.code || "server_error", reason: error?.message || String(error) }); process.exitCode = 1; });

function close() {
  if (closing) return;
  closing = true;
  diagnostics.record({ event: "gateway_shutdown_started", phase: "cleanup" });
  for (const item of active) item.controller?.abort("gateway_shutdown");
  for (const item of queue.splice(0)) if (!item.response.writableEnded) json(item.response, 503, rpcError(item.message?.id, -32005, "workbench_gateway_closing"));
  server.close(() => { diagnostics.record({ event: "gateway_shutdown_finished", phase: "cleanup" }); void diagnostics.close().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 2_000).unref();
}

const parentWatch = setInterval(() => {
  if (parentPid && (process.ppid !== parentPid || (() => { try { process.kill(parentPid, 0); return true; } catch { return false; } })() === false)) {
    diagnostics.record({ event: "gateway_parent_missing", phase: "cleanup", reason: `expected_parent:${parentPid}`, errorCode: "parent_missing" });
    close();
  }
}, 2_000);
parentWatch.unref();
process.once("SIGTERM", close);
process.once("SIGINT", close);
server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  diagnostics.record({ event: "gateway_ready", phase: "connect", transport: "http", port });
  process.stdout.write(`${JSON.stringify({ event: "ready", pid: process.pid, parentPid, port, generation, pluginGeneration })}\n`);
});
