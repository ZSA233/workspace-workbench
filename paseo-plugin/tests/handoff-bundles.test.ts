import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProject } from "../server/projects.ts";
import { createPreviewBundle, readBundleFile, appendBundle, assertBundleReady } from "../server/handoff-bundles.ts";
import { handleHandoffMaterials, chunkText } from "../server/handoff-access.ts";
import { handoffSchema } from "../shared/handoff.ts";
import { handoffMaterials } from "../shared/handoff-materials.ts";
import { writeState } from "../server/orchestration-state.ts";
import { putAgentBinding } from "../server/agent-store.ts";
import { validateReportMaterials } from "../server/agent-review.ts";
import type { AgentContext } from "../server/agent-provider.ts";

async function fixture(run: (root: string, config: string, context: AgentContext) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handoff-bundle-"))), config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, stateRoot: join(root, "state"), workspaceRoot: root }));
  const prior = process.env.WORKSPACE_WORKBENCH_CONFIG, registry = process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
  process.env.WORKSPACE_WORKBENCH_CONFIG = config; process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = join(root, "registry.json");
  const context = { paseo: { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: { id, cwd: root, workspaceId: "paseo", status: "idle", archivedAt: null } }),
    timeline: { refetch: async () => ({ epoch: "epoch", reset: true, startCursor: { epoch: "epoch", seq: 1 }, endCursor: { epoch: "epoch", seq: 4 }, hasOlder: false,
      entries: [
        { seqStart: 1, timestamp: "2026-09-15", item: { type: "user_message", text: "偏好：保留原始需求，按钮应为蓝色。" } },
        { seqStart: 2, timestamp: "2026-09-15", item: { type: "assistant_message", text: "假设按钮为红色，尚未确认。" } },
        { seqStart: 3, timestamp: "2026-09-15", item: { type: "reasoning", text: "HIDDEN-REASONING" } },
        { seqStart: 4, timestamp: "2026-09-15", item: { type: "tool_call", name: "exec", status: "completed", output: "PRIVATE-OUTPUT" } },
      ] }) },
  }) } } } as unknown as AgentContext;
  try { await withProject({ projectConfig: config }, () => run(root, config, context)); }
  finally { if (prior === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = prior; if (registry === undefined) delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY; else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = registry; rmSync(root, { recursive: true, force: true }); }
}

test("preview freezes original sources and public conversation, replay never recaptures", async () => fixture(async (root, config, context) => {
  writeFileSync(join(root, "requirements.md"), "按钮必须是蓝色。\n");
  const handoff = handoffSchema.parse({ goal: "Implement button", context: { preferences: [{ text: "蓝色按钮", sources: ["M1", "REQ"] }] }, reviewPacket: { references: [{ id: "REQ", path: "requirements.md", required: true }] } });
  const input = { ownerAgentId: "parent", ownerCwd: root, identity: "identity", handoff, runtime: { repositories: [{ id: "repo", worktreePath: root }] }, context };
  const bundle = await createPreviewBundle(input);
  assert.equal(bundle.conversation.state, "complete"); assert.equal(bundle.conversation.messages, 2);
  assert.equal(bundle.conversation.attachmentMetadata, "not_exposed");
  const exported = Object.keys(bundle.files).map(file => readBundleFile(bundle.bundle, file).toString("utf8")).join("\n");
  assert.match(exported, /M1/); assert.match(exported, /假设按钮为红色/); assert.doesNotMatch(exported, /HIDDEN-REASONING|PRIVATE-OUTPUT/);
  writeFileSync(join(root, "requirements.md"), "changed after preview");
  assert.deepEqual(await createPreviewBundle(input), bundle);
  assert.equal(readBundleFile(bundle.bundle, bundle.sources[0].file!).toString("utf8"), "按钮必须是蓝色。\n");
  writeState("context:parent-token", { agentId: "parent", cwd: root });
  const base = { projectConfig: config, token: "parent-token", bundle: bundle.bundle };
  const search = await handleHandoffMaterials(handoffMaterials.input.parse({ ...base, action: "search", query: "蓝色" }), context);
  assert.ok((search.hits as unknown[]).length > 0);
  await assert.rejects(handleHandoffMaterials(handoffMaterials.input.parse({ ...base, file: "../../project.json" }), context), /file_invalid/);
  writeState("context:other-token", { agentId: "other", cwd: root });
  await assert.rejects(handleHandoffMaterials(handoffMaterials.input.parse({ ...base, token: "other-token" }), context), /access_denied/);
  writeFileSync(join(root, "state", "handoff-bundles", bundle.bundle.id, "1", "HANDOFF.md"), "tampered");
  assert.throws(() => assertBundleReady(bundle.bundle), /integrity_failed/);
}));

