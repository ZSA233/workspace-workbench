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
const publicTools = [
  { name: "workbench_workspace_preview", description: "Preview an isolated Workspace handoff (read-only)." },
  { name: "workbench_workspace_execute", description: "Execute an approved isolated Workspace handoff." },
  { name: "workbench_workspace_status", description: "Read isolated Workspace handoff status." },
  { name: "workbench_review_preview", description: "Preview review context without starting a Reviewer." },
  { name: "workbench_review_execute", description: "Start or continue the Workspace Agent Review orchestration." },
  { name: "workbench_review_status", description: "Read the current and historical Agent Review status." },
  { name: "workbench_review_stop", description: "Stop the active Agent Review flow." },
  { name: "workbench_review_resume", description: "Resume a stopped or blocked Agent Review flow." },
];
const roleTools = [
  { name: "workbench_execution_report", description: "Report an execution turn ready for review." },
  { name: "workbench_reviewer_read", description: "Read the review snapshot through the read-only Reviewer boundary." },
  { name: "workbench_reviewer_result", description: "Submit a structured Reviewer result for the current snapshot." },
];
const tools = process.env.WORKBENCH_REVIEW_ONLY === "1"
  ? roleTools.filter((tool) => tool.name === "workbench_reviewer_read" || tool.name === "workbench_reviewer_result")
  : process.env.WORKBENCH_EXECUTION_REPORT_ONLY === "1"
  ? roleTools.filter((tool) => tool.name === "workbench_execution_report")
  : publicTools;
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
        relationship: { enum: ["independent", "child"] },
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
const workspaceStatusSchema = {
  type: "object",
  required: ["requestId"],
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    workspaceId: { type: "string", minLength: 1 },
  },
};
const reviewerReadSchema = {
  type: "object", additionalProperties: false, properties: {},
};
const reviewerResultSchema = {
  type: "object", required: ["result"], additionalProperties: false,
  properties: {
    result: {
      type: "object", required: ["verdict", "summary", "findings", "checks", "unreviewed", "snapshotId", "diffId"], additionalProperties: false,
      properties: {
        verdict: { enum: ["approved", "changes_requested", "blocked"] },
        summary: { type: "string", minLength: 1 },
        findings: { type: "array", items: { type: "object", required: ["id", "severity", "repositoryId", "path", "message", "needsFix"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, severity: { enum: ["info", "warning", "error"] }, repositoryId: { type: "string", minLength: 1 }, path: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 }, side: { enum: ["old", "new"] }, message: { type: "string", minLength: 1 }, suggestion: { type: "string" }, needsFix: { type: "boolean" } } } },
        checks: { type: "array", items: { type: "object", required: ["name", "status"], additionalProperties: false, properties: { name: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "not_run", "unavailable"] }, evidence: { type: "string" } } } },
        unreviewed: { type: "array", items: { type: "string" } },
        snapshotId: { type: "string", minLength: 1 },
        diffId: { type: "string", minLength: 1 },
        resultId: { type: "string", minLength: 1 },
      },
    },
  },
};
const executionReportSchema = {
  type: "object", required: ["report"], additionalProperties: false,
  properties: {
    turnId: { type: "string", minLength: 1 },
    report: {
      type: "object", required: ["status", "summary"], additionalProperties: false,
      properties: {
        status: { enum: ["ready_for_review", "needs_input", "failed"] },
        summary: { type: "string", minLength: 1 },
        changes: { type: "array", items: { type: "string" } },
        tests: { type: "array", items: { type: "string" } },
        knownLimitations: { type: "array", items: { type: "string" } },
        handoffId: { type: "string", minLength: 1 },
      },
    },
  },
};
const reviewContextSchema = {
  type: "object", required: ["workspaceId"], additionalProperties: false,
  properties: { workspaceId: { type: "string", minLength: 1 }, sessionId: { type: "string", minLength: 1 }, executionAgentId: { type: "string", minLength: 1 } },
};
const reviewExecuteSchema = {
  type: "object", required: ["workspaceId", "action"], additionalProperties: false,
  properties: { workspaceId: { type: "string", minLength: 1 }, sessionId: { type: "string", minLength: 1 }, executionAgentId: { type: "string", minLength: 1 }, action: { enum: ["start", "review", "repair", "resume"] } },
};
const reviewToolNames = new Set(["workbench_review_preview", "workbench_review_execute", "workbench_review_status", "workbench_review_stop", "workbench_review_resume"]);
const reviewerActions = new Map([
  ["workbench_reviewer_read", "reviewer_read"],
  ["workbench_reviewer_result", "reviewer_result"],
]);
let client;
async function handle(message) {
  if (message.method === "initialize") return { protocolVersion: message.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "workspace-workbench", version: packageMetadata.version } };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: tools.map((tool) => ({ ...tool, inputSchema: tool.name === "workbench_reviewer_read" ? reviewerReadSchema : tool.name === "workbench_reviewer_result" ? reviewerResultSchema : tool.name === "workbench_execution_report" ? executionReportSchema : tool.name === "workbench_review_execute" ? reviewExecuteSchema : tool.name === "workbench_workspace_status" ? workspaceStatusSchema : tool.name.startsWith("workbench_workspace_") ? schema : reviewContextSchema, annotations: { readOnlyHint: !["workbench_workspace_execute", "workbench_review_execute", "workbench_review_stop", "workbench_review_resume", "workbench_reviewer_result", "workbench_execution_report"].includes(tool.name), destructiveHint: false } })) };
  if (message.method !== "tools/call") throw new Error("method_not_found");
  const tool = tools.find((value) => message.params?.name === value.name);
  const action = tool?.name === "workbench_execution_report" ? "execution_report" : tool ? reviewerActions.get(tool.name) || tool.name.replace("workbench_workspace_", "") : null;
  const reviewerAction = action === "reviewer_read" || action === "reviewer_result";
  const reviewTool = Boolean(tool && reviewToolNames.has(tool.name));
  if ((!action && !reviewTool) || !endpoint || !projectConfig || (reviewerAction ? !process.env.WORKBENCH_REVIEW_TOKEN : !token)) throw new Error("workbench_context_unavailable");
  {
    client = new DaemonClient({ url: endpoint, clientId: `workbench-mcp-${randomUUID()}`, clientType: "mcp", reconnect: { enabled: false },
      webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }),
    });
    await client.connect();
  }
  let timer;
  try {
    const result = await Promise.race([
      reviewerAction
        ? client.invokePluginRpc("workspace-workbench-paseo", action === "reviewer_read" ? "workspace.workbench.agent-review.reviewer-read" : "workspace.workbench.agent-review.reviewer-result", {
            ...message.params.arguments,
            projectConfig,
            workspaceId: message.params.arguments?.workspaceId || process.env.WORKBENCH_REVIEW_WORKSPACE,
            sessionId: message.params.arguments?.sessionId || process.env.WORKBENCH_REVIEW_SESSION,
            reviewerAgentId: message.params.arguments?.reviewerAgentId || process.env.WORKBENCH_REVIEW_AGENT || "pending",
            token: process.env.WORKBENCH_REVIEW_TOKEN,
          })
        : action === "execution_report"
          ? client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.execution-report", {
              ...message.params.arguments,
              projectConfig,
            workspaceId: message.params.arguments?.workspaceId || process.env.WORKBENCH_WORKER_WORKSPACE || process.env.WORKBENCH_REVIEW_WORKSPACE,
              executionAgentId: message.params.arguments?.executionAgentId || process.env.WORKBENCH_AGENT_ID || "pending",
              token,
            })
        : reviewTool
          ? (() => {
              const args = message.params.arguments || {};
              const context = { ...args, projectConfig, workspaceId: args.workspaceId || process.env.WORKBENCH_WORKER_WORKSPACE || process.env.WORKBENCH_REVIEW_WORKSPACE, token };
              if (tool.name === "workbench_review_preview") return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.preview", context);
              if (tool.name === "workbench_review_status") return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.session", context);
              const controlAction = tool.name === "workbench_review_stop" ? "stop" : tool.name === "workbench_review_resume" ? "resume" : args.action === "start" ? null : args.action;
              if (!controlAction) return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.start", context);
              return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.control", { ...context, action: controlAction });
            })()
          : client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.orchestrate", { action, request: message.params.arguments, projectConfig, token }),
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
