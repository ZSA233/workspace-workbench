import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { createRegistrationScope } from "../client/initialization.ts";
import { createRecoveryClientStore } from "../client/recovery-store.ts";
import { recoveryPolicySchema } from "../shared/session-recovery.ts";

const require = createRequire(import.meta.url);
// Match the host's compilation and interop settings; evaluate the real entry,
// not a second implementation of the plugin registration function.
const compiled = buildSync({ entryPoints: [new URL("../index.client.tsx", import.meta.url).pathname], bundle: true,
  format: "cjs", jsx: "automatic", platform: "neutral", mainFields: ["module", "main"], target: "es2020",
  supported: { "async-await": false }, external: ["@getpaseo/plugin", "@getpaseo/plugin/client", "@getpaseo/plugin/client/react-native", "@getpaseo/plugin/client/ui", "@tanstack/react-query", "react", "react/jsx-runtime", "react-native", "zod"], write: false,
}).outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]");

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const policy = recoveryPolicySchema.parse({});
const response = (sessions: any[] = []) => ({ sessions, policy, available: true, nativeAvailable: false, loaded: true });

function fixture(options: { fail?: string; missing?: string; cleanupFailure?: string; throwRpc?: boolean; platform?: string; stateFailure?: boolean } = {}) {
  const registered = new Map<string, unknown>(), removed: string[] = [], calls: string[] = [], diagnostics: any[] = [], intervals = new Map<number, () => void>();
  const requires: string[] = [];
  const frames = new Map<number, () => void>();
  let nextTimer = 1, sessions: any[] = [], disposedCalls = 0;
  const add = (name: string, value?: unknown) => {
    calls.push(name);
    if (options.fail === name) throw new TypeError("Cannot read property 'prototype' of undefined");
    assert.ok(!registered.has(name), `duplicate registration: ${name}`);
    registered.set(name, value);
    return () => { disposedCalls++; removed.push(name); registered.delete(name); if (name === options.cleanupFailure) throw Error("cleanup fixture"); };
  };
  const client: any = {
    addSurface: (id: string, component: unknown) => add(`surface:${id}`, component),
    addSidebarItem: (item: any) => add(`sidebar:${item.id}`),
    addSettingsScreen: (item: any) => add(`settings:${item.id}`, item.Component),
    addWorkspacePanel: (item: any) => add(`panel:${item.id}`, item.Component),
    addCommandCenterItem: (item: any) => add(`command:${item.id}`, item),
    addHeaderButton: (item: any) => ({ remove: add(`header:${item.workspaceId}`), update() {} }),
    addComposerPill: (item: any) => ({ remove: add(`pill:${item.agentId}`), update() { calls.push(`update:${item.agentId}`); if (options.fail === "pill:update") throw Error("pill update failed"); } }),
    openSurface: (id: string) => calls.push(`open:${id}`), openPanel() {},
    rpc: (rpc: any, input: any) => {
      if (rpc.name === "workspace.workbench.client-diagnostic") { diagnostics.push(input); return Promise.resolve({ ok: true }); }
      if (rpc.name === "workspace.workbench.client-diagnostic-batch") { diagnostics.push(...input.events); return Promise.resolve({ ok: true }); }
      calls.push(`rpc:${input.action || rpc.name}`);
      if (options.throwRpc) throw Error("disconnected");
      return Promise.resolve(response(sessions));
    },
  };
  if (options.missing) delete client[options.missing];
  const component = () => null;
  const context: any = { module: { exports: {} }, console: { error() {}, info() {}, warn() {}, log() {} }, setTimeout(fn: () => void) { const id = nextTimer++; frames.set(id, fn); return id; }, clearTimeout(id: number) { frames.delete(id); },
    setInterval(fn: () => void) { const id = nextTimer++; intervals.set(id, fn); return id; }, clearInterval(id: number) { intervals.delete(id); },
    require(name: string) {
      requires.push(name);
      if (name === "react-native") return { Platform: { OS: options.platform || "android" }, View: component, Text: component, FlatList: component, Modal: component, TextInput: component, ScrollView: component };
      if (name === "@getpaseo/plugin/client/react-native" || name === "@getpaseo/plugin/client") return {};
      if (name === "zod" && options.stateFailure) {
        const real = require("zod");
        return { ...real, z: { ...real.z, object(shape: any) {
          const schema = real.z.object(shape);
          if (shape.enabledByAgent) Object.defineProperty(schema, "parse", { value() { throw new TypeError("state initialization fixture"); } });
          return schema;
        } } };
      }
      return require(name);
    },
  };
  context.exports = context.module.exports;
  for (const name of ["window", "document", "Element", "Worker"]) Object.defineProperty(context, name, { get() { throw Error(`native entry accessed ${name}`); } });
  vm.runInNewContext(compiled, context);
  const contribute = context.module.exports.default;
  return { contribute: () => contribute(client), client, registered, removed, calls, diagnostics, intervals, requires, context,
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(run => run()); }, frames,
    setSessions(value: any[]) { sessions = value; }, cleanupCalls: () => disposedCalls };
}

