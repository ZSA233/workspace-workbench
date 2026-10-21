import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryClientStore } from "../client/recovery-store.ts";
import { recoveryPolicySchema } from "../shared/session-recovery.ts";
import { createRegistrationQueue } from "../client/registration-queue.ts";
import { installNativeHealthMonitor } from "../client/native-health.ts";
import { createDiagnosticSender } from "../client/diagnostic-sender.ts";
import { configureNativeDiagnosticReporter, installNativeRenderErrorHook, reportNativeDiagnostic } from "../client/native-diagnostics.ts";
// @ts-ignore Read-only standalone collector is distributed as ESM.
import { collectAndroidDiagnostics, summarizeHostLog } from "../scripts/collect-android-diagnostics.mjs";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("demand-only native recovery has no idle RPC or timers and releases its session list when closed", async t => {
  const timers = new Map<number, { run: () => void; ms: number }>(); let id = 0, reads = 0;
  t.mock.method(globalThis, "setInterval", (run: () => void, ms: number) => { timers.set(++id, { run, ms }); return id; });
  t.mock.method(globalThis, "clearInterval", (id: number) => timers.delete(id));
  const sessions = Array.from({ length: 500 }, (_, i) => ({ agentId: `session-${i}` }));
  const store = createRecoveryClientStore({ rpc: async () => { reads++; return { sessions, policy: recoveryPolicySchema.parse({}), available: true, nativeAvailable: false }; } } as any, { demandOnly: true });
  store.start(); await store.refresh(); store.setForeground(false); store.setForeground(true); await tick();
  assert.equal(reads, 0); assert.equal(timers.size, 0);
  const closeFirst = store.observe(); await tick();
  assert.equal(reads, 1); assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 5000); assert.equal(store.getSnapshot().sessions.length, 500);
  const closeSecond = store.observe(); await tick(); closeFirst(); assert.equal(timers.size, 1);
  store.setForeground(false); assert.equal(timers.size, 0); store.setForeground(true); await tick(); assert.equal(timers.size, 1);
  closeSecond(); closeSecond(); assert.equal(timers.size, 0); assert.equal(store.getSnapshot().sessions.length, 0);
  const before = reads; await store.refresh(); store.setForeground(false); store.setForeground(true); await tick(); assert.equal(reads, before);
  store.close();
});

test("closing a native recovery view prevents queued reads and retention of late responses", async () => {
  let reads = 0, finish!: (response: any) => void;
  const store = createRecoveryClientStore({ rpc: () => { reads++; return new Promise(resolve => { finish = resolve; }); } } as any, { demandOnly: true });
  store.start(); const immediateClose = store.observe(); immediateClose(); await tick(); assert.equal(reads, 0);
  const close = store.observe(); await tick(); const pending = store.refresh(); assert.equal(reads, 1);
  close(); finish({ sessions: [{ agentId: "not-retained" }], policy: recoveryPolicySchema.parse({}), available: true, nativeAvailable: false });
  await pending; assert.equal(store.getSnapshot().sessions.length, 0); assert.equal(store.getSnapshot().loaded, false);
  store.close();
});

test("optional idle observation deduplicates snapshots and respects foreground and observer demand", async t => {
  const timers = new Map<number, { run: () => void; ms: number }>(); let id = 0, reads = 0, updates = 0;
  t.mock.method(globalThis, "setInterval", (run: () => void, ms: number) => { timers.set(++id, { run, ms }); return id; });
  t.mock.method(globalThis, "clearInterval", (id: number) => timers.delete(id));
  const store = createRecoveryClientStore({ rpc: async () => { reads++; return { sessions: [], policy: recoveryPolicySchema.parse({}), available: true, nativeAvailable: false }; } } as any, { idleIntervalMs: 30000 });
  store.subscribe(() => updates++); store.start(); await tick();
  assert.equal([...timers.values()][0].ms, 30000); assert.equal(reads, 1);
  await store.refresh(); assert.equal(updates, 1, "identical snapshots must not notify every pill and panel");
  const stopObserving = store.observe(); await tick(); assert.equal([...timers.values()][0].ms, 5000);
  store.setForeground(false); assert.equal(timers.size, 0);
  const before = reads, offscreenObserver = store.observe(); await tick(); assert.equal(reads, before);
  offscreenObserver(); store.setForeground(true); await tick(); assert.equal(reads, before + 1);
  stopObserving(); assert.equal([...timers.values()][0].ms, 30000);
  store.close(); assert.equal(timers.size, 0); await store.refresh(); assert.equal(reads, before + 1);
});

