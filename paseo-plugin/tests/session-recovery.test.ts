import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { recoveryPolicySchema } from "../shared/session-recovery.ts";
import { recoverableFailure } from "../server/session-recovery/errors.ts";
import { recoveryPrompt, SessionRecoveryController, type RecoveryReviewBridge } from "../server/session-recovery/controller.ts";
import { RecoveryDiskStore, type RecoveryRecord, type RecoveryStorage } from "../server/session-recovery/store.ts";

const capacity = { message: "Selected model is at capacity. Please try a different model." };
class MemoryStore implements RecoveryStorage {
  records: RecoveryRecord[] = [];
  load() { return structuredClone(this.records); }
  save(records: RecoveryRecord[]) { this.records = structuredClone(records); }
  close() {}
}
function harness(options: { store?: MemoryStore; review?: RecoveryReviewBridge; throwSend?: boolean } = {}) {
  let now = 1000000;
  const agent = {
    id: "codex-one", provider: "codex", workspaceId: "workspace-one", cwd: "/test/project", title: "Test session",
    status: "error", currentModeId: "auto", features: [{ id: "plan_mode", type: "toggle", value: false }], model: "test-model",
    runtimeInfo: { provider: "codex", sessionId: "thread-one", model: "test-model" }, lastUserMessageAt: "original-user-time",
    pendingPermissions: [], labels: {}, activeTurn: null, archivedAt: null, persistence: { provider: "codex", sessionId: "thread-one" },
  } as unknown as PaseoAgent;
  const entries: Array<{ turnId: string; item: { type: string; text?: string; clientMessageId?: string; message?: string } }> = [];
  const sent: Array<{ agentId: string; message: string; messageId: string }> = [];
  const api = { agents: { ref: () => ({ refresh: async () => ({ agent: structuredClone(agent) }), timeline: { refetch: async () => ({ entries: structuredClone(entries) }) } }) } } as unknown as PaseoApi;
  const store = options.store || new MemoryStore();
  const create = () => new SessionRecoveryController({ store, review: options.review, api: async () => api, now: () => now, random: () => 0,
    send: async (agentId, message, messageId) => {
      sent.push({ agentId, message, messageId });
      if (options.throwSend) throw new Error("Connection lost after possible acceptance");
      const turnId = `recovery-turn-${sent.length}`;
      entries.push({ turnId, item: { type: "user_message", text: message, clientMessageId: messageId } });
      agent.status = "running"; agent.activeTurn = { turnId, startedAt: null }; agent.lastUserMessageAt = `recovery-user-time-${sent.length}`;
    },
  });
  const controller = create();
  controller.register(agent);
  return { agent, entries, sent, controller, store, create, now: () => now, advance: (ms: number) => { now += ms; },
    enable: async (patch = {}) => controller.setPolicy(recoveryPolicySchema.parse(patch)),
    start: async () => controller.turnStarted(agent.id, agent.activeTurn?.turnId || null),
  };
}

