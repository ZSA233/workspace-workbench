import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProject } from "../server/projects.ts";
import {
  getReviewWorkspaceState,
  handleReviewModels,
  handleReviewSessionControl,
  handleReviewSessionEvents,
  handleReviewSessionStart,
  handleReviewSettingsGet,
  acceptExecutionReport,
  handleReviewTurnEnded,
  handleReviewSettingsUpdate,
  recordExecutionHandoff,
  readReviewerSnapshot,
  readReviewSession,
  recordReviewerResult,
  reviewAuthToken,
  startReview,
  handleCoordinatorReview,
  tickCoordinatorReviews,
  registerReviewLifecycle,
} from "../server/agent-review.ts";
import { getAgentBinding, putAgentBinding } from "../server/agent-store.ts";
import { clearWorkspaceRuntimeState, executePermanentWorkspaceDelete } from "../server/workspace-lifecycle.ts";
import { resolveReviewPreferences } from "../shared/agent-review.ts";
import { handoffSchema } from "../shared/handoff.ts";
import type { AgentContext } from "../server/agent-provider.ts";
import { writeState, writeReviewState, readReviewState } from "../server/orchestration-state.ts";
import { handleSessionOperation } from "../server/session-tools.ts";
import { sessionOperation } from "../shared/session-tools.ts";

type Harness = {
  root: string;
  config: string;
  context: AgentContext;
  sent: string[];
  reviewerSent: string[];
  reviewerCreate: Array<Record<string, unknown>>;
  setRuntime(runtime: Record<string, unknown>): void;
  setModels(models: Array<Record<string, unknown>>): void;
  setExecutionBusy(busy: boolean, turnId?: string): void;
  setReviewerBusy(busy: boolean): void;
  setReviewerWaitResults(results: Array<{ status: "idle" | "timeout" | "permission" | "failed"; error?: string; lastMessage?: string }>): void;
  cleanup(): void;
};

function harness(): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workbench-review-fixture-")));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Workbench Fixture"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  writeFileSync(join(root, "new-file.txt"), "untracked fixture\n");
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const config = join(root, "project.json");
  writeFileSync(config, JSON.stringify({
    schemaVersion: 1,
    // Review is off by default in real projects. The review fixture opts in
    // explicitly so these tests exercise the manual state machine.
    review: { reviewerTarget: "independent", mode: "manual", autoFix: true },
    project: { id: "fixture", displayName: "Fixture" },
    sourceRoot: root,
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "state", "workspaces"),
    repositories: [{ id: "fixture", path: ".", enabled: true }],
    agent: { provider: "paseo", bridge: { script: "mcp.mjs", endpoint: "127.0.0.1:6789" } },
  }));
  const sent: string[] = [];
  const reviewerSent: string[] = [];
  const reviewerCreate: Array<Record<string, unknown>> = [];
  let reviewerWaitResults: Array<{ status: "idle" | "timeout" | "permission" | "failed"; error?: string; lastMessage?: string }> = [];
  let runtime: Record<string, unknown> = {
    workspaceId: "managed-fixture",
    managed: true,
    treePath: root,
    repositories: [{ id: "fixture", repoPath: ".", worktreePath: root, branch: "main", baseRef: "main", baseSha: head, head, indexDigest: "index-1", worktreeDigest: "worktree-1", statusDigest: "status-1", dirtyPaths: ["new-file.txt"] }],
  };
  let models: Array<Record<string, unknown>> = [{ provider: "codex", id: "model-a", label: "Model A", isSelectable: true, isDefault: true }];
  const executionAgent = {
    id: "execution-fixture",
    workspaceId: "managed-fixture",
    cwd: root,
    status: "idle",
    activeTurn: null as { turnId: string } | null,
    model: "model-a",
    runtimeInfo: { provider: "codex", model: "model-a" },
    pendingPermissions: [],
  };
  const reviewerAgent = {
    id: "reviewer-fixture",
    workspaceId: "managed-fixture",
    cwd: root,
    status: "running",
    activeTurn: null as { turnId: string } | null,
    model: "model-a",
    runtimeInfo: { provider: "codex", model: "model-a" },
    pendingPermissions: [],
    archivedAt: null,
  };
  const executionHandle = {
    id: executionAgent.id,
    refresh: async () => ({ agent: executionAgent, project: null }),
    send: async (message: string) => { sent.push(message); },
  };
  const reviewerHandle = {
    id: reviewerAgent.id,
    refresh: async () => ({ agent: reviewerAgent, project: null }),
    waitForFinish: async () => reviewerWaitResults.shift() || await new Promise<never>(() => {}),
    send: async (message: string) => { reviewerSent.push(message); },
  };
  const context = {
    query: async () => ({ ok: true, result: runtime }),
    paseo: {
      providers: {
        listModels: async () => ({ provider: "codex", models, fetchedAt: new Date().toISOString(), requestId: "models" }),
      },
      agents: {
        ref: (id: string) => id === executionAgent.id ? executionHandle : reviewerHandle,
        list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      },
      workspaces: {
        open: async () => ({ id: "managed-fixture", agents: { create: async (options: Record<string, unknown>) => { reviewerCreate.push(options); return reviewerHandle; } } }),
      },
    },
  } as unknown as AgentContext;
  return {
    root,
    config,
    context,
    sent,
    reviewerSent,
    reviewerCreate,
    setRuntime(next) { runtime = next; },
    setModels(next) { models = next; },
    setExecutionBusy(busy, turnId = "busy") { executionAgent.activeTurn = busy ? { turnId } : null; },
    setReviewerBusy(busy) { reviewerAgent.activeTurn = busy ? { turnId: "review-turn" } : null; reviewerAgent.status = busy ? "running" : "idle"; },
    setReviewerWaitResults(results) { reviewerWaitResults = [...results]; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

async function withFixture<T>(fixture: Harness, callback: () => T | Promise<T>): Promise<T> {
  const previousRegistry = process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
  process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = join(fixture.root, "isolated-registry.json");
  const previous = process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  const previousLifecycle = process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE;
  process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = join(fixture.root, "review-settings.json");
  process.env.WORKSPACE_WORKBENCH_CONFIG = fixture.config;
  process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE = "1";
  try { return await withProject({ projectConfig: fixture.config }, callback); }
  finally {
    if (previousRegistry === undefined) delete process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY;
    else process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = previousRegistry;
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
    else process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = previous;
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    if (previousLifecycle === undefined) delete process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE;
    else process.env.WORKBENCH_ENABLE_REVIEW_LIFECYCLE = previousLifecycle;
    fixture.cleanup();
  }
}

test("a timed-out session wait does not continue polling after a slow refresh", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", requestedByAgentId: "reviewer-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    let refreshes = 0;
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const context = { ...fixture.context, paseo: { agents: { ref: () => ({ refresh: () => { refreshes++; return pending; } }) } } } as unknown as AgentContext;
    const result = await handleSessionOperation(sessionOperation.input.parse({ projectConfig: fixture.config, workspaceId: "managed-fixture", action: "wait", timeoutMs: 5 }), context);
    assert.equal((result as { timedOut: boolean }).timedOut, true);
    release({ agent: { id: "execution-fixture", cwd: fixture.root, workspaceId: "managed-fixture", status: "running", activeTurn: { turnId: "slow" } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshes, 1);
  });
});

test("main workspace starts an independent read-only review without an execution Agent", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fixture.setRuntime({
      workspaceId: "main", managed: false, treePath: fixture.root,
      repositories: [{ id: "fixture", repoPath: ".", worktreePath: fixture.root, branch: "main", baseRef: null, baseSha: null, head, indexDigest: "index-main", worktreeDigest: "worktree-main", statusDigest: "status-main", dirtyPaths: ["new-file.txt"] }],
      issues: [{ repositoryId: "missing", code: "worktree_missing", message: "worktree is unavailable" }],
    });
    const session = await startReview({ workspaceId: "main", projectConfig: fixture.config, instructions: "Review the recently completed task." }, fixture.context);
    assert.equal(session.executionAgentId, null);
    assert.equal(session.roundTarget, "independent");
    assert.equal(session.preferences.mode, "manual");
    assert.equal(session.preferences.autoFix, false);
    assert.ok(session.snapshot?.unreviewed.includes("missing: worktree_missing"));
    assert.equal(fixture.reviewerCreate.length, 1);
    const options = fixture.reviewerCreate[0] as { config?: { modeId?: string }; prompt?: string };
    assert.equal(options.config?.modeId, "auto");
    assert.match(String(options.prompt), /manual read-only review of the main workspace/i);
    assert.match(String(options.prompt), /recently completed task/i);
    const repair = await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: "main", sessionId: session.id, action: "repair" }, fixture.context);
    assert.equal(repair.ok, false);
    assert.equal(repair.error?.code, "review_not_waiting_for_repair");
  });
});

