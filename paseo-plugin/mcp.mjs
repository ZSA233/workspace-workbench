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
const tools = [
  { name: "workbench_workspace_preview", description: "Preview an isolated Workspace handoff (read-only)." },
  { name: "workbench_workspace_execute", description: "Execute an approved isolated Workspace handoff." },
  { name: "workbench_workspace_status", description: "Read isolated Workspace handoff status." },
];
const schema = {
  type: "object",
  required: ["requestId", "handoff"],
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    workspaceId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    baseRefs: { type: "object", additionalProperties: { type: "string" } },
    handoff: {
      type: "object",
      required: ["goal"],
      properties: {
        goal: { type: "string", minLength: 1 },
        startMode: { enum: ["adaptive", "plan-first"] },
        decisions: { type: "array", items: { type: "string" } },
        inScope: { type: "array", items: { type: "string" } },
        outOfScope: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
        acceptance: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        ambiguities: { type: "array", items: { type: "string" } },
      },
    },
  },
};
let client;
async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "workspace-workbench", version: packageMetadata.version } };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: tools.map((tool) => ({ ...tool, inputSchema: schema, annotations: { readOnlyHint: tool.name !== "workbench_workspace_execute", destructiveHint: false } })) };
  if (message.method !== "tools/call") throw new Error("method_not_found");
  const tool = tools.find((value) => message.params?.name === value.name);
  const action = tool?.name.replace("workbench_workspace_", "");
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
