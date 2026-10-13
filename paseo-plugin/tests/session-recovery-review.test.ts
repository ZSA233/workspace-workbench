import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { HostConnection } from "../server/host-connection.ts";
import { withProject } from "../server/projects.ts";
import { createReviewLifecycle } from "../server/review/lifecycle.ts";
import { createReviewRecoveryBridge, reviewPhaseDeadline } from "../server/review/session-recovery.ts";
import { reviewInfrastructure } from "../server/review/infrastructure.ts";
import { persistSession, readSession } from "../server/agent-review-store.ts";
import { putAgentBinding } from "../server/agent-store.ts";
import { readReviewState, writeReviewState } from "../server/orchestration-state.ts";
import { authKey, reportKey } from "../server/review/identity.ts";
import { recoveryPolicySchema } from "../shared/session-recovery.ts";
import { reviewPreferencesSchema } from "../shared/agent-review.ts";
import { SessionRecoveryController } from "../server/session-recovery/controller.ts";
import { installRecoveryCoordinator } from "../server/session-recovery/current.ts";
import type { RecoveryRecord } from "../server/session-recovery/store.ts";
import { withReviewTransitionLock } from "../server/review-state-transitions.ts";

async function fixture(role: "worker" | "reviewer", run: (f: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-recovery-review-")));
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({ sourceRoot: root, workspaceRoot: root, stateRoot: join(root, "state") }));
  const saved = { config: process.env.WORKSPACE_WORKBENCH_CONFIG, registry: process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY };
  process.env.WORKSPACE_WORKBENCH_CONFIG = config; process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = join(root, "no-registry.json");
  try { await withProject({ projectConfig: config }, async () => { const f = await prepare(root, config, role); try { await run(f); } finally { f.remove(); await f.controller.close(); } }); }
  finally {
    if (saved.config === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG; else process.env.WORKSPACE_WORKBENCH_CONFIG = saved.config;
    if (saved.registry === undefined) delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY; else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = saved.registry;
    rmSync(root, { recursive: true, force: true });
  }
}
async function prepare(root: string, config: string, role: "worker" | "reviewer") {
  const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Fixture"]);
  writeFileSync(join(root, "README.md"), "before\n"); git(["add", "README.md"]); git(["commit", "-qm", "initial"]);
  const head = git(["rev-parse", "HEAD"]), workspaceId = "fixture-workspace";
  let runtime = { workspaceId, managed: true, treePath: root, repositories: [{ id: "repo", repoPath: root, worktreePath: root,
    branch: "main", baseRef: "main", baseSha: head, head, indexDigest: "index", worktreeDigest: "worktree", statusDigest: "status", dirtyPaths: [] }] };
  const infrastructure = { ...reviewInfrastructure, backend: { queryObserver: async () => ({ ok: true, result: runtime }) as Awaited<ReturnType<typeof reviewInfrastructure.backend.queryObserver>> } };
  const lifecycle = createReviewLifecycle(infrastructure);
  const agent = { id: role, provider: "codex", cwd: root, workspaceId, status: "error", currentModeId: "read-only", model: "fixture",
    features: [{ id: "plan_mode", type: "toggle", value: false }], pendingPermissions: [], labels: {}, lastUserMessageAt: "original",
    runtimeInfo: { provider: "codex", sessionId: "thread", model: "fixture" }, activeTurn: null, persistence: { sessionId: "thread" },
  } as unknown as PaseoAgent;
  const entries: Array<{ turnId: string; item: { type: string; clientMessageId: string } }> = [];
  const api = { agents: { ref: () => ({ refresh: async () => ({ agent }), timeline: { refetch: async () => ({ entries }) }, waitForFinish: async () => new Promise<never>(() => {}) }) } } as unknown as PaseoApi;
  const host = { api: async () => api } as HostConnection;
  const bridge = createReviewRecoveryBridge(lifecycle, host);
  const original = lifecycle.sessions.newSession({ workspaceId, projectConfig: config, executionAgentId: role === "worker" ? agent.id : null,
    preferences: reviewPreferencesSchema.parse({ mode: "manual", reviewerTimeoutMs: 60000 }) });
  if (role === "worker") putAgentBinding({ agentId: agent.id, workspaceId, paseoWorkspaceId: workspaceId, cwd: root, provider: "codex/fixture",
    relationship: "independent", createdAt: "now", updatedAt: "now", delivery: "sent", handoffHash: "frozen-task" });
  const snapshot = role === "reviewer" ? await lifecycle.materials.captureSnapshot(workspaceId, lifecycle.authorization.currentRuntimeFromResponse(runtime), { paseo: api }) : null;
  const session = persistSession({ ...original, status: role === "worker" ? "waiting_execution" : "reviewing", round: 1,
    reviewerAgentId: role === "reviewer" ? agent.id : null, reviewerTurnId: role === "reviewer" ? "failed-turn" : null,
    snapshot, snapshotId: snapshot?.snapshotId || null, diffId: snapshot?.diffId || null,
    phaseDeadlineAt: role === "reviewer" ? Date.now() + 50000 : null,
    pendingReviewerResult: snapshot ? { verdict: "approved", summary: "Candidate must be discarded", findings: [], checks: [], criterionChecks: [], unreviewed: [], snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } : null,
  });
  if (role === "reviewer") writeReviewState(authKey(session.id), { token: "same-readonly-token", workspaceId, reviewerAgentId: agent.id });
  let records: RecoveryRecord[] = [];
  const receipts = new Map<string, import("../server/session-recovery/native-contract.ts").NativeReceipt>();
  const controller = new SessionRecoveryController({ api: async () => api, review: bridge,
    store: { load: () => records, save: rows => { records = structuredClone(rows); }, close() {} }, random: () => 0,
    receipt: async (_id, attemptId) => receipts.get(attemptId) || null,
    retry: async ({ agentId, attemptId }) => {
       agent.activeTurn = { turnId: "resumed-turn", startedAt: null }; agent.status = "running";
      const receipt = { agentId, attemptId, status: "accepted" as const, turnId: "resumed-turn", outcome: null, error: null };
      receipts.set(attemptId, receipt); return receipt;
    },
  });
  controller.register(agent); await controller.setPolicy(recoveryPolicySchema.parse({}));
  const remove = installRecoveryCoordinator(controller);
  return { controller, agent, session, lifecycle, bridge, remove, api,
    current: () => readSession(workspaceId, session.id)!,
    changeSnapshot: () => { runtime = { ...runtime, repositories: runtime.repositories.map(r => ({ ...r, worktreeDigest: "changed" })) }; },
    start: async () => { await controller.retryNow(agent.id); await controller.turnStarted(agent.id, "resumed-turn"); },
  };
}
const failure = { message: "Selected model is at capacity. Please try a different model." };

test("Worker failure and report finalization share recovery admission and resume in the same round", async () => {
  await fixture("worker", async f => {
    writeReviewState(reportKey(f.agent.id), { workspaceId: f.session.workspaceId, turnId: "failed-turn", report: { status: "ready_for_review" } });
    assert.equal(await f.controller.claimFailure(f.agent.id, "failed-turn", failure), true);
    await f.lifecycle.transitions.handleExecutionTurnEnded({ agent: { id: f.agent.id }, turnId: "failed-turn", outcome: { kind: "failed", error: failure } }, { paseo: f.api });
    assert.equal(f.current().status, "waiting_recovery");
    assert.ok(readReviewState<{ consumedAt?: string }>(reportKey(f.agent.id))?.consumedAt);
    await f.start(); assert.equal(f.current().status, "waiting_execution"); assert.equal(f.current().executionTurnId, "resumed-turn");
    assert.equal(f.current().round, 1); assert.equal(f.current().handoffHash, f.session.handoffHash);
  });
});

test("Reviewer recovery discards the failed candidate, preserves authorization and freezes the timeout budget", async () => {
  await fixture("reviewer", async f => {
    assert.equal(await f.controller.claimFailure(f.agent.id, "failed-turn", failure), true);
    let session = f.current(); assert.equal(session.status, "waiting_recovery"); assert.equal(session.pendingReviewerResult, null);
    const remaining = session.recovery!.remainingMs!; assert.ok(remaining > 0 && remaining <= 50000);
    // Simulate a long capacity wait without sleeping or increasing the active review budget.
    persistSession({ ...session, recovery: { ...session.recovery!, suspendedAt: Date.now() - 3600000 } });
    await f.start(); session = f.current();
    assert.equal(session.status, "reviewing"); assert.equal(session.reviewerTurnId, "resumed-turn"); assert.equal(session.round, 1);
    assert.ok(reviewPhaseDeadline(session)! <= Date.now() + remaining + 100);
    assert.equal(readReviewState<{ token: string }>(authKey(session.id))?.token, "same-readonly-token");
    assert.equal(session.latestResult, null); assert.equal(session.pendingReviewerResult, null);
  });
});

test("a changed Reviewer snapshot prevents continuation and revokes the candidate", async () => {
  await fixture("reviewer", async f => {
    await f.controller.claimFailure(f.agent.id, "failed-turn", failure); f.changeSnapshot();
    await f.controller.retryNow(f.agent.id);
    assert.notEqual(f.controller.list()[0].status, "running");
    assert.equal(f.agent.activeTurn, null); assert.equal(f.current().pendingReviewerResult, null);
    assert.equal(f.current().status, "failed"); assert.equal(readReviewState(authKey(f.session.id)), null);
  });
});

test("manual recovery stop terminates a waiting Review without claiming approval", async () => {
  await fixture("reviewer", async f => {
    await f.controller.claimFailure(f.agent.id, "failed-turn", failure); await f.controller.cancel(f.agent.id);
    assert.equal(f.current().status, "stopped"); assert.equal(readReviewState(authKey(f.session.id)), null);
    assert.equal(f.current().round, 1); assert.equal(f.current().latestResult, null);
  });
});

test("stopping a waiting Review under its transition lock cancels recovery without deadlocking", async () => {
  await fixture("reviewer", async f => {
    await f.controller.claimFailure(f.agent.id, "failed-turn", failure);
    await withReviewTransitionLock(f.session.workspaceId, () => f.lifecycle.dispatch.stopReview(f.current(), { paseo: f.api }));
    // Allow the queued recovery cancellation to acquire the released Review lock.
    await f.controller.tick();
    assert.equal(f.current().status, "stopped"); assert.equal(f.controller.list()[0].status, "stopped");
    assert.equal(readReviewState(authKey(f.session.id)), null); assert.equal(f.agent.activeTurn, null);
  });
});

test("an uncertain initial Worker handoff is never automatically redelivered", async () => {
  await fixture("worker", async f => {
    putAgentBinding({ agentId: f.agent.id, workspaceId: f.session.workspaceId, paseoWorkspaceId: f.session.workspaceId, cwd: f.agent.cwd,
      provider: "codex/fixture", relationship: "independent", createdAt: "now", updatedAt: "now", delivery: "pending", handoffHash: "frozen-task" });
    assert.equal(await f.controller.claimFailure(f.agent.id, "failed-turn", failure), false);
    assert.equal(f.agent.activeTurn, null); assert.equal(f.current().status, "waiting_execution");
  });
});