test("session messages authorize the original coordinator and deduplicate supplements", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", requestedByAgentId: "reviewer-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    writeState("context:coordinator-test", { agentId: "reviewer-fixture", cwd: fixture.root });
    const input = sessionOperation.input.parse({ projectConfig: fixture.config, workspaceId: "managed-fixture", token: "coordinator-test", action: "message", requestId: "supplement-1", text: "Preserve keyboard navigation" });
    recordExecutionHandoff({ workspaceId: input.workspaceId, projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff: handoffSchema.parse({ goal: "Implement navigation" }) });
    writeReviewState("agent-review:execution-report:execution-fixture", { turnId: "old-report", report: { status: "ready_for_review" } });
    await handleSessionOperation(input, fixture.context);
    assert.equal(readReviewState("agent-review:execution-report:execution-fixture"), null);
    await handleSessionOperation(input, fixture.context);
    assert.equal(fixture.sent.length, 1);
    await assert.rejects(handleSessionOperation({ ...input, text: "different" }, fixture.context), /conflict/);
    await assert.rejects(handleSessionOperation({ ...input, token: "other" }, fixture.context), /not_coordinator/);
    assert.equal(fixture.sent.length, 1);
  });
});

test("coordinator waits while busy, receives once, binds acceptance to turn and revokes on stop", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project", patch: { reviewerTarget: "coordinator" }, resetFields: [] });
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", requestedByAgentId: "reviewer-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    writeState("context:coordinator-test", { agentId: "reviewer-fixture", cwd: fixture.root });
    let session = await startReview({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(session.coordinator?.phase, "waiting");
    await tickCoordinatorReviews(fixture.context);
    assert.equal(fixture.reviewerSent.length, 0);
    fixture.setReviewerBusy(false);
    await tickCoordinatorReviews(fixture.context);
    await tickCoordinatorReviews(fixture.context);
    assert.equal(fixture.reviewerSent.length, 1);
    assert.equal(fixture.reviewerCreate.length, 0);
    session = readReviewSession("managed-fixture")!;
    assert.equal(session.coordinator?.phase, "sent");
    const input = { projectConfig: fixture.config, workspaceId: session.workspaceId, sessionId: session.id, assignmentId: session.coordinator!.messageId, round: session.round, token: "coordinator-test", action: "read" as const };
    await assert.rejects(handleCoordinatorReview(input, fixture.context), /turn_required/);
    fixture.setReviewerBusy(true);
    await handleCoordinatorReview(input, fixture.context);
    assert.equal(readReviewSession(session.workspaceId)?.reviewerTurnId, "review-turn");
    await assert.rejects(handleCoordinatorReview({ ...input, round: session.round + 1 }, fixture.context), /not_authorized/);
    // Failed/incomplete turns can retain their accepted phase in persisted state.
    const accepted = readReviewSession(session.workspaceId)!;
    writeReviewState(`agent-review:session:${accepted.workspaceId}:${accepted.id}`, { ...accepted, status: "failed" });
    const resumed = await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: session.workspaceId, action: "resume" }, fixture.context);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.session?.coordinator?.phase, "waiting");
    assert.equal(resumed.session?.reviewerTurnId, null);
    assert.notEqual(resumed.session?.coordinator?.messageId, input.assignmentId);
    await assert.rejects(handleCoordinatorReview(input, fixture.context), /not_authorized/);
    await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: session.workspaceId, action: "stop" }, fixture.context);
    await assert.rejects(handleCoordinatorReview({ ...input, assignmentId: resumed.session!.coordinator!.messageId }, fixture.context), /revoked/);
    const switched = await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: session.workspaceId, action: "independent" }, fixture.context);
    assert.equal(switched.ok, true);
    assert.equal(switched.session?.roundTarget, "independent");
    assert.equal(switched.session?.preferences.reviewerTarget, "coordinator");
  });
});

