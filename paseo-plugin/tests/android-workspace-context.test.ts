import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";

const code = transformSync(readFileSync(new URL("../client/android-workspace-context.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(api?: unknown) {
  const snapshots = new Map<string, any>(); let state: boolean | null = null;
  const module = { exports: {} as any };
  vm.runInNewContext(code, { module, exports: module.exports, require: () => ({
    clearWorkbenchWorkspaceSnapshots() { snapshots.clear(); state = null; },
    markWorkbenchWorkspaceSnapshotsReady(available: boolean) { state = available; },
    setWorkbenchWorkspaceSnapshot(workspace: any) { snapshots.set(workspace.id, workspace); },
  }) });
  return { context: module.exports.createAndroidWorkspaceContext(api), snapshots, state: () => state };
}

test("Android Workbench directory reads are demand-only, shared, paginated and never subscribe", async () => {
  const calls: any[] = [];
  const f = fixture({ async list(options: any) {
    calls.push(options);
    return options.page.cursor ? { entries: [{ id: "second", workspaceDirectory: "/second" }], pageInfo: { hasMore: false } }
      : { entries: [{ id: "first", directory: "/first" }], pageInfo: { hasMore: true, nextCursor: "next" } };
  } });
  await tick(); assert.equal(calls.length, 0);
  const first = f.context.observe(), second = f.context.observe(); await tick();
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !Object.hasOwn(call, "subscribe")));
  assert.equal(calls[1].page.cursor, "next"); assert.equal(f.snapshots.get("second").directory, "/second");
  assert.equal(f.state(), true);
  first(); first(); assert.equal(f.snapshots.size, 2);
  second(); assert.equal(f.snapshots.size, 0); assert.equal(f.state(), null);
  await tick(); assert.equal(calls.length, 2);
  const reopen = f.context.observe(); await tick(); assert.equal(calls.length, 4);
  reopen(); f.context.close(); f.context.observe()(); await tick(); assert.equal(calls.length, 4);
});

test("closing Android Workbench cancels queued reads and discards late data from a prior opening", async () => {
  let calls = 0; const responses: Array<(result: any) => void> = [];
  const f = fixture({ list() { calls++; return new Promise(resolve => responses.push(resolve)); } });
  const immediate = f.context.observe(); immediate(); await tick(); assert.equal(calls, 0);
  const first = f.context.observe(); await tick(); first();
  const second = f.context.observe(); await tick(); assert.equal(calls, 2);
  responses[0]({ entries: [{ id: "stale", directory: "/stale" }], pageInfo: { hasMore: true, nextCursor: "must-not-read" } });
  await tick(); assert.equal(calls, 2); assert.equal(f.snapshots.size, 0);
  responses[1]({ entries: [{ id: "current", directory: "/current" }] }); await tick();
  assert.equal(f.snapshots.size, 1); assert.equal(f.snapshots.has("current"), true);
  f.context.close(); second(); assert.equal(f.snapshots.size, 0);
});

test("missing or failed directory APIs finish loading and malformed pagination cannot loop", async () => {
  for (const api of [undefined, { list() { throw Error("offline"); } }, { async list() { return { entries: [], pageInfo: { hasMore: true } }; } }]) {
    const f = fixture(api), close = f.context.observe(); await tick(); assert.equal(f.state(), false);
    close(); f.context.close();
  }
});
