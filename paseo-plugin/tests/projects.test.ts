import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredProjects, resolveProject, type ProjectRoute } from "../server/projects.ts";

test("routing refuses unknown projects and ambiguous global access", () => {
  const sourceRoot = realpathSync(tmpdir());
  const route: ProjectRoute = { configPath: sourceRoot + "/project.json", sourceRoot, workspaceRoot: sourceRoot + "/workspaces", treesRoot: sourceRoot + "/workspaces/trees", recordsRoot: sourceRoot + "/state/records", stateRoot: sourceRoot + "/state", socketPath: sourceRoot + "/socket", displayName: "Fixture" };
  const other = { ...route, configPath: sourceRoot + "/other.json", sourceRoot: sourceRoot + "/other" };
  assert.equal(resolveProject({ directory: sourceRoot }, [route, other]).configPath, route.configPath);
  assert.throws(() => resolveProject({}, [route, other]), /selection_required/);
  assert.throws(() => resolveProject({ projectConfig: "/unknown.json" }, [route]), /not_registered/);
  assert.equal(resolveProject({ projectConfig: other.configPath }, [route, other]).configPath, other.configPath);
});

test("managed Workbench paths resolve their registered project without a copied config", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-workbench-managed-path-")));
  try {
    const route: ProjectRoute = { configPath: join(root, "project.json"), sourceRoot: root, workspaceRoot: join(root, ".workspace-workbench"), treesRoot: join(root, ".workspace-workbench", "worktrees"), recordsRoot: join(root, ".workspace-workbench", "records"), stateRoot: join(root, ".workspace-workbench", "state"), socketPath: join(root, ".workspace-workbench", "observer.sock"), displayName: "Fixture" };
    const managedPath = join(route.treesRoot, "fixture-agent-flow");
    mkdirSync(managedPath, { recursive: true });
    assert.equal(resolveProject({ directory: managedPath }, [route]).configPath, route.configPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-local configuration is discovered from the current directory without manual registration", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-workbench-project-")));
  try {
    const configDirectory = join(root, ".workspace-workbench");
    mkdirSync(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "project.json");
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      project: { id: "fixture", displayName: "Fixture" },
      sourceRoot: "..",
      workspaceRoot: "workspaces",
      stateRoot: "state",
      socketPath: "auto",
      repositories: [],
    }));
    assert.ok(registeredProjects({ directory: root }).some((project) => project.configPath === realpathSync(configPath)));
    assert.equal(resolveProject({ projectConfig: configPath }, []).configPath, realpathSync(configPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
