import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { childExecutionConfig } from "../server/execution-policy.ts";
import { orchestrate } from "../server/orchestrator.ts";
import { withProject } from "../server/projects.ts";
import { workflowRequest, workflowStatusRequest } from "../shared/orchestration.ts";

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
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parent(root, planning) : worker }), send: async () => { throw new Error("unexpected redelivery"); } }), list: async () => ({ entries: worker ? [{ agent: worker }] : [], pageInfo: { hasMore: false } }) }, workspaces: { open: async () => ({ id: "paseo-fixture", agents: { create: async (options: { config: unknown; labels: Record<string,string>; parent?: string }) => { creates++; assert.equal((options.config as { modeId: string }).modeId, "auto"); assert.equal(options.parent, undefined); assert.equal(options.labels["workspace-workbench.relationship"], "independent"); worker = { ...parent(root + "/tree"), id: "child", labels: options.labels, status: "running", workspaceId: "paseo-fixture" }; return { id: "child", current: () => worker }; } } }) } } as unknown as PaseoApi;
  const query = async (input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true, prepare: true } } };
    if (input.method === "workspace.runtime") return { ok: true, result: { workspaceId: "sample", managed: true, treePath: root + "/tree", capabilities: { agent: true } } };
    if (input.method === "workspace.detail") return { ok: true, result: { workspace: { sourceRoot: root }, repositories: [{ id: "api", name: "API", repoPath: ".", sourcePath: root, worktreePath: root }] } };
    return { ok: true, result: { id: "sample" } };
  };
  const request = workflowRequest.parse({ requestId: "one", name: "sample", repositories: [root], baseRefs: { [root]: "main" }, handoff: { goal: "Edit fixture" } });
  const canonicalRequest = workflowRequest.parse({ requestId: "one", name: "sample", repositories: ["api"], baseRefs: { api: "main" }, handoff: { goal: "Edit fixture" } });
  const run = (action: "preview" | "execute", currentRequest = request) => withProject({ projectConfig: config }, () => orchestrate(action, currentRequest, "parent", { paseo, query }));
  try {
    const preview = await run("preview");
    assert.deepEqual((preview as { request: { repositories?: string[]; baseRefs: Record<string, string> } }).request.repositories, ["api"]);
    assert.deepEqual((preview as { request: { baseRefs: Record<string, string> } }).request.baseRefs, { api: "main" });
    assert.deepEqual(calls, ["workspace.list", "workspace.detail"]);
    await assert.rejects(run("execute"), /mode_unconfirmed/);
    assert.equal(creates, 0);
    planning = false;
    await run("execute");
    assert.equal(creates, 1);
    assert.ok(calls.indexOf("workspace.create") < calls.indexOf("workspace.prepare"));
    await run("execute", canonicalRequest);
    assert.equal(creates, 1);
    assert.equal(calls.filter((method) => method === "workspace.create").length, 1);
    const status = await withProject({ projectConfig: config }, () => orchestrate("status", workflowStatusRequest.parse({ requestId: "one", workspaceId: "sample" }), "parent", { paseo, query }));
    assert.equal((status as { ok?: boolean }).ok, true);
    const normalizedStatus = await withProject({ projectConfig: config }, () => orchestrate("status", workflowStatusRequest.parse({ requestId: "one" }), "parent", { paseo, query }));
    assert.equal((normalizedStatus as { ok?: boolean }).ok, true);
    await assert.rejects(withProject({ projectConfig: config }, () => orchestrate("execute", { ...request, name: "conflict" }, "parent", { paseo, query })), /identity_conflict/);
    const invalid = workflowRequest.parse({ requestId: "invalid", name: "invalid", repositories: [root + "/missing"], handoff: { goal: "Invalid fixture" } });
    const invalidPreview = await run("preview", invalid);
    assert.equal((invalidPreview as { ok?: boolean }).ok, false);
    assert.equal((invalidPreview as { error?: { code?: string } }).error?.code, "repository_invalid");
    assert.equal(creates, 1);
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository aliases fail closed when a name is ambiguous", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-alias-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo" } }));
  const prior = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: parent(root) }) }) } } as unknown as PaseoApi;
  const query = async (input: { method: string }) => {
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true, prepare: false } } };
    if (input.method === "workspace.detail") return { ok: true, result: { workspace: { sourceRoot: root }, repositories: [
      { id: "one", name: "same-name", repoPath: "one", sourcePath: join(root, "one"), worktreePath: join(root, "one") },
      { id: "two", name: "same-name", repoPath: "two", sourcePath: join(root, "two"), worktreePath: join(root, "two") },
    ] } };
    return { ok: true, result: { id: "unused" } };
  };
  const request = workflowRequest.parse({ requestId: "ambiguous", name: "ambiguous", repositories: ["same-name"], handoff: { goal: "Ambiguous fixture" } });
  try {
    const result = await withProject({ projectConfig: config }, () => orchestrate("preview", request, "parent", { paseo, query }));
    assert.equal((result as { ok?: boolean }).ok, false);
    assert.equal((result as { error?: { code?: string } }).error?.code, "repository_ambiguous");
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
