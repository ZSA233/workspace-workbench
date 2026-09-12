import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { childExecutionConfig } from "../server/execution-policy.ts";
import { orchestrate } from "../server/orchestrator.ts";
import { withProject } from "../server/projects.ts";
import { workflowRequest } from "../shared/orchestration.ts";

const parent = (cwd: string, plan = false) => ({ id: "parent", cwd, provider: "codex", model: "fixture", currentModeId: "auto", availableModes: [{ id: "auto" }, { id: "full-access" }], pendingPermissions: [], features: [{ id: "plan_mode", type: "toggle", value: plan }] }) as unknown as PaseoAgent;
test("provider modes fail closed and never grant full access to the child", () => {
  assert.throws(() => childExecutionConfig(parent("/fixture", true), false), /mode_unconfirmed/);
  assert.throws(() => childExecutionConfig({ ...parent("/fixture"), features: [] }, false), /mode_unconfirmed/);
  assert.equal(childExecutionConfig({ ...parent("/fixture"), currentModeId: "full-access" }, true).modeId, "auto");
  assert.deepEqual(childExecutionConfig(parent("/fixture"), true).featureValues, { plan_mode: true });
});

test("preview is read-only; execute prepares, creates one child, retries without redelivery", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-flow-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo" } }));
  const prior = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  let planning = true, creates = 0;
  const calls: string[] = [];
  let worker: PaseoAgent | null = null;
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parent(root, planning) : worker }), send: async () => { throw new Error("unexpected redelivery"); } }), list: async () => ({ entries: worker ? [{ agent: worker }] : [], pageInfo: { hasMore: false } }) }, workspaces: { open: async () => ({ id: "paseo-fixture", agents: { create: async (options: { config: unknown; labels: Record<string,string> }) => { creates++; assert.equal((options.config as { modeId: string }).modeId, "auto"); worker = { ...parent(root + "/tree"), id: "child", labels: options.labels, status: "running", workspaceId: "paseo-fixture" }; return { id: "child", current: () => worker }; } } }) } } as unknown as PaseoApi;
  const query = async (input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true, prepare: true } } };
    if (input.method === "workspace.runtime") return { ok: true, result: { workspaceId: "sample", managed: true, treePath: root + "/tree", capabilities: { agent: true } } };
    if (input.method === "workspace.detail") return { ok: true, result: { repositories: [{ id: "api" }] } };
    return { ok: true, result: { id: "sample" } };
  };
  const request = workflowRequest.parse({ requestId: "one", name: "sample", repositories: ["api"], handoff: { goal: "Edit fixture" } });
  const run = (action: "preview" | "execute") => withProject({ projectConfig: config }, () => orchestrate(action, request, "parent", { paseo, query }));
  try {
    await run("preview");
    assert.deepEqual(calls, ["workspace.list", "workspace.detail"]);
    await assert.rejects(run("execute"), /mode_unconfirmed/);
    assert.equal(creates, 0);
    planning = false;
    await run("execute");
    assert.equal(creates, 1);
    assert.ok(calls.indexOf("workspace.create") < calls.indexOf("workspace.prepare"));
    await run("execute");
    assert.equal(creates, 1);
    assert.equal(calls.filter((method) => method === "workspace.create").length, 1);
    await assert.rejects(withProject({ projectConfig: config }, () => orchestrate("execute", { ...request, name: "conflict" }, "parent", { paseo, query })), /identity_conflict/);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
