import test from "node:test";
import assert from "node:assert/strict";
import type { PaseoAgent } from "@getpaseo/client";
import { actualPlanningState, assertInitialWorkerMode, childExecutionConfig, ExecutionPolicyError } from "../server/execution-policy.ts";

function agent(planning: boolean | undefined): PaseoAgent {
  return { provider: "codex", currentModeId: "full-access", availableModes: [{ id: "full-access" }], pendingPermissions: [], features: planning === undefined ? [] : [{ id: "plan_mode", type: "toggle", value: planning }] } as unknown as PaseoAgent;
}
for (const planning of [true, false, undefined]) {
  for (const planFirst of [true, false]) {
    test(`new worker: coordinator=${planning}, planFirst=${planFirst}`, () => {
      if (planning !== false) {
        assert.throws(() => childExecutionConfig(agent(planning), planFirst), (error: unknown) => error instanceof ExecutionPolicyError && error.code === (planning ? "coordinator_planning" : "coordinator_mode_unknown"));
      } else {
        const config = childExecutionConfig(agent(planning), planFirst);
        assert.equal(config.modeId, "full-access");
        assert.deepEqual(config.featureValues, { plan_mode: planFirst });
      }
    });
    test(`initial delivery checks actual worker=${planning}, planFirst=${planFirst}`, () => {
      if (planning === planFirst) assert.doesNotThrow(() => assertInitialWorkerMode(agent(planning), planFirst));
      else assert.throws(() => assertInitialWorkerMode(agent(planning), planFirst), ExecutionPolicyError);
    });
  }
}
test("permission preset never implies planning state", () => {
  assert.equal(actualPlanningState(agent(undefined)), "unknown");
  assert.equal(actualPlanningState(agent(true)), "plan");
  assert.equal(actualPlanningState(agent(false)), "execute");
});

test("a next-turn toggle cannot prove the effective mode of an active turn", () => {
  const active = { ...agent(false), activeTurn: { turnId: "turn", startedAt: null }, status: "running" as const };
  assert.equal(actualPlanningState(active), "unknown");
  assert.throws(() => childExecutionConfig(active, false), (error: unknown) => error instanceof ExecutionPolicyError && error.code === "coordinator_active_mode_unavailable");
});
