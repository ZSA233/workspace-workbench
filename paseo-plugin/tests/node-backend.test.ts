import { executeLocal } from "../server/backend/local-execution.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  chmodSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { loadConfig } from "../server/backend/config.ts";
import { Service } from "../server/backend/service.ts";
import { Git, gitDiagnostics } from "../server/backend/git.ts";
import { ObservationCache } from "../server/backend/cache.ts";
import { WorkspaceActivityIndex } from "../server/backend/workspace-activity.ts";
import { type Json, WorkbenchError } from "../server/backend/storage.ts";
import { observationTimingFromWire, readBudgetMs, resolveObservationTiming } from "../shared/observation-timing.ts";

export function fixture(extra: Json = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-node-")));
  for (const name of ["one", "two", "three"]) {
    const path = join(root, name);
    mkdirSync(path);
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "test@example.invalid"],
      ["config", "user.name", "Test"],
    ])
      git(path, args);
    writeFileSync(join(path, "README.md"), "initial\n");
    git(path, ["add", "."]);
    git(path, ["commit", "-qm", "initial"]);
  }
  const configPath = join(root, "project.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceRoot: root,
      stateRoot: join(root, "state"),
      workspaceRoot: join(root, "workspaces"),
      socketPath: join(root, "s.sock"),
      project: { id: "fixture", displayName: "Fixture" },
      repositories: ["one", "two", "three"].map((id) => ({ id, path: id })),
      discovery: { mode: "manual" },
      management: { enabled: true },
      agent: { provider: "paseo" },
      ...extra,
    }),
  );
  return { root, configPath, config: loadConfig(configPath) };
}
export function git(path: string, args: string[]) {
  const r = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
test("observation timing derives one consistent downstream budget", () => {
  const timing = resolveObservationTiming({ gitTimeoutSeconds: 30 });
  assert.equal(timing.gitTimeoutSeconds, 30);
  assert.equal(timing.observationTimeoutSeconds, 35);
  assert.equal(timing.observationTimeoutMs, 35_000);
  assert.equal(timing.bridgeTimeoutMs, 37_000);
  assert.equal(timing.clientRefreshTimeoutMs, 38_000);
  assert.equal(timing.clientQueryStaleTimeMs, 1_500);
  assert.equal(timing.staleWindowsMs.detail, timing.refreshIntervalsMs.detail * 3);
  assert.deepEqual(timing.followUpDelaysMs, [250, 1_000, 3_000]);
  assert.equal(timing.foregroundGitTimeoutMs, 4_500);
  assert.equal(readBudgetMs("workspace.list", timing), 3_000);
  assert.equal(readBudgetMs("repository.changes", timing), 5_000);
  assert.throws(
    () => resolveObservationTiming({ gitTimeoutSeconds: 30, observationTimeoutSeconds: 34.9 }),
    /at least 35 seconds/,
  );
  const changed = resolveObservationTiming({ gitTimeoutSeconds: 10 });
  assert.equal(changed.observationTimeoutSeconds, 15);
  assert.equal(changed.bridgeTimeoutMs, 17_000);
  assert.equal(changed.clientRefreshTimeoutMs, 18_000);
});

test("older timing payloads receive bounded read defaults", () => {
  const timing = resolveObservationTiming({ gitTimeoutSeconds: 30 });
  const wire = { ...timing } as Record<string, unknown>;
  delete wire.foregroundGitTimeoutMs;
  delete wire.backendHealthTimeoutMs;
  delete wire.readBudgetsMs;
  delete wire.cleanupReserveMs;
  const parsed = observationTimingFromWire(wire);
  assert.equal(parsed.foregroundGitTimeoutMs, 4_500);
  assert.equal(parsed.readBudgetsMs.list, 3_000);
});

test("workspace activity scans HEAD metadata only on request, caches it, aggregates repositories, and persists", async () => {
  const f = fixture();
  let service = new Service(f.config);
  try {
    const beforeCommands = gitDiagnostics().commands;
    const initial = await service.handle("workspace.list", { includeRemoved: true });
    assert.equal(gitDiagnostics().commands, beforeCommands, "workspace.list must not start Git activity scans");
    assert.ok(initial.workspaces.every((workspace: Json) => workspace.latestCommitAt === null));
    const workspaceIds = initial.workspaces.map((workspace: Json) => workspace.id);
    const started = await service.handle("workspace.activity", { action: "start", scanId: "scan-first", workspaceIds });
    assert.equal(started.state, "running");
    let status = started;
    for (let attempt = 0; attempt < 300 && status.state === "running"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await service.handle("workspace.activity", { action: "status", scanId: "scan-first" });
    }
    assert.equal(status.state, "complete");
    assert.equal(status.total, 3);
    const expected = ["one", "two", "three"]
      .map((name) => git(join(f.root, name), ["show", "-s", "--format=%cI", "HEAD"]))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    const after = await service.handle("workspace.list", { includeRemoved: true });
    assert.equal(after.workspaces.find((workspace: Json) => workspace.id === "main").latestCommitAt, expected);
    assert.equal(after.workspaces.find((workspace: Json) => workspace.id === "main").latestCommitState, "ready");

    const afterFirstScan = gitDiagnostics().commands;
    const cached = await service.handle("workspace.activity", { action: "start", scanId: "scan-cached", workspaceIds });
    assert.equal(cached.state, "complete");
    assert.equal(cached.total, 0);
    assert.equal(gitDiagnostics().commands, afterFirstScan, "fresh activity cache must avoid Git commands");
    await service.close();
    service = new Service(f.config);
    const restored = await service.handle("workspace.list", { includeRemoved: true });
    assert.equal(restored.workspaces.find((workspace: Json) => workspace.id === "main").latestCommitAt, expected);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cancelling a workspace activity scan stops its queued repository lookups", async () => {
  const f = fixture();
  const activity = new WorkspaceActivityIndex(f.config);
  try {
    activity.cancel("close-before-start");
    assert.equal(activity.start("close-before-start", [{ id: "workspace", repositories: [{ worktreePath: join(f.root, "one") }] }]).state, "cancelled");
    const paths = Array.from({ length: 40 }, (_, index) => {
      const path = join(f.root, `activity-alias-${index}`);
      symlinkSync(join(f.root, "one"), path, "dir");
      return path;
    });
    const beforeCommands = gitDiagnostics().commands;
    const started = activity.start("cancel-scan", [{ id: "workspace", repositories: paths.map((worktreePath) => ({ worktreePath })) }]);
    assert.equal(started.state, "running");
    assert.equal(activity.cancel("cancel-scan").state, "cancelled");
    await activity.close();
    assert.equal(activity.status("cancel-scan").state, "cancelled");
    assert.ok(gitDiagnostics().commands - beforeCommands <= 1, "cancelling should not drain the remaining repository queue");
  } finally {
    await activity.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("project config rejects an observation budget below the derived minimum", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-config-"))),
    configPath = join(root, "project.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "invalid", displayName: "Invalid" },
      sourceRoot: root,
      repositories: [],
      limits: { gitTimeoutSeconds: 30, observationTimeoutSeconds: 34 },
    }),
  );
  try {
    assert.throws(
      () => loadConfig(configPath),
      (error: any) => error?.code === "config_invalid" && /at least 35 seconds/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git rejects an observation that has already passed its deadline", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      new Git(join(f.root, "one"), 1_000, Date.now() - 1).run(["status"]),
      (error: any) => error?.code === "observation_timeout",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("Node backend preserves public rejection codes and idempotent records", async () => {
  const f = fixture();
  const service = new Service(f.config);
  try {
    for (const [method, params, code] of [
      ["missing.method", {}, "method_not_allowed"],
      ["agent.execute", {}, "agent_provider_required"],
      ["workspace.detail", { workspaceId: "missing" }, "workspace_missing"],
      ["workspace.runtime", { workspaceId: "main" }, "workspace_not_managed"],
      ["workspace.prepare", { workspaceId: "main", repositoryId: "one" }, "capability_unavailable"],
    ] as Array<[string, Json, string]>) {
      await assert.rejects(service.handle(method, params), (error: any) => {
        assert.equal(error.code, code, method);
        return true;
      });
    }
    const request = { requestId: "create-sample-1", name: "sample", repositories: ["one"], baseRefs: { one: "HEAD" } };
    const created = await service.handle("workspace.create", request);
    const repeated = await service.handle("workspace.create", request);
    assert.equal(repeated.requestHash, created.requestHash);
    assert.equal(repeated.createdAt, created.createdAt);
    assert.equal(repeated.operationId, "create-sample-1");
    const operation = await service.handle("workspace.operation.status", { operationId: "create-sample-1" });
    assert.equal(operation.workspaceId, created.id);
    assert.equal(operation.stage, "active");
    await assert.rejects(
      service.handle("workspace.create", { ...request, repositories: ["two"], baseRefs: { two: "HEAD" } }),
      (error: any) => error?.code === "request_identity_conflict",
    );
    const added = await service.handle("workspace.addRepositories", {
      workspaceId: created.id,
      repositories: ["two"],
      baseRefs: { two: "HEAD" },
    });
    assert.equal(added.repositories.length, 2);
    assert.deepEqual(added.addedRepositories, ["two"]);
    assert.deepEqual(added.existingRepositories, []);
    const repeatedAdd = await service.handle("workspace.addRepositories", {
      workspaceId: created.id,
      repositories: ["two"],
      baseRefs: { two: "HEAD" },
    });
    assert.deepEqual(repeatedAdd.addedRepositories, []);
    assert.deepEqual(repeatedAdd.existingRepositories, ["two"]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(added.treePath, ".workspace/manifest.json"), "utf8")).repositories,
      added.repositories,
    );
    const runtime = await service.handle("workspace.runtime", { workspaceId: created.id });
    assert.equal(runtime.repositories.length, 2);
    assert.equal((await service.handle("review-set.brief", { workspaceIds: [created.id] })).repositories.length, 2);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("historical execution reports do not block safe workspace cleanup", async () => {
  const f = fixture(), service = new Service(f.config);
  try {
    const created = await service.handle("workspace.create", { name: "report-receipt", repositories: ["one"] });
    const reviews = join(f.config.stateRoot, "reviews");
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, "execution-report.json"), JSON.stringify({
      workspaceId: created.id,
      executionAgentId: "worker",
      report: { status: "ready_for_review", summary: "historical receipt" },
    }));
    await service.handle("workspace.remove", { workspaceId: created.id });
    const preview = await service.handle("workspace.cleanup", { workspaceId: created.id });
    assert.equal(preview.preview, true);
    await service.handle("workspace.cleanup", { workspaceId: created.id, confirm: true });
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native additions recover partial failures, timeouts, and preserve modified branches", async () => {
  const f = fixture(),
    service = new Service(f.config);
  const original = Git.prototype.run;
  let failure = true;
  try {
    const initial = await service.handle("workspace.create", {
      name: "sample",
      repositories: ["one"],
    });
    Git.prototype.run = async function (args, check = true) {
      if (
        failure &&
        this.path.endsWith("/three") &&
        args[0] === "worktree" &&
        args[1] === "add"
      )
        throw new WorkbenchError("git_timeout", "injected");
      return original.call(this, args, check);
    };
    const request = {
      workspaceId: "sample",
      repositories: ["two", "three"],
      baseRefs: { two: "HEAD", three: "HEAD" },
    };
    await assert.rejects(service.handle("workspace.addRepositories", request));
    assert.equal(service.workspaces.get("sample").repositories.length, 2);
    await assert.rejects(
      service.handle("workspace.runtime", { workspaceId: "sample" }),
      /recover repository/,
    );
    failure = false;
    assert.equal(
      (await service.handle("workspace.addRepositories", request)).repositories
        .length,
      3,
    );
    assert.equal(
      (await service.handle("workspace.addRepositories", request)).repositories
        .length,
      3,
    );
    assert.equal(service.workspaces.get("sample").createdAt, initial.createdAt);
    writeFileSync(join(initial.treePath, "one/README.md"), "user changes\n");
    writeFileSync(join(initial.treePath, "one/.gitignore"), ".cache/\n");
    mkdirSync(join(initial.treePath, "one/.cache"), { recursive: true });
    writeFileSync(join(initial.treePath, "one/.cache/ignored.bin"), "ignored cache\n");
    writeFileSync(join(initial.treePath, "extra.txt"), "extra workspace content\n");
    const outside = join(f.root, "outside-target");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside\n");
    symlinkSync(outside, join(initial.treePath, "outside-link"));
    mkdirSync(f.config.cacheRoot, { recursive: true });
    const externalCache = join(f.config.cacheRoot, "keep.bin");
    writeFileSync(externalCache, "cache stays\n");
    await service.handle("workspace.remove", { workspaceId: "sample" });
    const preview = await service.handle("workspace.delete", { workspaceId: "sample", confirm: false });
    assert.equal(preview.canDelete, true);
    assert.equal(preview.requiresDataLossConfirmation, true);
    assert.ok(preview.dataLossSummary.repositories.some((repo: { repositoryId: string; paths: string[] }) =>
      repo.repositoryId === "one" && repo.paths.some((path) => path.includes(".cache"))));
    assert.ok(preview.dataLossSummary.extraPaths.includes("extra.txt"));
    await assert.rejects(
      service.handle("workspace.delete", {
        workspaceId: "sample",
        confirm: true,
      }),
      /Explicit data-loss confirmation is required/,
    );
    assert.equal(readFileSync(join(initial.treePath, "one/README.md"), "utf8"), "user changes\n");
    const deleted = await service.handle("workspace.delete", { workspaceId: "sample", confirm: true, confirmDataLoss: true });
    assert.equal(deleted.deleted, true);
    assert.equal(existsSync(initial.treePath), false);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "outside\n");
    assert.equal(readFileSync(externalCache, "utf8"), "cache stays\n");
  } finally {
    Git.prototype.run = original;
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Node runtime preparation supports Node and Python project requirements", async () => {
  const f = fixture({
    toolchain: {
      mode: "system",
      runtimePaths: [dirname(process.execPath)],
      repositories: {
        one: { node: process.versions.node.split(".")[0] },
        two: { python: "3.11" },
      },
    },
  });
  const service = new Service(f.config);
  try {
    const created = await service.handle("workspace.create", { name: "sample", repositories: ["one"] });
    const prepared = await service.handle("workspace.prepare", { workspaceId: created.id, repositoryId: "one" });
    assert.equal(prepared.status, "ready");
    const runtime = await service.handle("workspace.runtime", { workspaceId: created.id });
    assert.equal(runtime.toolchain.environment.variables.NPM_CONFIG_CACHE, join(service.runtime!.cacheRoot(created), "npm"));
    assert.equal(service.runtime?.requirements.two.python, "3.11");
    const raw = JSON.parse(readFileSync(f.configPath, "utf8"));
    raw.toolchain.repositories.two = { python: "3.11" };
    writeFileSync(f.configPath, JSON.stringify(raw));
    await service.handle("observer.reload");
    assert.equal(service.runtime?.requirements.two.python, "3.11");
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cache single-flight, refresh, persistence and bounds", async () => {
  const f = fixture({ limits: { cacheTtlSeconds: 0.5 } }),
    cache = new ObservationCache(f.config);
  let calls = 0;
  try {
    const producer = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        value: calls,
        observation: { state: "ready", observedAt: new Date().toISOString() },
      };
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.read("key", "one", producer)),
    );
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.value === 1));
    assert.equal(
      (await cache.read("key", "two", producer)).cache.refreshing,
      true,
    );
    const refreshing = await cache.read("key", "two", producer);
    assert.equal(refreshing.observation.state, "ready");
    assert.equal(refreshing.observation.cacheState, "refreshing");
    assert.equal(refreshing.observation.refreshing, true);
    await new Promise((r) => setTimeout(r, 30));
    const fresh = await cache.read("key", "two", producer);
    assert.equal(fresh.value, 2);
    assert.equal(fresh.observation.state, "ready");
    assert.equal(fresh.observation.cacheState, "fresh");
    assert.equal(fresh.observation.refreshing, false);
    await cache.close();
    const reopened = new ObservationCache(f.config);
    assert.equal((await reopened.read("key", "two", producer)).value, 2);
    await reopened.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cache preserves stale data across transient refresh failures", async () => {
  const f = fixture({ limits: { cacheTtlSeconds: 0.5 } });
  const cache = new ObservationCache(f.config);
  try {
    await cache.read("failed-refresh", "one", async () => ({
      value: "last-good",
      observation: { state: "ready", observedAt: "2026-01-01T00:00:00Z" },
    }));
    await new Promise((r) => setTimeout(r, 550));
    const stale = await cache.read("failed-refresh", "two", async () => {
      throw new WorkbenchError("git_timeout", "injected refresh timeout");
    });
    assert.equal(stale.value, "last-good");
    assert.equal(stale.observation.state, "ready");
    assert.equal(stale.observation.cacheState, "refreshing");
    await new Promise((r) => setTimeout(r, 30));

    const afterFailure = await cache.read("failed-refresh", "two", async () => {
      throw new WorkbenchError("git_timeout", "injected refresh timeout");
    });
    assert.equal(afterFailure.value, "last-good");
    assert.equal(afterFailure.observation.state, "ready");
    await new Promise((r) => setTimeout(r, 30));

    await cache.read("failed-refresh", "three", async () => ({
      value: "recovered",
      observation: { state: "ready", observedAt: "2026-01-02T00:00:00Z" },
    }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      (await cache.read("failed-refresh", "three", async () => {
        throw new Error("unexpected second recovery");
      })).value,
      "recovered",
    );
  } finally {
    await cache.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("slow fingerprints do not block cached data and changed fingerprints refresh once", async () => {
  const f = fixture({ limits: { cacheTtlSeconds: 0.5 } });
  const cache = new ObservationCache(f.config);
  let refreshes = 0;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await cache.read("slow-fingerprint", "old", async () => ({
      value: "last-good",
      observation: { state: "ready", observedAt: "2026-01-01T00:00:00Z" },
    }));
    const started = Date.now();
    const cached = await cache.read(
      "slow-fingerprint",
      async () => {
        await wait(200);
        return "new";
      },
      async () => {
        refreshes++;
        return {
          value: "new-value",
          observation: { state: "ready", observedAt: "2026-01-02T00:00:00Z" },
        };
      },
    );
    assert.ok(Date.now() - started < 100);
    assert.equal(cached.value, "last-good");
    await wait(260);
    assert.equal(refreshes, 1);
    assert.equal(
      (await cache.read("slow-fingerprint", async () => "new", async () => {
        throw new Error("unexpected second refresh");
      })).value,
      "new-value",
    );
  } finally {
    await cache.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("persisted workspace detail is shown before a new scheduler registers every repository", async () => {
  const f = fixture();
  let service = new Service(f.config);
  const originalRun = Git.prototype.run;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const first = await service.handle("workspace.detail", { workspaceId: "main" });
    assert.equal(first.observation.state, "ready");
    await service.close();

    service = new Service(f.config);
    Git.prototype.run = async function (args, check = true) {
      await wait(300);
      return originalRun.call(this, args, check);
    };
    const started = Date.now();
    const cached = await service.handle("workspace.detail", { workspaceId: "main" });
    assert.ok(Date.now() - started < 200, "a persisted detail must not wait for watcher/Git registration");
    assert.equal(cached.observation.state, "ready");
    assert.equal(cached.repositories.length, first.repositories.length);
  } finally {
    Git.prototype.run = originalRun;
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cache evicts stale data for durable refresh failures", async () => {
  const f = fixture({ limits: { cacheTtlSeconds: 0.5 } });
  const cache = new ObservationCache(f.config);
  try {
    await cache.read("durable-refresh", "one", async () => ({
      value: "old",
      observation: { state: "ready", observedAt: "2026-01-01T00:00:00Z" },
    }));
    await new Promise((r) => setTimeout(r, 550));
    const stale = await cache.read("durable-refresh", "two", async () => {
      throw new WorkbenchError("path_invalid", "injected invalid path");
    });
    assert.equal(stale.value, "old");
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(
      cache.read("durable-refresh", "two", async () => {
        throw new WorkbenchError("path_invalid", "invalid path remains invalid");
      }),
      /invalid path remains invalid/,
    );
  } finally {
    await cache.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("observation cache closes new work and releases retained entries", async () => {
  const f = fixture();
  const cache = new ObservationCache(f.config);
  try {
    await cache.read("close-me", "v1", async () => ({ observation: { state: "ready" }, value: "held" }), true, true);
    assert.equal(cache.status().memory.entries, 1);
    await cache.close();
    assert.equal(cache.status().closed, true);
    assert.equal(cache.status().memory.entries, 0);
    await assert.rejects(cache.read("after-close", "v1", async () => ({ observation: { state: "ready" } })), /observation cache is closed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("repository graph and changes keep ready state during stale branch refresh", async () => {
  const f = fixture({ limits: { cacheTtlSeconds: 0.5 } });
  const service = new Service(f.config);
  try {
    const workspace = await service.handle("workspace.create", {
      name: "branch-refresh",
      repositories: ["one"],
    });
    const graphParams = {
      workspaceId: workspace.id,
      repositoryId: "one",
      historyMode: "branch",
      maxCommits: 50,
    };
    const changesParams = {
      workspaceId: workspace.id,
      repositoryId: "one",
      scope: "branch",
    };
    const graph = await service.handle("repository.graph", graphParams);
    const changes = await service.handle("repository.changes", changesParams);
    assert.equal(graph.observation.state, "ready");
    assert.equal(changes.observation.state, "ready");
    await new Promise((r) => setTimeout(r, 550));

    // TTL is not invalidation. Explicitly invalidate the same cached snapshots.
    assert.equal((await service.handle("repository.graph", graphParams)).cache.refreshing, false);
    service.observation.scheduler.force(workspace.id);
    const staleGraph = await service.handle("repository.graph", graphParams);
    const staleChanges = await service.handle("repository.changes", changesParams);
    assert.equal(staleGraph.observation.state, "ready");
    assert.equal(staleGraph.observation.cacheState, "refreshing");
    assert.equal(staleGraph.cache.refreshing, true);
    assert.equal(staleChanges.observation.state, "ready");
    assert.equal(staleChanges.observation.cacheState, "refreshing");
    assert.equal(staleChanges.cache.refreshing, true);

    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await service.handle("repository.graph", graphParams)).observation.state, "ready");
    assert.equal((await service.handle("repository.changes", changesParams)).observation.state, "ready");
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("activity and path traversal fail closed while branch-backed commits survive permanent deletion", async () => {
  const f = fixture(),
    service = new Service(f.config);
  try {
    const w = await service.handle("workspace.create", {
      name: "sample",
      repositories: ["one"],
    });
    writeFileSync(
      join(f.config.stateRoot, "agent-bindings.json"),
      JSON.stringify({
        bindings: [{ workspaceId: "sample", status: "running" }],
      }),
    );
    await assert.rejects(
      service.handle("workspace.addRepositories", {
        workspaceId: "sample",
        repositories: ["two"],
      }),
      /finish execution/,
    );
    writeFileSync(
      join(f.config.stateRoot, "agent-bindings.json"),
      JSON.stringify({ bindings: [] }),
    );
    await assert.rejects(
      service.handle("repository.diff", {
        workspaceId: "sample",
        repositoryId: "one",
        scope: "working",
        path: "../secret",
      }),
    );
    await service.handle("workspace.addRepositories", { workspaceId: "sample", repositories: ["two"] });
    const committedHeads: Record<string, string> = {};
    const preservedBranches: Record<string, string> = {};
    for (const repositoryId of ["one", "two"]) {
      writeFileSync(join(w.treePath, repositoryId, "README.md"), "committed\n");
      git(join(w.treePath, repositoryId), ["add", "."]);
      git(join(w.treePath, repositoryId), ["commit", "-qm", "user commit"]);
      committedHeads[repositoryId] = git(join(w.treePath, repositoryId), ["rev-parse", "HEAD"]);
      preservedBranches[repositoryId] = git(join(w.treePath, repositoryId), ["branch", "--show-current"]);
    }
    await service.handle("workspace.remove", { workspaceId: "sample" });
    const preview = await service.handle("workspace.delete", { workspaceId: "sample", confirm: false });
    assert.equal(preview.canDelete, true);
    assert.deepEqual(preview.branchesPreserved, Object.values(preservedBranches));
    const deleted = await service.handle("workspace.delete", { workspaceId: "sample", confirm: true });
    assert.equal(deleted.deleted, true);
    for (const repositoryId of ["one", "two"]) {
      const source = join(f.root, repositoryId);
      assert.equal(git(source, ["rev-parse", `refs/heads/${preservedBranches[repositoryId]}`]), committedHeads[repositoryId]);
      assert.equal(git(source, ["cat-file", "-e", `${committedHeads[repositoryId]}^{commit}`]), "");
    }
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("permanent deletion warns on registered branch drift and preserves both branches", async () => {
  const f = fixture(), service = new Service(f.config);
  try {
    const workspace = await service.handle("workspace.create", { name: "branch-drift", repositories: ["one"] });
    const repo = workspace.repositories[0];
    const currentBranch = "release/branch-drift";
    git(repo.sourcePath, ["branch", currentBranch]);
    git(repo.worktreePath, ["checkout", "-q", currentBranch]);
    writeFileSync(join(repo.worktreePath, "uncommitted.txt"), "discard only after confirmation\n");
    await service.handle("workspace.remove", { workspaceId: workspace.id });

    const preview = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: false });
    assert.equal(preview.canDelete, true);
    assert.equal(preview.requiresDataLossConfirmation, true);
    assert.deepEqual(preview.gitIdentityWarnings, [{
      repositoryId: repo.id,
      code: "worktree_branch_changed",
      recordedBranch: repo.branch,
      currentBranch,
    }]);
    await assert.rejects(service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true }), /Explicit data-loss confirmation is required/);
    const deleted = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true, confirmDataLoss: true });
    assert.equal(deleted.deleted, true);
    assert.ok(deleted.branchesPreserved.includes(repo.branch));
    assert.ok(deleted.branchesPreserved.includes(currentBranch));
    assert.equal(existsSync(workspace.treePath), false);
    assert.notEqual(git(repo.sourcePath, ["show-ref", "--verify", "--hash", `refs/heads/${currentBranch}`]), "");
    assert.notEqual(git(repo.sourcePath, ["show-ref", "--verify", "--hash", `refs/heads/${repo.branch}`]), "");
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("permanent deletion falls back to the managed tree when Git identity is unavailable", async () => {
  const f = fixture(), service = new Service(f.config);
  try {
    const workspace = await service.handle("workspace.create", { name: "unregistered-tree", repositories: ["one"] });
    const repo = workspace.repositories[0];
    const commit = git(repo.sourcePath, ["rev-parse", `refs/heads/${repo.branch}`]);
    await service.handle("workspace.remove", { workspaceId: workspace.id });
    git(repo.sourcePath, ["worktree", "remove", repo.worktreePath]);
    mkdirSync(repo.worktreePath, { recursive: true });
    writeFileSync(join(repo.worktreePath, "created-without-worktree-metadata.txt"), "inside Workspace boundary\n");

    const preview = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: false });
    assert.equal(preview.canDelete, true);
    assert.equal(preview.requiresDataLossConfirmation, true);
    assert.deepEqual(preview.gitIdentityWarnings, [{ repositoryId: repo.id, code: "worktree_cleanup_skipped" }]);
    await assert.rejects(
      service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true }),
      /Explicit data-loss confirmation is required/,
    );
    const deleted = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true, confirmDataLoss: true });
    assert.equal(deleted.deleted, true);
    assert.equal(existsSync(workspace.treePath), false);
    assert.equal(existsSync(service.workspaces.recordPath(workspace.id)), false);
    assert.equal(git(repo.sourcePath, ["show-ref", "--verify", "--hash", `refs/heads/${repo.branch}`]), commit);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("partial permanent deletion retains the record and can be retried", async () => {
  const f = fixture(), service = new Service(f.config), original = Git.prototype.run;
  let failSecondRepository = true;
  try {
    const workspace = await service.handle("workspace.create", { name: "partial-delete", repositories: ["one", "two"] });
    writeFileSync(join(workspace.treePath, "one/README.md"), "dirty\n");
    await service.handle("workspace.remove", { workspaceId: workspace.id });
    Git.prototype.run = async function (args, check = true) {
      if (failSecondRepository && this.path.endsWith("/two") && args[0] === "worktree" && args[1] === "remove")
        throw new WorkbenchError("injected_delete_failure", "injected second repository failure");
      return original.call(this, args, check);
    };
    await assert.rejects(service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true, confirmDataLoss: true }), /injected second repository failure/);
    assert.equal(existsSync(service.workspaces.recordPath(workspace.id)), true);
    assert.equal(existsSync(workspace.repositories.find((repo: { id: string }) => repo.id === "one").worktreePath), false);
    assert.equal(existsSync(workspace.repositories.find((repo: { id: string }) => repo.id === "two").worktreePath), true);
    assert.equal(service.workspaces.get(workspace.id).permanentDeletion.status, "in_progress");
    assert.throws(() => service.workspaces.restore({ workspaceId: workspace.id }), /must be retried before restoring/);
    failSecondRepository = false;
    const deleted = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true, confirmDataLoss: true });
    assert.equal(deleted.deleted, true);
    assert.equal(existsSync(service.workspaces.recordPath(workspace.id)), false);
    assert.equal(existsSync(workspace.treePath), false);
  } finally {
    Git.prototype.run = original;
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("permanent deletion never removes a configured cache root inside the managed tree", async () => {
  const f = fixture(), service = new Service(f.config);
  try {
    const workspace = await service.handle("workspace.create", { name: "cache-boundary", repositories: ["one"] });
    const cacheRoot = join(workspace.treePath, "one", ".cache");
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(join(cacheRoot, "keep.bin"), "cache\n");
    service.workspaces.config.cacheRoot = cacheRoot;
    await service.handle("workspace.remove", { workspaceId: workspace.id });
    const preview = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: false });
    assert.equal(preview.canDelete, false);
    assert.equal(preview.blockedReason, "workspace_cache_overlap");
    assert.equal(readFileSync(join(cacheRoot, "keep.bin"), "utf8"), "cache\n");
    assert.equal(existsSync(workspace.treePath), true);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("permanent deletion removes read-only nested module-cache directories inside the managed tree", async () => {
  const f = fixture(), service = new Service(f.config);
  let readOnlyModuleDir = "";
  try {
    const workspace = await service.handle("workspace.create", { name: "readonly-module-cache", repositories: ["one"] });
    readOnlyModuleDir = join(workspace.treePath, "build/halh-go-mod-cache/go1.26.8/cloud.google.com/go/compute/metadata@v0.9.0");
    mkdirSync(readOnlyModuleDir, { recursive: true });
    const changes = join(readOnlyModuleDir, "CHANGES.md");
    writeFileSync(changes, "read-only module cache entry\n");
    chmodSync(changes, 0o444);
    chmodSync(readOnlyModuleDir, 0o555);
    await service.handle("workspace.remove", { workspaceId: workspace.id });
    const preview = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: false });
    assert.equal(preview.canDelete, true);
    assert.equal(preview.requiresDataLossConfirmation, true);
    await assert.rejects(service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true }), /Explicit data-loss confirmation is required/);
    assert.equal(existsSync(changes), true);
    const deleted = await service.handle("workspace.delete", { workspaceId: workspace.id, confirm: true, confirmDataLoss: true });
    assert.equal(deleted.deleted, true);
    assert.equal(existsSync(workspace.treePath), false);
    assert.equal(existsSync(changes), false);
  } finally {
    try { if (readOnlyModuleDir && existsSync(readOnlyModuleDir)) chmodSync(readOnlyModuleDir, 0o755); } catch { /* Preserve the original failure. */ }
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native create reconciles Git completion followed by timeout", async () => {
  const f = fixture(),
    service = new Service(f.config),
    original = Git.prototype.run;
  try {
    Git.prototype.run = async function (args, check = true) {
      const result = await original.call(this, args, check);
      if (args[0] === "worktree" && args[1] === "add")
        throw new WorkbenchError("git_timeout", "injected after completion");
      return result;
    };
    const w = await service.handle("workspace.create", {
      name: "timeout",
      repositories: ["one"],
    });
    assert.equal(w.state, "active");
    assert.equal(
      (await service.handle("workspace.runtime", { workspaceId: w.id }))
        .repositories.length,
      1,
    );
  } finally {
    Git.prototype.run = original;
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("root, rename and symlink diffs preserve selected-path boundaries", async () => {
  const f = fixture(),
    service = new Service(f.config);
  try {
    const w = await service.handle("workspace.create", {
        name: "paths",
        repositories: ["one"],
      }),
      path = w.repositories[0].worktreePath;
    const initial = git(path, ["rev-parse", "HEAD"]);
    assert.match(
      (
        await service.handle("repository.diff", {
          workspaceId: w.id,
          repositoryId: "one",
          scope: "commit",
          commitSha: initial,
          path: "README.md",
        })
      ).patch,
      /initial/,
    );
    renameSync(join(path, "README.md"), join(path, "renamed.md"));
    git(path, ["add", "."]);
    git(path, ["commit", "-qm", "rename"]);
    const commit = git(path, ["rev-parse", "HEAD"]),
      params = {
        workspaceId: w.id,
        repositoryId: "one",
        scope: "commit",
        commitSha: commit,
      };
    const files = (await service.handle("repository.changes", params)).files;
    assert.equal(files[0].oldPath, "README.md");
    assert.equal(files[0].path, "renamed.md");
    assert.match(
      (
        await service.handle("repository.diff", {
          ...params,
          path: "renamed.md",
        })
      ).patch,
      /rename from README.md/,
    );
    const secret = join(f.root, "secret");
    writeFileSync(secret, "outside-secret");
    symlinkSync(secret, join(path, "external"));
    await assert.rejects(
      service.handle("repository.diff", {
        workspaceId: w.id,
        repositoryId: "one",
        scope: "working",
        path: "external",
      }),
      /outside repository/,
    );
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("local Node CLI execution validates prepared runtimes and init preserves existing config", async () => {
  const f = fixture({
      toolchain: {
        mode: "system",
        runtimePaths: [dirname(process.execPath)],
        repositories: { one: { node: process.versions.node.split(".")[0] } },
      },
    }),
    service = new Service(f.config);
  try {
    const before = readFileSync(f.configPath, "utf8");
    const init = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        resolve(import.meta.dirname, "../server/backend/main.ts"),
        "init",
        "--root",
        f.root,
        "--output",
        f.configPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(init.status, 1);
    assert.equal(readFileSync(f.configPath, "utf8"), before);
    await service.handle("workspace.create", {
      name: "local",
      repositories: ["one"],
    });
    await assert.rejects(
      executeLocal(service, "local", "one", [process.execPath, "--version"]),
      /prepare/,
    );
    await service.handle("workspace.prepare", {
      workspaceId: "local",
      repositoryId: "one",
    });
    assert.equal(
      await executeLocal(service, "local", "one", [
        process.execPath,
        "-e",
        `process.exit(process.env.NPM_CONFIG_CACHE===${JSON.stringify(join(service.runtime!.cacheRoot(service.workspaces.get("local")), "npm"))}&&process.env.GOTOOLCHAIN==='local'?0:1)`,
      ]),
      0,
    );
    service.runtime!.requirements.one.node = "999";
    await assert.rejects(
      executeLocal(service, "local", "one", [process.execPath, "--version"]),
      /prepare/,
    );
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("mise data is shared while caches are isolated by workspace", async () => {
  const f = fixture({ toolchain: { mode: "auto", manager: "mise", repositories: { one: { go: "1.26" } } } });
  const service = new Service(f.config);
  try {
    const first = await service.handle("workspace.create", { name: "first", repositories: ["one"] });
    const second = await service.handle("workspace.create", { name: "second", repositories: ["one"] });
    const a = service.runtime!.cache(first, ["go", "python", "node"], true);
    const b = service.runtime!.cache(second, ["go", "python", "node"], true);
    assert.equal(a.MISE_DATA_DIR, join(f.config.stateRoot, "toolchains", "mise"));
    assert.equal(a.MISE_DATA_DIR, b.MISE_DATA_DIR);
    for (const name of ["MISE_CACHE_DIR", "GOCACHE", "GOMODCACHE", "PIP_CACHE_DIR", "NPM_CONFIG_CACHE"]) {
      assert.ok(a[name].startsWith(service.runtime!.cacheRoot(first)));
      assert.ok(b[name].startsWith(service.runtime!.cacheRoot(second)));
      assert.notEqual(a[name], b[name]);
    }
    assert.equal(service.runtime!.summary(first).cache.scope, "workspace");
    assert.equal(service.runtime!.summary(first).environment.variables.MISE_DATA_DIR, a.MISE_DATA_DIR);
    assert.equal(service.runtime!.summary(first).environment.variables.MISE_CACHE_DIR, a.MISE_CACHE_DIR);
    assert.equal(git(join(f.root, "one"), ["status", "--porcelain"]), "");
    const blocked = join(f.root, "blocked-cache");
    writeFileSync(blocked, "not a directory");
    service.runtime!.config.cacheRoot = blocked;
    assert.throws(() => service.runtime!.cache(first, ["go"], true), (error: any) => error?.code === "runtime_cache_unavailable");
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("repository IDs matching JavaScript prototype names retain journals and runtime requirements", async () => {
  const f = fixture({
      repositories: [
        { id: "one", path: "one" },
        { id: "__proto__", path: "two" },
      ],
      toolchain: {
        mode: "system",
        repositories: JSON.parse('{"__proto__":{"node":"999"}}'),
      },
    }),
    service = new Service(f.config);
  try {
    await service.handle("workspace.create", {
      name: "keys",
      repositories: ["one"],
    });
    const result = await service.handle("workspace.addRepositories", {
      workspaceId: "keys",
      repositories: ["__proto__"],
    });
    assert.equal(result.repositories.length, 2);
    assert.equal(result.preparations[0].status, "prepare_failed");
    await assert.rejects(
      service.handle("workspace.runtime", { workspaceId: "keys" }),
      /prepare runtimes/,
    );
    const saved = service.workspaces.get("keys");
    assert.equal(saved.repositories[1].id, "__proto__");
    assert.equal(Object.keys(saved.repositoryAdditions).length, 0);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("workspace detail returns completed repositories when one Git observation times out", async () => {
  const f = fixture(),
    service = new Service(f.config),
    original = Git.prototype.run;
  try {
    await service.handle("workspace.create", {
      name: "partial-detail",
      repositories: ["one", "two", "three"],
    });
    Git.prototype.run = async function (args, check = true) {
      if (args[0] === "status" && this.path.endsWith("/one"))
        throw new WorkbenchError("observation_timeout", "injected observation timeout");
      return original.call(this, args, check);
    };
    const detail = await service.handle("workspace.detail", {
      workspaceId: "partial-detail",
    });
    assert.equal(detail.observation.state, "partial");
    assert.ok(detail.repositories.find((repo: Json) => String(repo.repoPath).endsWith("two"))?.head);
    assert.equal(
      detail.repositories.find((repo: Json) => String(repo.repoPath).endsWith("one"))?.issues[0]?.code,
      "observation_timeout",
    );
  } finally {
    Git.prototype.run = original;
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("partial observations retain successful rows without an endless refresh loop", async () => {
  const f = fixture(),
    cache = new ObservationCache(f.config);
  try {
    await cache.read("partial", "one", async () => ({
      repositories: [{ repoPath: "one", head: "known-good", issues: [] }],
      observation: { state: "ready", observedAt: "2026-01-01T00:00:00Z" },
    }));
    await cache.read("partial", "two", async () => ({
      repositories: [
        { repoPath: "one", head: null, issues: [{ code: "git_timeout" }] },
      ],
      observation: { state: "partial", observedAt: "2026-01-02T00:00:00Z" },
    }));
    await new Promise((r) => setTimeout(r, 10));
    const completed = await cache.read("partial", "two", async () => {
      throw new Error("unexpected refresh");
    });
    assert.equal(completed.cache.refreshing, false);
    assert.equal(completed.observation.state, "partial");
    assert.equal(
      completed.observation.lastSuccessfulAt,
      "2026-01-01T00:00:00Z",
    );
    assert.equal(completed.repositories[0].head, "known-good");
    assert.equal(completed.repositories[0].observationStale, true);
  } finally {
    await cache.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("repository symlink changes cannot escape the configured source root", async () => {
  const f = fixture(),
    outside = realpathSync(mkdtempSync("/tmp/wb-outside-")),
    service = new Service(f.config);
  try {
    await service.handle("workspace.create", {
      name: "boundary",
      repositories: ["one"],
    });
    renameSync(join(f.root, "two"), join(f.root, "saved-two"));
    symlinkSync(outside, join(f.root, "two"));
    await assert.rejects(
      service.handle("workspace.addRepositories", {
        workspaceId: "boundary",
        repositories: ["two"],
      }),
      (error: unknown) =>
        error instanceof WorkbenchError && error.code === "path_outside_root",
    );
    assert.equal(service.workspaces.get("boundary").repositories.length, 1);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("repository additions honor configured default base when the request omits a ref", async () => {
  const f = fixture({
      repositories: [
        { id: "one", path: "one" },
        { id: "two", path: "two", defaultBase: "base" },
      ],
    }),
    service = new Service(f.config);
  try {
    const source = join(f.root, "two");
    git(source, ["branch", "base"]);
    const expected = git(source, ["rev-parse", "base"]);
    writeFileSync(join(source, "README.md"), "later commit\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-qm", "later"]);
    await service.handle("workspace.create", {
      name: "base",
      repositories: ["one"],
    });
    const added = await service.handle("workspace.addRepositories", {
      workspaceId: "base",
      repositories: ["two"],
    });
    assert.equal(added.repositories[1].baseRef, "base");
    assert.equal(added.repositories[1].baseSha, expected);
  } finally {
    await service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