test("coordinator soft timeout keeps an active turn reviewing and accepts its late result", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project", patch: { reviewerTarget: "coordinator" }, resetFields: [] });
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", requestedByAgentId: "reviewer-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    writeState("context:coordinator-timeout-test", { agentId: "reviewer-fixture", cwd: fixture.root });
    let session = await startReview({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture" }, fixture.context);
    fixture.setReviewerBusy(false);
    await tickCoordinatorReviews(fixture.context);
    await tickCoordinatorReviews(fixture.context);
    session = readReviewSession("managed-fixture")!;
    const input = { projectConfig: fixture.config, workspaceId: session.workspaceId, sessionId: session.id, assignmentId: session.coordinator!.messageId, round: session.round, token: "coordinator-timeout-test", action: "read" as const };
    fixture.setReviewerBusy(true);
    await handleCoordinatorReview(input, fixture.context);
    const accepted = readReviewSession(session.workspaceId)!;
    const acceptedAt = new Date(Date.now() - accepted.preferences.reviewerTimeoutMs - 1_000).toISOString();
    writeReviewState(`agent-review:session:${accepted.workspaceId}:${accepted.id}`, { ...accepted, coordinator: { ...accepted.coordinator!, acceptedAt, timeoutAt: null, hardTimeoutAt: null } });
    await tickCoordinatorReviews(fixture.context);
    const softTimedOut = readReviewSession(session.workspaceId)!;
    assert.equal(softTimedOut.status, "reviewing");
    assert.equal(softTimedOut.coordinator?.phase, "accepted");
    assert.ok(softTimedOut.coordinator?.timeoutAt);
    assert.ok(softTimedOut.coordinator?.hardTimeoutAt);

    const result = await recordReviewerResult({
      workspaceId: softTimedOut.workspaceId,
      sessionId: softTimedOut.id,
      reviewerAgentId: softTimedOut.reviewerAgentId!,
      token: reviewAuthToken(softTimedOut.id)!,
      result: { verdict: "approved", summary: "Approved after the soft timeout", findings: [], checks: [], unreviewed: [], snapshotId: softTimedOut.snapshotId, diffId: softTimedOut.diffId },
    }, fixture.context);
    assert.equal(result.accepted, true);
    assert.equal(result.session?.status, "reviewing");
    writeReviewState("agent-review:turn:reviewer-fixture:review-turn", { outcome: "completed", endedAt: new Date().toISOString() });
    await tickCoordinatorReviews(fixture.context);
    assert.equal(readReviewSession(session.workspaceId)?.status, "approved");
  });
});

test("coordinator hard timeout enters stopping, cancels the exact turn, and fails only after it ends", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project", patch: { reviewerTarget: "coordinator" }, resetFields: [] });
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", requestedByAgentId: "reviewer-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    writeState("context:coordinator-hard-timeout-test", { agentId: "reviewer-fixture", cwd: fixture.root });
    let session = await startReview({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture" }, fixture.context);
    fixture.setReviewerBusy(false);
    await tickCoordinatorReviews(fixture.context);
    await tickCoordinatorReviews(fixture.context);
    session = readReviewSession("managed-fixture")!;
    const input = { projectConfig: fixture.config, workspaceId: session.workspaceId, sessionId: session.id, assignmentId: session.coordinator!.messageId, round: session.round, token: "coordinator-hard-timeout-test", action: "read" as const };
    fixture.setReviewerBusy(true);
    await handleCoordinatorReview(input, fixture.context);
    const accepted = readReviewSession(session.workspaceId)!;
    const old = new Date(Date.now() - accepted.preferences.reviewerTimeoutMs * 2 - 1_000).toISOString();
    writeReviewState(`agent-review:session:${accepted.workspaceId}:${accepted.id}`, { ...accepted, coordinator: { ...accepted.coordinator!, acceptedAt: old, timeoutAt: old, hardTimeoutAt: old } });
    const cancelled: string[] = [];
    const timeoutContext = { ...fixture.context, paseo: { ...fixture.context.paseo, cancelAgent: async (agentId: string) => { cancelled.push(agentId); fixture.setReviewerBusy(false); } } } as AgentContext;
    await tickCoordinatorReviews(timeoutContext);
    const stopping = readReviewSession(session.workspaceId)!;
    assert.equal(stopping.status, "stopping");
    assert.equal(stopping.coordinator?.phase, "stopping");
    assert.deepEqual(cancelled, ["reviewer-fixture"]);

    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const server = { on(name: string, handler: (...args: any[]) => Promise<void>) { handlers.set(name, handler); return () => {}; } };
    const cleanup = registerReviewLifecycle(server as unknown as Parameters<typeof registerReviewLifecycle>[0]);
    try {
      await handlers.get("agent.turn_ended")!({ agent: { id: "reviewer-fixture" }, turnId: "review-turn", outcome: { kind: "cancelled" } }, timeoutContext);
    } finally {
      cleanup();
    }
    const failed = readReviewSession(session.workspaceId)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError?.code, "reviewer_timeout");
  });
});

