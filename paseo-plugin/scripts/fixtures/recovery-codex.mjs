/** Deterministic local Codex app-server protocol fixture. Never calls a model. */
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) { console.log("codex-cli 0.161.0"); process.exit(0); }
const root = process.env.WORKBENCH_RECOVERY_FIXTURE_ROOT;
if (!root) throw new Error("isolated_fixture_root_required");
mkdirSync(root, { recursive: true });
const models = [{ id: "recovery-fixture", model: "recovery-fixture", displayName: "Recovery fixture", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }];
if (process.env.WORKBENCH_RECOVERY_FIXTURE_SUCCEED === '1') models.push({ ...models[0], id: 'topic-alternate', model: 'topic-alternate', displayName: 'Topic analysis fixture', isDefault: false,
  supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}] });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const save = thread => writeFileSync(join(root, `${thread.id}.json`), JSON.stringify(thread));
const read = id => JSON.parse(readFileSync(join(root, `${id}.json`), "utf8"));
let current;
function captureMcp(method, params) {
  if (process.env.WORKBENCH_MCP_IDENTITY_FIXTURE !== '1' || method === 'thread/read') return false;
  const servers = params.config?.mcp_servers || {};
  const bridge = servers['workspace-workbench-session'] || servers['workspace-workbench'];
  const authorization = bridge?.http_headers?.Authorization;
  (current.mcpLaunches ||= []).push({ method, agentId: process.env.WORKBENCH_AGENT_ID || null,
    serverNames: Object.keys(servers), hasIdentity: Boolean(authorization),
    tokenMatchesEnvironment: Boolean(authorization) && authorization === `Bearer ${process.env.WORKBENCH_AGENT_TOKEN}`,
    authorizationDigest: authorization ? createHash('sha256').update(authorization).digest('hex') : null,
  });
  return true;
}
const workflow=()=>current?.creationOptions?.sandbox==='danger-full-access'
  ?{approvalPolicy:current.creationOptions.approvalPolicy,sandbox:{type:'dangerFullAccess'}}
  :{approvalPolicy:'on-request',sandbox:{type:'workspaceWrite',writableRoots:[current?.cwd]}};
createInterface({ input: process.stdin }).on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  const { id, method, params = {} } = request;
  const reply = result => send({ jsonrpc: "2.0", id, result });
  try {
    if (method === "initialize") return reply({ userAgent: "codex-cli/0.161.0", platformFamily: "unix", platformOs: "macos" });
    if (method === "model/list") return reply({ data: models, nextCursor: null });
    if (method === "account/read") return reply({ account: { type: "chatgpt", email: "fixture@example.invalid", planType: "plus" }, requiresOpenaiAuth: false });
    if (method === "account/rateLimits/read") return reply({ rateLimits: null });
    if (method === "config/read") return reply({ config: { model: "recovery-fixture", model_reasoning_effort: "low" } });
    if (method === "collaborationMode/list") return reply({ data: [{ name: "Code", mode: "default", model: "recovery-fixture" }, { name: "Plan", mode: "plan", model: "recovery-fixture" }] });
    if (method === "skills/list") return reply({ data: [], errors: [] });
    if (method === "thread/list") return reply({ data: [], nextCursor: null });
    if (method === "thread/loaded/list") return reply({ data: current ? [current.id] : [] });
    if (method === "thread/start") {
      current = { id: randomUUID(), cwd: params.cwd, modelProvider: "openai", createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), turns: [], status: { type: "idle" } };
      if (process.env.WORKBENCH_RECOVERY_FIXTURE_SUCCEED === '1') {
        current.requestedModel = params.model;
        current.creationOptions={approvalPolicy:params.approvalPolicy,sandbox:params.sandbox};
      }
      captureMcp(method, params); save(current); return reply({ thread: current, model: current.requestedModel || "recovery-fixture", ...workflow() });
    }
    if (method === "thread/read" || method === "thread/resume") {
      current = read(params.threadId); if (captureMcp(method, params)) save(current); return reply({ thread: current, model: current.requestedModel || "recovery-fixture", ...workflow() });
    }
    if (method === "turn/start") {
      current = read(params.threadId);
      const text = (params.input || []).filter(item => item.type === "text").map(item => item.text).join("\n");
      if (!current.scenario) current.scenario = text;
      const turn = { id: randomUUID(), items: params.input?.length ? [{ id: randomUUID(), type: "userMessage", content:
        process.env.WORKBENCH_RECOVERY_FIXTURE_SUCCEED === '1' ? params.input : [{ type: "text", text }] }] : [], status: "inProgress", error: null };
      current.inputs ||= []; current.inputs.push(params.input || []);
      if(process.env.WORKBENCH_RECOVERY_FIXTURE_SUCCEED === '1'){
        current.turnOptions ||= [];current.turnOptions.push({effort:params.effort,approvalPolicy:params.approvalPolicy,sandboxPolicy:params.sandboxPolicy});
      }
      current.turns.push(turn); save(current); reply({ turn });
      setTimeout(() => notify("turn/started", { threadId: current.id, turn }), 25);
      setTimeout(() => {
        const failing = process.env.WORKBENCH_RECOVERY_FIXTURE_SUCCEED !== '1' && !text.includes("MANUAL_CONTINUE") && (current.scenario.includes("ALWAYS_CAPACITY") || current.scenario.includes("QUOTA") || current.turns.length === 1);
        if (failing) {
          turn.status = "failed";
          turn.error = { message: current.scenario.includes("QUOTA") ? "Quota exceeded. Check your plan and billing details." : current.scenario.includes("NETWORK") ? "stream disconnected before completion: connection reset by peer" : "Selected model is at capacity. Please try a different model.", codexErrorInfo: current.scenario.includes("QUOTA") ? "usageLimitExceeded" : "serverOverloaded" };
        } else {
          const item = { id: randomUUID(), type: "agentMessage", text: "RECOVERY_FIXTURE_COMPLETED", phase: "final_answer" };
          turn.items.push(item); notify("item/started", { threadId: current.id, turnId: turn.id, item }); notify("item/completed", { threadId: current.id, turnId: turn.id, item });
          turn.status = "completed";
        }
        current.status = { type: "idle" }; save(current); notify("turn/completed", { threadId: current.id, turn });
      }, 180);
      return;
    }
    if (method === "turn/interrupt") return reply({});
    reply({});
  } catch (error) { send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } }); }
});
