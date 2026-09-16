/** Opt-in integration evidence: an actual Paseo daemon loads this plugin.
 * Uses an isolated home, registry, Git repositories and loopback listener.
 * Never changes the user's installed plugin. WORKBENCH_LIVE_AGENTS=1 also
 * invokes real Codex agents against only these temporary repositories.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { deflateSync } from "node:zlib";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import WebSocket from "ws";
const plugin = resolve(import.meta.dirname, ".."),
  root = realpathSync(mkdtempSync("/tmp/wb-live-")),
  home = join(root, "paseo"),
  registry = join(root, "projects.json");
mkdirSync(home);
const configs = [];
const git = (path, args) =>
  execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
for (const project of ["a", "b"]) {
  const path = join(root, project);
  mkdirSync(path);
  for (const name of ["one", "two", "three", "extra", "go-secrets"]) {
    const repo = join(path, name);
    mkdirSync(repo);
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Workbench verification"]);
    git(repo, ["config", "user.email", "verification@example.invalid"]);
    writeFileSync(join(repo, "README"), "initial\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);
  }
  const config = join(path, "project.json");
  configs.push(config);
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: 1,
      project: { id: project },
      sourceRoot: path,
      stateRoot: join(path, "state"),
      workspaceRoot: join(path, "workspaces"),
      socketPath: join(path, "s.sock"),
      discovery: { mode: "manual" },
      repositories: ["one", "two", "three"].map((id) => ({ id, path: id })),
      management: { enabled: true },
      limits: { cacheTtlSeconds: 0.5 },
    }),
  );
}
writeFileSync(registry, JSON.stringify({ configs }));
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    version: 1,
    pluginsEnabled: true,
    plugins: {
      "workspace-workbench-paseo": {
        source: "directory",
        path: plugin,
        enabled: true,
      },
    },
  }),
);
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
for (const config of configs) {
  const value = JSON.parse(readFileSync(config, "utf8"));
  value.agent = { provider: "paseo", bridge: { script: join(plugin, "mcp.mjs"), endpoint: `127.0.0.1:${port}` } };
  value.review = { mode: "manual", reviewerTarget: "independent", autoFix: false };
  writeFileSync(config, JSON.stringify(value));
}
const env = {
  ...process.env,
  PASEO_HOME: home,
  WORKSPACE_WORKBENCH_PROJECT_REGISTRY: registry,
  WORKSPACE_WORKBENCH_PLUGIN_ROOT: plugin,
};
delete env.WORKSPACE_WORKBENCH_CONFIG;
const cli = process.env.PASEO_CLI || "paseo";
const daemon = spawn(
  cli,
  [
    "daemon",
    "start",
    "--home",
    home,
    "--listen",
    `127.0.0.1:${port}`,
    "--foreground",
    "--no-relay",
    "--no-mcp",
    "--no-inject-mcp",
    process.env.WORKBENCH_LIVE_UI === "1" ? "--web-ui" : "--no-web-ui",
  ],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
daemon.stdout.on("data", (b) => {
  logs = (logs + b).slice(-200000);
});
daemon.stderr.on("data", (b) => {
  logs = (logs + b).slice(-200000);
});
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  clientId: "workbench-live-verification",
  clientType: "mcp",
  reconnect: { enabled: false },
  webSocketFactory: (url, options) =>
    new WebSocket(url, options?.protocols, { headers: options?.headers }),
});
const rpc = (config, method, params = {}) =>
  Promise.race([
    client.invokePluginRpc(
      "workspace-workbench-paseo",
      "workspace.workbench.query",
      { projectConfig: config, method, params },
    ),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("plugin RPC timeout")), 5000);
      t.unref();
    }),
  ]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check, timeout = 60000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (daemon.exitCode !== null)
      throw new Error(`isolated daemon exited: ${daemon.exitCode}`);
    await delay(250);
  }
  throw last || new Error("live verification timed out");
}
const report = { kind: "actual-paseo-plugin", projects: 2, checks: [], root };
try {
  await wait(async () => {
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    }
  });
  const health = [];
  // Exercise the new RPC boundaries in the real host without invoking a model.
  for (const [method, input] of [
    ["workspace.workbench.session", { workspaceId: "missing", action: "status" }],
    ["workspace.workbench.coordinator-review", { workspaceId: "missing", sessionId: "missing", assignmentId: "missing", round: 1, action: "read", token: "invalid-test-token" }],
  ]) {
    await assert.rejects(client.invokePluginRpc("workspace-workbench-paseo", method, { projectConfig: configs[0], ...input }), /workspace_session_missing|review_caller_context_invalid/);
  }
  report.checks.push("session and coordinator review RPC authorization boundaries");
  for (const config of configs)
    health.push(
      await wait(async () => {
        const r = await rpc(config, "observer.health");
        return r.ok && r.result.implementation === "node" ? r : null;
      }),
    );
  for (const response of health) {
    const timing = response.result.timing;
    assert.equal(timing.observationTimeoutSeconds, timing.gitTimeoutSeconds + 5);
    assert.equal(timing.bridgeTimeoutMs, timing.observationTimeoutMs + 2_000);
    assert.equal(
      timing.clientRefreshTimeoutMs,
      timing.bridgeTimeoutMs + 1_000,
    );
    assert.equal(typeof response.result.instanceId, "string");
    assert.equal(response.result.instanceId, response.result.process.instanceId);
  }
  assert.notEqual(health[0].result.process.pid, health[1].result.process.pid);
  report.checks.push(
    "actual plugin loaded; separate Node backend PIDs for two projects",
  );
  report.checks.push("actual worker health exposes the shared observation timing and instance identity");
  const created = await rpc(configs[0], "workspace.create", {
    name: "sample",
    repositories: ["one"],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const hook = join(root, "a/three/.git/hooks/post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const params = {
    workspaceId: "sample",
    repositories: ["two", "three"],
    baseRefs: { two: "HEAD", three: "HEAD" },
  };
  const failed = await rpc(configs[0], "workspace.addRepositories", params);
  assert.equal(failed.ok, false);
  const recordPath = join(root, "a/workspaces/records/sample.json");
  assert.equal(
    JSON.parse(readFileSync(recordPath, "utf8")).repositories.length,
    2,
  );
  unlinkSync(hook);
  const added = await rpc(configs[0], "workspace.addRepositories", params);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.result.repositories.length, 3);
  assert.equal(added.result.id, created.result.id);
  assert.equal(added.result.createdAt, created.result.createdAt);
  const repeated = await rpc(configs[0], "workspace.addRepositories", params);
  assert.equal(repeated.result.repositories.length, 3);
  report.checks.push(
    "real post-checkout hook failure retained partial addition; retry and idempotency preserved ID/history",
  );
  const runtime = await rpc(configs[0], "workspace.runtime", {
    workspaceId: "sample",
  });
  assert.equal(runtime.ok, true, JSON.stringify(runtime));
  assert.equal(runtime.result.repositories.length, 3);
  report.checks.push("new repositories present in subsequent handoff runtime");
  const publicQueries = [
    ["workspace.list", {}],
    ["workspace.detail", { workspaceId: "sample" }],
    ["workspace.identify", { directory: created.result.treePath }],
    ["workspace.runtime", { workspaceId: "sample" }],
    ["repository.graph", { workspaceId: "sample", repositoryId: "one", historyMode: "full" }],
    ["repository.changes", { workspaceId: "sample", repositoryId: "one", scope: "working" }],
    ["review-set.compare", { workspaceIds: ["sample"] }],
    ["review-set.brief", { workspaceIds: ["sample"] }],
  ];
  for (const [method, params] of publicQueries) {
    const result = await rpc(configs[0], method, params);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (method === "workspace.identify") assert.equal(result.result.matched, true, method);
    else assert.equal(result.result.schemaVersion, "workspace.workbench/v1", method);
  }
  report.checks.push("eight public panel RPCs returned Node protocol payloads on the same real repositories");
  const branchGraphQuery = {
    workspaceId: "sample",
    repositoryId: "one",
    historyMode: "branch",
    maxCommits: 50,
  };
  const branchChangesQuery = {
    workspaceId: "sample",
    repositoryId: "one",
    scope: "branch",
  };
  assert.equal((await rpc(configs[0], "repository.graph", branchGraphQuery)).result.observation.state, "ready");
  assert.equal((await rpc(configs[0], "repository.changes", branchChangesQuery)).result.observation.state, "ready");
  // Keep this above the configured TTL even when the daemon is busy starting
  // both project workers and servicing the compatibility probes.
  await delay(3500);
  await rpc(configs[0], "workspace.detail", { workspaceId: "sample", force: true });
  const staleGraph = await rpc(configs[0], "repository.graph", branchGraphQuery);
  const staleChanges = await rpc(configs[0], "repository.changes", branchChangesQuery);
  for (const response of [staleGraph, staleChanges]) {
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.observation.state, "ready", JSON.stringify(response));
    assert.equal(response.result.observation.cacheState, "refreshing", JSON.stringify(response));
    assert.equal(response.result.cache.refreshing, true, JSON.stringify(response));
  }
  report.checks.push("actual public Graph/Changes RPC keeps ready semantics during stale cache refresh");
  if (process.env.WORKBENCH_LIVE_AGENTS === "1") {
    const cwd = resolve(configs[0], "..");
    // Original sources are deliberately untracked: only the frozen bundle
    // makes them available inside the newly created worker worktree.
    writeFileSync(join(cwd, "one", "bundle-spec.md"), "# Original requirement\nThe required button color is BLUE. The coordinator's RED assumption is unconfirmed and conflicts with this document. Inspect the blue reference image, report the conflict and source evidence, and do not edit files.\n");
    const crc = data => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let n = 0; n < 8; n++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
    const pngChunk = (name, data) => { const type = Buffer.from(name), size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data]))); return Buffer.concat([size, type, data, checksum]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
    const pixels = Buffer.alloc(64 * (1 + 64 * 3)); for (let row = 0; row < 64; row++) for (let col = 0; col < 64; col++) pixels[row * 193 + 1 + col * 3 + 2] = 255;
    writeFileSync(join(cwd, "one", "bundle-image.png"), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]));
    const catalog = await client.listProviderModels("codex", { cwd });
    const model = process.env.WORKBENCH_LIVE_MODEL || catalog.models.find(item => item.isDefault && item.isSelectable !== false)?.id || catalog.models.find(item => item.isSelectable !== false)?.id;
    if (!model) throw new Error("live_codex_model_unavailable");
    const parent = await client.createAgent({ config: { provider: "codex", model, cwd, modeId: "auto", featureValues: { plan_mode: false },
      toolPolicy: { preapproved: ["workbench_workspace_preview", "workbench_workspace_execute", "workbench_workspace_status", "workbench_review_read", "workbench_review_result", "workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset"].map(tool => ({ kind: "mcp", server: "workspace-workbench", tool })) } },
      initialPrompt: "Use Workspace Workbench MCP to delegate an approved inspection to a new isolated Workspace named coordinator-smoke, repository one. Required original references: REQ (repositoryId one, path bundle-spec.md), IMG (repositoryId one, path bundle-image.png). Record the deliberately unconfirmed coordinator assumption 'the button is RED' in handoff.context.assumptions. The worker must read the originals from the frozen bundle, fetch the image with workbench_handoff_asset, and explicitly report any conflict between the assumption, original requirement and image. No file changes. Completion should report ready_for_review with materialsVersion and source evidence. Preview then execute using a stable requestId. When assigned a review, read the handoff materials and submit a structured review result. Identifying the conflict completes this inspection; no implementation or user clarification is needed for this inspection-only task." });
    report.modelEvidence = { model, coordinatorAgentId: parent.id, status: "running" };
    const review = await wait(async () => {
      const bindingPath = join(cwd, "state", "agent-bindings.json");
      if (!existsSync(bindingPath)) return false;
      const binding = JSON.parse(readFileSync(bindingPath, "utf8")).bindings.find(item => item.requestedByAgentId === parent.id || item.parentAgentId === parent.id);
      if (!binding) return false;
      const response = await client.invokePluginRpc("workspace-workbench-paseo", "workspace.workbench.agent-review.session", { projectConfig: configs[0], workspaceId: binding.workspaceId });
      if (["failed", "blocked"].includes(response.session?.status)) throw new Error(`live_review_${response.session.status}:${response.session.lastError?.code || "result"}`);
      return response.session?.status === "approved" ? response.session : false;
    }, 180_000);
    const timeline = await client.fetchAgentTimeline(parent.id, { limit: 100 });
    const executeEntry = timeline.entries.find(entry => entry.item.type === "tool_call" && JSON.stringify(entry.item).includes("workbench_workspace_execute"));
    if (!executeEntry?.turnId) throw new Error("live_handoff_turn_unavailable");
    assert.notEqual(executeEntry.turnId, review.reviewerTurnId, "Coordinator must finish the handoff turn before reviewing");
    assert.ok(review.materials, "Review must bind the execution materials version");
    const manifest = JSON.parse(readFileSync(join(cwd, "state", "handoff-bundles", review.materials.id, String(review.materials.version), "manifest.json"), "utf8"));
    assert.ok(manifest.conversation.messages > 0, "The actual host must export public conversation messages");
    const workerTimeline = await client.fetchAgentTimeline(review.executionAgentId, { limit: 100 });
    assert.ok(workerTimeline.entries.some(entry => entry.item.type === "tool_call" && entry.item.status === "completed" && entry.item.name.includes("workbench_handoff_asset")), "Worker must actually fetch the reference image");
    const reportText = JSON.stringify(review.events.filter(event => event.kind === "ready_for_review"));
    assert.match(reportText, /blue|蓝/i); assert.match(reportText, /red|红/i);
    report.modelEvidence = { ...report.modelEvidence, status: "passed", handoffTurnId: executeEntry.turnId, reviewTurnId: review.reviewerTurnId, workspaceId: review.workspaceId };
    report.checks.push("real Codex delegated inspection, ended the handoff turn, and approved in a later coordinator review turn");
    report.checks.push("worker retrieved frozen originals and image, identified conflicting coordinator assumption, and reported the materials version");
  }
  const removed = await rpc(configs[0], "workspace.remove", { workspaceId: "sample" });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.result.state, "removed");
  const restored = await rpc(configs[0], "workspace.restore", { workspaceId: "sample" });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.equal(restored.result.state, "active");
  report.checks.push("panel RPC remove/restore retained the same workspace and worktrees");
  execFileSync(
    cli,
    [
      "plugin",
      "reload",
      "workspace-workbench-paseo",
      "--host",
      `127.0.0.1:${port}`,
      "--json",
    ],
    { env, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const next = [];
  for (let i = 0; i < configs.length; i++)
    next.push(
      await wait(async () => {
        const r = await rpc(configs[i], "observer.health");
        return r.ok && r.result.process.pid !== health[i].result.process.pid
          ? r
          : null;
      }),
    );
  for (const old of health)
    assert.throws(() => process.kill(old.result.process.pid, 0));
  assert.equal(
    (await rpc(configs[0], "workspace.runtime", { workspaceId: "sample" }))
      .result.repositories.length,
    3,
  );
  report.checks.push(
    "actual plugin reload retired both old workers, started replacements, and retained workspace records",
  );
  process.kill(next[1].result.process.pid, "SIGKILL");
  await delay(200);
  const recovered = await wait(async () => {
    const r = await rpc(configs[1], "observer.health");
    return r.ok && r.result.process.pid !== next[1].result.process.pid
      ? r
      : null;
  });
  report.checks.push(
    "actual plugin request recovered a crashed project backend",
  );
  if (process.env.WORKBENCH_LIVE_UI === "1") {
    console.log(JSON.stringify({ kind: "ui-ready", url: `http://127.0.0.1:${port}`, project: resolve(configs[0], ".."), continueFile: join(root, "continue") }));
    await wait(() => existsSync(join(root, "continue")), 600_000);
  }
  execFileSync(
    cli,
    [
      "plugin",
      "disable",
      "workspace-workbench-paseo",
      "--host",
      `127.0.0.1:${port}`,
      "--json",
    ],
    { env, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
  );
  await wait(() =>
    configs.every(
      (config) => !existsSync(join(resolve(config, ".."), "s.sock")),
    ),
  );
  for (const pid of [next[0].result.process.pid, recovered.result.process.pid])
    assert.throws(() => process.kill(pid, 0));
  report.checks.push(
    "actual plugin unload exited workers and reclaimed sockets",
  );
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(join(root, "daemon-verification.log"), logs, { mode: 0o600 });
  console.error(
    JSON.stringify(
      {
        ...report,
        ok: false,
        error: error.message,
        logPath: join(root, "daemon-verification.log"),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  try {
    execFileSync(
      cli,
      ["daemon", "stop", "--home", home, "--timeout", "5", "--json"],
      { env, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {}
  daemon.kill("SIGTERM");
  await Promise.race([new Promise((r) => daemon.once("exit", r)), delay(5000)]);
  if (daemon.exitCode === null && !daemon.signalCode) daemon.kill("SIGKILL");
  if (report.ok) rmSync(root, { recursive: true, force: true });
}
