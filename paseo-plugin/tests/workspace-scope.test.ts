import test from "node:test";
import assert from "node:assert/strict";
import { withWorkspaceScope } from "../server/workspace-scope.ts";

test("scope changes wait for task startup, support nested calls and release after failure", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = withWorkspaceScope("fixture", async () => {
    order.push("task");
    await withWorkspaceScope("fixture", async () => { order.push("nested"); });
    await barrier;
    throw new Error("startup failed");
  });
  const failed = assert.rejects(first, /startup failed/);
  const second = withWorkspaceScope("fixture", async () => { order.push("add"); });
  await withWorkspaceScope("other", async () => { order.push("other"); });
  assert.ok(!order.includes("add"));
  release();
  await Promise.all([failed, second]);
  assert.ok(order.indexOf("add") > order.indexOf("nested"));
});
