import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGitRoots } from "../server/backend/discovery-scan.ts";

test("scan budget returns partial results and yields to other requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-scan-budget-"));
  try {
    const visible = join(root, "a-repository"); mkdirSync(visible); mkdirSync(join(visible, ".git"));
    for (let n = 0; n < 300; n++) mkdirSync(join(root, `directory-${String(n).padStart(3, "0")}`));
    let eventLoopResponsive = false;
    const timer = setTimeout(() => { eventLoopResponsive = true; }, 1);
    const result = await scanGitRoots({ sourceRoot: root, roots: [visible, root], maxDepth: 1, maxDirectories: 20 });
    clearTimeout(timer);
    assert.equal(result.incomplete, true);
    assert.equal(result.reason, "directory_limit");
    assert.ok(result.roots.includes(realpathSync(visible)));
    assert.equal(eventLoopResponsive, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scan skips actual generated paths and out-of-root symlinks, not lookalike names", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-scan-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "wb-scan-outside-"));
  try {
    const generated = join(root, "state"), ordinary = join(root, ".workspace-workbench");
    for (const path of [generated, ordinary, outside]) { mkdirSync(path, { recursive: true }); mkdirSync(join(path, ".git")); }
    symlinkSync(outside, join(root, "linked"));
    const result = await scanGitRoots({ sourceRoot: root, roots: [root], maxDepth: 2, excludePaths: [generated], followSymlinks: true });
    assert.deepEqual(result.roots, [realpathSync(ordinary)]);
    assert.equal(result.incomplete, false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