test("independent Reviewer timeout uses the same stopping lifecycle", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    fixture.setReviewerBusy(true);
    fixture.setReviewerWaitResults([{ status: "timeout" }, { status: "timeout" }]);
    const cancelled: string[] = [];
    const timeoutContext = { ...fixture.context, paseo: { ...fixture.context.paseo, cancelAgent: async (agentId: string) => { cancelled.push(agentId); fixture.setReviewerBusy(false); } } } as AgentContext;
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, timeoutContext);
    for (let index = 0; index < 5; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = readReviewSession(session.workspaceId)!;
    assert.equal(stopping.status, "stopping");
    assert.equal(stopping.lastError?.code, "reviewer_timeout");
    assert.deepEqual(cancelled, ["reviewer-fixture"]);

    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const server = { on(name: string, handler: (...args: any[]) => Promise<void>) { handlers.set(name, handler); return () => {}; } };
    const cleanup = registerReviewLifecycle(server as unknown as Parameters<typeof registerReviewLifecycle>[0]);
    try {
      await handlers.get("agent.turn_ended")!({ agent: { id: "reviewer-fixture" }, turnId: "review-turn", outcome: { kind: "cancelled" } }, timeoutContext);
    } finally {
      cleanup();
    }
    const failed = readReviewSession(session.workspaceId)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError?.code, "reviewer_timeout");
  });
});

test("the frozen review packet and referenced image reach the Reviewer", async () => {
  const fixture = harness();
  try {
    await withFixture(fixture, async () => {
      writeFileSync(join(fixture.root, "draft.png"), Buffer.from("draft-image"));
      const handoff = handoffSchema.parse({
        goal: "Implement the draft",
        reviewPacket: {
          requirementUnderstanding: "Match the supplied draft in the target Workspace.",
          plan: ["Update the implementation", "Run the relevant tests"],
          acceptanceCriteria: [{ id: "AC-1", text: "The implementation matches the draft", required: true }],
          references: [{ id: "REF-1", kind: "image", title: "Draft", purpose: "Visual source of truth", path: "draft.png", required: true }],
          instructions: "Compare the result with the draft before approving.",
        },
      });
      const recorded = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
      assert.equal(recorded.handoff?.reviewPacket.requirementUnderstanding, "Match the supplied draft in the target Workspace.");
      const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
      assert.equal(session.snapshot?.artifacts[0]?.status, "ready");
      assert.equal(session.snapshot?.artifacts[0]?.path, "draft.png");
      assert.equal(session.snapshot?.artifacts[0]?.assetId?.startsWith("review-"), true);
      assert.match(String(fixture.reviewerCreate[0]?.prompt), /Match the supplied draft/);
      assert.match(String(fixture.reviewerCreate[0]?.prompt), /AC-1/);
      const images = fixture.reviewerCreate[0]?.images as Array<{ data: string; mimeType: string }> | undefined;
      assert.deepEqual(images, [{ data: Buffer.from("draft-image").toString("base64"), mimeType: "image/png" }]);
    });
  } finally {
    fixture.cleanup();
  }
});

test("approval requires coverage for every required acceptance criterion", async () => {
  const fixture = harness();
  try {
    await withFixture(fixture, async () => {
      const handoff = handoffSchema.parse({ goal: "Implement the requirement", reviewPacket: { acceptanceCriteria: [{ id: "AC-1", text: "The requirement is implemented", required: true }] } });
      recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
      const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
      const baseResult = { verdict: "approved" as const, summary: "Looks good", findings: [], checks: [], unreviewed: [], snapshotId: session.snapshotId!, diffId: session.diffId! };
      const missing = await recordReviewerResult({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)!, result: { ...baseResult, criterionChecks: [{ id: "AC-1", status: "not_verifiable" as const }] }, finalize: true }, fixture.context);
      assert.equal(missing.accepted, false);
      assert.equal(missing.error?.code, "reviewer_invalid_result");
      const approved = await recordReviewerResult({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)!, result: { ...baseResult, criterionChecks: [{ id: "AC-1", status: "passed" as const, evidence: "Verified in the reviewed snapshot" }] }, finalize: true }, fixture.context);
      assert.equal(approved.accepted, true);
      assert.equal(approved.session?.status, "approved");
    });
  } finally {
    fixture.cleanup();
  }
});

test("review preferences resolve field by field and preserve project config", () => {
  const resolved = resolveReviewPreferences({ mode: "automatic", autoFix: false, maxRounds: 5 }, { autoFix: true }, { reviewerModel: "model-b" });
  assert.equal(resolved.mode, "automatic");
  assert.equal(resolved.autoFix, true);
  assert.equal(resolved.maxRounds, 5);
  assert.equal(resolved.reviewerModel, "model-b");
});

