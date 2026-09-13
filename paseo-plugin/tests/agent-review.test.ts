import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProject } from "../server/projects.ts";
import {
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
} from "../server/agent-review.ts";
import { resolveReviewPreferences } from "../shared/agent-review.ts";
import type { AgentContext } from "../server/agent-provider.ts";
import { writeState } from "../server/orchestration-state.ts";

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
  let runtime: Record<string, unknown> = {
    workspaceId: "managed-fixture",
    managed: true,
    treePath: root,
    repositories: [{ id: "fixture", repoPath: ".", worktreePath: root, branch: "main", baseRef: "main", baseSha: head, head, indexDigest: "index-1", worktreeDigest: "worktree-1", statusDigest: "status-1", dirtyPaths: ["new-file.txt"] }],
  };
  let models: Array<Record<string, unknown>> = [{ provider: "codex", id: "model-a", label: "Model A", isSelectable: true, isDefault: true }];
  const executionAgent = {
    id: "execution-fixture",
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
    waitForFinish: async () => await new Promise<never>(() => {}),
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
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

async function withFixture<T>(fixture: Harness, callback: () => T | Promise<T>): Promise<T> {
  const previous = process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
  const previousConfig = process.env.WORKSPACE_WORKBENCH_CONFIG;
  process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = join(fixture.root, "review-settings.json");
  process.env.WORKSPACE_WORKBENCH_CONFIG = fixture.config;
  try { return await withProject({ projectConfig: fixture.config }, callback); }
  finally {
    if (previous === undefined) delete process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS;
    else process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS = previous;
    if (previousConfig === undefined) delete process.env.WORKSPACE_WORKBENCH_CONFIG;
    else process.env.WORKSPACE_WORKBENCH_CONFIG = previousConfig;
    fixture.cleanup();
  }
}

test("review preferences resolve field by field and preserve project config", () => {
  const resolved = resolveReviewPreferences({ mode: "automatic", autoFix: false, maxRounds: 5 }, { autoFix: true }, { reviewerModel: "model-b" });
  assert.equal(resolved.mode, "automatic");
  assert.equal(resolved.autoFix, true);
  assert.equal(resolved.maxRounds, 5);
  assert.equal(resolved.reviewerModel, "model-b");
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
    assert.equal(session.round, 1);
    assert.equal(session.snapshot?.files.some((file) => file.path === "new-file.txt"), true);
    const created = fixture.reviewerCreate[0];
    const config = created.config as Record<string, unknown>;
    assert.equal(config.provider, "codex/model-a");
    assert.deepEqual(config.options, { sandbox_mode: "read-only", approval_policy: "never" });
    assert.deepEqual((config.toolPolicy as { preapproved: unknown[] }).preapproved, [
      { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_read" },
      { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_result" },
    ]);
    assert.equal((config.mcpServers as Record<string, unknown>)["workspace-workbench"], undefined);
    assert.ok(reviewAuthToken(session.id));
    const snapshot = await readReviewerSnapshot({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: session.reviewerAgentId!, token: reviewAuthToken(session.id)! }, fixture.context);
    assert.equal(snapshot.ok, true);
    const pendingIdSnapshot = await readReviewerSnapshot({ workspaceId: session.workspaceId, sessionId: session.id, reviewerAgentId: "pending", token: reviewAuthToken(session.id)! }, fixture.context);
    assert.equal(pendingIdSnapshot.ok, true);
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
    assert.deepEqual(config.review, { mode: "automatic", autoFix: false, maxRounds: 2 });
    assert.equal((config.review as Record<string, unknown>).reviewerModel, undefined);
    const models = await handleReviewModels({ projectConfig: fixture.config, workspaceId: "managed-fixture" }, fixture.context);
    assert.equal(models.models[0].id, "model-a");
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
