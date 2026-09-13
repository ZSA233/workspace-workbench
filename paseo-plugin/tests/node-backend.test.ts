import { executeLocal } from "../server/backend/local-execution.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
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
import { Git } from "../server/backend/git.ts";
import { ObservationCache } from "../server/backend/cache.ts";
import { type Json, WorkbenchError } from "../server/backend/storage.ts";

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
    const request = { name: "sample", repositories: ["one"], baseRefs: { one: "HEAD" } };
    const created = await service.handle("workspace.create", request);
    const repeated = await service.handle("workspace.create", request);
    assert.equal(repeated.requestHash, created.requestHash);
    assert.equal(repeated.createdAt, created.createdAt);
    const added = await service.handle("workspace.addRepositories", {
      workspaceId: created.id,
      repositories: ["two"],
      baseRefs: { two: "HEAD" },
    });
    assert.equal(added.repositories.length, 2);
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
    await service.handle("workspace.remove", { workspaceId: "sample" });
    await assert.rejects(
      service.handle("workspace.delete", {
        workspaceId: "sample",
        confirm: true,
      }),
      /user changes/,
    );
    await service.handle("workspace.restore", { workspaceId: "sample" });
    assert.equal(
      readFileSync(join(initial.treePath, "one/README.md"), "utf8"),
      "user changes\n",
    );
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
    assert.equal(runtime.toolchain.environment.variables.NPM_CONFIG_CACHE, join(f.config.cacheRoot, "npm"));
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
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await cache.read("key", "two", producer)).value, 2);
    await cache.close();
    const reopened = new ObservationCache(f.config);
    assert.equal((await reopened.read("key", "two", producer)).value, 2);
    await reopened.close();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("activity, path traversal and changed commits fail closed", async () => {
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
    writeFileSync(join(w.treePath, "one/README.md"), "committed\n");
    git(join(w.treePath, "one"), ["add", "."]);
    git(join(w.treePath, "one"), ["commit", "-qm", "user commit"]);
    await service.handle("workspace.remove", { workspaceId: "sample" });
    await assert.rejects(
      service.handle("workspace.delete", {
        workspaceId: "sample",
        confirm: true,
      }),
      /contains commits/,
    );
  } finally {
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
        `process.exit(process.env.NPM_CONFIG_CACHE===${JSON.stringify(join(f.config.cacheRoot, "npm"))}&&process.env.GOTOOLCHAIN==='local'?0:1)`,
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