test("native contribution bursts yield every four updates and replace superseded pending work", () => {
  const frames = new Map<number, () => void>(), applied: string[] = []; let id = 0;
  const queue = createRegistrationQueue({ deferred: true, now: () => 0, schedule: run => { frames.set(++id, run); return id as any; }, cancel: timer => { frames.delete(Number(timer)); } });
  const frame = () => { const work = [...frames.values()]; frames.clear(); work.forEach(run => run()); };
  for (let i = 0; i < 200; i++) queue.enqueue(String(i), () => applied.push(String(i)));
  queue.enqueue("0", () => applied.push("latest")); queue.cancel("1");
  assert.equal(applied.length, 0); assert.equal(frames.size, 1);
  frame(); assert.equal(applied.length, 4); assert.equal(applied[0], "latest"); assert.ok(!applied.includes("1"));
  frame(); assert.equal(applied.length, 8); queue.close(); frame(); assert.equal(applied.length, 8); assert.equal(frames.size, 0);
});

test("native registration respects the frame time budget and telemetry failures cannot stop it", () => {
  let at = 0, next: (() => void) | undefined, applied = 0;
  const queue = createRegistrationQueue({ deferred: true, now: () => at, schedule: run => { next = run; return 1 as any; }, cancel() {}, report() { throw Error("offline"); } });
  for (let i = 0; i < 5; i++) queue.enqueue(String(i), () => { at += 40; applied++; });
  next!(); assert.equal(applied, 1); next!(); assert.equal(applied, 2); queue.close();
});

test("reentrant host contribution callbacks do not multiply pending frame timers", () => {
  const frames = new Map<number, () => void>(); let id = 0;
  const queue = createRegistrationQueue({ deferred: true, now: () => 0, schedule: run => { frames.set(++id, run); return id as any; }, cancel: timer => { frames.delete(Number(timer)); } });
  queue.enqueue("first", () => { for (let i = 0; i < 20; i++) queue.enqueue(String(i), () => {}); });
  const run = [...frames.values()][0]; frames.clear(); run();
  assert.equal(frames.size, 1); queue.close(); assert.equal(frames.size, 0);
});

test("native health distinguishes foreground JS stalls from time spent in the background", () => {
  let at = 0, sample: (() => void) | undefined, activity!: (state: string) => void, removed = false;
  const events: Array<{ phase: string; details: Record<string, string> }> = [];
  const stop = installNativeHealthMonitor({ now: () => at, report: (phase, details) => { events.push({ phase, details }); },
    set: run => { sample = run; return 1 as any; }, clear: () => { sample = undefined; },
    activity: { currentState: "active", addEventListener: (_type, handler) => { activity = handler; return { remove() { removed = true; } }; } } });
  at = 30000; sample!(); assert.equal(events.at(-1)!.phase, "native-js-stall"); assert.equal(events.at(-1)!.details.maxLagMs, "28000");
  activity("background"); assert.equal(sample, undefined); at += 3600000; activity("active");
  at += 2000; sample!(); assert.equal(events.filter(event => event.phase === "native-js-stall").length, 1);
  stop(); assert.equal(sample, undefined); assert.equal(removed, true);
});

test("diagnostic bursts use bounded batches and one ordinary RPC at a time", async () => {
  const requests: any[] = []; let finish!: () => void;
  const sender = createDiagnosticSender({ rpc: (contract: any, input: any) => { requests.push({ method: contract.name, input }); return new Promise<void>(resolve => { finish = resolve; }); } } as any);
  for (let i = 0; i < 1000; i++) sender.report({ phase: "registration-before", platform: "android", details: { stage: String(i) } });
  await tick(); assert.equal(requests.length, 1); assert.equal(requests[0].input.events.length, 16);
  assert.equal(requests[0].input.events[0].details.stage, "936", "the queue retains at most 64 ordinary events");
  finish(); await tick(); assert.equal(requests.length, 2);
  sender.close(); finish(); await tick(); assert.equal(requests.length, 2);
});

