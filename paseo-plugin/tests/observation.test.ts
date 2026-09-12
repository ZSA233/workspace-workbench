import assert from "node:assert/strict";
import test from "node:test";

import { classifyObservationResponse } from "../client/observation.ts";

test("background cache refresh is distinct from a degraded observation", () => {
  assert.equal(classifyObservationResponse({
    ok: true,
    result: { observation: { state: "ready", cacheState: "refreshing", refreshing: true } },
  }), "refreshing");
  assert.equal(classifyObservationResponse({
    ok: true,
    result: { observation: { state: "partial", issues: [{ code: "git_timeout" }] } },
  }), "degraded");
});

test("transport failures remain unavailable while successful responses stay ready", () => {
  assert.equal(classifyObservationResponse({ ok: false, error: { code: "observer_timeout", message: "timeout" } }), "unavailable");
  assert.equal(classifyObservationResponse({ ok: true, result: { observation: { state: "ready" } } }), "ready");
  assert.equal(classifyObservationResponse(undefined), null);
});
