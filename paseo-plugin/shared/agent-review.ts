import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { agentRelationshipSchema } from "./agent-session.ts";

export const reviewModeSchema = z.enum(["off", "manual", "automatic"]);
export const reviewerSessionModeSchema = z.enum(["reuse", "new_per_round"]);
export const reviewLocaleSchema = z.enum(["zh-CN", "en-US"]);
export type ReviewLocale = z.infer<typeof reviewLocaleSchema>;

/** Fields stored in a project config. Models are deliberately not included. */
export const reviewPreferencePatchSchema = z.object({
  mode: reviewModeSchema.optional(),
  autoFix: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(10).optional(),
  reviewerRole: z.string().trim().min(1).optional(),
  instructions: z.string().optional(),
  reviewerSession: reviewerSessionModeSchema.optional(),
  reviewerTimeoutMs: z.number().int().min(30_000).max(3_600_000).optional(),
  repairTimeoutMs: z.number().int().min(30_000).max(7_200_000).optional(),
});
export type ReviewPreferencePatch = z.infer<typeof reviewPreferencePatchSchema>;

export const reviewModelOverrideSchema = z.object({
  executionModel: z.string().trim().min(1).nullable().optional(),
  reviewerModel: z.string().trim().min(1).nullable().optional(),
});
export type ReviewModelOverride = z.infer<typeof reviewModelOverrideSchema>;
export const reviewGlobalPatchSchema = reviewPreferencePatchSchema.merge(reviewModelOverrideSchema);

export const reviewPreferencesSchema = z.object({
  mode: reviewModeSchema.default("manual"),
  autoFix: z.boolean().default(true),
  maxRounds: z.number().int().min(1).max(10).default(3),
  reviewerRole: z.string().trim().min(1).default("Code reviewer"),
  instructions: z.string().default("Check requirement fit, correctness, regressions and tests; keep the implementation simple."),
  reviewerSession: reviewerSessionModeSchema.default("reuse"),
  reviewerTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
  repairTimeoutMs: z.number().int().min(30_000).max(7_200_000).default(1_800_000),
  executionModel: z.string().trim().min(1).nullable().default(null),
  reviewerModel: z.string().trim().min(1).nullable().default(null),
  /** Runtime-only locale captured when a review starts; never written to project settings. */
  locale: reviewLocaleSchema.default("zh-CN"),
});
export type ReviewPreferences = z.infer<typeof reviewPreferencesSchema>;

export const reviewPreferenceSourcesSchema = z.record(
  z.string(),
  z.enum(["project", "global", "default", "project-model", "global-model", "follow-execution"]),
);

export function resolveReviewPreferences(
  global: Partial<ReviewPreferences> = {},
  project: ReviewPreferencePatch = {},
  projectModels: ReviewModelOverride = {},
): ReviewPreferences {
  const defaults = reviewPreferencesSchema.parse({});
  const shared = { ...defaults, ...global, ...project };
  return reviewPreferencesSchema.parse({
    ...shared,
    executionModel: projectModels.executionModel !== undefined ? projectModels.executionModel : global.executionModel ?? null,
    reviewerModel: projectModels.reviewerModel !== undefined ? projectModels.reviewerModel : global.reviewerModel ?? null,
  });
}

export const reviewFindingSchema = z.object({
  id: z.string().trim().min(1),
  severity: z.enum(["info", "warning", "error"]),
  repositoryId: z.string().trim().min(1),
  path: z.string().trim().min(1),
  line: z.number().int().positive().optional(),
  side: z.enum(["old", "new"]).optional(),
  message: z.string().trim().min(1),
  suggestion: z.string().trim().optional(),
  needsFix: z.boolean().default(true),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewCheckSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "not_run", "unavailable"]),
  evidence: z.string().trim().optional(),
});

