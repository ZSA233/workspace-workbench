import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Git } from "../server/backend/git.ts";
import { workspaceBranchLabel, workspaceCurrentRefSummary } from "../server/backend/workspace-refs.ts";

test("workspace branch labels keep Gitlink branches exact and derive managed prefixes", () => {
  assert.equal(workspaceBranchLabel({
    id: "demo",
    layout: "gitlink",
    managed: true,
    branchName: "feature/demo",
    repositories: [{ id: "root", branch: "feature/demo" }],
  }), "feature/demo");
  assert.equal(workspaceBranchLabel({
    id: "demo",
    kind: "managed",
    repositories: [
      { id: "compose", branch: "obs/demo/compose" },
      { id: "h5/saba_manage", branch: "obs/demo/h5/saba_manage" },
    ],
  }), "obs/demo");
  assert.equal(workspaceBranchLabel({ id: "legacy", repositories: [{ id: "one", branch: "feature/one" }] }), "legacy");
  assert.equal(workspaceBranchLabel({ id: "main", kind: "live", managed: false, repositories: [] }), null);
});

test("workspace current ref summary only claims uniform state when every repository agrees", () => {
  assert.deepEqual(workspaceCurrentRefSummary([
    { branch: "obs/demo/one" },
    { branch: "obs/demo/two" },
  ]), { currentRef: null, currentRefState: "mixed" });
  assert.deepEqual(workspaceCurrentRefSummary([
    { branch: "feature/demo" },
    { branch: "feature/demo" },
  ]), { currentRef: "feature/demo", currentRefState: "uniform" });
  assert.deepEqual(workspaceCurrentRefSummary([{ branch: "" }, { branch: "feature/demo" }]), { currentRef: null, currentRefState: "mixed" });
  assert.deepEqual(workspaceCurrentRefSummary([]), { currentRef: null, currentRefState: "unknown" });
});

test("Git resolves detached HEAD candidates without changing checkout state", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wb-ref-candidates-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Workbench Test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "README.md"), "initial\n");
    git("add", "README.md");
    git("commit", "-qm", "initial");
    git("branch", "candidate");
    const head = git("rev-parse", "HEAD");
    git("checkout", "--detach", "-q", "HEAD");
    const candidates = await new Git(root).refsAtHead(head);
    assert.ok(candidates.includes("candidate"));
    assert.equal(git("branch", "--show-current"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