test("permanent workspace cleanup removes runtime records before the same id is reused", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const handoff = {
      version: "workspace.workbench.handoff/v1" as const,
      goal: "Original workspace task",
      decisions: [], inScope: [], outOfScope: [], steps: [], acceptance: [], constraints: [], ambiguities: [],
      reviewPacket: { requirementUnderstanding: "", plan: [], acceptanceCriteria: [], references: [], instructions: "" },
      startMode: "adaptive" as const,
      policy: { placementGuard: true },
      expected: { branchByRepository: {}, baseByRepository: {} },
    };
    const first = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
    putAgentBinding({ workspaceId: "managed-fixture", agentId: "execution-fixture", relationship: "independent", paseoWorkspaceId: "managed-fixture", cwd: fixture.root, provider: "codex/model-a", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    assert.equal(Boolean(getAgentBinding("managed-fixture")), true);
    assert.equal(getReviewWorkspaceState("managed-fixture").sessionCount, 1);

    const cleanup = clearWorkspaceRuntimeState("managed-fixture");
    assert.equal(cleanup.bindingRemoved, true);
    assert.equal(cleanup.sessionsRemoved, 1);
    assert.equal(getAgentBinding("managed-fixture"), null);
    assert.equal(getReviewWorkspaceState("managed-fixture").sessionCount, 0);
    assert.equal(readReviewSession("managed-fixture"), null);

    const recreated = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff: { ...handoff, goal: "Recreated workspace task" } });
    assert.notEqual(recreated.id, first.id);
    assert.equal(readReviewSession("managed-fixture")?.id, recreated.id);
  });
});

test("permanent deletion reports a runtime cleanup failure after confirmed filesystem deletion", async () => {
  const sequence: string[] = [];
  let deleteCalled = false;
  const result = await executePermanentWorkspaceDelete(
    { action: "delete", workspaceId: "managed-fixture", confirm: true },
    [],
    { agentBinding: true, reviewSessionCount: 1, activeReviewSessionId: "review-1" },
    {
      preview: async () => {
        sequence.push("preview");
        return { ok: true, result: { state: "active" } };
      },
      clearRuntime: () => {
        sequence.push("cleanup");
        throw new Error("agent_bindings_unreadable");
      },
      deleteWorkspace: async () => {
        deleteCalled = true;
        sequence.push("delete");
        return { ok: true, result: { state: "removed" } };
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "workspace_runtime_cleanup_failed");
  assert.deepEqual(sequence, ["preview", "delete", "cleanup"]);
  assert.equal(deleteCalled, true);
  assert.match(result.error?.message || "", /deletion completed/);
});

test("execution handoff creates the durable review timeline before completion", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const handoff = {
      version: "workspace.workbench.handoff/v1" as const,
      goal: "Implement the fixture behavior",
      decisions: ["Keep the change small"],
      inScope: ["fixture"],
      outOfScope: [],
      steps: ["Edit the fixture"],
      acceptance: ["The fixture test passes"],
      constraints: [],
      ambiguities: [],
      reviewPacket: { requirementUnderstanding: "", plan: [], acceptanceCriteria: [], references: [], instructions: "" },
      startMode: "adaptive" as const,
      policy: { placementGuard: true },
      expected: { branchByRepository: {}, baseByRepository: {} },
    };
    const first = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
    assert.equal(first.status, "waiting_execution");
    assert.equal(first.handoff?.goal, handoff.goal);
    assert.equal(first.events[0].summary, "Execution handoff recorded");
    const manuallyStarted = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(manuallyStarted.status, "reviewing");
    const duplicate = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
    assert.equal(duplicate.id, first.id);
  });
});

test("start creates a real read-only Reviewer from a server snapshot and includes untracked files", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(session.status, "reviewing");
    assert.equal(fixture.reviewerCreate[0].parent, undefined);
    assert.equal((fixture.reviewerCreate[0].labels as Record<string, string>)["workspace-workbench.relationship"], "independent");
    assert.equal((fixture.reviewerCreate[0].labels as Record<string, string>)["workspace-workbench.parent"], undefined);
    assert.equal(session.round, 1);
    assert.equal(session.snapshot?.files.some((file) => file.path === "new-file.txt"), true);
    const created = fixture.reviewerCreate[0];
    const config = created.config as Record<string, unknown>;
    assert.equal(config.provider, "codex/model-a");
    assert.match(String(created.prompt), /请使用中文返回审核摘要/);
    assert.match(String(config.systemPrompt), /只能进行只读审核/);
    assert.match(String(config.systemPrompt), /保持实现简单/);
    assert.deepEqual(config.options, { sandbox_mode: "read-only", approval_policy: "never" });
    assert.deepEqual((config.toolPolicy as { preapproved: unknown[] }).preapproved, [
      { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_read" },
      { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_result" },
      ...["workbench_handoff_read", "workbench_handoff_search", "workbench_handoff_asset"].map(tool => ({ kind: "mcp", server: "workbench-review", tool })),
    ]);
    assert.equal((config.mcpServers as Record<string, unknown>)["workspace-workbench"], undefined);
    assert.ok(reviewAuthToken(session.id));
    const snapshot = await readReviewerSnapshot({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)! }, fixture.context);
    assert.equal(snapshot.ok, true);
    const pendingIdSnapshot = await readReviewerSnapshot({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: "pending", token: reviewAuthToken(session.id)! }, fixture.context);
    assert.equal(pendingIdSnapshot.ok, true);
  });
});

test("an explicit English review locale is captured in the Reviewer prompt", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture", locale: "en-US" }, fixture.context);
    assert.equal(session.preferences.locale, "en-US");
    assert.match(String(fixture.reviewerCreate[0].prompt), /Return the review summary/);
    const config = fixture.reviewerCreate[0].config as Record<string, unknown>;
    assert.match(String(config.systemPrompt), /strictly read-only/);
    assert.match(String(config.systemPrompt), /keep the implementation simple/);
  });
});

