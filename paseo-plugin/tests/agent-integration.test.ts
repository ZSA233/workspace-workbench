import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext, PluginBeforeRequests } from "@getpaseo/plugin/server";
import { registerAgentIntegration } from "../server/agent-integration.ts";
import { withProject } from "../server/projects.ts";
import { readState, writeState } from "../server/orchestration-state.ts";
import { getAgentBinding, putAgentBinding } from "../server/agent-store.ts";
import { McpGatewayManager, setMcpGateway } from "../server/mcp-gateway.ts";

test("MCP binds exact identity; workers do not recurse; notifications steer and retry durably", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-injection-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo", bridge: { script: "mcp.mjs", endpoint: "127.0.0.1:6767", autoInject: true } } }));
  const previous = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const hooks = new Map<string, (input: unknown) => unknown>();
  const events = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const rpcHandlers = new Map<string, (input: unknown, context?: unknown) => unknown>();
  const server = { before: (name: string, handler: (input: unknown) => unknown) => { hooks.set(name, handler); return () => {}; }, on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { events.set(name, handler); return () => {}; }, handle: (contract: { name: string }, handler: (input: unknown) => unknown) => { rpcHandlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const cleanup = registerAgentIntegration(server);
  try {
    const request: PluginBeforeRequests["agent.create"] = { config: { provider: "codex", cwd: root, modeId: "auto", toolPolicy: { preapproved: [] } } };
    const injected = await hooks.get("agent.create")!({ request }) as typeof request;
    assert.deepEqual(injected.config.toolPolicy, request.config.toolPolicy);
    assert.equal(Object.hasOwn(injected.config, "systemPrompt"), false);
    // Preserve caller-owned prompts and mode/model settings without inserting
    // Workbench text into any provider setting, including on repeated creation.
    for (const provider of ["codex", "claude"]) {
      for (const planning of [true, false]) {
        const original = { ...request, config: { ...request.config, provider, model: "fixture",
          systemPrompt: "Caller instructions", featureValues: { plan_mode: planning },
          providerOptions: { custom: "preserved" } } };
        const once = await hooks.get("agent.create")!({ request: original }) as typeof original;
        const twice = await hooks.get("agent.create")!({ request: once }) as typeof original;
        for (const result of [once, twice]) {
          const { mcpServers: _mcp, ...settings } = result.config;
          assert.deepEqual(settings, original.config);
          assert.doesNotMatch(JSON.stringify(settings), /WORKBENCH_ORCHESTRATION/);
        }
      }
    }
    const bridge = injected.config.mcpServers?.["workspace-workbench"];
    assert.equal(bridge?.type, "http");
    assert.equal(bridge?.alwaysLoad, true);
    if (bridge?.type !== "http") throw new Error("missing bridge");
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:/);
    assert.match(bridge.headers?.Authorization || "", /Bearer/);
    const open = { agentId: "parent", cwd: root, purpose: "interactive", env: injected.env };
    await hooks.get("agent.session_open")!({ request: open });
    const contextRpc = rpcHandlers.get("workspace.workbench.agent_context");
    assert.ok(contextRpc);
    const liveContext = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { cwd: root, archivedAt: null } }) }) } } };
    assert.deepEqual(await contextRpc!({ projectConfig: config, agentId: "parent" }, liveContext), { ok: true, available: true, reason: "ready" });
    assert.deepEqual(await contextRpc!({ projectConfig: config, agentId: "not-injected" }, liveContext), { ok: true, available: false, reason: "not_injected" });
    const saved = withProject({ projectConfig: config }, () => readState<{ agentId: string }>(`context:${injected.env!.WORKBENCH_AGENT_TOKEN}`));
    assert.equal(saved?.agentId, "parent");
    const orchestrationRpc = rpcHandlers.get("workspace.workbench.orchestrate");
    assert.ok(orchestrationRpc);
    const currentToken = injected.env!.WORKBENCH_AGENT_TOKEN!;
    withProject({ projectConfig: config }, () => writeState(`context:${currentToken}`, { agentId: "parent", cwd: root, revoked: true }));
    const resumed = await orchestrationRpc!({ projectConfig: config, token: currentToken, action: "status", request: { requestId: "missing" } }, liveContext) as { error?: { code: string } };
    assert.equal(resumed.error?.code, "workflow_not_found", "a live resumed agent reaches the ordinary status lookup");
    assert.equal(withProject({ projectConfig: config }, () => readState<{ revoked: boolean }>(`context:${currentToken}`))?.revoked, false);
    withProject({ projectConfig: config }, () => writeState(`context:${currentToken}`, { agentId: "parent", cwd: root, revoked: true }));
    await hooks.get("agent.session_open")!({ request: open });
    assert.equal(withProject({ projectConfig: config }, () => readState<{ revoked: boolean }>(`context:${currentToken}`))?.revoked, undefined);
    const mismatched = await hooks.get("agent.session_open")!({ request: { ...open, agentId: "another" } });
    assert.deepEqual(mismatched, { ...open, agentId: "another" });
    const worker = { ...request, env: { WORKBENCH_WORKER_WORKSPACE: "sample" } };
    assert.deepEqual(await hooks.get("agent.create")!({ request: worker }), worker);
    withProject({ projectConfig: config }, () => putAgentBinding({ workspaceId: "fixture", agentId: "fixture-worker", relationship: "child", parentAgentId: "fixture-parent", paseoWorkspaceId: "paseo-fixture", cwd: root, provider: "codex/fixture", createdAt: "now", updatedAt: "now" }));
    let attempts = 0;
    const event = { agent: { id: "fixture-worker" }, turnId: "one", outcome: { kind: "completed" } };
    const context = { paseo: { agents: { ref: () => ({ send: async (_message: string, options: { activeTurnBehavior: string }) => {
      assert.equal(options.activeTurnBehavior, "steer");
      if (++attempts === 1) throw new Error("temporary delivery failure");
    } }) } } };
    await assert.rejects(events.get("agent.turn_ended")!(event, context), /temporary/);
    assert.equal(withProject({ projectConfig: config }, () => getAgentBinding("fixture"))?.pendingNotifications?.length, 1);
    await events.get("agent.turn_ended")!(event, context);
    await events.get("agent.turn_ended")!(event, context);
    assert.equal(attempts, 2);
    assert.equal(withProject({ projectConfig: config }, () => getAgentBinding("fixture"))?.pendingNotifications?.length, 0);
    withProject({ projectConfig: config }, () => putAgentBinding({ workspaceId: "independent-fixture", agentId: "independent-worker", relationship: "independent", requestedByAgentId: "fixture-parent", paseoWorkspaceId: "paseo-fixture", cwd: root, provider: "codex/fixture", createdAt: "now", updatedAt: "now" }));
    await events.get("agent.turn_ended")!({ agent: { id: "independent-worker" }, turnId: "independent", outcome: { kind: "completed" } }, context);
    assert.equal(attempts, 2, "independent sessions do not steer the requesting Agent");
    assert.equal(withProject({ projectConfig: config }, () => getAgentBinding("independent-fixture"))?.pendingNotifications?.length, 0);
  } finally {
    cleanup();
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Agent creation is not blocked when Paseo becomes temporarily unavailable", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-injection-deferred-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo", bridge: { script: "mcp.mjs", endpoint: "127.0.0.1:6767", autoInject: true } } }));
  const previousHome = process.env.PASEO_HOME;
  const home = mkdtempSync(join(tmpdir(), "workbench-injection-home-"));
  process.env.PASEO_HOME = home;
  const manager = new McpGatewayManager(join(process.cwd(), "mcp-gateway.mjs"), undefined,
    async () => ({ ok: false, stage: "endpoint", code: "workbench_paseo_endpoint_unavailable" }));
  setMcpGateway(manager);
  const previous = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const hooks = new Map<string, (input: unknown) => unknown>();
  const server = { before: (name: string, handler: (input: unknown) => unknown) => { hooks.set(name, handler); return () => {}; }, on: () => () => {}, handle: () => {} } as unknown as PluginServerContext;
  const cleanup = registerAgentIntegration(server);
  try {
    const request: PluginBeforeRequests["agent.create"] = { config: { provider: "codex", cwd: root, modeId: "auto", toolPolicy: { preapproved: [] } } };
    const started = Date.now();
    const injected = await hooks.get("agent.create")!({ request }) as typeof request;
    assert.ok(Date.now() - started < 2_000, "Agent creation must not wait for Paseo readiness");
    assert.equal(injected.config.mcpServers?.["workspace-workbench"]?.type, "http");
  } finally {
    cleanup();
    await manager.close();
    setMcpGateway(null);
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("registered projects need no bridge setup; old sessions acquire their own runtime MCP identity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-default-injection-")));
  const config = join(root, "project.json");
  const home = join(root, "paseo");
  const previous = { home: process.env.PASEO_HOME, config: process.env.WORKSPACE_WORKBENCH_CONFIG };
  process.env.PASEO_HOME = home;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const project = { sourceRoot: root, workspaceRoot: root, stateRoot: root };
  writeFileSync(config, JSON.stringify(project));
  const manager = new McpGatewayManager(join(import.meta.dirname, "..", "mcp-gateway.mjs"), undefined,
    async () => ({ ok: true, stage: "ready" }));
  setMcpGateway(manager);
  const hooks = new Map<string, (input: any) => Promise<any>>();
  const server = { before: (name: string, handler: (input: any) => Promise<any>) => { hooks.set(name, handler); return () => {}; }, on: () => () => {}, handle: () => {} } as unknown as PluginServerContext;
  const cleanup = registerAgentIntegration(server);
  try {
    const created = await hooks.get("agent.create")!({ request: { config: { provider: "codex", cwd: root, modeId: "plan" } } });
    assert.ok(created.env.WORKBENCH_AGENT_TOKEN, "new projects inject without an agent section");
    assert.equal(created.config.modeId, "plan");
    const unrelated = { type: "http", url: "http://127.0.0.1:1/mcp" };
    const open = { agentId: "old-session", cwd: root, purpose: "interactive", reason: "resume", env: { CUSTOM: "keep" }, mcpServers: { unrelated, "workspace-workbench": unrelated } };
    const restored = await hooks.get("agent.session_open")!({ request: open });
    const token = restored.env.WORKBENCH_AGENT_TOKEN;
    assert.ok(token);
    assert.notEqual(token, created.env.WORKBENCH_AGENT_TOKEN);
    assert.equal(restored.env.WORKBENCH_AGENT_ID, open.agentId);
    assert.equal(restored.env.CUSTOM, "keep");
    assert.deepEqual(restored.mcpServers.unrelated, unrelated);
    assert.deepEqual(restored.mcpServers["workspace-workbench"], unrelated);
    assert.equal(restored.mcpServers["workspace-workbench-session"].headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(withProject({ projectConfig: config }, () => readState(`context:${token}`)), { agentId: open.agentId, cwd: root });
    assert.deepEqual(withProject({ projectConfig: config }, () => readState(`session:${open.agentId}`)), { token });
    const resumed = await hooks.get("agent.session_open")!({ request: open });
    assert.equal(resumed.env.WORKBENCH_AGENT_TOKEN, token, "same Agent can recover its exact identity again");
    const other = await hooks.get("agent.session_open")!({ request: { ...open, agentId: "parallel-session" } });
    assert.notEqual(other.env.WORKBENCH_AGENT_TOKEN, token, "a shared cwd never shares authorship");
    const forged = { ...open, agentId: "parallel-session", env: { WORKBENCH_AGENT_TOKEN: token } };
    assert.deepEqual(await hooks.get("agent.session_open")!({ request: forged }), forged);
    for (const request of [
      { ...open, purpose: "history" },
      { ...open, env: { WORKBENCH_WORKER_WORKSPACE: "worker" } },
      { ...open, env: { WORKBENCH_REVIEW_ONLY: "1" } },
      { ...open, mcpServers: undefined, agentId: "old-host-session" },
    ]) assert.deepEqual(await hooks.get("agent.session_open")!({ request }), request);
    writeFileSync(config, JSON.stringify({ ...project, agent: { bridge: { autoInject: false } } }));
    assert.deepEqual(await hooks.get("agent.session_open")!({ request: open }), open);
    const disabledCreate = { config: { provider: "codex", cwd: root }, env: {} };
    assert.deepEqual(await hooks.get("agent.create")!({ request: disabledCreate }), disabledCreate);
  } finally {
    cleanup(); await manager.close(); setMcpGateway(null);
    if (previous.home === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous.home;
    if (previous.config === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous.config;
    rmSync(root, { recursive: true, force: true });
  }
});
