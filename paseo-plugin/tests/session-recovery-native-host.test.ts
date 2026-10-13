import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent } from "@getpaseo/client";
import { invokeWorkbenchNativeRecovery } from "../server/session-recovery/native-host.ts";
import { recoveryIdentity } from "../server/session-recovery/identity.ts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "native-recovery-host-")); writeFileSync(join(home, "server-id"), "isolated-service");
  const agent = { id: "codex-one", provider: "codex", cwd: home, workspaceId: "workspace", model: "fixture", currentModeId: "read-only",
    features: [{ id: "plan_mode", type: "toggle", value: false }], status: "error", lastError: "Selected model is at capacity.",
    lastUserMessageAt: "original-user-time", activeTurn: null, pendingPermissions: [], runtimeInfo: { sessionId: "native-thread", model: "fixture" }, labels: {},
  } as unknown as PaseoAgent;
  const inputs: unknown[] = []; let busy = false, lastTurn = "failed-turn", finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const session = { agentStorage: {}, sessionLogger: {}, buildAgentPayload: async () => structuredClone(agent), agentManager: {
    getAgent: () => agent, hasInFlightRun: () => busy, fetchTimeline: () => ({ rows: [{ turnId: lastTurn }] }), subscribe: () => () => {},
    streamAgent: (_id: string, input: []) => {
      if (busy) throw new Error("busy"); busy = true; inputs.push(input);
      return (async function* () {
        agent.status = "running"; agent.activeTurn = { turnId: "retry-turn", startedAt: null };
        yield { type: "turn_started", turnId: "retry-turn" };
        await gate; agent.status = "idle"; agent.activeTurn = null; busy = false;
        yield { type: "turn_completed", turnId: "retry-turn" };
      })();
    },
  } };
  const attempt = { action: "start", agentId: agent.id, attemptId: "attempt-one", identity: recoveryIdentity(agent), lastUserMessageAt: agent.lastUserMessageAt, failedTurnId: "failed-turn" };
  const invoke = (input: unknown) => invokeWorkbenchNativeRecovery(session, input, async () => {}, home);
  return { agent, inputs, invoke, attempt, finish, setLastTurn: (id: string) => { lastTurn = id; }, close: async () => { finish(); await new Promise(r => setImmediate(r)); rmSync(home, { recursive: true, force: true }); } };
}
test("native host starts an empty-input attempt once and preserves user history and mode", async () => {
  const f = fixture();
  try {
    const first = await f.invoke(f.attempt), second = await f.invoke(f.attempt);
    assert.equal((first as { receipt: { turnId: string } }).receipt.turnId, "retry-turn"); assert.deepEqual(first, second);
    assert.deepEqual(f.inputs, [[]]); assert.equal(f.agent.lastUserMessageAt, "original-user-time"); assert.equal(f.agent.currentModeId, "read-only");
    f.finish(); await new Promise(r => setImmediate(r));
    const proof = await f.invoke({ action: "read", agentId: f.agent.id, attemptId: f.attempt.attemptId });
    assert.equal((proof as { receipt: { outcome: { kind: string } } }).receipt.outcome.kind, "completed");
  } finally { await f.close(); }
});
for (const change of ["user", "mode", "model", "planning", "unknown-mode", "permission", "archive", "busy", "turn"] as const) {
  test(`native host rejects changed ${change} before starting`, async () => {
    const f = fixture();
    try {
      if (change === "user") f.agent.lastUserMessageAt = "new-user-time";
      if (change === "mode") f.agent.currentModeId = "full-access";
      if (change === "model") f.agent.model = "different-model";
      if (change === "planning") (f.agent.features![0] as { value: boolean }).value = true;
      if (change === "unknown-mode") f.agent.features = [];
      if (change === "permission") f.agent.pendingPermissions = [{ id: "pending" }] as never;
      if (change === "archive") f.agent.archivedAt = "now";
      if (change === "busy") f.agent.status = "running";
      if (change === "turn") f.setLastTurn("different-failed-turn");
      await assert.rejects(f.invoke(f.attempt), /native_recovery_session_changed/); assert.equal(f.inputs.length, 0);
    } finally { await f.close(); }
  });
}
test("a journaled but unconfirmed native attempt is never replayed", async () => {
  const f = fixture();
  try {
    await f.invoke(f.attempt);
    await assert.rejects(f.invoke({ ...f.attempt, identity: "f".repeat(64) }), /attempt_conflict/);
    await assert.rejects(f.invoke({ ...f.attempt, attemptId: "another-attempt" }), /changed_or_busy/);
    assert.equal(f.inputs.length, 1);
  } finally { await f.close(); }
});

test("host bridge installer preserves the original and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-install-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: "0.11.0" }));
    const directory = join(root, "dist/server/server"); mkdirSync(directory, { recursive: true });
    const original = 'import { ensureAgentLoaded, other } from "./agent/agent-loading.js";\nclass Session { invoke(msg) {\n            return this.pluginRuntime\n                .invokePluginRpc(msg.pluginId, msg.method, msg.input);\n} }\n';
    const file = join(directory, "session.js"); writeFileSync(file, original);
    const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["scripts/install-native-recovery-host.mjs", "--server-root", root, ...args], { encoding: "utf8" }));
    assert.equal(invoke().applied, false); assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(invoke("--apply").changed, true); assert.equal(readFileSync(file + ".workbench-native-recovery.original", "utf8"), original);
    assert.match(readFileSync(file, "utf8"), /invokeWorkbenchNativeRecovery/); assert.equal(invoke("--apply").changed, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("host bridge installer refuses unknown versions and source shapes without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "native-recovery-install-reject-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: "0.12.0" }));
    const invoke = () => execFileSync(process.execPath, ["scripts/install-native-recovery-host.mjs", "--server-root", root, "--apply"], { encoding: "utf8", stdio: "pipe" });
    assert.throws(invoke, /unsupported_paseo_version/);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@getpaseo/server", version: "0.11.0" }));
    const directory = join(root, "dist/server/server"); mkdirSync(directory, { recursive: true });
    const file = join(directory, "session.js"); writeFileSync(file, "unknown host source");
    assert.throws(invoke, /host_source_unrecognized/); assert.equal(readFileSync(file, "utf8"), "unknown host source");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