test("review accepts an execution Agent rooted at a registered repository worktree", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    fixture.setRuntime({
      workspaceId: "managed-fixture",
      managed: true,
      treePath: join(fixture.root, "workspace-container"),
      repositories: [{ id: "fixture", repoPath: ".", worktreePath: fixture.root, branch: "main", baseRef: "main", baseSha: "base", head: "head", indexDigest: "index-1", worktreeDigest: "worktree-1", statusDigest: "status-1", dirtyPaths: ["new-file.txt"] }],
    });
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(session.status, "reviewing");
    assert.equal(session.snapshot?.repositories[0].worktreePath, fixture.root);
  });
});

test("changes_requested sends the same execution Agent a finding-specific repair handoff", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const result = await recordReviewerResult({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      reviewerAgentId: session.reviewerAgentId!,
      token: reviewAuthToken(session.id)!,
      result: {
        verdict: "changes_requested",
        summary: "Fix the fixture behavior",
        findings: [{ id: "finding-1", severity: "error", repositoryId: "fixture", path: "new-file.txt", message: "The behavior is incomplete", needsFix: true }],
        checks: [], unreviewed: [], snapshotId: session.snapshotId, diffId: session.diffId,
      },
      finalize: true,
    }, fixture.context);
    assert.equal(result.accepted, true);
    assert.equal(result.session?.status, "fixing");
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0], /finding-1/);
    assert.match(fixture.sent[0], new RegExp(session.snapshotId!));
  });
});

test("reuse mode sends the next snapshot to the same Reviewer after repair", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project", patch: { mode: "automatic" }, resetFields: [] });
    const first = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const result = await recordReviewerResult({
      workspaceId: first.workspaceId,
      sessionId: first.id,
      reviewerAgentId: first.reviewerAgentId!,
      token: reviewAuthToken(first.id)!,
      result: {
        verdict: "changes_requested",
        summary: "Fix the fixture behavior",
        findings: [{ id: "finding-reuse", severity: "error", repositoryId: "fixture", path: "new-file.txt", message: "The behavior is incomplete", needsFix: true }],
        checks: [], unreviewed: [], snapshotId: first.snapshotId, diffId: first.diffId,
      },
      finalize: true,
    }, fixture.context);
    assert.equal(result.session?.status, "fixing");
    fixture.setReviewerBusy(false);
    fixture.setRuntime({
      workspaceId: "managed-fixture", managed: true, treePath: fixture.root,
      repositories: [{ id: "fixture", repoPath: ".", worktreePath: fixture.root, branch: "main", baseRef: "main", baseSha: "base-2", head: "head-2", indexDigest: "index-2", worktreeDigest: "worktree-2", statusDigest: "status-2", dirtyPaths: ["new-file.txt"] }],
    });
    writeState("context:execution-token", { agentId: "execution-fixture", cwd: fixture.root, workspaceId: "managed-fixture" });
    fixture.setExecutionBusy(true, "repair-turn");
    await acceptExecutionReport({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture", token: "execution-token", turnId: "repair-turn", report: { status: "ready_for_review", summary: "Repair is complete", changes: ["new-file.txt"], tests: ["fixture test"], knownLimitations: [] } }, fixture.context);
    await handleReviewTurnEnded({ agent: { id: "execution-fixture" }, turnId: "repair-turn", outcome: { kind: "completed" } }, fixture.context);
    const next = readReviewSession(first.workspaceId, first.id);
    assert.equal(next?.round, 2);
    assert.equal(next?.status, "reviewing");
    assert.equal(next?.reviewerAgentId, first.reviewerAgentId);
    assert.equal(fixture.reviewerCreate.length, 1);
    assert.equal(fixture.reviewerSent.length, 1);
  });
});

test("stale snapshots and invalid results fail closed", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    fixture.setRuntime({
      workspaceId: "managed-fixture", managed: true, treePath: fixture.root,
      repositories: [{ id: "fixture", repoPath: ".", worktreePath: fixture.root, branch: "main", baseRef: "main", baseSha: "base-changed", head: "head-changed", indexDigest: "index-2", worktreeDigest: "worktree-2", statusDigest: "status-2", dirtyPaths: ["new-file.txt"] }],
    });
    const stale = await readReviewerSnapshot({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)! }, fixture.context);
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, "review_snapshot_stale");
    const invalid = await recordReviewerResult({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)!, result: { verdict: "approved", summary: "bad", findings: [{ id: "must-fix", severity: "error", repositoryId: "fixture", path: "new-file.txt", message: "must fix", needsFix: true }], checks: [], unreviewed: [], snapshotId: session.snapshotId, diffId: session.diffId } }, fixture.context);
    assert.equal(invalid.accepted, false);
    assert.equal(invalid.error?.code, "review_not_active");
  });
});

test("model discovery and settings update keep shared rules separate from local model overrides", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project", patch: { mode: "automatic", autoFix: false, maxRounds: 2 }, resetFields: [] });
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project-model", patch: { reviewerModel: "model-a" }, resetFields: [] });
    const settings = await handleReviewSettingsGet({ projectConfig: fixture.config });
    assert.equal(settings.effective.mode, "automatic");
    assert.equal(settings.effective.autoFix, false);
    assert.equal(settings.effective.maxRounds, 2);
    assert.equal(settings.effective.reviewerModel, "model-a");
    const config = JSON.parse(readFileSync(fixture.config, "utf8")) as Record<string, unknown>;
    assert.deepEqual(config.review, { mode: "automatic", autoFix: false, maxRounds: 2, reviewerTarget: "independent" });
    assert.equal((config.review as Record<string, unknown>).reviewerModel, undefined);
    const models = await handleReviewModels({ projectConfig: fixture.config, workspaceId: "managed-fixture" }, fixture.context);
    assert.equal(models.models[0].id, "model-a");
  });
});