test("Android registers Workbench without loading recovery, injected controls or global error hooks", async () => {
  const f = fixture();
  const originalConsole = f.context.console.error, cleanup = f.contribute();
  await tick();
  assert.ok(f.registered.has("surface:workbench"));
  assert.ok(f.registered.has("panel:workspace-workbench-file"));
  assert.ok(![...f.registered.keys()].some(key => key.includes("session-recovery")));
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.calls.filter(x => x.startsWith("rpc:")), []);
  assert.ok(!f.requires.includes("@tanstack/react-query"), "panel bodies must be deferred");
  assert.ok(!f.requires.includes("@getpaseo/plugin/client/react-native"), "controls must not initialize during ordinary Android chat");
  assert.equal(f.context.console.error, originalConsole, "Android never installs a global console hook");
  assert.equal(f.diagnostics.length, 1); assert.equal(f.diagnostics[0].phase, "android-client-policy");
  cleanup(); cleanup();
  assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.context.console.error, originalConsole, "native error hook restored");
  const count = f.cleanupCalls(); cleanup(); assert.equal(f.cleanupCalls(), count);
});

for (const fail of ["surface:workbench-session-recovery", "sidebar:workbench-session-recovery", "settings:workbench-session-recovery-settings"]) {
  test(`recovery setup failure at ${fail} rolls back its own registrations and retains core`, async () => {
    const f = fixture({ fail, platform: "ios" }), cleanup = f.contribute(); await tick();
    assert.ok(f.registered.has("surface:workbench"));
    assert.ok(f.registered.has("command:open-workspace-workbench"));
    assert.ok(![...f.registered.keys()].some(key => key.includes("session-recovery")));
    assert.equal(f.intervals.size, 0);
    assert.ok(!f.calls.some(x => x === "rpc:list"));
    const error = f.diagnostics.find(x => x.phase === "registration-failed" && x.details.stage.startsWith("recovery:"));
    assert.ok(error); assert.match(error.details.message, /prototype/); assert.match(error.details.stack, /TypeError/);
    assert.match(error.details.pluginGeneration, /init-v21/);
    cleanup(); assert.equal(f.registered.size, 0);
  });
}

test("missing optional settings capability cannot disable the Workbench", async () => {
  const f = fixture({ missing: "addSettingsScreen", platform: "ios" }), cleanup = f.contribute(); await tick();
  assert.ok(f.registered.has("surface:workbench")); assert.equal(f.intervals.size, 0);
  assert.ok(f.diagnostics.some(x => x.phase === "registration-failed" && x.details.stage === "recovery:settings"));
  cleanup(); assert.equal(f.registered.size, 0);
});

test("state initialization failure is diagnosed after core registers and cannot start observation", async () => {
  const f = fixture({ stateFailure: true, platform: "ios" }), cleanup = f.contribute(); await tick();
  assert.ok(f.registered.has("surface:workbench")); assert.equal(f.intervals.size, 0);
  assert.ok(f.diagnostics.some(x => x.details.stage === "recovery:state" && x.details.stack));
  assert.ok(!f.calls.includes("rpc:list"));
  cleanup(); assert.equal(f.registered.size, 0);
});

