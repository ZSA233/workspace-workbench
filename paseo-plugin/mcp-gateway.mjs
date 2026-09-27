import { createRequestScheduler } from './shared/request-scheduler.mjs';
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { handle } from "./shared/mcp-router.mjs";
import { requestBudget } from "./shared/mcp-policy.mjs";
import { probePaseo } from "./shared/mcp-readiness.mjs";
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
const scheduler = createRequestScheduler();
let readinessFlight = null;
const readinessAbort = new AbortController();
let closing = false;
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
    projectConfig,
    token,
    role,
    workspaceId,
  };
}

async function onRequest(req, res) {
  if (req.url === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, component: "workbench-mcp-gateway", pluginGeneration, generation, pid: process.pid, parentPid, ...scheduler.health() });
    return;
  }
  if (req.url === "/ready" && req.method === "GET") {
    if (!key || req.headers["x-workbench-gateway-key"] !== key) {
      json(res, 401, { ok: false, stage: "gateway", code: "gateway_key_invalid" }); return;
    }
    if (!readinessFlight) readinessFlight = probePaseo({ signal: readinessAbort.signal }).finally(() => { readinessFlight = null; });
    const result = await readinessFlight;
    json(res, result.ok ? 200 : 503, { ...result, generation, pid: process.pid });
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
  if (res.destroyed) return;
  const id = randomUUID();
  const context = requestContext(req);
  const receivedAt = Date.now();
  scheduler.submit({ id, deadline: receivedAt + requestBudget(message),
    control: ['ping', 'initialize', 'tools/list'].includes(message.method),
    run: lifecycle => handle(message, lifecycle, context),
    diagnose: event => diagnostics.record({ ...event, event: 'mcp_request_phase', requestId: id, method: message.method, tool: toolName(message) }),
    respond: (error, result) => {
      let toolError;
      if (result?.isError) {
        try { toolError = JSON.parse(result.content?.find(item => item.type === 'text')?.text || '{}').error; } catch {}
      }
      const reason = error?.message || toolError?.code || '';
      if (error) json(res, /queue_timeout/.test(reason) ? 504 : /busy/.test(reason) ? 429 : 500, rpcError(message.id, /queue_timeout/.test(reason) ? -32008 : /busy/.test(reason) ? -32004 : -32603, reason));
      else json(res, 200, { jsonrpc: '2.0', id: message.id, result: ['ping', 'initialize'].includes(message.method)
        ? { ...result, _meta: { workbench: { transport: 'http', pluginGeneration, gatewayGeneration: generation, gatewayPid: process.pid, version: packageMetadata.version } } } : result });
      diagnostics.record({ event: error || result?.isError ? 'mcp_request_failed' : 'mcp_request_finished', requestId: id, projectHash: projectHash(context.projectConfig), method: message.method,
        tool: toolName(message), durationMs: Date.now() - receivedAt, reason, queueMs: error?.queueMs, dispatched: error?.workbenchDispatched ?? toolError?.dispatched, phase: error?.stage ?? toolError?.stage });
    },
  });
  res.once('close', () => { if (!res.writableEnded) scheduler.cancel(id, 'client_disconnected'); });

}

const server = createServer((req, res) => { void onRequest(req, res); });
server.on("error", error => {
  const code = error?.code || "server_error";
  const reason = error?.message || String(error);
  diagnostics.record({ event: "gateway_error", phase: "connect", errorCode: code, reason });
  // Fail the child so its owner can retry the same reserved address.
  try { process.stderr.write(`workbench_gateway_error ${code} ${reason}\n`); } catch {}
  process.exitCode = 1;
  process.exit(1);
});

function close() {
  if (closing) return;
  closing = true;
  diagnostics.record({ event: "gateway_shutdown_started", phase: "cleanup" });
  readinessAbort.abort();
  scheduler.close();
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
