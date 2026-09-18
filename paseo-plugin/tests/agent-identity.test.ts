import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { withProject } from "../server/projects.ts";
import { readState, writeState } from "../server/orchestration-state.ts";
import { liveAgentIdentity } from "../server/agent-identity.ts";

test("a resumed live agent can use its own archived-session token", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-agent-identity-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: root }));
  const previous = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config;
  try {
    await withProject({ projectConfig: config }, async () => {
      const token = "current-token";
      writeState(`context:${token}`, { agentId: "parent", cwd: root, revoked: true });
      writeState("session:parent", { token });
      let archivedAt: string | null = "2026-09-18T00:00:00Z";
      const paseo = { agents: { ref: (id: string) => {
        assert.equal(id, "parent");
        return { refresh: async () => ({ agent: { cwd: root, archivedAt } }) };
      } } } as unknown as PaseoApi;
      assert.equal(await liveAgentIdentity(token, paseo), null, "archived agent stays blocked");
      archivedAt = null;
      assert.equal((await liveAgentIdentity(token, paseo))?.agentId, "parent");
      assert.equal(readState<{ revoked: boolean }>(`context:${token}`)?.revoked, false);
      writeState(`context:${token}`, { agentId: "parent", cwd: root, revoked: true });
      writeState("session:parent", { token: "replacement-token" });
      assert.equal(await liveAgentIdentity(token, paseo), null, "rotated token stays blocked");
      assert.equal(await liveAgentIdentity("unknown-token", paseo), null, "unknown token stays blocked");
      writeState("session:parent", { token });
      const wrongCwd = { agents: { ref: () => ({ refresh: async () => ({ agent: { cwd: root + "-other", archivedAt: null } }) }) } } as unknown as PaseoApi;
      assert.equal(await liveAgentIdentity(token, wrongCwd), null, "changed project directory stays blocked");
    });
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