test("unloading before the initial observation is dispatched leaves no late reads", async () => {
  const f = fixture(), cleanup = f.contribute(); cleanup(); await tick();
  assert.equal(f.intervals.size, 0); assert.equal(f.registered.size, 0);
  assert.ok(!f.calls.includes("rpc:list"));
});

test("core setup failure cleans previous contributions and error hooks; another load succeeds", () => {
  const f = fixture({ fail: "panel:workspace-workbench-agent" }), originalConsole = f.context.console.error;
  assert.throws(f.contribute, /panel:workspace-workbench-agent/);
  assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.context.console.error, originalConsole);
  assert.ok(f.diagnostics.some(x => x.details.stage === "panel:workspace-workbench-agent" && x.details.stack));
  const next = fixture(); next.contribute()(); assert.equal(next.registered.size, 0);
});

test("a throwing optional native global handler cannot leave the console hook installed", () => {
  const f = fixture({ platform: "ios" }), originalConsole = f.context.console.error;
  f.context.ErrorUtils = { getGlobalHandler() { throw Error("host hook unavailable"); }, setGlobalHandler() {} };
  const cleanup = f.contribute();
  assert.ok(f.registered.has("surface:workbench")); cleanup();
  assert.equal(f.context.console.error, originalConsole);
});

test("workspace subscription and late roster responses cannot register headers after unload", async () => {
  const f = fixture({ platform: "ios" });
  let publish!: (value: any) => void, resolve!: (value: any) => void, subscribed = false;
  f.client.paseo = { workspaces: {
    subscribe(handler: (value: any) => void) { subscribed = true; publish = handler; return () => { subscribed = false; }; },
    list() { return new Promise(r => { resolve = r; }); },
  } };
  const cleanup = f.contribute();
  publish({ kind: "upsert", id: "first", workspace: { id: "first", directory: "/sample" } });
  f.frame();
  assert.ok(f.registered.has("header:first"));
  cleanup(); assert.equal(subscribed, false);
  resolve({ entries: [{ id: "late", directory: "/sample" }] });
  publish({ kind: "upsert", id: "later", workspace: { id: "later", directory: "/sample" } });
  await tick(); assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
});

test("cleanup failures do not skip removals and native reload leaves no background observer", async () => {
  const f = fixture({ cleanupFailure: "settings:workbench-session-recovery-settings", platform: "ios" });
  for (let i = 0; i < 3; i++) { const cleanup = f.contribute(); await tick(); assert.equal(f.intervals.size, 0); cleanup(); assert.equal(f.intervals.size, 0); assert.equal(f.registered.size, 0); }
  assert.ok(f.diagnostics.some(x => x.details.stage === "recovery:settings:cleanup"));
});

test("late recovery reads and synchronous disconnects do not escape or publish after unload", async () => {
  const f = fixture({ throwRpc: true }), cleanup = f.contribute(); await tick();
  assert.ok(f.registered.has("surface:workbench")); cleanup(); assert.equal(f.intervals.size, 0);
  let resolve!: (value: any) => void, publications = 0, requests = 0;
  const store = createRecoveryClientStore({ rpc() { requests++; return new Promise(r => { resolve = r; }); } } as any);
  store.subscribe(() => publications++);
  const first = store.refresh(); assert.equal(store.refresh(), first); await tick(); store.close();
  resolve(response()); await first; assert.equal(publications, 0); assert.equal(requests, 1);
  await assert.rejects(store.action({ action: "retryNow", agentId: "session" }), /closed/); assert.equal(requests, 1);
});

test("web recovery status pills share one observer and disappear on unload", async () => {
  const f = fixture({ platform: "web" });
  f.setSessions([{ agentId: "sample", workspaceId: "workspace", status: "ready", enabled: true, attempt: 0 }]);
  const cleanup = f.contribute(); await tick(); f.frame();
  assert.ok(f.registered.has("pill:sample")); assert.equal(f.intervals.size, 1);
  cleanup(); assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
});