test("resume before a snapshot restores the report gate without resending and preserves the frozen handoff", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const handoff = handoffSchema.parse({ goal: "Keep this requirement", reviewPacket: { acceptanceCriteria: [{ id: "AC-original", text: "Preserve the original criterion", required: true }] } });
    const original = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
    writeState("context:resume-token", { agentId: "execution-fixture", cwd: fixture.root, workspaceId: original.workspaceId });
    const input = { projectConfig: fixture.config, workspaceId: original.workspaceId, executionAgentId: "execution-fixture", token: "resume-token" };
    fixture.setExecutionBusy(true, "blocked-turn");
    await acceptExecutionReport({ ...input, report: { status: "needs_input", summary: "Missing input", changes: [], tests: [], knownLimitations: [] } }, fixture.context);
    const control = { projectConfig: fixture.config, workspaceId: original.workspaceId, sessionId: original.id, action: "resume" as const };
    const resumed = await handleReviewSessionControl(control, fixture.context);
    assert.equal(resumed.ok, true);
    assert.equal(resumed.session?.status, "waiting_execution");
    assert.equal(resumed.session?.id, original.id);
    assert.deepEqual(resumed.session?.handoff, original.handoff);
    assert.equal(fixture.sent.length + fixture.reviewerCreate.length + fixture.reviewerSent.length, 0);
    const duplicate = await handleReviewSessionControl(control, fixture.context);
    assert.equal(duplicate.session?.revision, resumed.session?.revision);
    fixture.setExecutionBusy(true, "ready-turn");
    const ready = await acceptExecutionReport({ ...input, report: { status: "ready_for_review", summary: "Complete", changes: [], tests: [], knownLimitations: [] } }, fixture.context);
    assert.equal(ready.accepted, true);
    await handleReviewTurnEnded({ agent: { id: "execution-fixture" }, turnId: "ready-turn", outcome: { kind: "completed" } }, fixture.context);
    assert.equal(readReviewSession(original.workspaceId)?.status, "ready_for_review");
    fixture.setExecutionBusy(false);
    const started = await startReview(input, fixture.context);
    assert.equal(started.status, "reviewing");
    assert.match(String(fixture.reviewerCreate[0]?.prompt), /AC-original/);
  });
});

test("restarting a terminal review preserves its frozen acceptance criteria and history", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const handoff = handoffSchema.parse({ goal: "Original goal", reviewPacket: { acceptanceCriteria: [{ id: "AC-original", text: "Preserve this", required: true }] } });
    const original = recordExecutionHandoff({ workspaceId: "managed-fixture", projectConfig: fixture.config, executionAgentId: "execution-fixture", handoff });
    await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: original.workspaceId, action: "stop" }, fixture.context);
    const started = await startReview({ projectConfig: fixture.config, workspaceId: original.workspaceId }, fixture.context);
    assert.notEqual(started.id, original.id);
    assert.deepEqual(started.handoff, original.handoff);
    assert.match(String(fixture.reviewerCreate[0]?.prompt), /AC-original/);
    assert.equal(readReviewSession(original.workspaceId, original.id)?.status, "stopped");
  });
});

test("ordinary turn endings do not start review; an explicit report is finalized only after the turn ends", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewTurnEnded({ agent: { id: "execution-fixture" }, turnId: "unreported", outcome: { kind: "completed" } }, fixture.context);
    assert.equal(readReviewSession("managed-fixture"), null);
    writeState("context:execution-token", { agentId: "execution-fixture", cwd: fixture.root, workspaceId: "managed-fixture" });
    fixture.setExecutionBusy(true, "reported");
    const accepted = await acceptExecutionReport({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture", token: "execution-token", turnId: "reported", report: { status: "ready_for_review", summary: "Implementation and tests are complete", changes: ["new-file.txt"], tests: ["fixture test"], knownLimitations: [] } }, fixture.context);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.session?.status, "waiting_execution");
    assert.equal(fixture.reviewerCreate.length, 0);
    const duplicate = await acceptExecutionReport({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture", token: "execution-token", turnId: "reported", report: { status: "ready_for_review", summary: "Implementation and tests are complete", changes: ["new-file.txt"], tests: ["fixture test"], knownLimitations: [] } }, fixture.context);
    assert.equal(duplicate.accepted, true);
    assert.equal(duplicate.session?.events.filter((event) => event.kind === "ready_for_review").length, 1);
    await handleReviewTurnEnded({ agent: { id: "execution-fixture" }, turnId: "reported", outcome: { kind: "completed" } }, fixture.context);
    assert.equal(readReviewSession("managed-fixture")?.status, "ready_for_review");
    assert.equal(fixture.reviewerCreate.length, 0);
  });
});

test("starting review from a ready-for-review report launches the Reviewer in manual mode", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    writeState("context:manual-start-token", { agentId: "execution-fixture", cwd: fixture.root, workspaceId: "managed-fixture" });
    fixture.setExecutionBusy(true, "manual-start-turn");
    await acceptExecutionReport({
      projectConfig: fixture.config,
      workspaceId: "managed-fixture",
      executionAgentId: "execution-fixture",
      token: "manual-start-token",
      turnId: "manual-start-turn",
      report: { status: "ready_for_review", summary: "Implementation is ready", changes: ["new-file.txt"], tests: ["fixture test"], knownLimitations: [] },
    }, fixture.context);
    await handleReviewTurnEnded({ agent: { id: "execution-fixture" }, turnId: "manual-start-turn", outcome: { kind: "completed" } }, fixture.context);
    assert.equal(readReviewSession("managed-fixture")?.status, "ready_for_review");
    const started = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(started.status, "reviewing");
    assert.equal(fixture.reviewerCreate.length, 1);
  });
});