test("error classification permits transient failures and rejects quota, authentication, policy and unexplained retry limits", () => {
  for (const message of [capacity.message, "Error running remote compact task: " + capacity.message, "server_is_overloaded", "Rate limit reached", "429 too many requests", "stream disconnected before completion", "exceeded retry limit, last status: 503", "websocket connection closed", "connection reset by peer", "ETIMEDOUT"]) assert.equal(recoverableFailure({ message }), true, message);
  for (const message of ["exceeded retry limit", "responseTooManyFailedAttempts", "401 Unauthorized", "429 quota exceeded", "rate limit exceeded: billing credits exhausted", "You've hit your usage limit; too many requests", "HTTP 503: request too large", "Context window exceeded", "Permission denied", "Sandbox error", "Canceled", "cyberPolicy", "bad request", "model not found"]) assert.equal(recoverableFailure({ message }), false, message);
  assert.equal(recoverableFailure({ ...capacity, willRetry: true }), false);
  assert.equal(recoverableFailure({ message: "connection failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } }), true);
  assert.equal(recoverableFailure({ message: "connection failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }), false);
});

test("default settings cover all sessions with ten-second interval and a one-hour budget", () => {
  assert.deepEqual(recoveryPolicySchema.parse({}), { enabled: true, intervalSeconds: 10, maxDurationMinutes: 60, enabledByAgent: {} });
  assert.equal(recoveryPolicySchema.safeParse({ intervalSeconds: 0 }).success, false);
});

test("registration does not resume historical errors; new failure waits and sends only a continuation", async () => {
  const h = harness(); await h.enable();
  await h.controller.tick(); assert.equal(h.sent.length, 0);
  assert.equal(await h.controller.claimFailure(h.agent.id, "original-turn", capacity), true);
  h.advance(9999); await h.controller.tick(); assert.equal(h.sent.length, 0);
  h.advance(1); await h.controller.tick(); assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message, recoveryPrompt);
  await h.start(); assert.equal(h.controller.list()[0].status, "running");
  assert.equal(h.controller.list()[0].attempt, 1);
  h.agent.activeTurn = null; h.agent.status = "idle";
  await h.controller.turnEnded(h.agent.id, "recovery-turn-1", { kind: "completed" });
  assert.equal(h.controller.list()[0].status, "succeeded"); await h.controller.close();
});

test("duplicate failures and concurrent ticks schedule one dispatch with a stable message ID", async () => {
  const h = harness(); await h.enable();
  await Promise.all([h.controller.claimFailure(h.agent.id, "original-turn", capacity), h.controller.claimFailure(h.agent.id, "original-turn", capacity)]);
  h.advance(10000); await Promise.all([h.controller.tick(), h.controller.tick()]);
  assert.equal(h.sent.length, 1); assert.match(h.sent[0].messageId, /^workbench-recovery:/);
  await h.controller.claimFailure(h.agent.id, "original-turn", capacity); assert.equal(h.sent.length, 1); await h.controller.close();
});

test("a transient Review resume failure is reconciled without redelivering the accepted message", async () => {
  let resumed = 0;
  const review: RecoveryReviewBridge = { inspect: async () => "task", suspend: async () => {}, stop: async () => {}, resume: async () => { if (++resumed === 1) throw new Error("runtime_unavailable"); } };
  const h = harness({ review }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.retryNow(h.agent.id); await h.start();
  assert.equal(h.controller.list()[0].status, "uncertain");
  h.advance(5000); await h.controller.tick();
  assert.equal(resumed, 2); assert.equal(h.controller.list()[0].status, "running"); assert.equal(h.sent.length, 1);
  await h.controller.close();
});

test("budget and attempt count survive retry turns, and expired recovery is not dispatched", async () => {
  const h = harness(); await h.enable({ maxDurationMinutes: 1 });
  await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  const deadline = h.controller.list()[0].deadlineAt;
  h.advance(10000); await h.controller.tick(); await h.start();
  h.agent.status = "error"; h.agent.activeTurn = null;
  await h.controller.turnEnded(h.agent.id, "recovery-turn-1", { kind: "failed", error: capacity });
  assert.equal(h.controller.list()[0].deadlineAt, deadline); assert.equal(h.controller.list()[0].attempt, 1);
  h.advance(50000); await h.controller.tick();
  assert.equal(h.sent.length, 1); assert.equal(h.controller.list()[0].reason, "recovery_time_limit");
  await h.controller.close();
});

test("unlimited recovery keeps trying beyond an hour and can be manually stopped", async () => {
  const h = harness(); await h.enable({ maxDurationMinutes: null });
  await h.controller.claimFailure(h.agent.id, "original-turn", capacity); h.advance(4000000);
  await h.controller.tick(); assert.equal(h.sent.length, 1);
  await h.controller.cancel(h.agent.id); assert.equal(h.controller.list()[0].status, "stopped");
  h.advance(4000000); await h.controller.tick(); assert.equal(h.sent.length, 1); await h.controller.close();
});

test("global and per-session policy changes apply to waiting episodes", async () => {
  const h = harness(); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.setPolicy(recoveryPolicySchema.parse({ enabledByAgent: { [h.agent.id]: false } }));
  h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 0); assert.equal(h.controller.list()[0].enabled, false);
  await h.controller.setPolicy(recoveryPolicySchema.parse({ enabled: false, enabledByAgent: { [h.agent.id]: true } }));
  assert.equal(h.controller.list()[0].enabled, true); await h.controller.close();
});

test("manual retry observes deadline and cannot replay an uncertain delivery", async () => {
  const h = harness({ throwSend: true }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.retryNow(h.agent.id); assert.equal(h.sent.length, 1); assert.equal(h.controller.list()[0].status, "uncertain");
  await assert.rejects(h.controller.retryNow(h.agent.id), /not_waiting/);
  h.advance(100000); await h.controller.tick(); assert.equal(h.sent.length, 1); await h.controller.close();
});

test("stopping an accepted recovery cannot be re-armed by its late start or failure", async () => {
  const h = harness(); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.retryNow(h.agent.id); await h.controller.cancel(h.agent.id); await h.start();
  assert.equal(h.controller.list()[0].status, "stopped");
  h.agent.activeTurn = null; h.agent.status = "error";
  await h.controller.turnEnded(h.agent.id, "recovery-turn-1", { kind: "failed", error: capacity });
  h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 1);
  assert.equal(h.controller.list()[0].status, "stopped"); await h.controller.close();
});

test("stopping an accepted recovery also survives a missed start event", async () => {
  const h = harness(); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.retryNow(h.agent.id); await h.controller.cancel(h.agent.id);
  h.agent.activeTurn = null; h.agent.status = "error";
  await h.controller.turnEnded(h.agent.id, "recovery-turn-1", { kind: "failed", error: capacity });
  h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 1); assert.equal(h.controller.list()[0].status, "stopped");
  await h.controller.close();
});

test("a stop requested during slow preflight verification prevents dispatch", async () => {
  let inspections = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const review: RecoveryReviewBridge = { inspect: async () => { if (++inspections === 2) { enter(); await gate; } return "task"; }, suspend: async () => {}, resume: async () => {}, stop: async () => {} };
  const h = harness({ review }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  h.advance(10000); const ticking = h.controller.tick(); await entered;
  const stopping = h.controller.cancel(h.agent.id); release(); await Promise.all([ticking, stopping]);
  assert.equal(h.sent.length, 0); assert.equal(h.controller.list()[0].status, "stopped"); await h.controller.close();
});

test("multiple sessions keep independent recovery identities and dispatch once each", async () => {
  const original = harness().agent, agents = new Map(["one", "two", "three"].map(id => [id, { ...structuredClone(original), id }]));
  let now = 1000000;
  const sent: Array<{ id: string; messageId: string }> = [];
  const api = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: structuredClone(agents.get(id)) }) }) } } as unknown as PaseoApi;
  const controller = new SessionRecoveryController({ api: async () => api, store: new MemoryStore(), now: () => now, random: () => 0,
    send: async (id, _prompt, messageId) => { sent.push({ id, messageId }); } });
  for (const agent of agents.values()) controller.register(agent);
  await controller.setPolicy(recoveryPolicySchema.parse({}));
  await Promise.all([...agents.keys()].map(id => controller.claimFailure(id, `failed-${id}`, capacity)));
  now += 10000; await Promise.all([controller.tick(), controller.tick()]);
  assert.deepEqual(sent.map(s => s.id).sort(), [...agents.keys()].sort()); assert.equal(new Set(sent.map(s => s.messageId)).size, 3);
  assert.ok(controller.list().every(s => s.attempt === 1)); await controller.close();
});

