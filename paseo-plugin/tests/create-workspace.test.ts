import assert from "node:assert/strict";
import test from "node:test";
import {
  clampCreateWorkspaceHeight,
  CREATE_WORKSPACE_MIN_HEIGHT,
  createWorkspaceNaturalHeight,
} from "../client/create-workspace-layout.ts";

test("create dialog height grows with repository choices but stays bounded", () => {
  const compact = createWorkspaceNaturalHeight({
    repositoryCount: 2,
    selectedCount: 1,
    basesExpanded: false,
    hasStatusMessage: false,
    maxHeight: 640,
  });
  const expanded = createWorkspaceNaturalHeight({
    repositoryCount: 2,
    selectedCount: 2,
    basesExpanded: true,
    hasStatusMessage: false,
    maxHeight: 640,
  });
  const many = createWorkspaceNaturalHeight({
    repositoryCount: 40,
    selectedCount: 20,
    basesExpanded: true,
    hasStatusMessage: true,
    maxHeight: 640,
  });
  assert.ok(compact >= CREATE_WORKSPACE_MIN_HEIGHT);
  assert.ok(expanded > compact);
  assert.equal(many, 640);
});

test("create dialog drag height is rounded and clamped", () => {
  assert.equal(clampCreateWorkspaceHeight(219.4, 640), CREATE_WORKSPACE_MIN_HEIGHT);
  assert.equal(clampCreateWorkspaceHeight(317.6, 640), 318);
  assert.equal(clampCreateWorkspaceHeight(900, 640), 640);
  assert.equal(clampCreateWorkspaceHeight(900, 180), CREATE_WORKSPACE_MIN_HEIGHT);
});
