import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const packageMetadata = require("./package.json");
const endpoint = process.env.WORKBENCH_PASEO_ENDPOINT;
const projectConfig = process.env.WORKBENCH_PROJECT_CONFIG;
const token = process.env.WORKBENCH_AGENT_TOKEN;
const names = ["preview", "execute", "status"];
const schema = { type: "object", required: ["requestId", "handoff"], additionalProperties: false, properties: {
  requestId: { type: "string" }, workspaceId: { type: "string" }, name: { type: "string" }, repositories: { type: "array", items: { type: "string" } },
  baseRefs: { type: "object", additionalProperties: { type: "string" } },
  handoff: { type: "object", required: ["goal"], properties: { goal: { type: "string" }, startMode: { enum: ["adaptive", "plan-first"] }, ...Object.fromEntries(["decisions", "inScope", "outOfScope", "steps", "acceptance", "constraints", "ambiguities"].map((key) => [key, { type: "array", items: { type: "string" } }])) } },
} };
let client;
async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "workspace-workbench", version: packageMetadata.version } };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: names.map((action) => ({ name: `workbench_workspace_${action}`, description: action === "execute" ? "Execute the approved isolated Workspace handoff; requires a non-planning coordinator. Retry with the identical request." : `${action} an isolated Workspace handoff without writes.`, inputSchema: schema, annotations: { readOnlyHint: action !== "execute", destructiveHint: false } })) };
  if (message.method !== "tools/call") throw new Error("method_not_found");
  const action = names.find((value) => message.params?.name === `workbench_workspace_${value}`);
  if (!action || !endpoint || !projectConfig || !token) throw new Error("workbench_context_unavailable");
  {
    client = new DaemonClient({ url: endpoint, clientId: `workbench-mcp-${randomUUID()}`, clientType: "mcp", reconnect: { enabled: false },
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }),
    });
    await client.connect();
  }
  let timer;
  try {
    const result = await Promise.race([
      client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.orchestrate", { action, request: message.params.arguments, projectConfig, token }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("workbench_request_uncertain_retry_same_identity")), 55_000); }),
    ]);
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result?.ok === false };
  } finally { clearTimeout(timer); await client.close(); client = undefined; }
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let message;
  try {
    if (line.length > 1_048_576) throw new Error("request_too_large");
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = await handle(message);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : "workbench_failed" } }) + "\n");
  }
}
await client?.close();
