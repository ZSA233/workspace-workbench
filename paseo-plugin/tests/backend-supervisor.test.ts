import { spawn, spawnSync, execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import {
  BackendSupervisor,
  backendRequest,
} from "../server/backend-supervisor.ts";
import { loadConfig } from "../server/backend/config.ts";
import type { ProjectRoute } from "../server/projects.ts";

const entry = resolve(import.meta.dirname, "../server/backend/main.ts");
const pluginVersion = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
).version as string;
function fixture(name: string) {
  // Keep Unix socket addresses short on macOS.
  const root = realpathSync(mkdtempSync(join("/tmp", `wb-${name}-`)));
  const configPath = join(root, "project.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      project: { id: name },
      sourceRoot: root,
      stateRoot: join(root, "state"),
      workspaceRoot: join(root, "workspaces"),
      socketPath: join(root, "s.sock"),
      discovery: { mode: "manual" },
      repositories: [],
    }),
  );
  const config = loadConfig(configPath);
  return { root, route: { ...config, displayName: name } as ProjectRoute };
}
async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail("condition did not settle");
}

test("real Node processes: concurrent starts, two projects, generation reload and unload", async () => {
  const a = fixture("a"),
    b = fixture("b"),
    first = new BackendSupervisor(entry),
    second = new BackendSupervisor(entry);
  try {
    await Promise.all([
      first.ensure(a.route, pluginVersion),
      first.ensure(a.route, pluginVersion),
      first.ensure(b.route, pluginVersion),
    ]);
    const oldA = (await backendRequest(a.route.socketPath, "observer.health"))!
      .result.process;
    const oldB = (await backendRequest(b.route.socketPath, "observer.health"))!
      .result.process;
    assert.notEqual(oldA.pid, oldB.pid);
    const denied = await backendRequest(
      a.route.socketPath,
      "observer.shutdown",
      { token: "wrong" },
    );
    assert.equal(denied?.ok, false);
    await second.ensure(a.route, pluginVersion);
    const next = (await backendRequest(a.route.socketPath, "observer.health"))!
      .result.process;
    assert.notEqual(next.pid, oldA.pid);
    await first.close();
    assert.equal(
      (await backendRequest(a.route.socketPath, "observer.health"))?.result
        .process.pid,
      next.pid,
      "old unload must not stop replacement",
    );
    await until(() => !existsSync(b.route.socketPath));
    await second.close();
    await until(() => !existsSync(a.route.socketPath));
    assert.equal(existsSync(`${a.route.socketPath}.owner.json`), false);
  } finally {
    await first.close();
    await second.close();
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test("a crashed owned backend is restarted and its stale socket is reclaimed", async () => {
  const f = fixture("crash"),
    supervisor = new BackendSupervisor(entry);
  try {
    await supervisor.ensure(f.route, pluginVersion);
    const pid = (await backendRequest(f.route.socketPath, "observer.health"))!
      .result.process.pid;
    process.kill(pid, "SIGKILL");
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await supervisor.ensure(f.route, pluginVersion);
    const health = await backendRequest(f.route.socketPath, "observer.health");
    assert.notEqual(health!.result.process.pid, pid);
    assert.equal(health!.result.implementation, "node");
  } finally {
    await supervisor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unrelated Unix service is neither killed nor unlinked", async () => {
  const f = fixture("foreign"),
    supervisor = new BackendSupervisor(entry);
  const server = createServer((socket) => {
    socket.on("data", () =>
      socket.write(
        JSON.stringify({ ok: true, result: { service: "unrelated" } }) + "\n",
      ),
    );
  });
  await new Promise<void>((r) => server.listen(f.route.socketPath, r));
  try {
    await assert.rejects(supervisor.ensure(f.route, pluginVersion), /unrelated/);
    assert.ok(existsSync(f.route.socketPath));
    assert.equal(
      (await backendRequest(f.route.socketPath, "observer.health"))?.result
        .service,
      "unrelated",
    );
  } finally {
    await supervisor.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unload racing startup does not leave an orphan backend", async () => {
  const f = fixture("unload"),
    supervisor = new BackendSupervisor(entry);
  try {
    const start = supervisor.ensure(f.route, pluginVersion).catch(() => {});
    await supervisor.close();
    await start;
    await until(() => !existsSync(f.route.socketPath));
  } finally {
    await supervisor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("backend starts with no Python on PATH", async () => {
  const f = fixture("no-python"),
    supervisor = new BackendSupervisor(entry),
    previous = process.env.PATH;
  try {
    const bin = join(f.root, "empty-bin");
    mkdirSync(bin);
    process.env.PATH = bin;
    await supervisor.ensure(f.route, pluginVersion);
    assert.equal(
      (await backendRequest(f.route.socketPath, "observer.health"))?.result
        .implementation,
      "node",
    );
  } finally {
    process.env.PATH = previous;
    await supervisor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("parent exit during initialization closes the worker even before disconnect listeners exist", async () => {
  const f = fixture("parent-exit");
  let pid = 0;
  try {
    const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['--experimental-strip-types',${JSON.stringify(entry)},'serve','--config',${JSON.stringify(f.route.configPath)}],{env:{...process.env,WORKBENCH_BACKEND_TOKEN:'fixture-token',WORKBENCH_BACKEND_PARENT_PID:String(process.pid)},stdio:['ignore','ignore','ignore','ipc']});process.stdout.write(String(child.pid));setTimeout(()=>process.exit(0),10);`;
    const parent = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 5000,
    });
    pid = Number(parent.stdout);
    assert.ok(pid > 0);
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(existsSync(f.route.socketPath), false);
  } finally {
    if (pid)
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("replacement waits for an in-flight real Git operation to drain", async () => {
  const f = fixture("drain"),
    a = new BackendSupervisor(entry),
    b = new BackendSupervisor(entry);
  const repo = join(f.root, "repo");
  mkdirSync(repo);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "file"), "initial");
  git(["add", "."]);
  git(["commit", "-qm", "initial"]);
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(f.route.configPath)},'utf8'))`,
      ],
      { encoding: "utf8" },
    ),
  );
  config.repositories = [{ id: "repo", path: "repo" }];
  writeFileSync(f.route.configPath, JSON.stringify(config));
  writeFileSync(
    join(repo, ".git/hooks/post-checkout"),
    "#!/bin/sh\nsleep 1\n",
    { mode: 0o755 },
  );
  try {
    await a.ensure(f.route, pluginVersion);
    const create = backendRequest(
      f.route.socketPath,
      "workspace.create",
      { name: "sample", repositories: ["repo"] },
      5000,
    );
    await until(
      async () =>
        ((await backendRequest(f.route.socketPath, "observer.health"))?.result
          .process.activeRequests || 0) > 0,
    );
    await b.ensure(f.route, pluginVersion);
    assert.equal((await create)?.ok, true);
    const runtime = await backendRequest(
      f.route.socketPath,
      "workspace.runtime",
      { workspaceId: "sample" },
    );
    assert.equal(runtime?.ok, true);
  } finally {
    await a.close();
    await b.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a second socket cannot create another writer for the same records", async () => {
  const f = fixture("single-owner"),
    supervisor = new BackendSupervisor(entry);
  try {
    await supervisor.ensure(f.route, pluginVersion);
    const second = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        entry,
        "serve",
        "--config",
        f.route.configPath,
        "--socket",
        join(f.root, "other.sock"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(second.status, 1);
    assert.match(second.stderr, /another process owns/);
    assert.equal(
      (await backendRequest(f.route.socketPath, "observer.health"))?.ok,
      true,
    );
  } finally {
    await supervisor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("ownership publication failure closes the socket and project lease", async () => {
  const f = fixture("publish-failure"),
    supervisor = new BackendSupervisor(entry);
  const owner = `${f.route.socketPath}.owner.json`;
  mkdirSync(owner);
  try {
    await assert.rejects(supervisor.ensure(f.route, pluginVersion));
    await until(() => !existsSync(f.route.socketPath));
    rmSync(owner, { recursive: true });
    await supervisor.ensure(f.route, pluginVersion);
    assert.equal(
      (await backendRequest(f.route.socketPath, "observer.health"))?.ok,
      true,
    );
  } finally {
    await supervisor.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
