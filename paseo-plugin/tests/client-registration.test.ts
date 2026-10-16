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
      calls.push(`rpc:${input.action || rpc.name}`);
      if (options.throwRpc) throw Error("disconnected");
      return Promise.resolve(response(sessions));
    },
  };
  if (options.missing) delete client[options.missing];
  const component = () => null;
  const context: any = { module: { exports: {} }, console: { error() {}, info() {}, warn() {}, log() {} }, setTimeout, clearTimeout,
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
    setSessions(value: any[]) { sessions = value; }, cleanupCalls: () => disposedCalls };
}

test("real compiled native entry registers core before recovery without loading its UI or DOM", async () => {
  const f = fixture();
  const originalConsole = f.context.console.error, cleanup = f.contribute();
  await tick();
  assert.ok(f.registered.has("surface:workbench"));
  assert.ok(f.registered.has("panel:workspace-workbench-file"));
  assert.ok(f.registered.has("settings:workbench-session-recovery-settings"));
  assert.ok(f.calls.indexOf("surface:workbench") < f.calls.indexOf("surface:workbench-session-recovery"));
  assert.equal(f.intervals.size, 1);
  assert.deepEqual(f.calls.filter(x => x.startsWith("rpc:")), ["rpc:list"]);
  assert.ok(!f.requires.includes("@tanstack/react-query"), "panel bodies must be deferred");
  cleanup(); cleanup();
  assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.context.console.error, originalConsole, "native error hook restored");
  const count = f.cleanupCalls(); cleanup(); assert.equal(f.cleanupCalls(), count);
});

for (const fail of ["surface:workbench-session-recovery", "sidebar:workbench-session-recovery", "settings:workbench-session-recovery-settings"]) {
  test(`recovery setup failure at ${fail} rolls back its own registrations and retains core`, async () => {
    const f = fixture({ fail }), cleanup = f.contribute(); await tick();
    assert.ok(f.registered.has("surface:workbench"));
    assert.ok(f.registered.has("command:open-workspace-workbench"));
    assert.ok(![...f.registered.keys()].some(key => key.includes("session-recovery")));
    assert.equal(f.intervals.size, 0);
    assert.ok(!f.calls.some(x => x === "rpc:list"));
    const error = f.diagnostics.find(x => x.phase === "registration-failed" && x.details.stage.startsWith("recovery:"));
    assert.ok(error); assert.match(error.details.message, /prototype/); assert.match(error.details.stack, /TypeError/);
    assert.match(error.details.pluginGeneration, /init-v18/);
    cleanup(); assert.equal(f.registered.size, 0);
  });
}

test("missing optional settings capability cannot disable the Workbench", () => {
  const f = fixture({ missing: "addSettingsScreen" }), cleanup = f.contribute();
  assert.ok(f.registered.has("surface:workbench")); assert.equal(f.intervals.size, 0);
  assert.ok(f.diagnostics.some(x => x.phase === "registration-failed" && x.details.stage === "recovery:settings"));
  cleanup(); assert.equal(f.registered.size, 0);
});

test("state initialization failure is diagnosed after core registers and cannot start observation", () => {
  const f = fixture({ stateFailure: true }), cleanup = f.contribute();
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
  const f = fixture(), originalConsole = f.context.console.error;
  f.context.ErrorUtils = { getGlobalHandler() { throw Error("host hook unavailable"); }, setGlobalHandler() {} };
  const cleanup = f.contribute();
  assert.ok(f.registered.has("surface:workbench")); cleanup();
  assert.equal(f.context.console.error, originalConsole);
});

test("workspace subscription and late roster responses cannot register headers after unload", async () => {
  const f = fixture();
  let publish!: (value: any) => void, resolve!: (value: any) => void, subscribed = false;
  f.client.paseo = { workspaces: {
    subscribe(handler: (value: any) => void) { subscribed = true; publish = handler; return () => { subscribed = false; }; },
    list() { return new Promise(r => { resolve = r; }); },
  } };
  const cleanup = f.contribute();
  publish({ kind: "upsert", id: "first", workspace: { id: "first", directory: "/sample" } });
  assert.ok(f.registered.has("header:first"));
  cleanup(); assert.equal(subscribed, false);
  resolve({ entries: [{ id: "late", directory: "/sample" }] });
  publish({ kind: "upsert", id: "later", workspace: { id: "later", directory: "/sample" } });
  await tick(); assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
});

test("cleanup failures do not skip subsequent removals and reload leaves one observer", async () => {
  const f = fixture({ cleanupFailure: "settings:workbench-session-recovery-settings" });
  for (let i = 0; i < 3; i++) { const cleanup = f.contribute(); await tick(); assert.equal(f.intervals.size, 1); cleanup(); assert.equal(f.intervals.size, 0); assert.equal(f.registered.size, 0); }
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

test("recovery status pills share one observer and disappear on unload", async () => {
  const f = fixture();
  f.setSessions([{ agentId: "sample", workspaceId: "workspace", status: "ready", enabled: true, attempt: 0 }]);
  const cleanup = f.contribute(); await tick();
  assert.ok(f.registered.has("pill:sample")); assert.equal(f.intervals.size, 1);
  cleanup(); assert.equal(f.registered.size, 0); assert.equal(f.intervals.size, 0);
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