test("fatal JS errors carry an instance identity without serializing unrelated console objects", t => {
  t.mock.method(console, "error", () => {});
  const target = globalThis as any, previous = target.ErrorUtils, events: any[] = []; let handler: any, forwarded = 0, serialized = 0;
  handler = () => forwarded++;
  target.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (next: any) => { handler = next; } };
  configureNativeDiagnosticReporter({ platform: "android", report: event => { events.push(event); } });
  const cleanup = installNativeRenderErrorHook();
  try {
    console.error("unrelated host error", { toJSON() { serialized++; throw Error("large object"); } });
    handler(new Error("arbitrary fatal error"), true);
    assert.equal(serialized, 0); assert.equal(forwarded, 1); assert.equal(events[0].phase, "native-js-fatal");
    assert.ok(events[0].details.clientInstance); assert.match(events[0].details.message, /arbitrary fatal error/);
    handler({ get message() { throw Error("unprintable exception"); } }, true);
    assert.equal(forwarded, 2);
  } finally { cleanup(); configureNativeDiagnosticReporter(null); target.ErrorUtils = previous; }
});

test("Android quiet diagnostics skip routine work before formatting and keep only the marker and explicit failures", t => {
  t.mock.method(console, "info", () => {}); t.mock.method(console, "error", () => {});
  const events: any[] = [];
  configureNativeDiagnosticReporter({ platform: "android", errorsOnly: true, report: event => { events.push(event); } });
  try {
    const details = Object.defineProperty({}, "mustNotRead", { enumerable: true, get() { throw Error("routine telemetry must be skipped before formatting"); } });
    for (const phase of ["registration-before", "registration-after", "panel-entry", "native-component-selected", "native-health"]) reportNativeDiagnostic(phase, details);
    assert.equal(events.length, 0);
    reportNativeDiagnostic("android-client-policy", { recoveryUi: "disabled" });
    reportNativeDiagnostic("component_load_failed", { message: "explicit panel failure" });
    assert.equal(events.length, 2);
  } finally { configureNativeDiagnosticReporter(null); }
});

test("Android collector targets the app and preserves disabled plugins and device logs", async () => {
  const output = await mkdtemp(join(tmpdir(), "wb-android-capture-")), commands: string[][] = [];
  try {
    const report = await collectAndroidDiagnostics({ output, home: output, durationSeconds: 0 }, async (command: string, args: string[]) => {
      commands.push([command, ...args]);
      if (command === "paseo") return args[0] === "plugin" ? JSON.stringify([{ id: "workspace-workbench-paseo", status: "disabled", enabled: false }]) : "{}";
      if (args[0] === "devices") return "List of devices attached\nfixture device product:fixture\n";
      if (args.includes("packages")) return "package:com.example.paseo\n";
      if (args.includes("pidof")) return "123\n";
      return "fixture output\n";
    });
    assert.equal(report.plugin.enabled, false); assert.equal(report.android.status, "captured");
    const logs = commands.filter(args => args.includes("logcat")); assert.equal(logs.length, 2);
    assert.ok(logs.every(args => args.includes("--pid") && args.includes("123")));
    assert.ok(commands.some(args => args.includes("exit-info"))); assert.ok(commands.some(args => args.includes("meminfo")));
    assert.ok(!commands.some(args => args.some(arg => ["-c", "enable", "reload", "restart", "force-stop"].includes(arg))));
    assert.match(await readFile(join(output, "app-crash-123.txt"), "utf8"), /fixture/);
    const summary = summarizeHostLog(JSON.stringify({ msg: "ws_runtime_metrics", time: 0, memory: { rss: 1234 } }));
    assert.equal(summary.recentHostTransport[0].hostMemory.rss, 1234); assert.match(summary.note, /not Android memory/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
