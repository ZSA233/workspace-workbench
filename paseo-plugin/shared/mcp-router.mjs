import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";
import { withMcpConnection } from "./mcp-connection.mjs";
import { coordinatorGuidance } from "./handoff-guidance.mjs";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json");
const materialTools = [
  { name: "workbench_handoff_read", description: "Read HANDOFF.md, SOURCES.md or a file segment from the assigned materials version. Fetch required sources before implementation." },
  { name: "workbench_handoff_search", description: "Search original documents and public conversation history, returning excerpts with source locations." },
  { name: "workbench_handoff_asset", description: "Fetch an original image or readable text asset from the assigned materials version." },
];
const publicTools = [
  ...materialTools,
  ...["status", "message", "history", "wait", "stop"].map(action => ({ name: `workbench_session_${action}`, description: ({ status: "Read the bound worker status and review phase.", message: "Send a supplement to the bound worker; requestId deduplicates delivery. Default steer; use interrupt only when explicitly requested.", history: "Read bounded public worker conversation history.", wait: "Wait at most 30 seconds for worker progress. Do not automatically loop.", stop: "Explicitly cancel the bound worker current turn and check its state." })[action] })),
  { name: "workbench_review_read", description: "Accept the assigned coordinator review and read its frozen material; do not edit." },
  { name: "workbench_review_result", description: "Submit the assigned coordinator review result, then end this turn." },
  { name: "workbench_artifact_register", description: "Register a handoff asset from a local path or image data." },
  { name: "workbench_workspace_preview", description: "Validate the canonical request and freeze handoff materials without Git changes. Check missing required sources before execute; retries reuse the same materials." },
  { name: "workbench_workspace_execute", description: "Run the saved preview; requestId alone is enough after preview. Full input remains accepted. Report success and end this turn." },
  { name: "workbench_workspace_status", description: "Read an uncertain Workspace handoff using its request ID (requestId); use operation_status for a Git operationId." },
  { name: "workbench_workspace_submit", description: "Submit an authorized task and original paths, then create or reuse its Workspace and start the worker without a separate preview." },
  { name: "workbench_workspace_create", description: "Create or reuse a Git Workspace only. This does not require an Agent, handoff, Reviewer or parent session." },
  { name: "workbench_workspace_add_repositories", description: "Add repositories to an existing flat managed Workspace without creating a new Workspace or Agent session." },
  { name: "workbench_workspace_operation_status", description: "Read the durable status of a Git Workspace creation operation by operationId." },
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
// An independent execution session needs the public coordinator tools while it
// is working, and it also needs the completion channel promised by its
// handoff. Keep that combination explicit instead of silently making the
// worker choose between implementation tools and execution_report.
const independentWorkerTools = [...publicTools, roleTools[0]];
function runtimeContext(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const role = overrides.role || env.WORKBENCH_ROLE ||
    (env.WORKBENCH_REVIEW_ONLY === "1" ? "reviewer" :
      env.WORKBENCH_EXECUTION_REPORT_ONLY === "1" ? "execution-report" :
        env.WORKBENCH_EXECUTION_REPORT === "1" ? "worker" : "interactive");
  return {
    endpoint: overrides.endpoint || env.WORKBENCH_PASEO_ENDPOINT,
    projectConfig: overrides.projectConfig || env.WORKBENCH_PROJECT_CONFIG,
    token: overrides.token || env.WORKBENCH_AGENT_TOKEN || env.WORKBENCH_REVIEW_TOKEN,
    role,
    reviewOnly: role === "reviewer" || env.WORKBENCH_REVIEW_ONLY === "1",
    executionReportOnly: role === "execution-report" || env.WORKBENCH_EXECUTION_REPORT_ONLY === "1",
    executionReport: role === "worker" || env.WORKBENCH_EXECUTION_REPORT === "1",
    workerWorkspace: overrides.workspaceId || env.WORKBENCH_WORKER_WORKSPACE,
    reviewWorkspace: env.WORKBENCH_REVIEW_WORKSPACE,
    reviewSession: env.WORKBENCH_REVIEW_SESSION,
    reviewAgent: env.WORKBENCH_REVIEW_AGENT,
    executionAgent: env.WORKBENCH_AGENT_ID,
  };
}

function toolsFor(runtime) {
  return runtime.reviewOnly
  ? [...roleTools.filter((tool) => tool.name === "workbench_reviewer_read" || tool.name === "workbench_reviewer_result"), ...materialTools]
  : runtime.executionReportOnly
  ? [...roleTools.filter((tool) => tool.name === "workbench_execution_report"), ...materialTools]
  : runtime.executionReport
  ? independentWorkerTools
  : publicTools;
}
const schema = {
  type: "object",
  required: ["requestId", "handoff"],
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    workspaceId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    sourceWorkspaceId: { type: "string", minLength: 1, description: "Selected read-only Gitlink Workspace to use as a nested workspace source." },
    branchName: { type: "string", minLength: 1, description: "One branch name for the outer repository and every child repository." },
    rootBaseRef: { type: "string", minLength: 1, description: "Outer repository ref; child defaults come from its pinned Gitlink commits." },
    baseRefs: { type: "object", additionalProperties: { type: "string" } },
    handoff: {
      type: "object",
      required: ["goal"],
      properties: {
        goal: { type: "string", minLength: 1 },
        context: { type: "object", additionalProperties: false, properties: Object.fromEntries(["understanding", "requirements", "preferences", "decisions", "rejectedAlternatives", "assumptions"].map(key => [key, { type: "array", maxItems: 100, items: { type: "object", required: ["text"], properties: { text: { type: "string" }, sources: { type: "array", items: { type: "string" } }, ...(["decisions", "rejectedAlternatives"].includes(key) ? { reason: { type: "string" } } : {}) } } }])) },
        startMode: { enum: ["adaptive", "plan-first"] },
        relationship: { enum: ["independent", "child"] },
        decisions: { type: "array", items: { type: "string" } },
        inScope: { type: "array", items: { type: "string" } },
        outOfScope: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
        acceptance: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        ambiguities: { type: "array", items: { type: "string" } },
        reviewPacket: {
          type: "object", additionalProperties: false,
          properties: {
            requirementUnderstanding: { type: "string" },
            plan: { type: "array", items: { type: "string" } },
            acceptanceCriteria: { type: "array", items: { type: "object", required: ["id", "text"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 }, required: { type: "boolean" } } } },
            references: { type: "array", items: { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, kind: { enum: ["file", "document", "prototype", "image", "pdf"] }, title: { type: "string" }, purpose: { type: "string" }, required: { type: "boolean" }, repositoryId: { type: "string" }, path: { type: "string" }, assetId: { type: "string" }, mimeType: { type: "string" } } } },
            instructions: { type: "string" },
          },
        },
      },
    },
  },
};
Object.assign(schema.properties.handoff.properties.reviewPacket.properties.references.items.properties, {
  reading: { type: "string", description: "Sections/pages to read and why this original source matters." },
  readableAlternativeIds: { type: "array", items: { type: "string" }, description: "For required PDFs, IDs of readable text or page images supplied alongside the original." },
});
const artifactRegisterSchema = {
  type: "object", required: ["artifact"], additionalProperties: false,
  properties: {
    artifact: {
      type: "object", required: ["title"], additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        purpose: { type: "string", minLength: 1 },
        kind: { enum: ["file", "document", "prototype", "image", "pdf"] },
        mimeType: { type: "string", minLength: 1 },
        data: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
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
const workspaceCreateSchema = {
  type: "object", required: ["name"], additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    sourceWorkspaceId: { type: "string", minLength: 1 },
    branchName: { type: "string", minLength: 1 },
    rootBaseRef: { type: "string", minLength: 1 },
    baseRefs: { type: "object", additionalProperties: { type: "string" } },
  },
};
const workspaceAddRepositoriesSchema = {
  type: "object", required: ["workspaceId", "repositories"], additionalProperties: false,
  properties: {
    workspaceId: { type: "string", minLength: 1 },
    repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    baseRefs: { type: "object", additionalProperties: { type: "string" } },
  },
};
const workspaceOperationStatusSchema = {
  type: "object", required: ["operationId"], additionalProperties: false,
  properties: { operationId: { type: "string", minLength: 1 } },
};
const workspaceSubmitSchema = {
  type: "object", required: ["task"], additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 }, repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    sourceWorkspaceId: { type: "string", minLength: 1, description: "Selected Gitlink Workspace source." },
    branchName: { type: "string", minLength: 1, description: "Shared outer and child branch name." },
    rootBaseRef: { type: "string", minLength: 1, description: "Outer repository base ref; children default to pinned commits." },
    baseRefs: { type: "object", additionalProperties: { type: "string" } }, task: { type: "string", minLength: 1 },
    originalPaths: { type: "array", maxItems: 128, items: { type: "string", minLength: 1 } },
    startMode: { enum: ["adaptive", "plan-first"] }, relationship: { enum: ["independent", "child"] },
  },
};
const workspaceExecuteSchema = { ...schema, required: ["requestId"], properties: { ...schema.properties, workspaceId: { type: "string", minLength: 1 } } };
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
        criterionChecks: { type: "array", items: { type: "object", required: ["id", "status"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "not_verifiable"] }, evidence: { type: "string" } } } },
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
        materialsVersion: { type: "integer", minimum: 1 },
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
const sessionSchema = { type: "object", required: ["workspaceId"], additionalProperties: false, properties: {
  workspaceId: { type: "string", minLength: 1 }, requestId: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1, maxLength: 32768 },
  behavior: { enum: ["steer", "interrupt"] }, attachments: schema.properties.handoff.properties.reviewPacket.properties.references,
  limit: { type: "integer", minimum: 1, maximum: 100 }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 },
  cursor: { type: "object", required: ["epoch", "seq"], properties: { epoch: { type: "string" }, seq: { type: "integer" } } },
} };
function extraSchema(name) {
  if (name.startsWith("workbench_handoff_")) return { type: "object", additionalProperties: false, required: name.endsWith("_search") ? ["query"] : name.endsWith("_asset") ? ["sourceId"] : [], properties: {
    workspaceId: { type: "string" }, bundle: { type: "object", required: ["id", "version"], properties: { id: { type: "string" }, version: { type: "integer", minimum: 1 } } },
    ...(name.endsWith("_read") ? { file: { type: "string", description: "Default HANDOFF.md; SOURCES.md lists original sources; environment.json is the execution receipt." } } : {}),
    offset: { type: "integer", minimum: 0 }, ...(name.endsWith("_search") ? { query: { type: "string", minLength: 1 } } : {}), ...(name.endsWith("_asset") ? { sourceId: { type: "string" } } : {}),
  } };
  if (name.startsWith("workbench_session_")) {
    const action = name.split("_").at(-1);
    const fields = ["workspaceId", ...({ message: ["requestId", "text", "behavior", "attachments"], history: ["limit", "cursor"], wait: ["timeoutMs"] }[action] || [])];
    return { ...sessionSchema, properties: Object.fromEntries(fields.map(field => [field, sessionSchema.properties[field]])), required: action === "message" ? ["workspaceId", "requestId", "text"] : ["workspaceId"] };
  }
  if (name === "workbench_review_read" || name === "workbench_review_result") return { type: "object", additionalProperties: false,
    required: ["workspaceId", "sessionId", "round", "assignmentId", ...(name.endsWith("_result") ? ["result"] : [])],
    properties: { workspaceId: { type: "string" }, sessionId: { type: "string" }, assignmentId: { type: "string" }, round: { type: "integer", minimum: 1 }, ...(name.endsWith("_result") ? reviewerResultSchema.properties : {}) } };
  return null;
}
const reviewerActions = new Map([
  ["workbench_reviewer_read", "reviewer_read"],
  ["workbench_reviewer_result", "reviewer_result"],
]);
function callArguments(message) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const candidate = params.arguments ?? params.args ?? params.input;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const { name: _name, arguments: _arguments, args: _args, input: _input, ...direct } = params;
  return direct;
}
function toolInputSchema(name) {
  return extraSchema(name) || (name === "workbench_artifact_register" ? artifactRegisterSchema
    : name === "workbench_reviewer_read" ? reviewerReadSchema
    : name === "workbench_reviewer_result" ? reviewerResultSchema
    : name === "workbench_execution_report" ? executionReportSchema
    : name === "workbench_review_execute" ? reviewExecuteSchema
    : name === "workbench_workspace_status" ? workspaceStatusSchema
    : name === "workbench_workspace_operation_status" ? workspaceOperationStatusSchema
    : name === "workbench_workspace_create" ? workspaceCreateSchema
    : name === "workbench_workspace_add_repositories" ? workspaceAddRepositoriesSchema
    : name === "workbench_workspace_submit" ? workspaceSubmitSchema
    : name === "workbench_workspace_execute" ? workspaceExecuteSchema
    : name.startsWith("workbench_workspace_") ? schema
    : reviewContextSchema);
}

