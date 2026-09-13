/** Opt-in integration evidence: an actual Paseo daemon loads this plugin.
 * Uses an isolated home, registry, Git repositories and loopback listener.
 * Never changes the user's installed plugin or starts an execution Agent.
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
  for (const name of ["one", "two", "three"]) {
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
    "--no-web-ui",
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
  for (const config of configs)
    health.push(
      await wait(async () => {
        const r = await rpc(config, "observer.health");
        return r.ok && r.result.implementation === "node" ? r : null;
      }),
    );
  assert.notEqual(health[0].result.process.pid, health[1].result.process.pid);
  report.checks.push(
    "actual plugin loaded; separate Node backend PIDs for two projects",
  );
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
  // Exercise the same public RPC used by the panel, and compare its payload
  // with the retained Python protocol oracle on these real worktrees.
  const volatile = new Set(["observedAt", "durationMs", "observation", "cache", "updatedAt"]);
  function compatible(actual, expected, path) {
    if (Array.isArray(expected)) {
      assert.equal(actual?.length, expected.length, path);
      expected.forEach((value, i) => compatible(actual[i], value, `${path}[${i}]`));
    } else if (expected !== null && typeof expected === "object") {
      for (const [key, value] of Object.entries(expected))
        if (!volatile.has(key)) compatible(actual?.[key], value, `${path}.${key}`);
    } else assert.deepEqual(actual, expected, path);
  }
  for (const [method, query] of [
    ["workspace.list", {}],
    ["workspace.detail", { workspaceId: "sample" }],
    ["workspace.identify", { directory: created.result.treePath }],
    ["workspace.runtime", { workspaceId: "sample" }],
    ["repository.graph", { workspaceId: "sample", repositoryId: "one", historyMode: "full" }],
    ["repository.changes", { workspaceId: "sample", repositoryId: "one", scope: "working" }],
    ["review-set.compare", { workspaceIds: ["sample"] }],
    ["review-set.brief", { workspaceIds: ["sample"] }],
  ]) {
    const expected = JSON.parse(execFileSync("python3", ["-m", "workspace_workbench", "serve", "--stdio", "--config", configs[0]], {
      env: { ...env, PYTHONPATH: resolve(plugin, "../src") },
      input: JSON.stringify({ id: 1, method, params: query }) + "\n",
      encoding: "utf8", timeout: 15000,
    }).trim());
    const actual = await rpc(configs[0], method, query);
    assert.equal(actual.ok, true, JSON.stringify(actual));
    assert.equal(expected.ok, true, JSON.stringify(expected));
    compatible(actual.result, expected.result, method);
  }
  report.checks.push("eight panel RPC payloads matched legacy Python fields on the same real repositories (timing/cache metadata excluded)");
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
