import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/backend/config.ts";
import { Workspaces } from "../server/backend/workspaces.ts";

function git(path: string, ...args: string[]) { return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim(); }
function repository(path: string) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "config", "user.name", "Fixture");
  git(path, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(path, "README.md"), "fixture\n");
  git(path, "add", "."); git(path, "commit", "-qm", "initial");
}

test("main workspace selection discovers nested repositories without changing the managed catalog", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-main-")));
  const configured = join(root, "configured"), deploy = join(root, "deploy"), secrets = join(root, "go-secrets");
  repository(root); repository(configured); repository(deploy); repository(secrets);
  const configPath = join(root, "project.json");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"), recordsRoot: join(root, "records"), treesRoot: join(root, "trees"), discovery: { mode: "manual", roots: ["."], maxDepth: 3 }, repositories: [{ id: "configured", path: "configured", enabled: true }] }));
  const original = readFileSync(configPath, "utf8");
  try {
    const workspaces = new Workspaces(loadConfig(configPath));
    const first = workspaces.mainCandidates();
    assert.ok(first.repositories.some((repo: { path: string }) => repo.path === deploy));
    assert.ok(!first.repositories.some((repo: { path: string }) => repo.path === secrets));
    assert.deepEqual(workspaces.list()[0].repositories.map((repo: { id: string }) => repo.id), ["configured"]);
    const saved = workspaces.saveMainSelection({ revision: first.revision, repositories: [deploy] });
    assert.equal(saved.revision, 1);
    assert.deepEqual(workspaces.list()[0].repositories.map((repo: { sourcePath: string }) => repo.sourcePath), [deploy]);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.throws(() => workspaces.saveMainSelection({ revision: 0, repositories: [] }), /selection changed/);
    assert.equal(loadConfig(configPath).repositories.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
