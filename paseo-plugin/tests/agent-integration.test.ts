import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext, PluginBeforeRequests } from "@getpaseo/plugin/server";
import { registerAgentIntegration } from "../server/agent-integration.ts";
import { withProject } from "../server/projects.ts";
import { readState } from "../server/orchestration-state.ts";
import { getAgentBinding, putAgentBinding } from "../server/agent-store.ts";

test("MCP binds exact identity; workers do not recurse; notifications steer and retry durably", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-injection-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo", bridge: { script: "mcp.mjs", endpoint: "127.0.0.1:6767" } } }));
  const previous = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const hooks = new Map<string, (input: unknown) => unknown>();
  const events = new Map<string, (event: unknown, context: unknown) => Promise<void>>();
  const rpcHandlers = new Map<string, (input: unknown) => unknown>();
  const server = { before: (name: string, handler: (input: unknown) => unknown) => { hooks.set(name, handler); return () => {}; }, on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => { events.set(name, handler); return () => {}; }, handle: (contract: { name: string }, handler: (input: unknown) => unknown) => { rpcHandlers.set(contract.name, handler); } } as unknown as PluginServerContext;
  const cleanup = registerAgentIntegration(server);
  try {
    const request: PluginBeforeRequests["agent.create"] = { config: { provider: "codex", cwd: root, modeId: "auto", toolPolicy: { preapproved: [] } } };
    const injected = hooks.get("agent.create")!({ request }) as typeof request;
    assert.deepEqual(injected.config.toolPolicy, request.config.toolPolicy);
    const bridge = injected.config.mcpServers?.["workspace-workbench"];
    assert.equal(bridge?.type, "stdio");
    assert.equal(bridge?.alwaysLoad, true);
    if (bridge?.type !== "stdio") throw new Error("missing bridge");
    assert.equal(bridge.env?.WORKBENCH_AGENT_TOKEN, injected.env?.WORKBENCH_AGENT_TOKEN);
    const open = { agentId: "parent", cwd: root, purpose: "interactive", env: injected.env };
    hooks.get("agent.session_open")!({ request: open });
    const contextRpc = rpcHandlers.get("workspace.workbench.agent_context");
    assert.ok(contextRpc);
    assert.deepEqual(await contextRpc!({ projectConfig: config, agentId: "parent" }), { ok: true, available: true, reason: "ready" });
    assert.deepEqual(await contextRpc!({ projectConfig: config, agentId: "not-injected" }), { ok: true, available: false, reason: "not_injected" });
    const saved = withProject({ projectConfig: config }, () => readState<{ agentId: string }>(`context:${injected.env!.WORKBENCH_AGENT_TOKEN}`));
    assert.equal(saved?.agentId, "parent");
    assert.throws(() => hooks.get("agent.session_open")!({ request: { ...open, agentId: "another" } }), /context_changed/);
    const worker = { ...request, env: { WORKBENCH_WORKER_WORKSPACE: "sample" } };
    assert.equal(hooks.get("agent.create")!({ request: worker }), worker);
    withProject({ projectConfig: config }, () => putAgentBinding({ workspaceId: "fixture", agentId: "fixture-worker", parentAgentId: "fixture-parent", paseoWorkspaceId: "paseo-fixture", cwd: root, provider: "codex/fixture", createdAt: "now", updatedAt: "now" }));
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
  } finally {
    cleanup();
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
