import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { childExecutionConfig } from "../server/execution-policy.ts";
import { orchestrate } from "../server/orchestrator.ts";
import { withProject } from "../server/projects.ts";
import { readState } from "../server/orchestration-state.ts";
import { orchestrationRpc, workflowRequest, workflowStatusRequest, workflowSubmitRequest } from "../shared/orchestration.ts";

const parent = (cwd: string, plan = false) => ({ id: "parent", cwd, provider: "codex", model: "fixture", currentModeId: "auto", availableModes: [{ id: "auto" }, { id: "full-access" }], pendingPermissions: [], features: [{ id: "plan_mode", type: "toggle", value: plan }] }) as unknown as PaseoAgent;

test("submit request keeps task when requestId is present", () => {
  const parsed = (orchestrationRpc as unknown as { input: { parse(value: unknown): { request: { task?: string } } } }).input.parse({
    projectConfig: "/fixture/project.json",
    token: "token",
    action: "submit",
    request: { requestId: "submit-with-id", task: "keep this task" },
  });
  assert.equal(parsed.request.task, "keep this task");
});
test("provider modes fail closed and inherit the current permission by default", () => {
  assert.throws(() => childExecutionConfig(parent("/fixture", true), false), /主控仍在计划模式/);
  assert.throws(() => childExecutionConfig({ ...parent("/fixture"), features: [] }, false), /未返回主控实际计划状态/);
  assert.equal(childExecutionConfig({ ...parent("/fixture"), currentModeId: "full-access" }, true).modeId, "full-access");
  assert.equal(childExecutionConfig({ ...parent("/fixture"), currentModeId: "full-access" }, true, "auto").modeId, "auto");
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
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parent(root, planning) : worker }), send: async () => { throw new Error("unexpected redelivery"); } }), list: async () => ({ entries: worker ? [{ agent: worker }] : [], pageInfo: { hasMore: false } }) }, workspaces: { open: async () => ({ id: "paseo-fixture", agents: { create: async (options: { config: unknown; labels: Record<string,string>; parent?: string }) => { creates++; assert.equal((options.config as { modeId: string }).modeId, "auto"); assert.equal(options.parent, undefined); assert.equal(options.labels["workspace-workbench.relationship"], "independent"); worker = { ...parent(root + "/tree"), id: "child", labels: options.labels, status: "idle", workspaceId: "paseo-fixture" }; return { id: "child", current: () => worker, send: async () => {} }; } } }) } } as unknown as PaseoApi;
  const query = async (input: { method: string }) => {
    calls.push(input.method);
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true, prepare: true } } };
    if (input.method === "workspace.runtime") return { ok: true, result: { workspaceId: "sample", managed: true, treePath: root + "/tree", capabilities: { agent: true } } };
    if (input.method === "workspace.detail") return { ok: true, result: { workspace: { sourceRoot: root }, repositories: [{ id: "api", name: "API", repoPath: ".", sourcePath: root, worktreePath: root }] } };
    return { ok: true, result: { id: "sample" } };
  };
  const request = workflowRequest.parse({ requestId: "one", name: "sample", repositories: [root], baseRefs: { [root]: "main" }, handoff: { goal: "Edit fixture" } });
  const canonicalRequest = workflowRequest.parse({ requestId: "one", name: "sample", repositories: ["api"], baseRefs: { api: "main" }, handoff: { goal: "Edit fixture" } });
  const directRequest = workflowRequest.parse({ requestId: "direct", name: "direct", repositories: [root], baseRefs: { [root]: "main" }, handoff: { goal: "Direct fixture" } });
  const run = (action: "preview" | "execute", currentRequest = request) => withProject({ projectConfig: config }, () => orchestrate(action, currentRequest, "parent", { paseo, query }));
  try {
    planning = false;
    const direct = await run("execute", directRequest);
    assert.equal((direct as { ok?: boolean }).ok, false);
    assert.equal((direct as { error?: { code?: string } }).error?.code, "preview_required");
    planning = true;
    const preview = await run("preview");
    assert.deepEqual((preview as { request: { repositories?: string[]; baseRefs: Record<string, string> } }).request.repositories, ["api"]);
    assert.deepEqual((preview as { request: { baseRefs: Record<string, string> } }).request.baseRefs, { api: "main" });
    const savedPreview = withProject({ projectConfig: config }, () => readState<{ stage?: string; identity?: string }>("workflow:parent:one"));
    assert.equal(savedPreview?.stage, "previewed");
    assert.equal(typeof savedPreview?.identity, "string");
    assert.deepEqual(calls, ["workspace.list", "workspace.detail"]);
    await assert.rejects(run("execute"), /主控仍在计划模式/);
    assert.equal(creates, 0);
    planning = false;
    const resumedById = await withProject({ projectConfig: config }, () => orchestrate("execute", workflowStatusRequest.parse({ requestId: "one" }), "parent", { paseo, query }));
    assert.equal((resumedById as { ok?: boolean }).ok, true);
    assert.equal(creates, 1);
    assert.ok(calls.indexOf("workspace.create") < calls.indexOf("workspace.prepare"));
    await run("execute", canonicalRequest);
    assert.equal(creates, 1);
    assert.equal(calls.filter((method) => method === "workspace.create").length, 1);
    const status = await withProject({ projectConfig: config }, () => orchestrate("status", workflowStatusRequest.parse({ requestId: "one", workspaceId: "sample" }), "parent", { paseo, query }));
    assert.equal((status as { ok?: boolean }).ok, true);
    const normalizedStatus = await withProject({ projectConfig: config }, () => orchestrate("status", workflowStatusRequest.parse({ requestId: "one" }), "parent", { paseo, query }));
    assert.equal((normalizedStatus as { ok?: boolean }).ok, true);
    const conflict = await withProject({ projectConfig: config }, () => orchestrate("execute", { ...request, name: "conflict" }, "parent", { paseo, query }));
    assert.equal((conflict as { ok?: boolean }).ok, false);
    assert.equal((conflict as { error?: { code?: string } }).error?.code, "request_identity_conflict");
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

test("Gitlink workflow preview resolves the selected outer Workspace and preserves one shared branch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-gitlink-flow-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root, agent: { provider: "paseo" } }));
  const previous = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: parent(root) }) }) } } as unknown as PaseoApi;
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const query = async (input: { method: string; params?: Record<string, unknown> }) => {
    calls.push(input);
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true } } };
    if (input.method === "workspace.detail") return { ok: true, result: { workspace: { sourceRoot: root }, repositories: [
      { id: "@root", repoPath: ".", sourcePath: join(root, "outer"), worktreePath: join(root, "outer") },
      { id: "halh", repoPath: "halh", sourcePath: join(root, "outer", "halh"), worktreePath: join(root, "outer", "halh") },
    ] } };
    throw new Error(`unexpected method ${input.method}`);
  };
  try {
    const request = workflowRequest.parse({ requestId: "gitlink", name: "nested", sourceWorkspaceId: "linked-fixture",
      branchName: "feature/nested", rootBaseRef: "main", baseRefs: { halh: "pin-sha" }, handoff: { goal: "Implement fixture" } });
    const result = await withProject({ projectConfig: config }, () => orchestrate("preview", request, "parent", { paseo, query }));
    assert.equal((result as { ok?: boolean }).ok, true);
    assert.equal(calls.find(call => call.method === "workspace.detail")?.params?.workspaceId, "linked-fixture");
    assert.equal((result as { request: { branchName: string; sourceWorkspaceId: string } }).request.branchName, "feature/nested");
    assert.equal((result as { request: { sourceWorkspaceId: string } }).request.sourceWorkspaceId, "linked-fixture");
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("submit creates an internal operation identity and hands original paths to the worker without preview replay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-submit-")));
  const config = join(root, "project.json"), source = join(root, "requirements.md");
  writeFileSync(source, "Original requirement\n");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, sourceRoot: root, workspaceRoot: root, stateRoot: root, recordsRoot: join(root, "records"), treesRoot: join(root, "trees"), repositories: [], agent: { provider: "paseo" } }));
  const prior = process.env.WORKSPACE_WORKBENCH_CONFIG; process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  let sent = "";
  const worker = { ...parent(root), id: "submit-worker", cwd: root, workspaceId: "paseo-submit", status: "idle", activeTurn: null } as unknown as PaseoAgent;
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: id === "parent" ? parent(root) : worker }), send: async (message: string) => { sent = message; } }), list: async () => ({ entries: [], pageInfo: { hasMore: false } }) }, workspaces: { open: async () => ({ id: "paseo-submit", agents: { create: async () => ({ id: "submit-worker", current: () => worker, refresh: async () => ({ agent: worker }), send: async (message: string) => { sent = message; } }) } }) } } as unknown as PaseoApi;
  const query = async (input: { method: string }) => {
    if (input.method === "workspace.list") return { ok: true, result: { capabilities: { create: true, agent: true, prepare: false } } };
    if (input.method === "workspace.detail") return { ok: true, result: { workspace: { sourceRoot: root }, repositories: [{ id: "repo", repoPath: ".", sourcePath: root, worktreePath: root }] } };
    if (input.method === "workspace.runtime") return { ok: true, result: { workspaceId: "sample", managed: true, treePath: root, repositories: [], capabilities: { agent: true } } };
    return { ok: true, result: {} };
  };
  try {
    const request = workflowSubmitRequest.parse({ workspaceId: "sample", task: "Implement the approved requirement", originalPaths: [source] });
    const result = await withProject({ projectConfig: config }, () => orchestrate("submit", request, "parent", { paseo, query }));
    assert.equal((result as { ok?: boolean }).ok, true);
    assert.equal((result as { action?: string }).action, "accepted");
    const requestId = (result as { requestId?: string }).requestId;
    assert.ok(requestId);
    const deadline = Date.now() + 2_000;
    while (!sent && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(sent, /Implement the approved requirement/);
    assert.match(sent, /requirements\.md/);
    const saved = withProject({ projectConfig: config }, () => readState<{ stage?: string }>(`workflow:parent:${requestId}`));
    assert.equal(saved?.stage, "handed-off");
  } finally {
    if (prior === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