test("non-recoverable errors expose their stop reason without dispatching", async () => {
  const h = harness(); await h.enable();
  await h.controller.turnEnded(h.agent.id, "quota-turn", { kind: "failed", error: { message: "Quota exceeded" } });
  assert.equal(h.controller.list()[0].status, "stopped"); assert.equal(h.controller.list()[0].reason, "Quota exceeded");
  assert.equal(h.sent.length, 0); await h.controller.close();
});

test("unloading does not change a confirmed running turn into another dispatch", async () => {
  const h = harness(); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  await h.controller.retryNow(h.agent.id); await h.start(); await h.controller.close();
  const next = h.create(); await next.setPolicy(recoveryPolicySchema.parse({})); h.advance(10000); await next.tick();
  assert.equal(h.sent.length, 1); assert.equal(next.list()[0].status, "running"); await next.close();
});

for (const mutation of ["newMessage", "mode", "planning", "model", "requestedModel", "permission", "archive", "closed", "busy"] as const) {
  test(`waiting recovery is canceled for ${mutation}`, async () => {
    const h = harness(); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
    if (mutation === "newMessage") h.agent.lastUserMessageAt = "new-user-message";
    if (mutation === "mode") h.agent.currentModeId = "full-access";
    if (mutation === "planning") (h.agent.features![0] as { value: boolean }).value = true;
    if (mutation === "model") h.agent.model = "other-model", h.agent.runtimeInfo!.model = "other-model";
    if (mutation === "requestedModel") h.agent.model = "other-model";
    if (mutation === "permission") h.agent.pendingPermissions = [{ id: "permission" }] as never;
    if (mutation === "archive") h.agent.archivedAt = "archived";
    if (mutation === "closed") h.agent.status = "closed";
    if (mutation === "busy") h.agent.activeTurn = { turnId: "new-turn", startedAt: null };
    h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 0); assert.equal(h.controller.records.get(h.agent.id)?.status, "stopped");
    await h.controller.close();
  });
}

