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

test("main workspace selection discovers repository names without changing the managed catalog", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-main-")));
  const configured = join(root, "configured"), deploy = join(root, "deploy"), secrets = join(root, "go-secrets");
  repository(root); repository(configured); repository(deploy);
  for (const name of ["go-secrets", "secrets", ".hidden", "node_modules", "vendor", "dist", ".workspace-workbench"])
    repository(join(root, name));
  mkdirSync(join(secrets, "nested", ".git"), { recursive: true });
  const configPath = join(root, "project.json");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"), recordsRoot: join(root, "records"), treesRoot: join(root, "trees"), discovery: { mode: "manual", roots: ["."], maxDepth: 3 }, repositories: [{ id: "configured", path: "configured", enabled: true }] }));
  const original = readFileSync(configPath, "utf8");
  try {
    const workspaces = new Workspaces(loadConfig(configPath));
    const first = await workspaces.mainCandidates();
    assert.ok(first.repositories.some((repo: { path: string }) => repo.path === deploy));
    for (const name of ["go-secrets", "secrets", ".hidden", "node_modules", "vendor", "dist", ".workspace-workbench"]) {
      const candidate = first.repositories.find((repo: { path: string }) => repo.path === join(root, name));
      assert.ok(candidate, `${name} should be discoverable`);
      assert.equal(candidate.selected, false, `${name} should be opt-in`);
    }
    assert.ok(!first.repositories.some((repo: { path: string }) => repo.path === join(root, ".git")));
    assert.ok(!first.repositories.some((repo: { path: string }) => repo.path === join(secrets, "nested")));
    assert.equal(first.scan.incomplete, false);
    assert.deepEqual(workspaces.list()[0].repositories.map((repo: { id: string }) => repo.id), ["configured"]);
    const saved = await workspaces.saveMainSelection({ revision: first.revision, repositories: [deploy, secrets] });
    assert.equal(saved.revision, 1);
    assert.deepEqual(workspaces.list()[0].repositories.map((repo: { sourcePath: string }) => repo.sourcePath), [deploy, secrets]);
    assert.equal(readFileSync(configPath, "utf8"), original);
    await assert.rejects(workspaces.saveMainSelection({ revision: 0, repositories: [] }), /selection changed/);
    assert.equal(loadConfig(configPath).repositories.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit project exclusion still hides matching names and can be removed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-exclude-")));
  repository(join(root, "node_modules"));
  const configPath = join(root, "project.json");
  const value = { schemaVersion: 1, sourceRoot: root, stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"), recordsRoot: join(root, "records"), treesRoot: join(root, "trees"), discovery: { mode: "manual", roots: ["."], maxDepth: 3, exclude: ["node_modules"] }, repositories: [] };
  try {
    writeFileSync(configPath, JSON.stringify(value));
    assert.equal((await new Workspaces(loadConfig(configPath)).mainCandidates()).repositories.length, 0);
    writeFileSync(configPath, JSON.stringify({ ...value, discovery: { ...value.discovery, exclude: [] } }));
    assert.ok((await new Workspaces(loadConfig(configPath)).mainCandidates()).repositories.some((repo: { name: string }) => repo.name === "node_modules"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