test("iOS startup restores headers across frames without recovery polling or per-session pills", async () => {
  const f = fixture({ platform: "ios" });
  f.setSessions(Array.from({ length: 53 }, (_, i) => ({ agentId: `agent-${i}`, workspaceId: `workspace-${i}`, status: "ready", enabled: true, attempt: 0 })));
  f.client.paseo = { workspaces: { list: async () => ({ entries: Array.from({ length: 248 }, (_, i) => ({ id: `workspace-${i}`, directory: "/fixture" })) }) } };
  const cleanup = f.contribute(); await tick();
  const count = (prefix: string) => [...f.registered.keys()].filter(key => key.startsWith(prefix)).length;
  assert.equal(count("pill:"), 0); assert.equal(count("header:"), 0, "startup must not synchronously mutate hundreds of host UI registrations");
  f.frame(); assert.equal(count("pill:"), 0); assert.ok(count("header:") > 0 && count("header:") <= 4);
  for (let frame = 0; f.frames.size && frame < 1000; frame++) f.frame();
  assert.equal(count("pill:"), 0); assert.equal(count("header:"), 248);
  const before = f.calls.filter(call => /^(pill:|header:|update:)/.test(call)).length;
  assert.equal(f.intervals.size, 0); await tick();
  assert.ok(!f.calls.includes("rpc:list"));
  const command = f.registered.get("command:workbench-session-recovery-agent") as any;
  command.onSelect({ agent: { id: "agent-52" } });
  assert.ok(f.calls.includes("open:workbench-session-recovery-agent"));
  assert.equal(f.frames.size, 0); assert.equal(f.calls.filter(call => /^(pill:|header:|update:)/.test(call)).length, before);
  cleanup(); f.frame(); assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0); assert.equal(f.frames.size, 0);
});

test("Android enable and reload never read or subscribe to sessions/workspaces or mutate chat buttons", async () => {
  const f = fixture({ stateFailure: true });
  f.client.paseo = { workspaces: {
    list() { throw Error("Android must not enumerate workspaces in ordinary chat"); },
    subscribe() { throw Error("Android must not listen to global workspace events"); },
  } };
  f.client.addComposerPill = f.client.addHeaderButton = () => { throw Error("Android must not touch the shared chat button store"); };
  f.context.ErrorUtils = { getGlobalHandler() { throw Error("Android must not inspect the host error handler"); }, setGlobalHandler() { throw Error("Android must not replace the host error handler"); } };
  for (let pass = 0; pass < 3; pass++) {
    const cleanup = f.contribute(); await tick(); f.frame();
    assert.ok(f.registered.has("surface:workbench")); assert.ok(f.registered.has("command:open-workspace-workbench"));
    assert.ok(![...f.registered.keys()].some(key => /session-recovery|^header:|^pill:/.test(key)));
    assert.equal(f.intervals.size, 0); assert.equal(f.frames.size, 0);
    assert.ok(!f.calls.some(call => call.startsWith("rpc:")));
    assert.ok(!f.diagnostics.some(event => event.phase === "registration-failed"));
    cleanup(); await tick(); assert.equal(f.registered.size, 0);
  }
});

for (const late of [false, true]) test(`workspace directory stream is released on unload, including a ${late ? "late" : "ready"} response`, async () => {
  const f = fixture({ platform: "web" }); let resolve!: (value: any) => void, released = 0;
  f.client.paseo = { workspaces: { list: () => new Promise(r => { resolve = r; }) } };
  const cleanup = f.contribute();
  if (late) cleanup();
  resolve({ entries: [{ id: "workspace", directory: "/sample" }], subscription: { async release() { released++; } } });
  await tick(); cleanup(); await tick(); assert.equal(released, 1); assert.equal(f.registered.size, 0);
});

test("registration scopes clean partial setup once even when diagnostics or cleanup throw", () => {
  const removed: number[] = [];
  const scope = createRegistrationScope(() => { throw Error("diagnostic disconnected"); });
  scope.register("one", () => () => removed.push(1));
  scope.register("two", () => () => { removed.push(2); throw Error("cleanup"); });
  scope.close(); scope.close(); assert.deepEqual(removed, [2, 1]);
});

test("recovery panel registration only imports the full UI on demand", () => {
  const source = readFileSync(new URL("../client/session-recovery.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('import("./session-recovery-panel")'));
  assert.ok(!source.includes('from "./native-components"'));
  assert.ok(!source.includes("new RecoveryClientStore"));
});