function toolDescriptor(tool) {
  return {
    ...tool,
    inputSchema: toolInputSchema(tool.name),
    annotations: {
    readOnlyHint: !["workbench_workspace_preview", "workbench_workspace_submit", "workbench_workspace_create", "workbench_workspace_add_repositories", "workbench_session_message", "workbench_session_stop", "workbench_review_read", "workbench_review_result", "workbench_artifact_register", "workbench_workspace_execute", "workbench_review_execute", "workbench_review_stop", "workbench_review_resume", "workbench_reviewer_result", "workbench_execution_report"].includes(tool.name),
      destructiveHint: tool.name === "workbench_session_stop",
    },
  };
}

export function toolCatalog(overrides = {}) {
  return toolsFor(runtimeContext(overrides)).map(toolDescriptor);
}

function callContext(runtime, args) {
  return {
    projectConfig: runtime.projectConfig,
    token: runtime.token,
    workspaceId: args.workspaceId || runtime.workerWorkspace || runtime.reviewWorkspace,
    sessionId: args.sessionId || runtime.reviewSession,
    reviewerAgentId: args.reviewerAgentId || runtime.reviewAgent || "pending",
    executionAgentId: args.executionAgentId || runtime.executionAgent || "pending",
  };
}

export async function handle(message, lifecycle = {}, overrides = {}) {
  const runtime = runtimeContext(overrides);
  const tools = toolsFor(runtime);
  if (message.method === "initialize") return {
    protocolVersion: message.params?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "workspace-workbench", version: packageMetadata.version },
    ...(!runtime.reviewOnly && !runtime.executionReportOnly && !runtime.executionReport ? { instructions: coordinatorGuidance } : {}),
  };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools: tools.map(toolDescriptor) };
  if (message.method !== "tools/call") throw new Error("method_not_found");
  const tool = tools.find((value) => message.params?.name === value.name);
  const args = callArguments(message);
  const action = tool?.name === "workbench_artifact_register" ? "artifact_register" : tool?.name === "workbench_execution_report" ? "execution_report" : tool ? reviewerActions.get(tool.name) || tool.name.replace("workbench_workspace_", "") : null;
  const reviewerAction = action === "reviewer_read" || action === "reviewer_result";
  const materialAction = Boolean(tool?.name.startsWith("workbench_handoff_"));
  const reviewTool = Boolean(tool && reviewToolNames.has(tool.name));
  const extra = tool && extraSchema(tool.name);
  const directWorkspaceAction = tool?.name === "workbench_workspace_create" || tool?.name === "workbench_workspace_add_repositories" || tool?.name === "workbench_workspace_operation_status";
  if (tool?.name === "workbench_workspace_status" && typeof args.requestId !== "string") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "workspace_status_request_id_required", message: "workbench_workspace_status requires the requestId returned by workspace_submit, preview, or execute; use workbench_workspace_operation_status with operationId for Git creation status." } }) }], isError: true };
  }
  const needsToken = !directWorkspaceAction && !runtime.token;
  if ((!action && !reviewTool && !extra) || !runtime.endpoint || !runtime.projectConfig || needsToken) throw new Error("workbench_context_unavailable");
  const sockets = new Set();
  const client = new DaemonClient({ url: runtime.endpoint, clientId: `workbench-mcp-${randomUUID()}`, clientType: "mcp", reconnect: { enabled: false },
    webSocketFactory: (url, options) => {
      const socket = new WebSocket(url, options?.protocols, { headers: options?.headers });
      sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      return socket;
    },
  });
  if (action === "submit" && typeof args.task !== "string") throw new Error("workbench_submit_task_missing");
  const context = callContext(runtime, args);
  const result = await withMcpConnection(client, () => (
      directWorkspaceAction
        ? client.invokePluginRpc("workspace-workbench-paseo", tool.name === "workbench_workspace_create"
          ? "workspace.workbench.workspace-create"
          : tool.name === "workbench_workspace_add_repositories"
            ? "workspace.workbench.workspace-add-repositories"
            : "workspace.workbench.workspace-operation-status", { ...args, projectConfig: runtime.projectConfig })
        : materialAction
        ? client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.handoff-materials", { ...args, ...context, action: tool.name.split("_").at(-1) })
        : extra
        ? client.invokePluginRpc("workspace-workbench-paseo", tool.name.startsWith("workbench_session_") ? "workspace.workbench.session" : "workspace.workbench.coordinator-review", { ...args, ...context, action: tool.name.split("_").at(-1) })
        : reviewerAction
        ? client.invokePluginRpc("workspace-workbench-paseo", action === "reviewer_read" ? "workspace.workbench.agent-review.reviewer-read" : "workspace.workbench.agent-review.reviewer-result", { ...args, ...context })
        : action === "artifact_register"
          ? client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.artifact.register", { ...args, ...context })
        : action === "execution_report"
          ? client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.execution-report", { ...args, ...context })
        : reviewTool
          ? (() => {
              const reviewContext = { ...args, ...context };
              if (tool.name === "workbench_review_preview") return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.preview", reviewContext);
              if (tool.name === "workbench_review_status") return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.session", reviewContext);
              const controlAction = tool.name === "workbench_review_stop" ? "stop" : tool.name === "workbench_review_resume" ? "resume" : args.action === "start" ? null : args.action;
              if (!controlAction) return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.start", reviewContext);
              return client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.control", { ...reviewContext, action: controlAction });
            })()
          : client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.orchestrate", { action, request: action === "submit" && !args.requestId ? { ...args, requestId: randomUUID() } : args, projectConfig: runtime.projectConfig, token: runtime.token })
  ), { ...lifecycle, forceClose: () => { for (const socket of sockets) socket.terminate(); sockets.clear(); } });
  if (materialAction && result?.image) {
    const { image, ...metadata } = result;
    return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", data: image.data, mimeType: image.mimeType }], isError: false };
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result?.ok === false };
}
