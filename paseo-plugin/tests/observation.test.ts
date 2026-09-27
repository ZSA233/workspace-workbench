import assert from "node:assert/strict";
import test from "node:test";

import { classifyObservationResponse, observationStatusFor, persistentObservationFailure } from "../client/observation.ts";

test("background cache refresh is distinct from a degraded observation", () => {
  const refreshing = {
    ok: true,
    result: { observation: { state: "ready", cacheState: "refreshing", refreshing: true } },
  };
  assert.equal(classifyObservationResponse(refreshing), "refreshing");
  assert.equal(observationStatusFor(refreshing, false, false), "fresh");
  assert.equal(classifyObservationResponse({
    ok: true,
    result: { observation: { state: "partial", issues: [{ code: "git_timeout" }] } },
  }), "degraded");
  assert.equal(observationStatusFor({
    ok: true,
    result: { observation: { state: "partial", cacheState: "refreshing", refreshing: true } },
  }, false, false), "degraded");
});

test("transport failures remain unavailable while successful responses stay ready", () => {
  assert.equal(classifyObservationResponse({ ok: false, error: { code: "observer_timeout", message: "timeout" } }), "unavailable");
  assert.equal(classifyObservationResponse({ ok: true, result: { observation: { state: "ready" } } }), "ready");
  assert.equal(classifyObservationResponse(undefined), null);
  assert.equal(observationStatusFor(undefined, true, false, 1_000), "loading");
  assert.equal(observationStatusFor(undefined, true, false, 90_000), "unavailable");
});

test("warnings require three failures and a full validation window", () => {
  assert.equal(persistentObservationFailure(0, 600_000, 90_000), false);
  assert.equal(persistentObservationFailure(1, 600_000, 90_000), false);
  assert.equal(persistentObservationFailure(3, 10_000, 90_000), false);
  assert.equal(persistentObservationFailure(3, 90_000, 90_000), true);
  assert.equal(persistentObservationFailure(0, null, 90_000), false);
});
