import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveProject, type ProjectRoute } from "../server/projects.ts";

test("routing refuses unknown projects and ambiguous global access", () => {
  const sourceRoot = realpathSync(tmpdir());
  const route: ProjectRoute = { configPath: sourceRoot + "/project.json", sourceRoot, workspaceRoot: sourceRoot + "/workspaces", stateRoot: sourceRoot + "/state", socketPath: sourceRoot + "/socket", displayName: "Fixture" };
  const other = { ...route, configPath: sourceRoot + "/other.json", sourceRoot: sourceRoot + "/other" };
  assert.equal(resolveProject({ directory: sourceRoot }, [route, other]).configPath, route.configPath);
  assert.throws(() => resolveProject({}, [route, other]), /selection_required/);
  assert.throws(() => resolveProject({ projectConfig: "/unknown.json" }, [route]), /not_registered/);
  assert.equal(resolveProject({ projectConfig: other.configPath }, [route, other]).configPath, other.configPath);
});
