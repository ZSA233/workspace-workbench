import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../server/backend/config.ts";
import { Service } from "../server/backend/service.ts";
import { Git } from "../server/backend/git.ts";
import { WorkbenchError } from "../server/backend/storage.ts";
import { runtimeIdentity } from "../server/backend/identity.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-gitlink-")));
  const child = join(root, "child"), outer = join(root, "dev-workspaces");
  mkdirSync(child); mkdirSync(outer);
  for (const dir of [child, outer]) {
    git(dir, "init", "-q");
    git(dir, "config", "user.name", "Fixture");
    git(dir, "config", "user.email", "fixture@example.invalid");
  }
  writeFileSync(join(child, "README"), "pinned\n");
  git(child, "add", "README"); git(child, "commit", "-qm", "initial");
  git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "halh");
  // The submodule checkout has its own Git config. Do not rely on a developer
  // or CI runner's global identity when later scenarios create child commits.
  git(join(outer, "halh"), "config", "user.name", "Fixture");
  git(join(outer, "halh"), "config", "user.email", "fixture@example.invalid");
  git(outer, "commit", "-qam", "initial");
  const pinned = git(outer, "rev-parse", "HEAD:halh");
  const configPath = join(root, "project.json");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, sourceRoot: root,
    stateRoot: join(root, "state"), workspaceRoot: join(root, "workspaces"),
    discovery: { mode: "manual", maxDepth: 2 }, repositories: [], management: { enabled: true } }));
  return { root, outer, child, pinned, service: new Service(loadConfig(configPath)) };
}
async function detailUntil(service: Service, workspaceId: string, ready: (detail: any) => boolean) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const detail = await service.handle("workspace.detail", { workspaceId, force: attempt === 0 });
    if (ready(detail)) return detail;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Gitlink observation did not converge");
}

