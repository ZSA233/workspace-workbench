import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Uses the actual plugin, host Agent manager and Codex adapter with a local protocol fixture. */
export async function verifySessionRecovery({ client, root, wait, report, reload }) {
  const pluginId = "workspace-workbench-paseo", rpcName = "workspace.workbench.recovery";
  const rpc = input => client.invokePluginRpc(pluginId, rpcName, input);
  const readPolicy = () => client.invokePluginRpc(pluginId, "settings.workspace-workbench-recovery.read", {});
  const policy = async patch => {
    const old = await readPolicy(); assert.equal(old.status, "ready");
    const saved = await client.invokePluginRpc(pluginId, "settings.workspace-workbench-recovery.write", { revision: old.revision, values: { ...old.values, ...patch } });
    assert.equal(saved.status, "saved"); return saved.values;
  };
  const initial = await wait(async () => { const result = await rpc({ action: "list" }); return result.available ? result : null; });
  if (process.env.WORKBENCH_LIVE_RECOVERY_NO_NATIVE === "1") assert.equal(initial.nativeAvailable, false);
  let actualNative = false;
  try {
    const capability = await client.invokePluginRpc(pluginId, "workspace.workbench.nativeRecovery.v1", { action: "capabilities" });
    actualNative = capability.version === 1 && capability.emptyInput && capability.receipts;
  } catch (error) { report.nativeProbeError = error.message; }
  if (actualNative && !initial.nativeAvailable) await wait(async () => (await rpc({ action: "list" })).nativeAvailable);
  initial.nativeAvailable = actualNative;
  const defaults = await readPolicy();
  assert.equal(defaults.values.intervalSeconds, 10); assert.equal(defaults.values.maxDurationMinutes, 60); assert.equal(defaults.values.enabled, true);
  assert.equal(defaults.values.method, "continue"); assert.equal(defaults.values.continueMessage, "继续");
  const cwd = join(root, "outside-workbench"); mkdirSync(cwd);
  const create = async (scenario, title = scenario, observeRegistration = true) => {
    const snapshot = await client.createAgent({ config: { provider: "codex", model: "recovery-fixture", thinkingOptionId: "low", cwd, modeId: "auto", featureValues: { plan_mode: false } }, title });
    const id = snapshot.id;
    if (observeRegistration) await wait(async () => (await rpc({ action: "get", agentId: id })).sessions.length);
    await client.sendMessage(id, scenario, { messageId: `fixture-original-${id}` });
    return id;
  };
  const state = async id => (await rpc({ action: "get", agentId: id })).sessions[0];
  const threads = async id => {
    const snapshot = await client.fetchAgent({ agentId: id });
    const threadId = snapshot.agent.runtimeInfo?.sessionId || snapshot.agent.persistence?.sessionId;
    return JSON.parse(readFileSync(join(root, "recovery-codex", `${threadId}.json`), "utf8"));
  };
  const defaultFirst = await create("CAPACITY_ONCE", "Default continue recovery outside Workbench");
  const waiting = await wait(async () => { const s = await state(defaultFirst); return s.status === "waiting" ? s : null; });
  assert.equal(waiting.connectedToWorkbench, false); assert.ok(waiting.nextAttemptAt - Date.now() <= 12000);
  assert.equal(waiting.deliveryKind, "message");
  await rpc({ action: "retryNow", agentId: defaultFirst });
  await wait(async () => { const s = await state(defaultFirst); if (["stopped", "paused", "uncertain"].includes(s.status)) throw new Error(`continue_recovery_failed: ${s.reason}`); return s.status === "succeeded"; });
  const defaultThread = await threads(defaultFirst);
  assert.equal(defaultThread.turns.length, 2);
  assert.equal(defaultThread.inputs[1].length, 1);
  assert.equal(defaultThread.inputs[1][0].type, "text"); assert.equal(defaultThread.inputs[1][0].text, "继续");
  const defaultTimeline = await client.fetchAgentTimeline(defaultFirst, { direction: "tail", limit: 100 });
  assert.deepEqual(defaultTimeline.entries.filter(entry => entry.item.type === "user_message").map(entry => entry.item.text), ["CAPACITY_ONCE", "继续"]);
  report.checks.push("actual host defaults to a single 继续 message; no system prompt or host patch is required");

  await policy({ method: "auto" });
  const first = await create("CAPACITY_ONCE", "Preferred recovery outside Workbench");
  await wait(async () => (await state(first)).status === "waiting");
  await rpc({ action: "retryNow", agentId: first });
  const completed = await wait(async () => { const s = await state(first); if (["stopped", "paused"].includes(s.status)) throw new Error(`native_recovery_failed: ${s.reason}`); return s.status === "succeeded" ? s : null; });
  assert.equal(completed.attempt, 1);
  const thread = await threads(first); assert.equal(thread.turns.length, 2);
  assert.equal(completed.deliveryKind, initial.nativeAvailable ? "native" : "message");
  if (initial.nativeAvailable) assert.deepEqual(thread.inputs[1], []);
  else { assert.equal(thread.inputs[1].length, 1); assert.equal(thread.inputs[1][0].text, "继续"); }
  assert.equal(thread.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage").length, initial.nativeAvailable ? 1 : 2);
  const timeline = await client.fetchAgentTimeline(first, { direction: "tail", limit: 100 });
  assert.equal(timeline.entries.filter(entry => entry.item.type === "user_message").length, initial.nativeAvailable ? 1 : 2);
  report.checks.push(initial.nativeAvailable
    ? "actual host prefers empty-input native recovery when installed; native and Paseo history gained no user message"
    : "actual host without the native interface automatically falls back to 继续 and retains the original session");

  await policy({ method: "continue", intervalSeconds: 1, maxDurationMinutes: null });
  // No recovery list/get RPC, retryNow or UI subscriber is involved from agent
  // creation through recovery. Observe only the host and the protocol fixture.
  const unobserved = await create("CAPACITY_ONCE", "Automatic recovery without recovery UI polling", false);
  await wait(async () => {
    const thread = await threads(unobserved);
    return thread.turns.length === 2 && thread.turns[1].status === "completed";
  });
  const unobservedThread = await threads(unobserved);
  assert.equal(unobservedThread.inputs[1][0].text, "继续");
  assert.equal((await state(unobserved)).attempt, 1);
  report.checks.push("actual host registers and automatically continues a new session without any recovery UI status polling or retryNow");

  const network = await create("NETWORK_ONCE");
  await wait(async () => (await state(network)).status === "succeeded");
  const quota = await create("QUOTA");
  await wait(async () => (await client.fetchAgent({ agentId: quota })).agent.status === "error");
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal((await threads(quota)).turns.length, 1);
  report.checks.push("actual host recovers a transient connection failure and never retries exhausted quota");

  await policy({ intervalSeconds: 30, maxDurationMinutes: 60 });
  const restored = await create("CAPACITY_RELOAD");
  const before = await wait(async () => { const s = await state(restored); return s.status === "waiting" ? s : null; });
  await reload();
  const after = await wait(async () => { const result = await rpc({ action: "get", agentId: restored }); return result.available && result.sessions[0]?.status === "waiting" ? result.sessions[0] : null; });
  assert.equal(after.deadlineAt, before.deadlineAt); assert.equal(after.attempt, 0);
  await rpc({ action: "retryNow", agentId: restored });
  await wait(async () => (await state(restored)).status === "succeeded");
  assert.equal((await threads(restored)).turns.length, 2);
  report.checks.push("actual plugin reload retained a queued recovery and its original time budget without replaying the handoff");

  const manual = await create("ALWAYS_CAPACITY_USER");
  await wait(async () => (await state(manual)).status === "waiting");
  await client.sendMessage(manual, "MANUAL_CONTINUE", { messageId: "fixture-manual-user" });
  await wait(async () => (await state(manual)).status === "stopped");
  assert.equal((await threads(manual)).turns.length, 2);
  const canceled = await create("ALWAYS_CAPACITY_CANCEL");
  await wait(async () => (await state(canceled)).status === "waiting");
  await rpc({ action: "cancel", agentId: canceled });
  await assert.rejects(rpc({ action: "retryNow", agentId: canceled }), /not_waiting/);
  await rpc({ action: "setEnabled", agentId: canceled, enabled: false });
  assert.equal((await state(canceled)).enabled, false);
  report.checks.push("actual host cancels pending recovery on new user work, honors manual stop and persists a per-session disable");
  await policy({ enabled: true, method: "continue", continueMessage: "继续", intervalSeconds: 10, maxDurationMinutes: 60 });
  report.recoverySessions = { defaultFirst, first, unobserved, network, quota, restored, manual, canceled };
  report.nativeAvailable = initial.nativeAvailable;
}
