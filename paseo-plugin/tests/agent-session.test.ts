import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { handleAgentDelegate } from "../server/agent-provider.ts";
import { handleAgentSessionSettingsGet, handleAgentSessionSettingsUpdate, resolveAgentPermissionMode, resolveAgentRelationship } from "../server/agent-session.ts";
import { getAgentBinding, putAgentBinding } from "../server/agent-store.ts";
import { withProject } from "../server/projects.ts";
import { handoffSchema } from "../shared/handoff.ts";

function configFixture(root: string): string {
  const path = join(root, "project.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    project: { id: "fixture", displayName: "Fixture" },
    sourceRoot: root,
    workspaceRoot: join(root, "workspaces"),
    stateRoot: join(root, "state"),
    repositories: [{ id: "fixture", path: ".", enabled: true }],
    agent: { provider: "paseo", bridge: { script: "mcp.mjs", endpoint: "127.0.0.1:6789" } },
  }));
  return path;
}

test("agent session settings resolve project provider overrides over global defaults", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-agent-session-settings-"));
  const config = configFixture(root);
  const previous = process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = join(root, "settings.json");
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  try {
    await withProject({ projectConfig: config }, async () => {
      const initial = await handleAgentSessionSettingsGet();
      assert.equal(initial.effective.defaultRelationship, "independent");
      assert.equal(initial.effective.permissionMode, "inherit");
      await handleAgentSessionSettingsUpdate({ scope: "global", patch: { defaultRelationship: "child", permissionMode: "full-access", providerRelationships: { codex: "child" } }, resetFields: [] });
      await handleAgentSessionSettingsUpdate({ scope: "project", patch: { defaultRelationship: "independent", permissionMode: "auto", providerRelationships: { fixture: "child" } }, resetFields: [] });
      assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).agent.session, { defaultRelationship: "independent", permissionMode: "auto", providerRelationships: { fixture: "child" } });
      const resolved = await handleAgentSessionSettingsGet();
      assert.equal(resolved.effective.defaultRelationship, "independent");
      assert.equal(resolved.effective.permissionMode, "auto");
      assert.equal(resolveAgentRelationship("codex/model"), "child");
      assert.equal(resolveAgentRelationship("fixture/model"), "child");
      assert.equal(resolveAgentRelationship("other/model"), "independent");
      assert.equal(resolveAgentPermissionMode(), "auto");
      await handleAgentSessionSettingsUpdate({ scope: "project", patch: {}, resetFields: ["providerRelationships"] });
      assert.equal(resolveAgentRelationship("fixture/model"), "independent");
      await handleAgentSessionSettingsUpdate({ scope: "project", patch: {}, resetFields: ["permissionMode"] });
      assert.equal(resolveAgentPermissionMode(), "full-access");
      await handleAgentSessionSettingsUpdate({ scope: "project", patch: {}, resetFields: ["defaultRelationship"] });
      assert.equal(resolveAgentRelationship("other/model"), "child");
    });
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
    else process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = previous;
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Agent bindings remain child sessions and upgrade on the next write", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-agent-binding-legacy-"));
  const previous = process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
  const path = join(directory, "bindings.json");
  process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = path;
  try {
    writeFileSync(path, JSON.stringify({ schemaVersion: "workspace.workbench.agent-bindings/v1", bindings: [{ workspaceId: "sample", agentId: "worker", parentAgentId: "parent", paseoWorkspaceId: "paseo", cwd: "/fixture/tree", provider: "codex/fixture", createdAt: "now", updatedAt: "now" }] }));
    const legacy = getAgentBinding("sample");
    assert.equal(legacy?.relationship, "child");
    assert.equal(legacy?.parentAgentId, "parent");
    putAgentBinding({ ...legacy!, status: "idle" });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, "workspace.workbench.agent-bindings/v2");
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
    else process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

function parentAgent(currentModeId: "auto" | "full-access" = "auto") {
  return {
    id: "parent",
    cwd: "/fixture/source",
    provider: "codex",
    model: "fixture",
    currentModeId,
    availableModes: [{ id: "auto" }, { id: "full-access" }],
    features: [{ id: "plan_mode", type: "toggle", value: false }],
    pendingPermissions: [],
  };
}