test("selected Gitlink root appears as one live workspace and creates matching nested branches", async () => {
  const f = fixture();
  try {
    const candidates = await f.service.handle("linked.workspaces.list");
    const outer = candidates.repositories.find((row: { path: string }) => row.path === f.outer);
    assert.ok(outer);
    assert.equal(outer.selected, false);
    await f.service.handle("linked.workspaces.save", { revision: candidates.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    assert.equal(f.service.workspaces.identify(join(f.outer, "halh")).workspaceId, live.id);
    const liveDetail = await f.service.handle("workspace.detail", { workspaceId: live.id });
    assert.deepEqual(liveDetail.gitlinks.map((link: { path: string }) => link.path), ["halh"]);
    assert.equal(liveDetail.gitlinks[0].committedSha, f.pinned);
    assert.equal(liveDetail.gitlinks[0].indexSha, f.pinned);
    assert.equal(liveDetail.gitlinks[0].checkoutSha, f.pinned);
    const sourcePreview = await f.service.handle("linked.workspace.preview", { sourceWorkspaceId: live.id, rootBaseRef: "HEAD" });
    assert.equal(sourcePreview.links[0].pinnedSha, f.pinned);

    // The source child may move ahead; a new Workspace still starts at the outer pin.
    writeFileSync(join(f.outer, "halh", "README"), "source changed\n");
    git(join(f.outer, "halh"), "commit", "-qam", "source-change");
    const request = { sourceWorkspaceId: live.id, name: "example", branchName: "feature/example" };
    const created = await f.service.handle("workspace.create", request);
    const childPath = join(created.treePath, "halh");
    assert.equal(git(created.treePath, "branch", "--show-current"), "feature/example");
    assert.equal(git(childPath, "branch", "--show-current"), "feature/example");
    assert.equal(git(childPath, "rev-parse", "HEAD"), f.pinned);
    assert.equal(f.service.workspaces.identify(childPath).workspaceId, created.id);
    assert.equal((await f.service.handle("workspace.create", request)).id, created.id);
    await assert.rejects(f.service.handle("workspace.addRepositories", { workspaceId: created.id, repositories: ["halh"] }), /flat additions are unavailable/);

    const detail = await f.service.handle("workspace.detail", { workspaceId: created.id });
    assert.equal(detail.gitlinks[0].checkoutSha, f.pinned);
    assert.equal(detail.repositories.length, 2);
    assert.equal(detail.repositories.find((row: { repoPath: string }) => row.repoPath === "halh").branch, "feature/example");
    await f.service.handle("workspace.remove", { workspaceId: created.id });
    const preview = await f.service.handle("workspace.cleanup", { workspaceId: created.id });
    assert.equal(preview.repositories, 2);
    await f.service.handle("workspace.cleanup", { workspaceId: created.id, confirm: true });
    assert.equal(existsSync(created.treePath), false);
    const permanent = await f.service.handle("workspace.delete", { workspaceId: created.id, confirm: true });
    assert.equal(permanent.deleted, true);
    assert.deepEqual(permanent.branchesPreserved, ["feature/example", "feature/example"]);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("uninitialized child remains visible but blocks nested Workspace creation", async () => {
  const f = fixture();
  try {
    const candidates = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: candidates.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    rmSync(join(f.outer, "halh"), { recursive: true, force: true });
    const detail = await f.service.handle("workspace.detail", { workspaceId: live.id });
    assert.equal(detail.repositories.find((row: { repoPath: string }) => row.repoPath === "halh").status, "missing");
    const preview = await f.service.handle("linked.workspace.preview", { sourceWorkspaceId: live.id });
    assert.equal(preview.links[0].issue, "repository_missing");
    await assert.rejects(f.service.handle("workspace.create", { sourceWorkspaceId: live.id, name: "missing" }), /checkout unavailable/);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Gitlink discovery uses index entries even without a .gitmodules file", async () => {
  const f = fixture();
  try {
    git(f.outer, "rm", "-q", ".gitmodules");
    git(f.outer, "commit", "-qm", "remove module metadata");
    const candidates = await f.service.handle("linked.workspaces.list");
    assert.deepEqual(candidates.repositories.find((row: { path: string }) => row.path === f.outer)?.links.map((link: { path: string }) => link.path), ["halh"]);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("nested Gitlink paths retain their relative layout and clean up from children to outer root", async () => {
  const f = fixture();
  try {
    const frontend = join(f.root, "frontend");
    mkdirSync(frontend);
    git(frontend, "init", "-q");
    git(frontend, "config", "user.name", "Fixture");
    git(frontend, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(frontend, "README"), "frontend\n");
    git(frontend, "add", "README"); git(frontend, "commit", "-qm", "initial");
    git(f.outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", frontend, "h5/saba_manage");
    git(f.outer, "commit", "-qam", "add nested child");
    const candidates = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: candidates.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    const created = await f.service.handle("workspace.create", { sourceWorkspaceId: live.id, name: "nested", branchName: "feature/nested" });
    assert.deepEqual(created.repositories.map((repo: { repoPath: string }) => repo.repoPath), [".", "h5/saba_manage", "halh"]);
    assert.equal(git(join(created.treePath, "h5", "saba_manage"), "branch", "--show-current"), "feature/nested");
    assert.equal(git(join(created.treePath, "halh"), "branch", "--show-current"), "feature/nested");
    await f.service.handle("workspace.remove", { workspaceId: created.id });
    await f.service.handle("workspace.cleanup", { workspaceId: created.id, confirm: true });
    assert.equal(existsSync(created.treePath), false);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("Gitlink cleanup preserves child edits and branch collisions do not create a root worktree", async () => {
  const f = fixture();
  try {
    const candidates = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: candidates.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    git(join(f.outer, "halh"), "branch", "feature/collision");
    await assert.rejects(f.service.handle("workspace.create", { sourceWorkspaceId: live.id, name: "collision", branchName: "feature/collision" }), /branch already exists/);
    assert.equal(existsSync(join(f.root, "workspaces", "trees", "collision")), false);
    const created = await f.service.handle("workspace.create", { sourceWorkspaceId: live.id, name: "dirty", branchName: "feature/dirty" });
    writeFileSync(join(created.treePath, "halh", "README"), "user edit\n");
    await f.service.handle("workspace.remove", { workspaceId: created.id });
    await assert.rejects(f.service.handle("workspace.cleanup", { workspaceId: created.id, confirm: true }), /user changes/);
    assert.equal(readFileSync(join(created.treePath, "halh", "README"), "utf8"), "user edit\n");
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("outer pointers distinguish child edits, checkout drift, staged updates and committed pins", async () => {
  const f = fixture();
  try {
    const choice = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: choice.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    writeFileSync(join(f.outer, "halh", "README"), "uncommitted\n");
    const dirty = await f.service.handle("workspace.detail", { workspaceId: live.id, force: true });
    assert.equal(dirty.repositories.find((row: { repoPath: string }) => row.repoPath === ".").dirty, false);
    assert.equal(dirty.repositories.find((row: { repoPath: string }) => row.repoPath === "halh").dirty, true);
    assert.equal(dirty.gitlinks[0].checkoutSha, f.pinned);
    const initialOuterSha = git(f.outer, "rev-parse", "HEAD");
    const rootIdentity = await runtimeIdentity(live.repositories.find((repo: { role: string }) => repo.role === "gitlink-root"), f.service.config, false);
    const childIdentity = await runtimeIdentity(live.repositories.find((repo: { role: string }) => repo.role === "gitlink-child"), f.service.config, false);
    assert.deepEqual(rootIdentity.dirtyPaths, []);
    assert.deepEqual(childIdentity.dirtyPaths, ["README"]);
    git(join(f.outer, "halh"), "commit", "-qam", "child-change");
    const childHead = git(join(f.outer, "halh"), "rev-parse", "HEAD");
    const drift = await detailUntil(f.service, live.id, detail => detail.gitlinks[0].checkoutSha === childHead);
    assert.equal(drift.gitlinks[0].committedSha, f.pinned);
    assert.equal(drift.gitlinks[0].indexSha, f.pinned);
    assert.equal(drift.gitlinks[0].checkoutSha, childHead);
    git(f.outer, "add", "halh");
    const staged = await detailUntil(f.service, live.id, detail => detail.gitlinks[0].indexSha === childHead);
    assert.equal(staged.gitlinks[0].committedSha, f.pinned);
    assert.equal(staged.gitlinks[0].indexSha, childHead);
    git(f.outer, "commit", "-qm", "update-pointer");
    const committed = await detailUntil(f.service, live.id, detail => detail.gitlinks[0].committedSha === childHead);
    assert.equal(committed.gitlinks[0].committedSha, childHead);
    const currentPreview = await f.service.handle("linked.workspace.preview", { sourceWorkspaceId: live.id, rootBaseRef: "HEAD" });
    const earlierPreview = await f.service.handle("linked.workspace.preview", { sourceWorkspaceId: live.id, rootBaseRef: initialOuterSha });
    assert.equal(currentPreview.links[0].pinnedSha, childHead);
    assert.equal(earlierPreview.links[0].pinnedSha, f.pinned);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("explicit child override creates visible initial drift and still permits safe clean removal", async () => {
  const f = fixture();
  try {
    const choice = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: choice.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    writeFileSync(join(f.outer, "halh", "README"), "ahead\n");
    git(join(f.outer, "halh"), "commit", "-qam", "ahead");
    const ahead = git(join(f.outer, "halh"), "rev-parse", "HEAD");
    const created = await f.service.handle("workspace.create", { sourceWorkspaceId: live.id, name: "override", branchName: "feature/override", baseRefs: { halh: ahead } });
    const detail = await f.service.handle("workspace.detail", { workspaceId: created.id });
    assert.equal(detail.gitlinks[0].committedSha, f.pinned);
    assert.equal(detail.gitlinks[0].checkoutSha, ahead);
    await f.service.handle("workspace.remove", { workspaceId: created.id });
    await f.service.handle("workspace.cleanup", { workspaceId: created.id, confirm: true });
    assert.equal(existsSync(created.treePath), false);
  } finally { await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test("partial nested creation reuses the frozen record and completes without another root branch", async () => {
  const f = fixture();
  const original = Git.prototype.run;
  try {
    const choice = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: choice.revision, repositories: [f.outer] });
    const live = f.service.workspaces.list().find(row => row.kind === "linked-live");
    assert.ok(live);
    let inject = true;
    Git.prototype.run = async function(args: string[], check = true) {
      if (inject && this.path === join(f.outer, "halh") && args[0] === "worktree" && args[1] === "add") {
        inject = false;
        throw new WorkbenchError("git_failed", "injected child failure");
      }
      return original.call(this, args, check);
    };
    const request = { sourceWorkspaceId: live.id, name: "recover", branchName: "feature/recover" };
    await assert.rejects(f.service.handle("workspace.create", request), /creation failed/);
    const record = f.service.workspaces.get("recover");
    assert.equal(record.state, "create_failed");
    assert.equal(existsSync(record.treePath), true);
    Git.prototype.run = original;
    const selection = await f.service.handle("linked.workspaces.list");
    await f.service.handle("linked.workspaces.save", { revision: selection.revision, repositories: [] });
    const recovered = await f.service.handle("workspace.create", request);
    assert.equal(recovered.state, "active");
    assert.equal(git(join(recovered.treePath, "halh"), "branch", "--show-current"), "feature/recover");
  } finally { Git.prototype.run = original; await f.service.close(); rmSync(f.root, { recursive: true, force: true }); }
});
