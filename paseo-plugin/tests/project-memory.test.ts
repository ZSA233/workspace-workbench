import test from "node:test";
import assert from "node:assert/strict";
import { chooseProject } from "../client/project-memory.ts";
import { observerSettings } from "../shared/settings.ts";
import { readFileSync } from "node:fs";

test("project selection requires a matching directory or an explicit global choice", () => {
  const one = { configPath: "one" }, two = { configPath: "two" };
  assert.equal(chooseProject([one, two], one, "two", "two", true), one);
  assert.equal(chooseProject([one, two], undefined, "", "two", false), undefined);
  assert.equal(chooseProject([one], undefined, "removed", "removed", false), undefined);
  assert.equal(chooseProject([one, two], undefined, "two", "one", false), two);
  assert.equal(chooseProject([one, two], undefined, "two", "one", true), undefined);
  assert.equal(chooseProject([one, two], undefined, "", "two", false, true), undefined);
  assert.equal(chooseProject([one, two], undefined, "two", "one", false, true), undefined);
  assert.equal(chooseProject([two, one], undefined, "", "removed", false), undefined);
  assert.deepEqual(observerSettings.schema.parse({}).lastProjectByHost, {});
  assert.deepEqual(observerSettings.schema.parse({}).workspaceViewByScope, {});
  const saved = observerSettings.schema.parse({ selectedWorkspaceByPaseoWorkspace: { project: 'existing-id' }, workspaceViewByScope: { project: 'tree' } });
  assert.equal(saved.selectedWorkspaceByPaseoWorkspace.project, 'existing-id'); assert.equal(saved.workspaceViewByScope.project, 'tree');
  const source = readFileSync(new URL("../index.client.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('const observerSurfaceId = "workbench"'));
  assert.ok(source.includes('title: "Workspace Workbench"'));
  const panel = readFileSync(new URL("../client/panel.tsx", import.meta.url), "utf8");
  assert.ok(panel.includes('useProjectMemory(props.hostWorkspaceId || "global")'));
  const memory = readFileSync(new URL("../client/project-memory.ts", import.meta.url), "utf8");
  assert.ok(memory.includes("lastProjectByHost.global = configPath"));
});