test("default execution creates an independent Agent without a parent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-agent-session-create-"));
  const previous = process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  const config = configFixture(directory);
  process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = join(directory, "bindings.json");
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const creates: Array<Record<string, unknown>> = [];
  const worker = { id: "worker", cwd: "/fixture/tree", workspaceId: "paseo", status: "idle", provider: "codex", model: "fixture", features: parentAgent().features, labels: {} };
  const paseo = {
    agents: {
      ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parentAgent() : worker }), send: async () => {} }),
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    },
    workspaces: {
      open: async () => ({ id: "paseo", agents: { create: async (options: Record<string, unknown>) => { creates.push(options); return { id: worker.id, current: () => worker, send: async () => {} }; } } }),
    },
  } as unknown as PaseoApi;
  try {
    const result = await withProject({ projectConfig: config }, () => handleAgentDelegate({ workspaceId: "sample", parentAgentId: "parent", handoff: handoffSchema.parse({ goal: "Execute fixture" }) }, { paseo, query: async () => ({ ok: true, result: { workspaceId: "sample", managed: true, treePath: "/fixture/tree", capabilities: { agent: true } } }) }));
    assert.equal(result.ok, true);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].parent, undefined);
    assert.equal((creates[0].config as { modeId: string }).modeId, "auto");
    assert.equal((creates[0].labels as Record<string, string>)["workspace-workbench.relationship"], "independent");
    assert.equal((creates[0].labels as Record<string, string>)["workspace-workbench.parent"], undefined);
    const independentConfig = creates[0].config as { mcpServers: Record<string, { type?: string; headers?: Record<string, string> }>; toolPolicy: { preapproved: Array<{ server: string; tool: string }> } };
    assert.ok(independentConfig.mcpServers["workspace-workbench"]);
    assert.equal(independentConfig.mcpServers["workspace-workbench-report"], undefined);
    assert.equal(independentConfig.mcpServers["workspace-workbench"].type, "http");
    assert.equal(independentConfig.mcpServers["workspace-workbench"].headers?.["X-Workbench-Role"], "worker");
    assert.equal((creates[0].env as Record<string, string>).WORKBENCH_EXECUTION_REPORT_ONLY, undefined);
    assert.equal((creates[0].env as Record<string, string>).WORKBENCH_EXECUTION_REPORT, "1");
    assert.ok(independentConfig.toolPolicy.preapproved.some((grant) => grant.server === "workspace-workbench" && grant.tool === "workbench_workspace_submit"));
    assert.ok(independentConfig.toolPolicy.preapproved.some((grant) => grant.server === "workspace-workbench" && grant.tool === "workbench_execution_report"));
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
    else process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = previous;
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit child relationship keeps the Paseo parent link", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-agent-session-child-"));
  const previous = process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = join(directory, "bindings.json");
  process.env.WORKSPACE_WORKBENCH_CONFIG = configFixture(directory);
  const creates: Array<Record<string, unknown>> = [];
  const worker = { id: "worker", cwd: "/fixture/tree", workspaceId: "paseo", status: "idle", provider: "codex", model: "fixture", features: parentAgent().features, labels: {} };
  const paseo = {
    agents: {
      ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parentAgent() : worker }), send: async () => {} }),
      list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
    },
    workspaces: {
      open: async () => ({ id: "paseo", agents: { create: async (options: Record<string, unknown>) => { creates.push(options); return { id: worker.id, current: () => worker, send: async () => {} }; } } }),
    },
  } as unknown as PaseoApi;
  try {
    const result = await withProject({ projectConfig: process.env.WORKSPACE_WORKBENCH_CONFIG! }, () => handleAgentDelegate({ workspaceId: "sample", parentAgentId: "parent", handoff: handoffSchema.parse({ goal: "Execute fixture", relationship: "child" }) }, { paseo, query: async () => ({ ok: true, result: { workspaceId: "sample", managed: true, treePath: "/fixture/tree", capabilities: { agent: true } } }) }));
    assert.equal(result.ok, true);
    assert.equal(creates[0].parent, "parent");
    assert.equal((creates[0].labels as Record<string, string>)["workspace-workbench.relationship"], "child");
    assert.equal((creates[0].labels as Record<string, string>)["workspace-workbench.parent"], "parent");
    const childConfig = creates[0].config as { mcpServers: Record<string, unknown>; toolPolicy: { preapproved: unknown[] } };
    assert.ok(childConfig.mcpServers["workspace-workbench-report"]);
    assert.equal(childConfig.mcpServers["workspace-workbench"], undefined);
    assert.equal((creates[0].env as Record<string, string>).WORKBENCH_EXECUTION_REPORT_ONLY, "1");
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS;
    else process.env.WORKSPACE_WORKBENCH_AGENT_BINDINGS = previous;
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    rmSync(directory, { recursive: true, force: true });
  }
});