test("missing required source and PDF require explicit readable alternatives", async () => fixture(async (root, _config, context) => {
  writeFileSync(join(root, "spec.pdf"), "%PDF-1.0 fixture"); writeFileSync(join(root, "spec.txt"), "Readable source text");
  const create = (identity: string, references: unknown[]) => createPreviewBundle({ identity, ownerAgentId: "parent", ownerCwd: root, context, runtime: { repositories: [{ id: "r", worktreePath: root }] }, handoff: handoffSchema.parse({ goal: "Read specification", reviewPacket: { references } }) });
  const missing = await create("missing", [{ id: "missing", path: "absent.md" }]);
  assert.deepEqual(missing.blockers, ["missing"]); assert.throws(() => assertBundleReady(missing.bundle), /required_materials/);
  const pdf = await create("pdf", [{ id: "pdf", path: "spec.pdf" }]); assert.deepEqual(pdf.blockers, ["pdf"]); assert.ok(pdf.sources[0].file);
  const readable = await create("readable", [{ id: "pdf", path: "spec.pdf", readableAlternativeIds: ["text"] }, { id: "text", path: "spec.txt" }]);
  assert.deepEqual(readable.blockers, []);
}));

test("append preserves old versions and blocks old reports after supplement acceptance", async () => fixture(async (root, _config, context) => {
  const handoff = handoffSchema.parse({ goal: "Implement" });
  const first = await createPreviewBundle({ ownerAgentId: "parent", ownerCwd: root, identity: "versions", handoff, context, runtime: { repositories: [] } });
  const before = readBundleFile(first.bundle, "HANDOFF.md");
  const second = await appendBundle(first.bundle, { requestId: "supplement", text: "保留键盘导航", sender: "parent", references: [], handoff });
  assert.equal(second.bundle.version, 2); assert.deepEqual(readBundleFile(first.bundle, "HANDOFF.md"), before);
  assert.match(readBundleFile(second.bundle, "supplements/2.md").toString("utf8"), /保留键盘导航/);
  const binding = { workspaceId: "w", agentId: "worker", requestedByAgentId: "parent", relationship: "independent" as const, paseoWorkspaceId: "paseo", cwd: root, provider: "codex", createdAt: "now", updatedAt: "now", handoffBundle: first.bundle };
  putAgentBinding({ ...binding, pendingHandoffBundle: second.bundle }); assert.throws(() => validateReportMaterials("w", 1), /delivery_pending/);
  putAgentBinding({ ...binding, handoffBundle: second.bundle }); assert.throws(() => validateReportMaterials("w", 1), /version_required:2/); validateReportMaterials("w", 2);
  assert.throws(() => appendBundle(first.bundle, { requestId: "supplement", text: "conflict", sender: "parent", references: [], handoff }), /identity_conflict/);
}));

test("text segmentation is bounded and preserves unicode across pages", () => {
  const text = "原始需求🙂".repeat(6000), bytes = Buffer.from(text);
  let offset = 0, result = "";
  do { const chunk = chunkText(bytes, offset); assert.ok(Buffer.byteLength(chunk.content) <= 16384); result += chunk.content; if (chunk.nextOffset === null) break; offset = chunk.nextOffset; } while (offset < bytes.length);
  assert.equal(result, text);
});

test("oversized required text is explicitly blocked, optional sources warn", async () => fixture(async (root, _config, context) => {
  writeFileSync(join(root, "large.md"), Buffer.alloc(512 * 1024 + 1, 65));
  const bundle = await createPreviewBundle({ ownerAgentId: "parent", ownerCwd: root, identity: "limits", context,
    runtime: { repositories: [{ id: "r", worktreePath: root }] }, handoff: handoffSchema.parse({ goal: "Inspect", reviewPacket: { references: [{ id: "large", path: "large.md" }, { id: "optional", path: "missing.md", required: false }] } }) });
  assert.deepEqual(bundle.blockers, ["large"]);
  assert.match(bundle.sources[0].error!, /size_exceeded/);
  assert.ok(bundle.warnings.some(warning => warning.includes("optional")));
}));

test("conversation pagination preserves the initial boundary and marks gaps", async () => fixture(async (root, _config, context) => {
  let calls = 0;
  const paged = { ...context, paseo: { agents: { ref: () => ({ timeline: { refetch: async (input: { cursor?: { seq: number } }) => {
    calls++;
    if (calls === 2) { assert.equal(input.cursor?.seq, 10); throw new Error("history provider disconnected"); }
    return { epoch: "e", reset: true, hasOlder: true, startCursor: { epoch: "e", seq: 10 }, endCursor: { epoch: "e", seq: 20 }, entries: [{ seqStart: 10, timestamp: "now", item: { type: "user_message", text: "Keep this original decision" } }] };
  } } }) } } } as unknown as AgentContext;
  const bundle = await createPreviewBundle({ ownerAgentId: "parent", ownerCwd: root, identity: "partial", context: paged, runtime: { repositories: [] }, handoff: handoffSchema.parse({ goal: "Inspect" }) });
  assert.equal(calls, 2); assert.equal(bundle.conversation.boundary, 20); assert.equal(bundle.conversation.state, "partial");
  assert.match(readBundleFile(bundle.bundle, "conversation/000-000.md").toString("utf8"), /original decision/);
  assert.match(bundle.conversation.reason!, /disconnected/);
}));
