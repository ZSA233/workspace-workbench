import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/backend/config.ts";
import { Service } from "../server/backend/service.ts";
import { Git } from "../server/backend/git.ts";
import { WorkbenchError } from "../server/backend/storage.ts";

function git(path: string, ...args: string[]) { return execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim(); }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-orphan-")));
  const tree = join(root, "workspaces", "trees", "lost"), sources = ["alpha", "beta"];
  mkdirSync(tree, { recursive: true });
  for (const id of sources) {
    const source = join(root, id); mkdirSync(source);
    git(source, "init", "-q"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(source, "README"), `${id}\n`);
    git(source, "add", "README"); git(source, "commit", "-qm", "initial");
    git(source, "worktree", "add", "-q", "--detach", join(tree, id), "HEAD");
  }
  const configPath = join(root, "project.json");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: root,
    workspaceRoot: join(root, "workspaces"), stateRoot: join(root, "workspaces", ".workbench"),
    repositories: sources.map(id => ({ id, path: id, enabled: true })),
    discovery: { mode: "manual" }, management: { enabled: true } }));
  return { root, tree, service: new Service(loadConfig(configPath)) };
}

test("orphan is auto-listed, previewed, and adopted without inventing a base", async () => {
  const f = fixture();
  try {
    const list = await f.service.handle("workspace.list");
    assert.deepEqual(list.orphanCandidates.map((item: { id: string }) => item.id), ["lost"]);
    assert.equal(list.workspaces.some((item: { id: string }) => item.id === "lost"), false);
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, true);
    assert.equal(preview.repositories.length, 2);
    assert.ok(preview.repositories.every((repo: { branch: string | null }) => repo.branch === null));
    const request = { workspaceId: "lost", fingerprint: preview.fingerprint, branches: { alpha: "recovered/lost/alpha" } };
    const adopted = await f.service.handle("workspace.orphan.adopt", request);
    assert.equal(adopted.state, "active"); assert.equal(adopted.origin, "adopted");
    assert.equal(adopted.repositories.find((repo: { id: string }) => repo.id === "alpha").baseRef, null);
    assert.equal(adopted.repositories.find((repo: { id: string }) => repo.id === "beta").baseSha, null);
    assert.equal(git(join(f.tree, "alpha"), "branch", "--show-current"), "recovered/lost/alpha");
    assert.equal(git(join(f.tree, "beta"), "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.equal((await f.service.handle("workspace.orphan.adopt", request)).state, "active");
    const after = await f.service.handle("workspace.list");
    assert.equal(after.orphanCandidates.length, 0);
    assert.ok(after.workspaces.some((item: { id: string }) => item.id === "lost"));
    const detail = await f.service.handle("workspace.detail", { workspaceId: "lost" });
    assert.equal(detail.repositories.length, 2);
    const graph = await f.service.handle("repository.graph", { workspaceId: "lost", repoPath: "alpha", historyMode: "branch", maxCommits: 50 });
    assert.ok(graph.nodes.length > 0);
    const working = await f.service.handle("repository.changes", { workspaceId: "lost", repoPath: "alpha", scope: "working" });
    assert.deepEqual(working.files, []);
    const runtime = await f.service.handle("workspace.runtime", { workspaceId: "lost" });
    assert.equal(runtime.repositories.length, 2);
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    const impact = await f.service.handle("workspace.delete", { workspaceId: "lost", confirm: false });
    assert.equal(impact.canDelete, true);
    assert.equal(impact.detachedSafetyRefs.length, 1);
    await f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true });
    assert.equal(existsSync(f.tree), false);
    assert.equal(git(join(f.root, "beta"), "show-ref", "--verify", impact.detachedSafetyRefs[0].ref).split(/\s+/)[0], preview.repositories.find((repo: { id: string }) => repo.id === "beta").head);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("preview changes, branch collisions, edits, and commits block unsafe adoption or cleanup", async () => {
  const f = fixture();
  try {
    const original = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    git(join(f.root, "alpha"), "branch", "recovered/lost/alpha");
    await assert.rejects(f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: original.fingerprint, branches: { alpha: "recovered/lost/alpha" } }), /already exists/);
    git(join(f.tree, "alpha"), "switch", "-c", "different");
    await assert.rejects(f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: original.fingerprint, branches: {} }), /changed after preview/);
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    await f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} });
    writeFileSync(join(f.tree, "beta", "README"), "edit\n");
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /user changes/);
    git(join(f.tree, "beta"), "restore", "README");
    writeFileSync(join(f.tree, "beta", "README"), "commit\n");
    git(join(f.tree, "beta"), "commit", "-qam", "later");
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /not protected by a retained branch/);
    assert.equal(existsSync(f.tree), true);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("partial branch switch resumes from persisted adoption plan without duplicate branches", async () => {
  const f = fixture(), original = Git.prototype.run;
  try {
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    let fail = true;
    Git.prototype.run = async function(args: string[], check = true) {
      if (fail && this.path === join(f.tree, "beta") && args[0] === "switch") {
        fail = false; throw new WorkbenchError("git_failed", "injected failure");
      }
      return original.call(this, args, check);
    };
    const request = { workspaceId: "lost", fingerprint: preview.fingerprint, branches: { alpha: "recovered/lost/alpha", beta: "recovered/lost/beta" } };
    await assert.rejects(f.service.handle("workspace.orphan.adopt", request), /injected failure/);
    assert.equal(f.service.workspaces.get("lost").state, "adopt_failed");
    assert.equal((await f.service.handle("workspace.list")).orphanCandidates[0].resume, true);
    assert.deepEqual((await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" })).plannedBranches, request.branches);
    Git.prototype.run = original;
    const resumed = await f.service.handle("workspace.orphan.adopt", request);
    assert.equal(resumed.state, "active");
    assert.equal(git(join(f.tree, "alpha"), "branch", "--show-current"), "recovered/lost/alpha");
    assert.equal(git(join(f.tree, "beta"), "branch", "--show-current"), "recovered/lost/beta");
    assert.ok(readFileSync(f.service.workspaces.recordPath("lost"), "utf8").includes('"origin": "adopted"'));
  } finally { Git.prototype.run = original; await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an invalid legacy record and extra metadata remain visible and are preserved during adoption", async () => {
  const f = fixture();
  try {
    const recordPath = f.service.workspaces.recordPath("lost");
    writeFileSync(recordPath, "{legacy record}");
    mkdirSync(join(f.tree, ".workspace"));
    writeFileSync(join(f.tree, ".workspace", "notes.txt"), "keep me");
    const listed = await f.service.handle("workspace.list");
    assert.equal(listed.orphanCandidates[0].recordInvalid, true);
    assert.equal(listed.workspaces.some((item: { id: string }) => item.id === "lost"), false);
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, true);
    assert.ok(preview.warnings.some((item: { code: string }) => item.code === "record_invalid"));
    assert.ok(preview.warnings.some((item: { code: string }) => item.code === "workspace_metadata_unknown"));
    const adopted = await f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} });
    assert.equal(adopted.state, "active");
    assert.equal(readFileSync(adopted.adoption.existingRecordBackup, "utf8"), "{legacy record}");
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /metadata contains user files/);
    assert.equal(readFileSync(join(f.tree, ".workspace", "notes.txt"), "utf8"), "keep me");
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("nested repository paths can be adopted and cleanly removed without deleting unrelated paths", async () => {
  const f = fixture();
  try {
    const source = join(f.root, "h5", "saba_manage"), target = join(f.tree, "h5", "saba_manage");
    mkdirSync(source, { recursive: true });
    git(source, "init", "-q"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(source, "README"), "h5\n"); git(source, "add", "README"); git(source, "commit", "-qm", "initial");
    mkdirSync(join(f.tree, "h5")); git(source, "worktree", "add", "-q", "--detach", target, "HEAD");
    const configPath = f.service.config.configPath;
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.repositories.push({ id: "h5/saba_manage", path: "h5/saba_manage", enabled: true });
    writeFileSync(configPath, JSON.stringify(config));
    f.service.workspaces.config = loadConfig(configPath);
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, true);
    assert.equal(preview.repositories.length, 3);
    await f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} });
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true });
    assert.equal(existsSync(f.tree), false);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("symlinked workspace metadata cannot be adopted", async () => {
  const f = fixture();
  try {
    const external = join(f.root, "external"); mkdirSync(external);
    symlinkSync(external, join(f.tree, ".workspace"));
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, false);
    assert.ok(preview.issues.some((item: { code: string }) => item.code === "workspace_metadata_unsafe"));
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("concurrent adoption is idempotent and dirty content is retained", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.tree, "beta", "README"), "user work\n");
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.repositories.find((repo: { id: string }) => repo.id === "beta").dirty, true);
    const request = { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} };
    const results = await Promise.all([f.service.handle("workspace.orphan.adopt", request), f.service.handle("workspace.orphan.adopt", request)]);
    assert.deepEqual(results.map(item => item.state), ["active", "active"]);
    assert.equal(readFileSync(join(f.tree, "beta", "README"), "utf8"), "user work\n");
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /user changes/);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an unconfigured source worktree is adopted with configured siblings while build output stays untouched", async () => {
  const f = fixture();
  try {
    const source = join(f.root, "deploy"), target = join(f.tree, "deploy");
    mkdirSync(source);
    git(source, "init", "-q"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(source, "README"), "deploy\n"); git(source, "add", "README"); git(source, "commit", "-qm", "initial");
    git(source, "worktree", "add", "-q", "--detach", target, "HEAD");
    mkdirSync(join(f.tree, "build")); writeFileSync(join(f.tree, "build", "artifact"), "keep me");
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.repositories.map((repo: { id: string }) => repo.id), ["alpha", "beta", "deploy"]);
    assert.equal(preview.repositories.find((repo: { id: string }) => repo.id === "deploy").sourcePath, source);
    assert.ok(preview.warnings.some((warning: { code: string }) => warning.code === "workspace_extra_path"));
    const adopted = await f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} });
    assert.equal(adopted.state, "active");
    assert.equal(f.service.workspaces.get("lost").repositories.length, 3);
    assert.equal((await f.service.handle("workspace.detail", { workspaceId: "lost" })).repositories.length, 3);
    assert.equal((await f.service.handle("workspace.reviewRuntime", { workspaceId: "lost" })).repositories.length, 3);
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /extra files/);
    assert.equal(readFileSync(join(f.tree, "build", "artifact"), "utf8"), "keep me");
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("an unverified sibling remains untouched while confirmed worktrees can be adopted", async () => {
  const f = fixture(), outside = realpathSync(mkdtempSync(join(tmpdir(), "wb-outside-")));
  try {
    git(outside, "init", "-q"); git(outside, "config", "user.name", "Fixture"); git(outside, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(outside, "README"), "outside\n"); git(outside, "add", "README"); git(outside, "commit", "-qm", "initial");
    git(outside, "worktree", "add", "-q", "--detach", join(f.tree, "rogue"), "HEAD");
    const preview = await f.service.handle("workspace.orphan.preview", { workspaceId: "lost" });
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.repositories.map((repo: { id: string }) => repo.id), ["alpha", "beta"]);
    assert.deepEqual(preview.unmanagedPaths, [join(f.tree, "rogue")]);
    const adopted = await f.service.handle("workspace.orphan.adopt", { workspaceId: "lost", fingerprint: preview.fingerprint, branches: {} });
    assert.deepEqual(adopted.adoption.unmanagedPaths, [join(f.tree, "rogue")]);
    await f.service.handle("workspace.remove", { workspaceId: "lost" });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: "lost", confirm: true }), /extra files/);
    assert.equal(existsSync(join(f.tree, "rogue", "README")), true);
  } finally {
    await f.service.close();
    try { git(outside, "worktree", "remove", join(f.tree, "rogue")); } catch {}
    rmSync(f.root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
});
