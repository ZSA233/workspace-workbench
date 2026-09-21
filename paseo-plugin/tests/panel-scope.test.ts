import assert from "node:assert/strict";
import test from "node:test";
import { projectPreferenceScopeKey, workbenchScopeKey } from "../client/panel/scope.ts";

test("panel scope keys remain stable and isolate host/project/workspace", () => {
  assert.equal(projectPreferenceScopeKey("/tmp/project.json", "host-1"), "project:/tmp/project.json:paseo-workspace:host-1");
  assert.equal(projectPreferenceScopeKey("/tmp/project.json", ""), "project:/tmp/project.json:paseo-workspace:global");
  assert.notEqual(
    workbenchScopeKey({ hostWorkspaceId: "host-1", projectConfig: "a", workspaceId: "main" }),
    workbenchScopeKey({ hostWorkspaceId: "host-1", projectConfig: "a", workspaceId: "other" }),
  );
});

