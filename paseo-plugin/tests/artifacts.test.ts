import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifactRegister } from "../shared/artifacts.ts";
import { withProject } from "../server/projects.ts";
import { registerArtifact } from "../server/artifacts.ts";
import { writeState } from "../server/orchestration-state.ts";
import {
  artifactImageAttachments,
  listArtifacts,
  materializeReviewArtifact,
  readStoredArtifact,
  resolveArtifactReference,
  storeArtifactBytes,
} from "../server/artifacts.ts";

test("handoff assets use an asset ID and path without content hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-artifacts-"));
  const storage = join(root, "state");
  const previousStorage = process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT;
  const source = join(root, "draft.png");
  writeFileSync(source, Buffer.from("draft-image"));
  process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT = storage;
  try {
    const stored = storeArtifactBytes({ id: "draft-image", title: "Draft", kind: "image", mimeType: "image/png", bytes: readFileSync(source) });
    assert.equal(Object.hasOwn(stored, "sha256"), false);
    assert.deepEqual(listArtifacts().artifacts.map((artifact) => artifact.id), ["draft-image"]);
    assert.deepEqual(readStoredArtifact(stored.id).bytes, Buffer.from("draft-image"));

    const resolved = resolveArtifactReference({ id: "draft", title: "Draft", kind: "image", path: "draft.png", required: true }, { repositories: [{ id: "repo", worktreePath: root }] });
    assert.equal(resolved.path, "draft.png");
    assert.equal(resolved.assetId, "");
    const materialized = materializeReviewArtifact(resolved);
    assert.match(materialized.assetId, /^review-/);
    assert.equal(Object.hasOwn(materialized, "sha256"), false);

    const images = artifactImageAttachments([{ assetId: materialized.assetId, mimeType: "image/png", status: "ready" }]);
    assert.deepEqual(images, [{ data: Buffer.from("draft-image").toString("base64"), mimeType: "image/png" }]);
  } finally {
    if (previousStorage === undefined) delete process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT;
    else process.env.WORKSPACE_WORKBENCH_ARTIFACT_ROOT = previousStorage;
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact registration accepts a local path or data, but never both", () => {
  const pathInput = artifactRegister.input.parse({
    projectConfig: "/tmp/project.json",
    token: "token",
    artifact: { title: "Draft", path: "draft.png" },
  });
  assert.equal(pathInput.artifact.path, "draft.png");
  assert.throws(() => artifactRegister.input.parse({
    projectConfig: "/tmp/project.json",
    token: "token",
    artifact: { title: "Draft", mimeType: "image/png", data: "ZGF0YQ==", path: "draft.png" },
  }), /exactly one of data or path is required/);
});

test("the coordinator can register a generated image by local path", async () => {
  const root = mkdtempSync(join(tmpdir(), "workbench-artifact-register-"));
  const config = join(root, "project.json");
  const stateRoot = join(root, "state");
  writeFileSync(join(root, "draft.png"), Buffer.from("generated-image"));
  writeFileSync(config, JSON.stringify({ sourceRoot: root, stateRoot, workspaceRoot: join(stateRoot, "workspaces") }));
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  try {
    const result = await withProject({ projectConfig: config }, async () => {
      writeState("context:token", { agentId: "coordinator", cwd: root });
      return registerArtifact(
        { token: "token", artifact: { title: "Generated draft", path: "draft.png" } },
        { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "coordinator", cwd: root, archivedAt: null } }) }) } } } as never,
      );
    });
    assert.equal(result.ok, true);
    assert.equal(result.reference?.kind, "image");
    assert.equal(result.reference?.mimeType, "image/png");
  } finally {
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
