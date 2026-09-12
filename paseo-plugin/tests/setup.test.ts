import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { handleProjectStorage, saveProjectSetup, scanProject } from "../server/setup.ts";

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function temporaryGitProject(): string {
  const root = mkdtempSync(join(process.env.TMPDIR || "/tmp", "workspace-workbench-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workbench Test");
  writeFileSync(join(root, "README.md"), "initial\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("setup scan prioritizes a parent Git checkout and exposes nested checkouts", async () => {
  const root = temporaryGitProject();
  try {
    const nested = join(root, "packages", "child");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q");
    const result = await scanProject(root);
    assert.equal(result.projectRoot, realpathSync(root));
    assert.equal(result.gitRoot, realpathSync(root));
    assert.deepEqual(result.defaultRepositoryPaths, ["."]);
    assert.ok(result.repositories.some((repository) => repository.repoPath === "." && repository.kind === "root" && repository.selectedByDefault));
    assert.ok(result.repositories.some((repository) => repository.repoPath === "packages/child" && repository.kind === "nested" && !repository.selectedByDefault));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup save writes a local config, local ignore block, and automatic registry entry", async () => {
  const root = temporaryGitProject();
  const projectIgnore = join(root, ".gitignore");
  writeFileSync(projectIgnore, "dist/\n");
  const projectIgnoreBefore = readFileSync(projectIgnore, "utf8");
  const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "workspace-workbench-home-"));
  const priorHome = process.env.HOME;
  const priorPython = process.env.WORKSPACE_WORKBENCH_PYTHON;
  const priorDownload = process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD;
  process.env.HOME = home;
  process.env.WORKSPACE_WORKBENCH_PYTHON = join(home, "missing-python");
  process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = "1";
  try {
    const result = await saveProjectSetup({ directory: root, repositories: ["."], shareConfig: false });
    const configPath = join(realpathSync(root), ".workspace-workbench", "project.json");
    assert.equal(result.project.configPath, configPath);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.repositories[0].path, ".");
    assert.equal(config.workspaceRoot, ".");
    assert.equal(config.treesRoot, "worktrees");
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /workspace-workbench:begin/);
    assert.match(exclude, /project\.json/);
    assert.match(exclude, /worktrees\//);
    assert.match(readFileSync(join(home, ".config", "workspace-workbench", "projects.json"), "utf8"), /project\.json/);
    const storage = await handleProjectStorage({ projectConfig: configPath });
    assert.equal(storage.config.relativePath, ".workspace-workbench/project.json");
    assert.equal(storage.worktrees.relativePath, ".workspace-workbench/worktrees");
    assert.equal(storage.state.relativePath, ".workspace-workbench/state");
    assert.equal(storage.ignoreMode, "local");
    assert.ok(["missing", "failed"].includes(result.backend.state));
    assert.equal(readFileSync(projectIgnore, "utf8"), projectIgnoreBefore);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPython === undefined) delete process.env.WORKSPACE_WORKBENCH_PYTHON; else process.env.WORKSPACE_WORKBENCH_PYTHON = priorPython;
    if (priorDownload === undefined) delete process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD; else process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = priorDownload;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("shared setup keeps the project config visible while ignoring runtime folders", async () => {
  const root = temporaryGitProject();
  const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "workspace-workbench-home-"));
  const priorHome = process.env.HOME;
  const priorPython = process.env.WORKSPACE_WORKBENCH_PYTHON;
  const priorDownload = process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD;
  process.env.HOME = home;
  process.env.WORKSPACE_WORKBENCH_PYTHON = join(home, "missing-python");
  process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = "1";
  try {
    writeFileSync(join(root, ".gitignore"), ".workspace-workbench/\n");
    await saveProjectSetup({ directory: root, repositories: ["."], shareConfig: true });
    const exclude = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
    assert.doesNotMatch(exclude, /project\.json/);
    assert.match(exclude, /state\//);
    assert.match(exclude, /worktrees\//);
    assert.match(exclude, /workspace\.lock/);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /workspace-workbench:shared-config/);
    const status = spawnSync("git", ["-C", root, "status", "--short", "--ignored", "--untracked-files=all"], { encoding: "utf8" }).stdout;
    assert.doesNotMatch(status, /!! .*project\.json/);
    await saveProjectSetup({ directory: root, repositories: ["."], shareConfig: false });
    assert.doesNotMatch(readFileSync(join(root, ".gitignore"), "utf8"), /workspace-workbench:shared-config/);
    assert.match(readFileSync(join(root, ".git", "info", "exclude"), "utf8"), /project\.json/);
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPython === undefined) delete process.env.WORKSPACE_WORKBENCH_PYTHON; else process.env.WORKSPACE_WORKBENCH_PYTHON = priorPython;
    if (priorDownload === undefined) delete process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD; else process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = priorDownload;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup save preserves an existing project storage layout", async () => {
  const root = temporaryGitProject();
  const configDirectory = join(root, ".workspace-workbench");
  mkdirSync(configDirectory, { recursive: true });
  const configPath = join(configDirectory, "project.json");
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    project: { id: "fixture", displayName: "Fixture" },
    sourceRoot: "..",
    workspaceRoot: "legacy-workspaces",
    recordsRoot: "legacy-state/records",
    treesRoot: "legacy-workspaces/trees",
    stateRoot: "legacy-state",
    socketPath: "auto",
  }));
  const home = mkdtempSync(join(process.env.TMPDIR || "/tmp", "workspace-workbench-home-"));
  const priorHome = process.env.HOME;
  const priorPython = process.env.WORKSPACE_WORKBENCH_PYTHON;
  const priorDownload = process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD;
  process.env.HOME = home;
  process.env.WORKSPACE_WORKBENCH_PYTHON = join(home, "missing-python");
  process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = "1";
  try {
    await saveProjectSetup({ directory: root, repositories: ["."], shareConfig: false });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.workspaceRoot, "legacy-workspaces");
    assert.equal(config.recordsRoot, "legacy-state/records");
    assert.equal(config.treesRoot, "legacy-workspaces/trees");
    assert.equal(config.stateRoot, "legacy-state");
  } finally {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorPython === undefined) delete process.env.WORKSPACE_WORKBENCH_PYTHON; else process.env.WORKSPACE_WORKBENCH_PYTHON = priorPython;
    if (priorDownload === undefined) delete process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD; else process.env.WORKSPACE_WORKBENCH_DISABLE_DOWNLOAD = priorDownload;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
