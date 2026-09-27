import assert from "node:assert/strict";
import test from "node:test";

import { classifyObservationResponse, observationStatusFor, observationTimeExpired } from "../client/observation.ts";

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
  assert.equal(observationStatusFor(undefined, true, false, 10_000), "unavailable");
});

test("roster cache age does not expire without validation support", () => {
  const now = Date.parse("2026-09-25T00:10:00Z");
  const roster = {
    ok: true,
    result: { observation: { state: "ready", deferred: true } },
  };
  assert.equal(observationTimeExpired({
    response: roster,
    lastSuccessfulAt: "2026-09-25T00:00:00Z",
    cacheAgeMs: 600_000,
    staleAfterMs: 90_000,
    now,
  }), false);
});

test("validated snapshots stay fresh through backend cache TTL and expire after validation stops", () => {
  const now = Date.parse("2026-09-25T00:10:00Z");
  const response = {
    ok: true,
    result: { observation: {
      state: "ready",
      validationKey: "roster",
      validationToken: "4",
      validatedAt: "2026-09-25T00:09:30Z",
    } },
  };
  assert.equal(observationTimeExpired({
    response,
    lastSuccessfulAt: "2026-09-25T00:00:00Z",
    cacheAgeMs: 600_000,
    staleAfterMs: 90_000,
    now,
  }), false);
  assert.equal(observationTimeExpired({
    response: { ...response, result: { observation: { ...response.result.observation, validatedAt: "2026-09-24T23:00:00Z" } } },
    lastSuccessfulAt: "2026-09-25T00:00:00Z",
    cacheAgeMs: null,
    staleAfterMs: 90_000,
    now,
  }), true);
});
