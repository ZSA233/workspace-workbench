import test from "node:test";
import assert from "node:assert/strict";
import { publicTimeline } from "../server/session-tools.ts";
import { sessionOperation } from "../shared/session-tools.ts";
import { handoffOutcome } from "../shared/handoff-guidance.mjs";

test("history omits reasoning and raw tool input/output, and bounds large messages", () => {
  const value = publicTimeline([
    { item: { type: "reasoning", text: "hidden" } },
    { seqStart: 2, item: { type: "tool_call", name: "exec", status: "completed", input: "secret", output: "secret" } },
    { seqStart: 3, item: { type: "assistant_message", text: "内容".repeat(40_000) } },
  ]);
  assert.equal(value.items.length, 2);
  assert.equal(value.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(value.items)) <= 32768);
  assert.doesNotMatch(JSON.stringify(value), /secret|hidden/);
});

test("session contract bounds wait and history and disallows arbitrary actions", () => {
  const base = { projectConfig: "/fixture", workspaceId: "w", action: "wait" };
  assert.equal(sessionOperation.input.parse(base).behavior, "steer");
  assert.equal(sessionOperation.input.safeParse({ ...base, timeoutMs: 30001 }).success, false);
  assert.equal(sessionOperation.input.safeParse({ ...base, limit: 101 }).success, false);
  assert.equal(sessionOperation.input.safeParse({ ...base, action: "delete" }).success, false);
});

test("all successful handoff actions request an end turn, failures do not", () => {
  for (const action of ["created", "reused", "already-running"]) assert.equal(handoffOutcome({ ok: true, action }).nextAction, "end_turn");
  assert.equal(handoffOutcome({ ok: false }).nextAction, "check_status");
});
