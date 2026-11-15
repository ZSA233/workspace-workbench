import assert from "node:assert/strict";
import test from "node:test";
import { observeDesktopWorkspaceContext, type DesktopWorkspaceDirectoryApi } from "../client/desktop-workspace-context.ts";
import { workspaceDirectorySnapshot } from "../client/workspace-directory.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(api?: DesktopWorkspaceDirectoryApi) {
  const snapshots = new Map<string, ReturnType<typeof workspaceDirectorySnapshot>>();
  const availability: boolean[] = [];
  const close = observeDesktopWorkspaceContext(api, {
    upsert(entry) {
      const snapshot = workspaceDirectorySnapshot(entry);
      if (snapshot) snapshots.set(entry.id, snapshot);
      else snapshots.delete(entry.id);
    },
    remove(id) { snapshots.delete(id); },
    ready(available) { availability.push(available); },
  });
  return { close, snapshots, availability };
}

test("the host workspace directory wins if both compatibility fields are present", () => {
  assert.deepEqual(workspaceDirectorySnapshot({ id: "one", directory: "/old", workspaceDirectory: "/actual" }),
    { id: "one", directory: "/actual", name: "one" });
  assert.equal(workspaceDirectorySnapshot({ id: "one" }), null);
});

test("desktop directory context understands both host field names and paginates with one subscription", async () => {
  const calls: unknown[] = [];
  let handler: Parameters<NonNullable<DesktopWorkspaceDirectoryApi["subscribe"]>>[0] = () => {};
  let released = 0, unsubscribed = 0;
  const f = fixture({
    subscribe(callback) { handler = callback; return () => { unsubscribed++; }; },
    async list(options) {
      calls.push(options);
      return options?.page?.cursor
        ? { entries: [{ id: "new", workspaceDirectory: "/new", name: "New" }], pageInfo: { hasMore: false } }
        : { entries: [{ id: "old", directory: "/old" }], pageInfo: { hasMore: true, nextCursor: "next" }, subscription: { async release() { released++; } } };
    },
  });
  await tick();
  assert.deepEqual(calls, [{ subscribe: {}, page: { limit: 100 } }, { page: { limit: 100, cursor: "next" } }]);
  assert.deepEqual(f.snapshots.get("old"), { id: "old", directory: "/old", name: "old" });
  assert.deepEqual(f.snapshots.get("new"), { id: "new", directory: "/new", name: "New" });
  assert.deepEqual(f.availability, [true]);
  handler({ kind: "upsert", workspace: { id: "new", workspaceDirectory: "/newer" } });
  assert.equal(f.snapshots.get("new")?.directory, "/newer");
  handler({ kind: "upsert", workspace: { id: "new" } });
  assert.equal(f.snapshots.has("new"), false, "a missing directory must not retain a stale one");
  handler({ kind: "remove", id: "old" });
  assert.equal(f.snapshots.has("old"), false);
  f.close(); f.close(); await tick();
  assert.equal(unsubscribed, 1); assert.equal(released, 1);
});

test("live workspace changes beat older paginated listing results", async () => {
  let handler: Parameters<NonNullable<DesktopWorkspaceDirectoryApi["subscribe"]>>[0] = () => {};
  let resolvePage!: (value: Awaited<ReturnType<NonNullable<DesktopWorkspaceDirectoryApi["list"]>>>) => void;
  const f = fixture({ subscribe(callback) { handler = callback; return () => {}; }, list() { return new Promise(resolve => { resolvePage = resolve; }); } });
  await tick();
  handler({ kind: "upsert", workspace: { id: "moved", workspaceDirectory: "/current" } });
  handler({ kind: "remove", id: "deleted" });
  resolvePage({ entries: [{ id: "moved", workspaceDirectory: "/stale" }, { id: "deleted", directory: "/deleted" }] });
  await tick();
  assert.equal(f.snapshots.get("moved")?.directory, "/current");
  assert.equal(f.snapshots.has("deleted"), false);
  assert.deepEqual(f.availability, [true]);
  f.close();
});

test("closed observers discard late results and release a late stream", async () => {
  let calls = 0, released = 0;
  let resolvePage!: (value: Awaited<ReturnType<NonNullable<DesktopWorkspaceDirectoryApi["list"]>>>) => void;
  const f = fixture({ list() { calls++; return new Promise(resolve => { resolvePage = resolve; }); } });
  await tick(); f.close();
  resolvePage({ entries: [{ id: "stale", directory: "/stale" }], subscription: { async release() { released++; } } });
  await tick();
  assert.equal(f.snapshots.size, 0); assert.deepEqual(f.availability, []); assert.equal(released, 1);
  const immediate = fixture({ async list() { calls++; return { entries: [] }; } });
  immediate.close(); await tick(); assert.equal(calls, 1);
});

test("missing directory API and malformed pagination fail closed", async () => {
  for (const api of [undefined, { async list() { throw Error("offline"); } }, { async list() { return { entries: [], pageInfo: { hasMore: true } }; } }]) {
    const f = fixture(api); await tick(); assert.deepEqual(f.availability, [false]); f.close();
  }
});