test("a late execution report cannot overwrite an active review phase", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    writeState("context:late-report-token", { agentId: "execution-fixture", cwd: fixture.root, workspaceId: "managed-fixture" });
    fixture.setExecutionBusy(true, "late-report-turn");
    const result = await acceptExecutionReport({
      projectConfig: fixture.config,
      workspaceId: "managed-fixture",
      executionAgentId: "execution-fixture",
      token: "late-report-token",
      turnId: "late-report-turn",
      report: { status: "ready_for_review", summary: "Late report", changes: [], tests: [], knownLimitations: [] },
    }, fixture.context);
    assert.equal(result.accepted, false);
    assert.equal(result.error?.code, "execution_report_unexpected");
    assert.equal(result.session?.status, "reviewing");
    assert.equal(result.session?.events.some((event) => event.kind === "ready_for_review"), false);
  });
});

test("a Reviewer result is a candidate until its turn completes", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const result = {
      verdict: "approved" as const,
      summary: "Approved after checking the fixture",
      findings: [],
      checks: [],
      unreviewed: [],
      snapshotId: session.snapshotId!,
      diffId: session.diffId!,
    };
    const candidate = await recordReviewerResult({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      reviewerAgentId: session.reviewerAgentId!,
      token: reviewAuthToken(session.id)!,
      result,
    }, fixture.context);
    assert.equal(candidate.accepted, true);
    assert.equal(candidate.session?.status, "reviewing");
    assert.ok(candidate.session!.revision > session.revision);
    assert.deepEqual(candidate.session?.pendingReviewerResult?.summary, result.summary);
    assert.equal(candidate.session?.latestResult, null);
    assert.equal(candidate.session?.events.some((event) => event.kind === "review_candidate"), true);
    const duplicate = await recordReviewerResult({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      reviewerAgentId: session.reviewerAgentId!,
      token: reviewAuthToken(session.id)!,
      result,
    }, fixture.context);
    assert.equal(duplicate.session?.revision, candidate.session?.revision);

    const formal = await recordReviewerResult({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      reviewerAgentId: session.reviewerAgentId!,
      token: reviewAuthToken(session.id)!,
      result,
      finalize: true,
    }, fixture.context);
    assert.equal(formal.accepted, true);
    assert.equal(formal.session?.status, "approved");
    assert.ok(formal.session!.revision > candidate.session!.revision);
    assert.equal(formal.session?.pendingReviewerResult, null);
    assert.equal(formal.session?.latestResult?.verdict, "approved");
    assert.equal(formal.session?.events.at(-1)?.kind, "finished");
  });
});

test("event pagination returns a nullable end cursor when there are no newer events", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const page = await handleReviewSessionEvents({ projectConfig: fixture.config, workspaceId: "managed-fixture", sessionId: session.id, after: 999, limit: 50 });
    assert.equal(page.ok, true);
    assert.equal(page.events.length, 0);
    assert.equal(page.next, null);
  });
});

test("active review start is idempotent and a later request creates a separate history record", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const first = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const duplicate = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(duplicate.id, first.id);
    assert.equal(fixture.reviewerCreate.length, 1);
    await recordReviewerResult({ workspaceId: first.workspaceId, sessionId: first.id, reviewerAgentId: first.reviewerAgentId!, token: reviewAuthToken(first.id)!, result: { verdict: "approved", summary: "Approved", findings: [], checks: [], unreviewed: [], snapshotId: first.snapshotId, diffId: first.diffId }, finalize: true }, fixture.context);
    const second = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.notEqual(second.id, first.id);
    assert.equal(readReviewSession("managed-fixture")?.id, second.id);
  });
});

test("stop stays in stopping when host cancellation is unavailable instead of pretending it succeeded", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    const session = await startReview({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    const stopped = await handleReviewSessionControl({ projectConfig: fixture.config, workspaceId: "managed-fixture", sessionId: session.id, action: "stop" }, fixture.context);
    assert.equal(stopped.session.status, "stopping");
    assert.equal(stopped.session.lastError?.code, "cancel_unavailable");
    const late = await recordReviewerResult({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)!, result: { verdict: "approved", summary: "Late result", findings: [], checks: [], unreviewed: [], snapshotId: session.snapshotId, diffId: session.diffId } }, fixture.context);
    assert.equal(late.accepted, false);
  });
});

test("an explicitly unavailable Reviewer model is reported without silently falling back", async () => {
  const fixture = harness();
  await withFixture(fixture, async () => {
    await handleReviewSettingsUpdate({ projectConfig: fixture.config, scope: "project-model", patch: { reviewerModel: "missing-model" }, resetFields: [] });
    const result = await handleReviewSessionStart({ projectConfig: fixture.config, workspaceId: "managed-fixture", executionAgentId: "execution-fixture" }, fixture.context);
    assert.equal(result.ok, false);
    assert.match(result.error?.code || "", /reviewer_model_unavailable/);
    assert.equal(fixture.reviewerCreate.length, 0);
  });
});

test("blocked or failed filesystem deletion preserves all runtime history", async () => {
  for (const blockedPreview of [true, false]) {
    let cleared = false, deleted = false;
    const result = await executePermanentWorkspaceDelete({ action: "delete", workspaceId: "fixture", confirm: true }, [], { agentBinding: true, reviewSessionCount: 2, activeReviewSessionId: null }, {
      preview: async () => ({ ok: true, result: { canDelete: !blockedPreview, blockedReason: "workspace_dirty" } }),
      deleteWorkspace: async () => { deleted = true; return { ok: false, error: { code: "workspace_dirty", message: "user changed worktree after preview" } }; },
      clearRuntime: () => { cleared = true; throw new Error("must not clear history"); },
    });
    assert.equal(result.ok, false); assert.equal(cleared, false); assert.equal(deleted, !blockedPreview);
  }
});
