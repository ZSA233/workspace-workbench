import assert from "node:assert/strict";
import test from "node:test";
import { sampleCurve, curvePath } from "../client/graph/geometry.ts";
import { createHistoryLoadGate } from "../client/graph/pagination.ts";
import { readFileSync } from "node:fs";

test("history gates are independent closures and graph render does not construct a class", () => {
  const first = createHistoryLoadGate().allow;
  const second = createHistoryLoadGate().allow;
  const request = (allow: typeof first, offset: number) => allow("same", 50, offset, 300, 1500, false, true);
  assert.equal(request(first, 0), false);
  assert.equal(request(first, 1150), true);
  assert.equal(request(first, 1151), false);
  assert.equal(request(second, 0), false);
  assert.equal(request(second, 1150), true);
  const source = readFileSync(new URL("../client/components/graph.tsx", import.meta.url), "utf8");
  assert.ok(!source.includes("new HistoryLoadGate"));
  assert.ok(source.includes("historyGate.current === null"));
});

test("native curves share exact endpoints with web and remain monotonic at every pixel density", () => {
  for (const scale of [1, 1.5, 2, 2.625, 3, 4]) {
    for (const x of [8, 24, 40, 72]) {
      const a = { x: 8, y: 15 }, b = { x, y: 30 };
      const samples = sampleCurve(a, b);
      assert.deepEqual(samples[0], a);
      assert.deepEqual(samples.at(-1), b);
      assert.ok(curvePath(a, b).endsWith(`${b.x} ${b.y}`));
      for (let i = 1; i < samples.length; i++) {
        assert.ok(samples[i].y >= samples[i - 1].y);
        assert.ok(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y) * scale < 20);
      }
    }
  }
});

test("history gate rejects layout events, concurrent requests, failed-page repeats and limits", () => {
  const gate = createHistoryLoadGate();
  const attempt = (count: number, offset: number, busy = false, identity = "project/repo/head") => gate.allow(identity, count, offset, 300, 1500, busy, true);
  assert.equal(attempt(50, 0), false);
  assert.equal(attempt(50, 1150), true);
  assert.equal(attempt(50, 1151), false);
  assert.equal(attempt(100, 1152, true), false);
  assert.equal(attempt(100, 1152), false); // layout-only repeat
  assert.equal(attempt(100, 1153), true);
  assert.equal(attempt(200, 1200), false);
  assert.equal(attempt(50, 1150, false, "other/repo"), false);
  assert.equal(attempt(50, 1151, false, "other/repo"), true);
});
