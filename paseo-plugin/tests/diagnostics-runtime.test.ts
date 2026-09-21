import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDiagnosticSink, MAX_BYTES, MAX_EVENTS } from "../server/diagnostics-runtime.mjs";

test("diagnostic sink keeps a bounded queue and preserves failure events", async () => {
  const root = await mkdtemp(join(tmpdir(), "workbench-diagnostics-"));
  const sink = createDiagnosticSink({ root, component: "test", generation: "test-generation" });
  for (let i = 0; i < 1_000; i++) sink.record({ event: "mcp_request_finished", requestId: String(i), method: "tools/call" });
  sink.record({ event: "mcp_request_timeout", requestId: "timeout", errorCode: "request_timeout" });
  await sink.close();
  const file = join(root, `test.${process.pid}.jsonl`);
  const text = await readFile(file, "utf8");
  assert.match(text, /request_timeout/);
  assert.ok((await stat(file)).size <= MAX_BYTES);
  assert.equal(MAX_EVENTS, 1_000);
  assert.equal((sink.status() as { queued?: number }).queued, 0);
});