const reviewResultInputSchema = z.object({
  verdict: z.enum(["approved", "changes_requested", "blocked"]).optional(),
  // Kept for compatibility with the first experimental Reviewer tool. The
  // server normalizes it and never lets it bypass the result validation.
  outcome: z.enum(["approved", "changes_requested", "blocked"]).optional(),
  summary: z.string().trim().min(1),
  findings: z.array(reviewFindingSchema).default([]),
  checks: z.array(reviewCheckSchema).default([]),
  unreviewed: z.array(z.string().trim().min(1)).default([]),
  snapshotId: z.string().trim().min(1),
  diffId: z.string().trim().min(1),
  resultId: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.verdict && !value.outcome) ctx.addIssue({ code: "custom", path: ["verdict"], message: "verdict is required" });
  if (value.verdict && value.outcome && value.verdict !== value.outcome) ctx.addIssue({ code: "custom", path: ["outcome"], message: "verdict and outcome disagree" });
});

export const reviewResultSchema = reviewResultInputSchema.transform((value) => ({ ...value, verdict: value.verdict || value.outcome! }));
export type ReviewResult = z.output<typeof reviewResultSchema>;

export const reviewSnapshotFileSchema = z.object({
  repositoryId: z.string().trim().min(1),
  path: z.string().trim().min(1),
  oldPath: z.string().trim().optional(),
  status: z.string().trim().min(1),
  binary: z.boolean().default(false),
  truncated: z.boolean().default(false),
  diff: z.string().optional(),
  content: z.string().optional(),
});
export const reviewSnapshotRepositorySchema = z.object({
  id: z.string().trim().min(1),
  repoPath: z.string().trim().min(1),
  worktreePath: z.string().trim().min(1),
  branch: z.string().nullable(),
  baseRef: z.string().nullable(),
  baseSha: z.string().nullable(),
  head: z.string().nullable(),
  indexDigest: z.string().trim().min(1),
  worktreeDigest: z.string().trim().min(1),
  statusDigest: z.string().trim().min(1),
  dirtyPaths: z.array(z.string()),
});
export const reviewSnapshotSchema = z.object({
  workspaceId: z.string().trim().min(1),
  treePath: z.string().trim().min(1),
  snapshotId: z.string().trim().min(1),
  diffId: z.string().trim().min(1),
  capturedAt: z.string().datetime(),
  repositories: z.array(reviewSnapshotRepositorySchema),
  files: z.array(reviewSnapshotFileSchema),
  unreviewed: z.array(z.string()),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

export const reviewEventSchema = z.object({
  id: z.string().trim().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  kind: z.enum([
    "started", "execution_turn_ended", "ready_for_review", "review_queued",
    "reviewer_created", "review_started", "review_candidate", "review_result", "repair_requested",
    "repair_sent", "paused", "resumed", "stopped", "failed", "blocked",
    "expired", "finished",
  ]),
  /** Stable localization key for system events. Older records may omit it. */
  messageKey: z.string().trim().min(1).optional(),
  messageArgs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  summary: z.string().trim().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewSessionStatusSchema = z.enum([
  "waiting_execution", "ready_for_review", "queued", "reviewing", "changes_requested",
  "fixing", "approved", "blocked", "failed", "stopping", "stopped", "limit_reached",
]);

export const reviewSessionSchema = z.object({
  version: z.literal(2),
  id: z.string().trim().min(1),
  revision: z.number().int().nonnegative().default(0),
  workspaceId: z.string().trim().min(1),
  projectConfig: z.string().trim().min(1),
  paseoWorkspaceId: z.string().trim().min(1).nullable(),
  handoffHash: z.string().trim().min(1).nullable().default(null),
  handoff: z.object({
    goal: z.string(),
    decisions: z.array(z.string()),
    inScope: z.array(z.string()),
    outOfScope: z.array(z.string()),
    steps: z.array(z.string()).default([]),
    acceptance: z.array(z.string()),
    constraints: z.array(z.string()).default([]),
    ambiguities: z.array(z.string()).default([]),
    startMode: z.enum(["adaptive", "plan-first"]).default("adaptive"),
    handoffId: z.string().optional(),
    relationship: agentRelationshipSchema.optional(),
    reviewLocale: reviewLocaleSchema.optional(),
    expected: z.object({
      branchByRepository: z.record(z.string(), z.string()).default({}),
      baseByRepository: z.record(z.string(), z.string()).default({}),
      dirty: z.boolean().optional(),
    }).default({ branchByRepository: {}, baseByRepository: {} }),
  }).nullable(),
  executionAgentId: z.string().trim().min(1).nullable(),
  executionModelId: z.string().trim().min(1).nullable().default(null),
  executionTurnId: z.string().trim().min(1).nullable(),
  reviewerAgentId: z.string().trim().min(1).nullable(),
  reviewerModelId: z.string().trim().min(1).nullable().default(null),
  reviewerTurnId: z.string().trim().min(1).nullable(),
  status: reviewSessionStatusSchema,
  round: z.number().int().nonnegative(),
  maxRounds: z.number().int().positive(),
  snapshotId: z.string().nullable(),
  diffId: z.string().nullable(),
  snapshot: reviewSnapshotSchema.nullable(),
  preferences: reviewPreferencesSchema,
  events: z.array(reviewEventSchema),
  pendingReviewerResult: reviewResultInputSchema.nullable().default(null),
  latestResult: reviewResultInputSchema.transform((value) => ({ ...value, verdict: value.verdict || value.outcome! })).nullable(),
  stopAgentIds: z.array(z.string().trim().min(1)).default([]),
  pendingOperation: z.object({
    kind: z.enum(["create_reviewer", "send_reviewer", "send_repair", "cancel"]),
    requestId: z.string(),
    messageId: z.string().optional(),
    createdAt: z.string().datetime(),
  }).nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  updatedAt: z.string().datetime(),
});
export type ReviewSession = z.output<typeof reviewSessionSchema>;

const projectContext = z.object({ projectConfig: z.string().trim().min(1), workspaceId: z.string().trim().min(1), token: z.string().trim().min(1).optional() });
const rpcError = z.object({ code: z.string(), message: z.string() });

export const reviewSessionQuery = defineRpc({
  name: "workspace.workbench.agent-review.session",
  input: projectContext.extend({ sessionId: z.string().trim().min(1).optional() }),
  output: z.object({ ok: z.boolean(), session: reviewSessionSchema.nullable(), preferences: reviewPreferencesSchema, sources: reviewPreferenceSourcesSchema }),
});
export const reviewSessionList = defineRpc({
  name: "workspace.workbench.agent-review.sessions",
  input: projectContext,
  output: z.object({ ok: z.boolean(), sessions: z.array(reviewSessionSchema), activeSessionId: z.string().nullable(), error: rpcError.optional() }),
});
export const reviewSessionEvents = defineRpc({
  name: "workspace.workbench.agent-review.events",
  input: projectContext.extend({ sessionId: z.string().trim().min(1), after: z.number().int().min(-1).default(-1), limit: z.number().int().min(1).max(100).default(50) }),
  output: z.object({ ok: z.boolean(), events: z.array(reviewEventSchema), next: z.number().int().nonnegative().nullable(), error: rpcError.optional() }),
});
export const reviewSettingsGet = defineRpc({
  name: "workspace.workbench.agent-review.settings.get",
  input: z.object({ projectConfig: z.string().trim().min(1) }),
  output: z.object({ ok: z.boolean(), effective: reviewPreferencesSchema, project: reviewPreferencePatchSchema, global: reviewGlobalPatchSchema, models: reviewModelOverrideSchema, sources: reviewPreferenceSourcesSchema, error: rpcError.optional() }),
});
export const reviewSettingsUpdate = defineRpc({
  name: "workspace.workbench.agent-review.settings.update",
  input: z.object({ projectConfig: z.string().trim().min(1), scope: z.enum(["project", "global", "project-model"]), patch: reviewGlobalPatchSchema, resetFields: z.array(z.string()).default([]) }),
  output: z.object({ ok: z.boolean(), effective: reviewPreferencesSchema, project: reviewPreferencePatchSchema, global: reviewGlobalPatchSchema, models: reviewModelOverrideSchema, sources: reviewPreferenceSourcesSchema, error: rpcError.optional() }),
});
export const reviewModels = defineRpc({
  name: "workspace.workbench.agent-review.models",
  input: z.object({ projectConfig: z.string().trim().min(1), workspaceId: z.string().trim().min(1).optional() }),
  output: z.object({ ok: z.boolean(), provider: z.literal("codex"), models: z.array(z.object({ id: z.string(), label: z.string(), selectable: z.boolean(), isDefault: z.boolean() })), error: rpcError.optional() }),
});
export const reviewSessionStart = defineRpc({
  name: "workspace.workbench.agent-review.start",
  input: projectContext.extend({ executionAgentId: z.string().trim().min(1).optional(), locale: reviewLocaleSchema.optional(), requestId: z.string().trim().min(1).optional() }),
  output: z.object({ ok: z.boolean(), session: reviewSessionSchema.nullable(), error: rpcError.optional() }),
});
export const reviewPreview = defineRpc({
  name: "workspace.workbench.agent-review.preview",
  input: projectContext,
  output: z.object({
    ok: z.boolean(),
    session: reviewSessionSchema.nullable(),
    workspace: z.object({ workspaceId: z.string(), treePath: z.string(), repositories: z.array(z.object({ id: z.string(), worktreePath: z.string(), branch: z.string().nullable(), baseSha: z.string().nullable(), head: z.string().nullable(), dirtyPaths: z.array(z.string()) })) }).nullable(),
    preferences: reviewPreferencesSchema,
    error: rpcError.optional(),
  }),
});
export const reviewSessionControl = defineRpc({
  name: "workspace.workbench.agent-review.control",
  input: projectContext.extend({ sessionId: z.string().trim().min(1).optional(), action: z.enum(["stop", "resume", "review", "repair"]) }),
  output: z.object({ ok: z.boolean(), session: reviewSessionSchema, error: rpcError.optional() }),
});

export const executionReport = defineRpc({
  name: "workspace.workbench.agent-review.execution-report",
  input: projectContext.extend({
    executionAgentId: z.string().trim().min(1),
    token: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    report: z.object({
      status: z.enum(["ready_for_review", "needs_input", "failed"]),
      summary: z.string().trim().min(1),
      changes: z.array(z.string()).default([]),
      tests: z.array(z.string()).default([]),
      knownLimitations: z.array(z.string()).default([]),
      handoffId: z.string().trim().min(1).optional(),
    }),
  }),
  output: z.object({ ok: z.boolean(), session: reviewSessionSchema.nullable(), accepted: z.boolean(), error: rpcError.optional() }),
});

export const reviewerRead = defineRpc({
  name: "workspace.workbench.agent-review.reviewer-read",
  input: projectContext.extend({ sessionId: z.string().trim().min(1), reviewerAgentId: z.string().trim().min(1), token: z.string().trim().min(1) }),
  output: z.object({ ok: z.boolean(), snapshot: reviewSnapshotSchema.nullable(), error: rpcError.optional() }),
});
export const reviewerResult = defineRpc({
  name: "workspace.workbench.agent-review.reviewer-result",
  input: projectContext.extend({ sessionId: z.string().trim().min(1), reviewerAgentId: z.string().trim().min(1), token: z.string().trim().min(1), result: reviewResultInputSchema }),
  output: z.object({ ok: z.boolean(), session: reviewSessionSchema.nullable(), accepted: z.boolean(), error: rpcError.optional() }),
});

export type ReviewReviewerResultInput = z.input<typeof reviewerResult>;
