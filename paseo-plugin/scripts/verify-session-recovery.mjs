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
  await wait(async () => (await rpc({ action: "list" })).available);
  const defaults = await readPolicy();
  assert.equal(defaults.values.intervalSeconds, 10); assert.equal(defaults.values.maxDurationMinutes, 60); assert.equal(defaults.values.enabled, true);
  const cwd = join(root, "outside-workbench"); mkdirSync(cwd);
  const create = async (scenario, title = scenario) => {
    const snapshot = await client.createAgent({ config: { provider: "codex", model: "recovery-fixture", thinkingOptionId: "low", cwd, modeId: "auto", featureValues: { plan_mode: false } }, title });
    const id = snapshot.id;
    await wait(async () => (await rpc({ action: "get", agentId: id })).sessions.length);
    await client.sendMessage(id, scenario, { messageId: `fixture-original-${id}` });
    return id;
  };
  const state = async id => (await rpc({ action: "get", agentId: id })).sessions[0];
  const threads = async id => {
    const snapshot = await client.fetchAgent({ agentId: id });
    const threadId = snapshot.agent.runtimeInfo?.sessionId || snapshot.agent.persistence?.sessionId;
    return JSON.parse(readFileSync(join(root, "recovery-codex", `${threadId}.json`), "utf8"));
  };
  const first = await create("CAPACITY_ONCE", "Capacity outside Workbench");
  const waiting = await wait(async () => { const s = await state(first); return s.status === "waiting" ? s : null; });
  assert.equal(waiting.connectedToWorkbench, false); assert.ok(waiting.nextAttemptAt - Date.now() <= 12000);
  await rpc({ action: "retryNow", agentId: first });
  const completed = await wait(async () => { const s = await state(first); if (["stopped", "paused"].includes(s.status)) throw new Error(`native_recovery_failed: ${s.reason}`); return s.status === "succeeded" ? s : null; });
  assert.equal(completed.attempt, 1);
  const thread = await threads(first); assert.equal(thread.turns.length, 2);
  assert.deepEqual(thread.inputs[1], []);
  assert.equal(thread.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage").length, 1);
  const timeline = await client.fetchAgentTimeline(first, { direction: "tail", limit: 100 });
  assert.equal(timeline.entries.filter(entry => entry.item.type === "user_message").length, 1);
  report.checks.push("actual host recovered an unregistered Codex capacity failure with empty input; native and Paseo history gained no user message");

  await policy({ intervalSeconds: 1, maxDurationMinutes: null });
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
  await policy({ enabled: true, intervalSeconds: 10, maxDurationMinutes: 60 });
  report.recoverySessions = { first, network, quota, restored, manual, canceled };
}
