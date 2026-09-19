import test from "node:test";
import assert from "node:assert/strict";
import { command } from "../server/backend/process.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("aborting a Git/process child releases it before the normal timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cancel-"));
  const controller = new AbortController();
  try {
    const started = Date.now();
    const pending = command(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      cwd: root,
      timeout: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25).unref();
    await assert.rejects(pending, (error: any) => error?.code === "observer_cancelled");
    assert.ok(Date.now() - started < 2_000, "cancellation must not wait for the process timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