test("unknown planning state never becomes execution authorization", async () => {
  const h = harness(); await h.enable(); h.agent.features = [];
  assert.equal(await h.controller.claimFailure(h.agent.id, "original-turn", capacity), false); await h.controller.close();
});

test("a second snapshot check catches user input arriving during review inspection", async () => {
  let h: ReturnType<typeof harness>, inspections = 0;
  const review: RecoveryReviewBridge = { inspect: async () => { if (++inspections === 2) h.agent.lastUserMessageAt = "new-user"; return "task"; }, suspend: async () => {}, resume: async () => {}, stop: async () => {} };
  h = harness({ review }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 0); await h.controller.close();
});

test("read-only verification outage pauses without spending attempts or replaying", async () => {
  let inspections = 0;
  const review: RecoveryReviewBridge = { inspect: async () => { if (++inspections === 2) throw new Error("runtime_unavailable"); return "task"; }, suspend: async () => {}, resume: async () => {}, stop: async () => {} };
  const h = harness({ review }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  h.advance(10000); await h.controller.tick(); assert.equal(h.controller.list()[0].status, "paused"); assert.equal(h.sent.length, 0);
  h.advance(10000); await h.controller.tick(); assert.equal(h.sent.length, 1); await h.controller.close();
});

test("reload preserves waiting budgets and does not automatically replay an unconfirmed send", async () => {
  const h = harness({ throwSend: true }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  const deadline = h.controller.list()[0].deadlineAt; await h.controller.close();
  const next = h.create(); await next.setPolicy(recoveryPolicySchema.parse({})); h.advance(10000); await next.tick();
  assert.equal(h.sent.length, 1); assert.equal(next.list()[0].deadlineAt, deadline); await next.close();
  const last = h.create(); await last.setPolicy(recoveryPolicySchema.parse({})); h.advance(10000); await last.tick();
  assert.equal(h.sent.length, 1); assert.equal(last.list()[0].status, "uncertain"); await last.close();
});

test("generation retirement while verification is pending prevents dispatch", async () => {
  let resolve!: () => void, count = 0;
  const hold = new Promise<void>(r => { resolve = r; });
  const review: RecoveryReviewBridge = { inspect: async () => { if (++count === 2) await hold; return "task"; }, suspend: async () => {}, resume: async () => {}, stop: async () => {} };
  const h = harness({ review }); await h.enable(); await h.controller.claimFailure(h.agent.id, "original-turn", capacity);
  h.advance(10000); const tick = h.controller.tick(); await new Promise(r => setImmediate(r));
  const close = h.controller.close(); resolve(); await Promise.all([tick, close]); assert.equal(h.sent.length, 0);
});

test("disk store preserves unknown fields, rejects a live second owner and retains uncertain state", () => {
  const directory = mkdtempSync(join(tmpdir(), "workbench-recovery-store-"));
  try {
    const store = new RecoveryDiskStore(directory, "service-one");
    assert.throws(() => new RecoveryDiskStore(directory, "service-one"), /owner_busy/);
    store.save([]); const path = join(directory, "state.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), futureField: "keep" }));
    store.load(); store.save([]); store.close();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).futureField, "keep");
    const next = new RecoveryDiskStore(directory, "service-one"); assert.deepEqual(next.load(), []); store.close(); next.save([]); next.close();
    const other = new RecoveryDiskStore(directory, "service-two"); assert.throws(() => other.load(), /identity_changed/); other.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
