import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PaseoAgent, PaseoAgentHandle, PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { nativeWebSocketFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { currentProject, registeredProjects, withProject } from "./projects.ts";
import { getAgentBinding } from "./agent-store.ts";
import { readReviewState, readState, removeReviewState, writeReviewState, writeState, digest } from "./orchestration-state.ts";
import type { AgentContext } from "./agent-provider.ts";
import { queryObserver } from "./observer.ts";
import type { Handoff } from "../shared/handoff.ts";
import { formatCopyFrom, getWorkbenchCopy } from "../shared/copy.ts";
import {
  executionReport,
  reviewModels,
  reviewGlobalPatchSchema,
  reviewModelOverrideSchema,
  reviewPreferencePatchSchema,
  reviewPreferencesSchema,
  reviewResultSchema,
  reviewPreview,
  reviewSessionControl,
  reviewSessionEvents,
  reviewSessionList,
  reviewSessionQuery,
  reviewSessionSchema,
  reviewSessionStart,
  reviewSettingsGet,
  reviewSettingsUpdate,
  reviewerRead,
  reviewerResult,
  reviewSnapshotSchema,
  type ReviewLocale,
  type ReviewEvent,
  type ReviewModelOverride,
  type ReviewPreferencePatch,
  type ReviewPreferences,
  type ReviewSession,
  type ReviewSnapshot,
} from "../shared/agent-review.ts";

const execFileAsync = promisify(execFile);
const sessionKey = (workspaceId: string, id: string) => `agent-review:session:${workspaceId}:${id}`;
const indexKey = (workspaceId: string) => `agent-review:index:${workspaceId}`;
const reportKey = (agentId: string) => `agent-review:execution-report:${agentId}`;
const turnKey = (agentId: string, turnId: string) => `agent-review:turn:${agentId}:${turnId}`;
const authKey = (sessionId: string) => `agent-review:auth:${sessionId}`;
const now = () => new Date().toISOString();
const reviewerMonitors = new Set<string>();
const reviewStartFlights = new Map<string, Promise<ReviewSession>>();
const reviewTransitionQueues = new Map<string, Promise<void>>();

type RuntimeRepository = {
  id: string;
  repoPath: string;
  worktreePath: string;
  branch: string | null;
  baseRef?: string | null;
  baseSha: string | null;
  head: string | null;
  indexDigest: string;
  worktreeDigest: string;
  statusDigest: string;
  dirtyPaths: string[];
};
type ExecutionReportRpcInput = {
  projectConfig: string;
  workspaceId: string;
  executionAgentId: string;
  token: string;
  turnId?: string;
  report: ExecutionReportRecord["report"];
};
type ReviewerReadRpcInput = {
  projectConfig: string;
  workspaceId: string;
  sessionId: string;
  reviewerAgentId: string;
  token: string;
};
type ReviewerResultRpcInput = ReviewerReadRpcInput & { result: unknown };
type Runtime = {
  workspaceId: string;
  managed: boolean;
  treePath: string | null;
  repositories: RuntimeRepository[];
};
type StoredReviewIndex = { sessionIds: string[]; activeSessionId: string | null };
type StoredGlobalSettings = {
  version: 1;
  defaults: Partial<ReviewPreferences>;
  projects: Record<string, ReviewModelOverride>;
  agentSession?: {
    defaults?: unknown;
    projects?: Record<string, unknown>;
  };
};
type ExecutionReportRecord = {
  workspaceId: string;
  executionAgentId: string;
  turnId: string | null;
  report: {
    status: "ready_for_review" | "needs_input" | "failed";
    summary: string;
    changes: string[];
    tests: string[];
    knownLimitations: string[];
    handoffId?: string;
  };
  createdAt: string;
  consumedAt?: string;
};
type ReviewAuth = { token: string; workspaceId: string; reviewerAgentId: string };

async function acquireReviewDiskLock(path: string): Promise<() => void> {
  const deadline = Date.now() + 15_000;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const heartbeat = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch { /* release will report no state change */ }
      }, 30_000);
      heartbeat.unref();
      return () => { clearInterval(heartbeat); rmSync(path, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 10 * 60_000) rmSync(path, { recursive: true, force: true });
      }
      catch { /* another owner may be replacing the lock */ }
      if (Date.now() >= deadline) throw new Error("review_orchestrator_busy");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    }
  }
}

async function withReviewTransitionLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const key = `${project.configPath}:${workspaceId}`;
  const previous = reviewTransitionQueues.get(key) || Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
  const chain = previous.then(() => queued);
  reviewTransitionQueues.set(key, chain);
  await previous;
  let releaseDisk: (() => void) | null = null;
  try {
    releaseDisk = await acquireReviewDiskLock(join(project.stateRoot, "reviews", `.transition-${digest(workspaceId)}`));
    return await operation();
  } finally {
    releaseDisk?.();
    releaseQueue();
    if (reviewTransitionQueues.get(key) === chain) reviewTransitionQueues.delete(key);
  }
}

function handoffSnapshot(handoff: Handoff): NonNullable<ReviewSession["handoff"]> {
  return {
    goal: handoff.goal,
    decisions: [...handoff.decisions],
    inScope: [...handoff.inScope],
    outOfScope: [...handoff.outOfScope],
    steps: [...handoff.steps],
    acceptance: [...handoff.acceptance],
    constraints: [...handoff.constraints],
    ambiguities: [...handoff.ambiguities],
    startMode: handoff.startMode,
    ...(handoff.handoffId ? { handoffId: handoff.handoffId } : {}),
    ...(handoff.relationship ? { relationship: handoff.relationship } : {}),
    ...(handoff.reviewLocale ? { reviewLocale: handoff.reviewLocale } : {}),
    expected: {
      branchByRepository: { ...handoff.expected.branchByRepository },
      baseByRepository: { ...handoff.expected.baseByRepository },
      ...(handoff.expected.dirty === undefined ? {} : { dirty: handoff.expected.dirty }),
    },
  };
}

function boundHandoff(workspaceId: string): ReviewSession["handoff"] {
  const handoff = getAgentBinding(workspaceId)?.handoff;
  if (!handoff) return null;
  return handoffSnapshot(handoff);
}

function errorInfo(error: unknown, fallback = "Agent Review is unavailable"): { code: string; message: string } {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === "string" ? String((error as Error & { code?: unknown }).code) : error.message;
    return { code: code || "review_failed", message: error.message || fallback };
  }
  return { code: "review_failed", message: fallback };
}

function projectConfigRaw(): Record<string, unknown> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  try {
    const value = JSON.parse(readFileSync(project.configPath, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch (error) {
    throw new Error(`project_config_unavailable: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function reviewSettingsPath(): string {
  return process.env.WORKSPACE_WORKBENCH_REVIEW_SETTINGS?.trim()
    || join(homedir(), ".config", "workspace-workbench", "review-settings.json");
}

function readGlobalSettings(): StoredGlobalSettings {
  try {
    const value = JSON.parse(readFileSync(reviewSettingsPath(), "utf8")) as Partial<StoredGlobalSettings>;
    const defaults = value.defaults && typeof value.defaults === "object" ? value.defaults : {};
    const projects = value.projects && typeof value.projects === "object" ? value.projects : {};
    const agentSession = value.agentSession && typeof value.agentSession === "object" ? value.agentSession : undefined;
    return { version: 1, defaults: reviewGlobalPatchSchema.parse(defaults), projects: Object.fromEntries(Object.entries(projects).flatMap(([key, item]) => {
      const parsed = zModelOverride().safeParse(item);
      return parsed.success ? [[key, parsed.data]] : [];
    })), ...(agentSession ? { agentSession } : {}) };
  } catch {
    return { version: 1, defaults: {}, projects: {} };
  }
}

function zModelOverride() {
  // Kept local to avoid a settings file ever accepting arbitrary provider
  // configuration or credentials.
  return reviewModelOverrideSchema;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function readProjectReview(): ReviewPreferencePatch {
  const raw = projectConfigRaw().review;
  const parsed = reviewPreferencePatchSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  return parsed.success ? parsed.data : {};
}

function preferenceLayers(): { project: ReviewPreferencePatch; global: Partial<ReviewPreferences>; models: ReviewModelOverride; effective: ReviewPreferences; sources: Record<string, "project" | "global" | "default" | "project-model" | "global-model" | "follow-execution"> } {
  const project = readProjectReview();
  const globalFile = readGlobalSettings();
  const projectPath = currentProject()?.configPath || "";
  const global = reviewGlobalPatchSchema.parse(globalFile.defaults);
  const models = zModelOverride().parse(globalFile.projects[projectPath] || {});
  const effective = reviewPreferencesSchema.parse({
    ...global,
    ...project,
    executionModel: models.executionModel !== undefined ? models.executionModel : global.executionModel ?? null,
    reviewerModel: models.reviewerModel !== undefined ? models.reviewerModel : global.reviewerModel ?? null,
  });
  const sources: Record<string, "project" | "global" | "default" | "project-model" | "global-model" | "follow-execution"> = {};
  for (const field of ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTimeoutMs", "repairTimeoutMs"] as const) {
    sources[field] = field in (project as Record<string, unknown>) ? "project" : field in (global as Record<string, unknown>) ? "global" : "default";
  }
  sources.executionModel = models.executionModel !== undefined ? "project-model" : global.executionModel !== undefined ? "global-model" : "follow-execution";
  sources.reviewerModel = models.reviewerModel !== undefined ? "project-model" : global.reviewerModel !== undefined ? "global-model" : "follow-execution";
  return { project, global, models, effective, sources };
}

function updateProjectReview(patch: ReviewPreferencePatch, resetFields: string[]): void {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const raw = projectConfigRaw();
  const previous = raw.review && typeof raw.review === "object" && !Array.isArray(raw.review) ? raw.review as Record<string, unknown> : {};
  const next = { ...previous, ...patch };
  for (const field of resetFields) delete (next as Record<string, unknown>)[field];
  if (Object.keys(next).length) raw.review = next;
  else delete raw.review;
  atomicJson(project.configPath, raw);
}

function updateReviewSettings(scope: "project" | "global" | "project-model", patch: ReviewPreferencePatch | ReviewModelOverride, resetFields: string[]): void {
  if (scope === "project") {
    updateProjectReview(reviewPreferencePatchSchema.parse(patch), resetFields);
    return;
  }
  const file = readGlobalSettings();
  if (scope === "project-model") {
    const projectPath = currentProject()?.configPath;
    if (!projectPath) throw new Error("project_context_required");
    const current = file.projects[projectPath] || {};
    const next = { ...current, ...zModelOverride().parse(patch) };
    for (const field of resetFields) delete (next as Record<string, unknown>)[field];
    if (Object.keys(next).length) file.projects[projectPath] = next;
    else delete file.projects[projectPath];
  } else {
    const parsed = reviewGlobalPatchSchema.parse(patch);
    file.defaults = { ...file.defaults, ...parsed };
    for (const field of resetFields) delete (file.defaults as Record<string, unknown>)[field];
  }
  atomicJson(reviewSettingsPath(), file);
}

function sessionIndex(workspaceId: string): StoredReviewIndex {
  const value = readReviewState<StoredReviewIndex>(indexKey(workspaceId));
  return value && Array.isArray(value.sessionIds) ? value : { sessionIds: [], activeSessionId: null };
}

function readSession(workspaceId: string, id?: string): ReviewSession | null {
  const index = sessionIndex(workspaceId);
  const sessionId = id || index.activeSessionId || index.sessionIds.at(-1);
  if (!sessionId) return null;
  const raw = readReviewState<unknown>(sessionKey(workspaceId, sessionId));
  const parsed = reviewSessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function readReviewSession(workspaceId: string, id?: string): ReviewSession | null {
  return readSession(workspaceId, id);
}

export type ReviewWorkspaceState = {
  sessionCount: number;
  activeSessionId: string | null;
};

function reviewSessionIdsForWorkspace(workspaceId: string): Set<string> {
  const ids = new Set<string>();
  const index = sessionIndex(workspaceId);
  for (const id of index.sessionIds) if (typeof id === "string" && id) ids.add(id);
  const project = currentProject();
  if (!project) return ids;
  try {
    for (const entry of readdirSync(join(project.stateRoot, "reviews"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const parsed = reviewSessionSchema.safeParse(JSON.parse(readFileSync(join(project.stateRoot, "reviews", entry.name), "utf8")));
        if (parsed.success && parsed.data.workspaceId === workspaceId) ids.add(parsed.data.id);
      } catch {
        // Ignore unrelated or partially written review records.
      }
    }
  } catch {
    // The state directory may not exist for a workspace without Review history.
  }
  return ids;
}

export function getReviewWorkspaceState(workspaceId: string): ReviewWorkspaceState {
  const index = sessionIndex(workspaceId);
  const ids = reviewSessionIdsForWorkspace(workspaceId);
  return {
    sessionCount: ids.size,
    activeSessionId: typeof index.activeSessionId === "string" && ids.has(index.activeSessionId) ? index.activeSessionId : null,
  };
}

export function clearReviewWorkspaceState(workspaceId: string): { sessionsRemoved: number; indexRemoved: boolean; authRecordsRemoved: number; runtimeRecordsRemoved: number } {
  const ids = reviewSessionIdsForWorkspace(workspaceId);
  let sessionsRemoved = 0;
  let authRecordsRemoved = 0;
  let runtimeRecordsRemoved = 0;
  for (const id of ids) {
    let session: ReviewSession | null = null;
    try {
      const parsed = reviewSessionSchema.safeParse(readReviewState<unknown>(sessionKey(workspaceId, id)));
      if (parsed.success) session = parsed.data;
    } catch { /* cleanup remains best effort for malformed records */ }
    if (session?.executionAgentId) {
      if (removeReviewState(reportKey(session.executionAgentId))) runtimeRecordsRemoved += 1;
      if (session.executionTurnId && removeReviewState(turnKey(session.executionAgentId, session.executionTurnId))) runtimeRecordsRemoved += 1;
    }
    if (session?.reviewerAgentId && session.reviewerTurnId && removeReviewState(turnKey(session.reviewerAgentId, session.reviewerTurnId))) runtimeRecordsRemoved += 1;
    if (removeReviewState(sessionKey(workspaceId, id))) sessionsRemoved += 1;
    if (removeReviewState(authKey(id))) authRecordsRemoved += 1;
  }
  const indexRemoved = removeReviewState(indexKey(workspaceId));
  return { sessionsRemoved, indexRemoved, authRecordsRemoved, runtimeRecordsRemoved };
}

/** Used by the local integration harness; the token is never returned by a UI RPC. */
export function reviewAuthToken(sessionId: string): string | null {
  return readReviewState<ReviewAuth>(authKey(sessionId))?.token || null;
}

function persistSession(session: ReviewSession, event?: { kind: ReviewEvent["kind"]; summary: string; messageKey?: string; messageArgs?: Record<string, string | number | boolean>; details?: Record<string, unknown> }): ReviewSession {
  const stored = readReviewState<unknown>(sessionKey(session.workspaceId, session.id));
  const parsedStored = reviewSessionSchema.safeParse(stored);
  if (parsedStored.success && parsedStored.data.revision !== session.revision) throw new Error("review_state_conflict");
  const nextEvent: ReviewEvent | null = event ? {
    id: randomUUID(),
    sequence: session.events.length,
    createdAt: now(),
    kind: event.kind,
    messageKey: event.messageKey || `review.event.${event.kind}`,
    ...(event.messageArgs ? { messageArgs: event.messageArgs } : {}),
    summary: event.summary,
    details: {
      ...(event.details || {}),
      round: session.round,
    },
  } : null;
  const next = reviewSessionSchema.parse({
    ...session,
    revision: session.revision + 1,
    events: nextEvent ? [...session.events, nextEvent] : session.events,
    updatedAt: now(),
  });
  writeReviewState(sessionKey(next.workspaceId, next.id), next);
  const index = sessionIndex(next.workspaceId);
  const sessionIds = index.sessionIds.includes(next.id) ? index.sessionIds : [...index.sessionIds, next.id];
  const active = ["approved", "blocked", "failed", "stopped", "limit_reached"].includes(next.status) ? index.activeSessionId === next.id ? null : index.activeSessionId : next.id;
  writeReviewState(indexKey(next.workspaceId), { sessionIds, activeSessionId: active });
  return next;
}

function newSession(input: { workspaceId: string; projectConfig: string; executionAgentId: string | null; preferences: ReviewPreferences; status?: ReviewSession["status"]; handoff?: ReviewSession["handoff"] }): ReviewSession {
  const handoff = input.handoff === undefined ? boundHandoff(input.workspaceId) : input.handoff;
  return reviewSessionSchema.parse({
    version: 2,
    id: randomUUID(),
    revision: 0,
    workspaceId: input.workspaceId,
    projectConfig: input.projectConfig,
    paseoWorkspaceId: null,
    handoffHash: handoff ? digest(handoff) : null,
    handoff,
    executionAgentId: input.executionAgentId,
    executionModelId: null,
    executionTurnId: null,
    reviewerAgentId: null,
    reviewerModelId: null,
    reviewerTurnId: null,
    status: input.status || "waiting_execution",
    round: 0,
    maxRounds: input.preferences.maxRounds,
    snapshotId: null,
    diffId: null,
    snapshot: null,
    preferences: input.preferences,
    events: [],
    pendingReviewerResult: null,
    latestResult: null,
    stopAgentIds: [],
    pendingOperation: null,
    lastError: null,
    updatedAt: now(),
  });
}

const activeReviewStatuses = ["waiting_execution", "ready_for_review", "queued", "reviewing", "changes_requested", "fixing", "stopping"] as const;

/** Create the durable review record at handoff time, before the child edits. */
export function recordExecutionHandoff(input: { workspaceId: string; projectConfig: string; executionAgentId: string; handoff: Handoff }): ReviewSession {
  const handoff = handoffSnapshot(input.handoff);
  const existing = readSession(input.workspaceId);
  const sameTask = existing
    && existing.executionAgentId === input.executionAgentId
    && digest(existing.handoff) === digest(handoff);
  if (sameTask) return existing;
  if (existing && existing.preferences.mode !== "off" && activeReviewStatuses.includes(existing.status as (typeof activeReviewStatuses)[number])) {
    throw new Error("review_active_different_task");
  }
  const session = newSession({
    workspaceId: input.workspaceId,
    projectConfig: input.projectConfig,
    executionAgentId: input.executionAgentId,
    preferences: {
      ...preferenceLayers().effective,
      ...(handoff.reviewLocale ? { locale: handoff.reviewLocale } : {}),
    },
    status: "waiting_execution",
    handoff,
  });
  return persistSession({ ...session, handoffHash: digest(input.handoff) }, {
    kind: "started",
    summary: "Execution handoff recorded",
    details: { executionAgentId: input.executionAgentId, goal: input.handoff?.goal || "", handoffId: input.handoff?.handoffId || null },
  });
}

function currentRuntimeFromResponse(value: unknown): Runtime {
  if (!value || typeof value !== "object") throw new Error("workspace_runtime_invalid");
  const candidate = value as Record<string, unknown>;
  if (candidate.managed !== true || typeof candidate.treePath !== "string" || !Array.isArray(candidate.repositories)) throw new Error("workspace_not_managed");
  const repositories: RuntimeRepository[] = [];
  for (const raw of candidate.repositories) {
    if (!raw || typeof raw !== "object") throw new Error("workspace_runtime_invalid");
    const item = raw as Record<string, unknown>;
    const required = ["id", "repoPath", "worktreePath", "indexDigest", "worktreeDigest", "statusDigest"];
    if (required.some((key) => typeof item[key] !== "string")) throw new Error("workspace_runtime_identity_incomplete");
    repositories.push({
      id: String(item.id), repoPath: String(item.repoPath), worktreePath: canonicalPath(String(item.worktreePath)),
      branch: typeof item.branch === "string" ? item.branch : null,
      baseRef: typeof item.baseRef === "string" ? item.baseRef : null,
      baseSha: typeof item.baseSha === "string" ? item.baseSha : null,
      head: typeof item.head === "string" ? item.head : null,
      indexDigest: String(item.indexDigest), worktreeDigest: String(item.worktreeDigest),
      statusDigest: String(item.statusDigest), dirtyPaths: Array.isArray(item.dirtyPaths) ? item.dirtyPaths.filter((path): path is string => typeof path === "string") : [],
    });
  }
  const workspaceId = String(candidate.workspaceId || "");
  if (!workspaceId) throw new Error("workspace_runtime_identity_incomplete");
  return { workspaceId, managed: true, treePath: canonicalPath(String(candidate.treePath)), repositories };
}

function canonicalPath(value: string): string {
  try { return realpathSync(value); }
  catch { return resolve(value); }
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right) && canonicalPath(left!) === canonicalPath(right!);
}

/**
 * A managed Workspace is a container for one or more repository worktrees.
 * Agents created by the normal handoff path use the container as cwd, while
 * an explicitly bound agent may use one of the registered repository
 * worktrees. Both are valid only when they are exact, registered paths.
 */
function runtimeAgentCwdMatches(runtime: Runtime, cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  return [runtime.treePath, ...runtime.repositories.map((repository) => repository.worktreePath)]
    .some((candidate) => samePath(cwd, candidate));
}

function pathWithin(root: string, child: string): boolean {
  const base = canonicalPath(root);
  const target = canonicalPath(child);
  const relativePath = relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.startsWith("\\"));
}

function reviewerContextMatches(session: ReviewSession, auth: ReviewAuth | null, input: { token: string; workspaceId: string; reviewerAgentId: string }): boolean {
  if (!auth || auth.token !== input.token || auth.workspaceId !== input.workspaceId) return false;
  if (input.reviewerAgentId === "pending") {
    // The MCP process starts with a pending id because the host assigns the
    // real Agent id during create. Once the id is known, the same token may
    // continue to use the pending environment value.
    return auth.reviewerAgentId === session.reviewerAgentId
      || (auth.reviewerAgentId === "pending" && session.reviewerAgentId === null);
  }
  return auth.reviewerAgentId === input.reviewerAgentId && session.reviewerAgentId === input.reviewerAgentId;
}

async function currentRuntime(workspaceId: string, context: AgentContext): Promise<Runtime> {
  const response = await (context.query || queryObserver)({ method: "workspace.runtime", params: { workspaceId } });
  if (!response.ok) throw new Error(response.error?.code || "workspace_runtime_unavailable");
  const runtime = currentRuntimeFromResponse(response.result);
  if (runtime.workspaceId !== workspaceId) throw new Error("workspace_runtime_identity_changed");
  return runtime;
}

async function authorizeReviewCaller(token: string | undefined, context: AgentContext): Promise<void> {
  if (!token) return;
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const identity = readState<{ agentId?: string; cwd?: string; revoked?: boolean }>(`context:${token}`);
  if (!identity || identity.revoked || !identity.agentId) throw new Error("review_caller_context_invalid");
  const callerCwd = identity.cwd;
  if (!callerCwd || ![project.sourceRoot, project.workspaceRoot].some((root) => pathWithin(root, callerCwd))) throw new Error("review_caller_project_mismatch");
  const snapshot = await context.paseo.agents.ref(identity.agentId).refresh();
  if (!snapshot?.agent || snapshot.agent.archivedAt || (identity.cwd && !samePath(snapshot.agent.cwd, identity.cwd))) throw new Error("review_caller_context_changed");
}

function runtimeIdentity(runtime: Runtime): string {
  return digest({
    workspaceId: runtime.workspaceId,
    treePath: runtime.treePath,
    repositories: runtime.repositories.map((repo) => ({
      id: repo.id, repoPath: repo.repoPath, worktreePath: repo.worktreePath, branch: repo.branch,
      baseRef: repo.baseRef, baseSha: repo.baseSha, head: repo.head, indexDigest: repo.indexDigest,
      worktreeDigest: repo.worktreeDigest, statusDigest: repo.statusDigest, dirtyPaths: [...repo.dirtyPaths].sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function safeRelativePath(root: string, value: string): string | null {
  if (!value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\0")) return null;
  const normalizedValue = value.replaceAll("\\", "/");
  if (normalizedValue.split("/").includes("..")) return null;
  const target = resolve(root, normalizedValue);
  const rel = relative(resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith(".git/") || rel === ".git") return null;
  return rel.split("\\").join("/");
}

function pathHasSymlink(root: string, value: string): boolean {
  let current = resolve(root);
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // The final path may have been deleted between status and capture. The
      // caller will report that as unreadable rather than following anything.
      return false;
    }
  }
  return false;
}

async function gitOutput(root: string, args: string[], maxBuffer = 768 * 1024): Promise<string | null> {
  try {
    const safeArgs = args[0] === "diff" && !args.includes("--no-ext-diff") ? ["diff", "--no-ext-diff", ...args.slice(1)] : args;
    const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-C", root, ...safeArgs], { timeout: 10_000, maxBuffer, encoding: "utf8" }) as { stdout?: string };
    return String(result.stdout || "");
  } catch {
    return null;
  }
}

function diffNames(value: string): Array<{ status: string; path: string; oldPath?: string }> {
  const parts = value.split("\0");
  const result: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const tab = item.indexOf("\t");
    const status = (tab >= 0 ? item.slice(0, tab) : item).trim();
    let path = tab >= 0 ? item.slice(tab + 1) : parts[++index] || "";
    let oldPath: string | undefined;
    if (/^[RC]/.test(status)) {
      oldPath = path;
      path = parts[++index] || "";
    }
    if (path) result.push({ status: status.slice(0, 1) || "M", path, ...(oldPath ? { oldPath } : {}) });
  }
  return result;
}

function workingNames(value: string): Array<{ status: string; path: string; oldPath?: string }> {
  const parts = value.split("\0");
  const result: Array<{ status: string; path: string; oldPath?: string }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const status = item.slice(0, 2).trim() || "M";
    let path = item.slice(3);
    let oldPath: string | undefined;
    if ((status[0] === "R" || status[0] === "C") && parts[index + 1]) {
      oldPath = path;
      path = parts[++index];
    }
    if (path) result.push({ status, path, ...(oldPath ? { oldPath } : {}) });
  }
  return result;
}

async function fileMaterial(root: string, path: string): Promise<{ content?: string; binary: boolean; truncated: boolean; issue?: string }> {
  const safe = safeRelativePath(root, path);
  if (!safe) return { binary: false, truncated: false, issue: "path_outside_worktree" };
  if (pathHasSymlink(root, safe)) return { binary: false, truncated: false, issue: "symlink_not_followed" };
  const absolute = resolve(root, safe);
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return { binary: false, truncated: false, issue: "symlink_not_followed" };
    if (!stat.isFile()) return { binary: false, truncated: false, issue: "non_regular_file" };
    if (stat.size > 512 * 1024) return { binary: false, truncated: true, issue: "file_too_large" };
    const data = readFileSync(absolute);
    const binary = data.includes(0);
    if (binary) return { binary: true, truncated: false };
    return { content: data.toString("utf8"), binary: false, truncated: false };
  } catch {
    return { binary: false, truncated: false, issue: "file_unreadable" };
  }
}

async function captureSnapshot(workspaceId: string, before: Runtime, context: AgentContext): Promise<ReviewSnapshot> {
  const files = new Map<string, { repositoryId: string; path: string; oldPath?: string; status: string; binary: boolean; truncated: boolean; diff?: string; content?: string }>();
  const unreviewed: string[] = [];
  for (const repo of before.repositories) {
    const names = new Map<string, { status: string; oldPath?: string }>();
    const committed = repo.baseSha && repo.head ? await gitOutput(repo.worktreePath, ["diff", "--name-status", "-z", "--find-renames", repo.baseSha, repo.head]) : "";
    if (committed === null) unreviewed.push(`${repo.id}: committed change list unavailable`);
    for (const entry of diffNames(committed || "")) names.set(entry.path, entry);
    const status = await gitOutput(repo.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    if (status === null) {
      unreviewed.push(`${repo.id}: Git status unavailable`);
    } else {
      for (const entry of workingNames(status)) names.set(entry.path, entry);
    }
    for (const [path, entry] of names) {
      const safe = safeRelativePath(repo.worktreePath, path);
      if (!safe) {
        unreviewed.push(`${repo.id}:${path}: path outside worktree`);
        continue;
      }
      const safeOldPath = entry.oldPath ? safeRelativePath(repo.worktreePath, entry.oldPath) : undefined;
      if (entry.oldPath && !safeOldPath) unreviewed.push(`${repo.id}:${entry.oldPath}: old path is outside worktree`);
      const parts: string[] = [];
      if (repo.baseSha && repo.head) {
        const committedDiff = await gitOutput(repo.worktreePath, ["diff", "--binary", "--find-renames", repo.baseSha, repo.head, "--", safe]);
        if (committedDiff === null) unreviewed.push(`${repo.id}:${safe}: committed diff unavailable`);
        else if (committedDiff) parts.push(committedDiff);
      }
      const workingDiff = repo.head ? await gitOutput(repo.worktreePath, ["diff", "--binary", "HEAD", "--", safe]) : "";
      if (workingDiff === null) unreviewed.push(`${repo.id}:${safe}: working diff unavailable`);
      else if (workingDiff) parts.push(workingDiff);
      const material = await fileMaterial(repo.worktreePath, safe);
      // A deleted file or an unreadable working-tree copy can still be fully
      // reviewed when Git supplied a complete patch. Binary and truncated
      // material remain explicitly unreviewed as required by the protocol.
      if (material.binary) unreviewed.push(`${repo.id}:${safe}: binary content is not included`);
      else if (material.truncated) unreviewed.push(`${repo.id}:${safe}: file exceeds the review size limit`);
      else if (material.issue && (!parts.length || ["file_too_large", "symlink_not_followed", "non_regular_file", "path_outside_worktree"].includes(material.issue))) unreviewed.push(`${repo.id}:${safe}: ${material.issue}`);
      const key = `${repo.id}:${safe}`;
      files.set(key, {
        repositoryId: repo.id, path: safe, ...(safeOldPath ? { oldPath: safeOldPath } : {}), status: entry.status,
        binary: material.binary, truncated: material.truncated, ...(parts.length ? { diff: parts.join("\n") } : {}),
        ...(material.content !== undefined ? { content: material.content } : {}),
      });
      if (material.binary || material.truncated || material.issue) continue;
      if (!parts.length && material.content === undefined) unreviewed.push(`${repo.id}:${safe}: no readable material`);
    }
  }
  const repositories = before.repositories.map((repo) => ({ ...repo, dirtyPaths: [...repo.dirtyPaths].sort() })).sort((left, right) => left.id.localeCompare(right.id));
  const fileList = [...files.values()].sort((left, right) => `${left.repositoryId}:${left.path}`.localeCompare(`${right.repositoryId}:${right.path}`));
  const snapshotId = digest({ workspaceId, repositories });
  const diffId = digest({ snapshotId, files: fileList, unreviewed: [...unreviewed].sort() });
  const snapshot = reviewSnapshotSchema.parse({ workspaceId, treePath: before.treePath, snapshotId, diffId, capturedAt: now(), repositories, files: fileList, unreviewed });
  const after = await currentRuntime(workspaceId, context);
  if (runtimeIdentity(before) !== runtimeIdentity(after)) throw new Error("workspace_changed_during_snapshot");
  return snapshot;
}

function reviewerModelId(value: string): string {
  return value.startsWith("codex/") ? value.slice("codex/".length) : value;
}

async function availableCodexModels(context: AgentContext, cwd: string): Promise<Array<{ id: string; label: string; selectable: boolean; isDefault: boolean }>> {
  const response = await context.paseo.providers.listModels("codex", { cwd, requestId: randomUUID() });
  return (response.models || []).map((model) => ({ id: model.id, label: model.label || model.id, selectable: model.isSelectable !== false, isDefault: model.isDefault === true }));
}

async function resolveReviewerModel(session: ReviewSession, runtime: Runtime, context: AgentContext): Promise<{ model: string; models: Array<{ id: string; label: string; selectable: boolean; isDefault: boolean }> }> {
  const models = await availableCodexModels(context, runtime.treePath!);
  const explicit = session.preferences.reviewerModel;
  const execution = session.executionAgentId ? await context.paseo.agents.ref(session.executionAgentId).refresh() : null;
  const executionModel = execution?.agent?.runtimeInfo?.model || execution?.agent?.model || null;
  const requested = explicit ? reviewerModelId(explicit) : executionModel ? reviewerModelId(executionModel) : models.find((model) => model.isDefault && model.selectable)?.id;
  if (!requested) throw new Error("reviewer_model_unavailable");
  const found = models.find((model) => model.id === requested && model.selectable);
  if (!found) throw new Error(`reviewer_model_unavailable:${requested}`);
  return { model: found.id, models };
}

function bridgeEndpoint(configPath: string): { endpoint: string; script: string } {
  const config = projectConfigRaw();
  const bridge = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent) ? (config.agent as Record<string, unknown>).bridge : null;
  if (!bridge || typeof bridge !== "object" || Array.isArray(bridge)) throw new Error("reviewer_bridge_unavailable");
  const script = (bridge as Record<string, unknown>).script;
  const configured = (bridge as Record<string, unknown>).endpoint;
  if (typeof script !== "string" || !script.trim() || typeof configured !== "string" || !configured.trim()) throw new Error("reviewer_bridge_unavailable");
  let target = configured;
  if (configured === "auto") {
    const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
    try {
      const record = JSON.parse(readFileSync(join(home, "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
      target = record.listen || record.sockPath || "";
    } catch {
      throw new Error("reviewer_bridge_endpoint_unavailable");
    }
  }
  target = target.replace(/^unix:\/\//, "");
  const endpoint = target.startsWith("/") ? `ws+unix://${target}:/ws` : /^(127\.0\.0\.1|localhost):\d+$/.test(target) ? `ws://${target}/ws` : "";
  if (!endpoint) throw new Error("reviewer_bridge_endpoint_unavailable");
  return { endpoint, script: resolve(dirname(configPath), script) };
}

const reviewerOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "checks", "unreviewed", "snapshotId", "diffId"],
  properties: {
    verdict: { type: "string", enum: ["approved", "changes_requested", "blocked"] },
    summary: { type: "string", minLength: 1 },
    findings: { type: "array", items: { type: "object", required: ["id", "severity", "repositoryId", "path", "message", "needsFix"], additionalProperties: false, properties: { id: { type: "string" }, severity: { enum: ["info", "warning", "error"] }, repositoryId: { type: "string" }, path: { type: "string" }, line: { type: "integer", minimum: 1 }, side: { enum: ["old", "new"] }, message: { type: "string" }, suggestion: { type: "string" }, needsFix: { type: "boolean" } } } },
    checks: { type: "array", items: { type: "object", required: ["name", "status"], additionalProperties: false, properties: { name: { type: "string" }, status: { enum: ["passed", "failed", "not_run", "unavailable"] }, evidence: { type: "string" } } } },
    unreviewed: { type: "array", items: { type: "string" } },
    snapshotId: { type: "string" },
    diffId: { type: "string" },
    resultId: { type: "string" },
  },
};

function reviewMcpEnvironment(session: ReviewSession, reviewerAgentId: string, token: string, bridge: { endpoint: string; script: string }): Record<string, string> {
  return {
    WORKBENCH_PROJECT_CONFIG: session.projectConfig,
    WORKBENCH_PASEO_ENDPOINT: bridge.endpoint,
    WORKBENCH_REVIEW_TOKEN: token,
    WORKBENCH_REVIEW_SESSION: session.id,
    WORKBENCH_REVIEW_WORKSPACE: session.workspaceId,
    WORKBENCH_REVIEW_AGENT: reviewerAgentId,
    WORKBENCH_REVIEW_ONLY: "1",
  };
}

function reviewerLanguageParts(session: ReviewSession): { localized: ReturnType<typeof getWorkbenchCopy>; role: string; instructions: string } {
  const localized = getWorkbenchCopy(session.preferences.locale as ReviewLocale);
  const role = session.preferences.reviewerRole === "Code reviewer" || session.preferences.reviewerRole === "代码审核者"
    ? localized.reviewDefaultRole
    : session.preferences.reviewerRole;
  const instructions = session.preferences.instructions === "Check requirement fit, correctness, regressions and tests; keep the implementation simple."
    || session.preferences.instructions === "检查需求是否满足、实现是否正确、是否引入回归、测试是否充分；保持实现简单。"
    ? localized.reviewDefaultInstructions
    : session.preferences.instructions;
  return { localized, role, instructions };
}

function reviewerPrompt(session: ReviewSession): string {
  const { localized, role, instructions } = reviewerLanguageParts(session);
  const previousReview = session.events.filter((event) => event.kind === "review_result").at(-1);
  const previousCompletion = session.events.filter((event) => event.kind === "ready_for_review").at(-1);
  return [
    formatCopyFrom(localized, "reviewPromptIntro", [session.id, session.round]),
    localized.reviewPromptRead,
    formatCopyFrom(localized, "reviewPromptIdentity", [session.snapshotId, session.diffId]),
    formatCopyFrom(localized, "reviewPromptOriginal", [JSON.stringify(session.handoff || {})]),
    formatCopyFrom(localized, "reviewPromptPrevious", [JSON.stringify({ review: previousReview?.details || null, completion: previousCompletion?.details || null }).slice(0, 6000)]),
    localized.reviewPromptReturn,
    localized.reviewPromptLanguage,
    `${localized.reviewSettingsRole}: ${role}.`,
    `${localized.reviewSettingsInstructions}: ${instructions}`,
  ].join(" ");
}

async function findExistingReviewer(session: ReviewSession, context: AgentContext): Promise<PaseoAgent | null> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const result = await context.paseo.agents.list({ filter: { labels: { "workspace-workbench.role": "reviewer", "workspace-workbench.review-session": session.id, "workspace-workbench.review-round": String(session.round), "workspace-workbench.project": digest(project.configPath) } }, page: { limit: 50 } });
  const entries = result.entries.map((entry) => entry.agent);
  if (entries.length > 1) throw new Error("reviewer_candidates_ambiguous");
  return entries[0] || null;
}

async function ensureReviewer(session: ReviewSession, runtime: Runtime, context: AgentContext): Promise<ReviewSession> {
  if (session.reviewerAgentId && session.preferences.reviewerSession === "reuse") {
    const handle = context.paseo.agents.ref(session.reviewerAgentId);
    const existing = await handle.refresh();
    if (existing?.agent && !existing.agent.archivedAt && runtimeAgentCwdMatches(runtime, existing.agent.cwd) && (!session.paseoWorkspaceId || existing.agent.workspaceId === session.paseoWorkspaceId)) {
      const identified = existing.agent.runtimeInfo?.model || existing.agent.model ? { ...session, reviewerModelId: existing.agent.runtimeInfo?.model || existing.agent.model || null } : session;
      if (identified.reviewerModelId !== session.reviewerModelId) persistSession(identified);
      // Reuse means reuse the Reviewer conversation, not skip the next round.
      // A repair produces a new snapshot, so the same Reviewer must receive a
      // new authenticated prompt before it can read and judge that snapshot.
      if (session.pendingOperation?.kind === "send_reviewer") {
        const recovered = persistSession({ ...identified, status: "reviewing", pendingOperation: null, reviewerTurnId: existing.agent.activeTurn?.turnId || null, lastError: null }, { kind: "review_started", summary: `Review round ${session.round} restored after an uncertain Reviewer handoff`, details: { reviewerAgentId: session.reviewerAgentId, snapshotId: session.snapshotId, diffId: session.diffId, recovered: true } });
        monitorReviewer(handle, recovered, context);
        return recovered;
      }
      if (session.status === "reviewing") return identified;
      if (existing.agent.activeTurn) throw new Error("reviewer_busy");
      const auth = readReviewState<ReviewAuth>(authKey(session.id));
      if (!auth || auth.reviewerAgentId !== session.reviewerAgentId) throw new Error("reviewer_auth_unrecoverable");
      const requestId = digest({ sessionId: session.id, round: session.round, snapshotId: session.snapshotId, diffId: session.diffId });
      const queued = persistSession({ ...identified, status: "queued", pendingOperation: { kind: "send_reviewer", requestId, createdAt: now() } }, { kind: "review_queued", summary: `Review round ${session.round} queued`, details: { reviewerAgentId: session.reviewerAgentId } });
      try {
        await handle.send(reviewerPrompt(queued), { messageId: requestId });
      } catch (error) {
        return persistSession({ ...queued, status: "failed", pendingOperation: null, lastError: errorInfo(error, "Reviewer handoff failed") }, { kind: "failed", summary: "Reviewer handoff could not be sent", details: errorInfo(error) });
      }
      const refreshed = await handle.refresh();
      const next = persistSession({ ...queued, status: "reviewing", pendingOperation: null, reviewerTurnId: refreshed?.agent?.activeTurn?.turnId || null, lastError: null }, { kind: "review_started", summary: `Review round ${queued.round} started`, details: { reviewerAgentId: queued.reviewerAgentId, snapshotId: queued.snapshotId, diffId: queued.diffId, sessionMode: "reuse" } });
      monitorReviewer(handle, next, context);
      return next;
    }
    throw new Error("reviewer_identity_changed");
  }
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const model = await resolveReviewerModel(session, runtime, context);
  const { localized, role, instructions } = reviewerLanguageParts(session);
  const bridge = bridgeEndpoint(project.configPath);
  const recovered = await findExistingReviewer(session, context);
  const previousAuth = readReviewState<ReviewAuth>(authKey(session.id));
  const recoveringCreation = session.pendingOperation?.kind === "create_reviewer";
  const token = recoveringCreation && previousAuth?.reviewerAgentId === "pending" ? previousAuth.token : randomUUID();
  if (recovered) {
    if (!runtimeAgentCwdMatches(runtime, recovered.cwd) || recovered.runtimeInfo?.provider !== "codex" || recovered.runtimeInfo?.model !== model.model) throw new Error("reviewer_identity_changed");
    if (!previousAuth || (previousAuth.reviewerAgentId !== recovered.id && previousAuth.reviewerAgentId !== "pending")) throw new Error("reviewer_auth_unrecoverable");
    writeReviewState(authKey(session.id), { ...previousAuth, reviewerAgentId: recovered.id });
    const handle = context.paseo.agents.ref(recovered.id);
    const refreshed = await handle.refresh();
    const next = persistSession({ ...session, paseoWorkspaceId: recovered.workspaceId || session.paseoWorkspaceId, reviewerAgentId: recovered.id, reviewerModelId: model.model, reviewerTurnId: refreshed?.agent?.activeTurn?.turnId || null, status: "reviewing", pendingOperation: null, lastError: null }, { kind: "review_started", summary: `Review round ${session.round} restored`, details: { reviewerAgentId: recovered.id, model: model.model, recovered: true, snapshotId: session.snapshotId, diffId: session.diffId } });
    monitorReviewer(handle, next, context);
    return next;
  }
  if (session.pendingOperation?.kind === "create_reviewer" && !session.reviewerAgentId) throw new Error("reviewer_recovery_required");
  const requestId = digest({ sessionId: session.id, round: session.round, model: model.model });
  const pending = { kind: "create_reviewer" as const, requestId, createdAt: now() };
  const creating = persistSession({ ...session, reviewerModelId: model.model, pendingOperation: pending }, { kind: "review_queued", summary: "Reviewer is being created", details: { model: model.model } });
  // A reviewer is created in the managed Workspace, with a read-only Codex
  // provider sandbox and only the two review MCP tools preapproved. The
  // normal Workbench bridge explicitly ignores WORKBENCH_REVIEW_ONLY agents.
  let workspace;
  let handle: PaseoAgentHandle;
  writeReviewState(authKey(session.id), { token, workspaceId: session.workspaceId, reviewerAgentId: "pending" });
  try {
    workspace = await context.paseo.workspaces.open(runtime.treePath!);
    handle = await workspace.agents.create({
      title: `${role} · ${session.workspaceId}`,
      env: reviewMcpEnvironment(session, "pending", token, bridge),
      config: {
        provider: `codex/${model.model}`,
        modeId: "auto",
        options: { sandbox_mode: "read-only", approval_policy: "never" },
        toolPolicy: { preapproved: [
          { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_read" },
          { kind: "mcp", server: "workbench-review", tool: "workbench_reviewer_result" },
        ] },
        mcpServers: { "workbench-review": { type: "stdio", command: process.execPath, args: [bridge.script], env: reviewMcpEnvironment(session, "pending", token, bridge), alwaysLoad: true } },
      systemPrompt: [
        formatCopyFrom(localized, "reviewSystemRole", [role]),
        localized.reviewSystemReadOnly,
        localized.reviewSystemNeverWrite,
        `${localized.reviewSettingsInstructions}: ${instructions}`,
        localized.reviewPromptLanguage,
      ].join(" "),
      },
      prompt: reviewerPrompt(session),
      clientMessageId: requestId,
      outputSchema: reviewerOutputSchema,
      labels: {
        "workspace-workbench.role": "reviewer",
        "workspace-workbench.review-session": session.id,
        "workspace-workbench.review-round": String(session.round),
        "workspace-workbench.workspace-id": session.workspaceId,
        "workspace-workbench.project": digest(project.configPath),
        "workspace-workbench.relationship": "independent",
        "workspace-workbench.read-only": "true",
        "workspace-workbench.model": model.model,
      },
    });
  } catch (error) {
    return persistSession({ ...creating, status: "failed", pendingOperation: null, lastError: errorInfo(error, "Reviewer could not be created") }, { kind: "failed", summary: "Reviewer could not be created", details: errorInfo(error) });
  }
  // The MCP environment is created before the Agent id exists. The token is
  // still bound to the session; the server accepts only the actual returned
  // id. A reviewer that cannot be refreshed is never considered active.
  let refreshed;
  try { refreshed = await handle.refresh(); }
  catch (error) { return persistSession({ ...creating, status: "failed", pendingOperation: null, lastError: errorInfo(error, "Reviewer identity could not be verified") }, { kind: "failed", summary: "Reviewer identity could not be verified", details: errorInfo(error) }); }
  if (!refreshed?.agent || !runtimeAgentCwdMatches(runtime, refreshed.agent.cwd) || (refreshed.agent.runtimeInfo?.provider && refreshed.agent.runtimeInfo.provider !== "codex") || (refreshed.agent.runtimeInfo?.model && refreshed.agent.runtimeInfo.model !== model.model)) return persistSession({ ...creating, status: "failed", pendingOperation: null, lastError: { code: "reviewer_identity_unverified", message: "Reviewer identity could not be verified" } }, { kind: "failed", summary: "Reviewer identity could not be verified", details: {} });
  writeReviewState(authKey(session.id), { token, workspaceId: session.workspaceId, reviewerAgentId: handle.id } satisfies ReviewAuth);
  const next = persistSession({ ...creating, paseoWorkspaceId: workspace!.id, reviewerAgentId: handle.id, reviewerTurnId: refreshed.agent.activeTurn?.turnId || null, pendingOperation: null, status: "reviewing", lastError: null }, { kind: "reviewer_created", summary: "Read-only Reviewer created", details: { agentId: handle.id, model: model.model, sandbox: "read-only", tools: ["workbench_reviewer_read", "workbench_reviewer_result"] } });
  const active = persistSession(next, { kind: "review_started", summary: `Review round ${next.round} started`, details: { reviewerAgentId: handle.id, model: model.model, snapshotId: next.snapshotId, diffId: next.diffId } });
  monitorReviewer(handle, active, context);
  return active;
}

function monitorReviewer(handle: PaseoAgentHandle, session: ReviewSession, context: AgentContext): void {
  const monitorKey = `${session.id}:${session.round}:${handle.id}`;
  if (reviewerMonitors.has(monitorKey)) return;
  reviewerMonitors.add(monitorKey);
  void handle.waitForFinish(session.preferences.reviewerTimeoutMs).then(async (result) => {
    const latest = readSession(session.workspaceId, session.id);
    if (!latest || latest.status !== "reviewing" || latest.reviewerAgentId !== handle.id) return;
    if (result.status !== "idle") {
      const code = result.status === "timeout"
        ? "reviewer_timeout"
        : result.status === "permission"
          ? "reviewer_permission_required"
          : "reviewer_turn_failed";
      let cancellation: { code: string; message: string } | null = null;
      if (result.status === "timeout") {
        try { await cancelAgentIfSupported(context, handle.id); }
        catch (error) { cancellation = errorInfo(error, "Timed-out Reviewer could not be cancelled"); }
      }
      const details = { status: result.status, error: result.error || null, ...(cancellation ? { cancellation } : {}) };
      persistSession({ ...latest, status: result.status === "permission" ? "blocked" : "failed", lastError: { code, message: result.error || code } }, { kind: result.status === "permission" ? "blocked" : "failed", summary: result.status === "permission" ? "Reviewer is waiting for permission" : "Reviewer did not finish", details });
      return;
    }
    // The dedicated MCP result is authoritative. A JSON-looking final chat
    // message is not a review result and must not bypass the Reviewer tool
    // boundary or its snapshot validation.
    const parsed = reviewResultSchema.safeParse(parseStructuredResult(result.lastMessage || ""));
    const candidate = latest.pendingReviewerResult;
    if (candidate) {
      const recorded = await recordReviewerResult({ sessionId: latest.id, workspaceId: latest.workspaceId, reviewerAgentId: handle.id, token: readReviewState<ReviewAuth>(authKey(latest.id))?.token || "", result: candidate, finalize: true }, context).catch((error) => ({ ok: false, accepted: false, session: null, error: errorInfo(error) }));
      if (!recorded.accepted) {
        const current = readSession(latest.workspaceId, latest.id);
        if (current?.status === "reviewing") persistSession({ ...current, status: "failed", lastError: recorded.error || { code: "reviewer_result_rejected", message: "Reviewer result was rejected" } }, { kind: "failed", summary: "Reviewer result was rejected", details: recorded.error || {} });
      }
      return;
    }
    const diagnostic = parsed.success ? "" : parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    persistSession({ ...latest, status: "failed", lastError: { code: "reviewer_invalid_result", message: "Reviewer finished without a valid structured result" } }, { kind: "failed", summary: "Reviewer returned an invalid result", details: { diagnostic } });
  }).catch((error) => {
    const latest = readSession(session.workspaceId, session.id);
    if (latest && latest.status === "reviewing") persistSession({ ...latest, status: "failed", lastError: errorInfo(error, "Reviewer turn failed") }, { kind: "failed", summary: "Reviewer turn failed", details: errorInfo(error) });
  }).finally(() => { reviewerMonitors.delete(monitorKey); });
}

async function recoverReviewerMonitor(session: ReviewSession, context: AgentContext): Promise<void> {
  if (session.status !== "reviewing" || !session.reviewerAgentId) return;
  try {
    const runtime = await currentRuntime(session.workspaceId, context);
    const refreshed = await context.paseo.agents.ref(session.reviewerAgentId).refresh();
    if (!refreshed?.agent || refreshed.agent.archivedAt || !runtimeAgentCwdMatches(runtime, refreshed.agent.cwd) || (session.paseoWorkspaceId && refreshed.agent.workspaceId !== session.paseoWorkspaceId)) {
      persistSession({ ...session, status: "failed", lastError: { code: "reviewer_identity_changed", message: "Reviewer identity could not be restored after reconnect" } }, { kind: "failed", summary: "Reviewer could not be restored", details: {} });
      return;
    }
    monitorReviewer(context.paseo.agents.ref(session.reviewerAgentId), session, context);
  } catch {
    // Keep the persisted state visible while the host is reconnecting. The
    // next query retries recovery instead of inventing a terminal result.
  }
}

function parseStructuredResult(text: string): unknown {
  const value = text.trim();
  if (!value) return null;
  try { return JSON.parse(value); } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(value.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

async function startReviewer(session: ReviewSession, context: AgentContext): Promise<ReviewSession> {
  if (!session.snapshot || !session.snapshotId || !session.diffId) throw new Error("review_snapshot_unavailable");
  if (session.status === "stopped" || session.status === "failed") throw new Error("review_session_not_resumable");
  const runtime = await currentRuntime(session.workspaceId, context);
  const current = readSession(session.workspaceId, session.id);
  if (!current || current.revision !== session.revision || ["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(current.status)) throw new Error("review_state_conflict");
  session = current;
  const snapshot = session.snapshot;
  if (!snapshot || runtimeIdentity(runtime) !== runtimeIdentityFromSnapshot(snapshot)) throw new Error("review_snapshot_stale");
  return ensureReviewer(session, runtime, context);
}

async function createOrUpdateReadySession(input: { workspaceId: string; projectConfig: string; executionAgentId: string; executionTurnId: string | null; report: ExecutionReportRecord["report"] }, context: AgentContext): Promise<ReviewSession> {
  const layers = preferenceLayers();
  const existing = readSession(input.workspaceId);
  if (existing && ["approved", "blocked", "failed", "stopped", "limit_reached", "stopping"].includes(existing.status)) return existing;
  if (existing && !["waiting_execution", "fixing"].includes(existing.status)) return existing;
  let session = existing;
  if (!session) session = persistSession(newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId: input.executionAgentId, preferences: layers.effective }), { kind: "started", summary: "Execution handoff recorded", details: { executionAgentId: input.executionAgentId } });
  if (session.executionAgentId !== input.executionAgentId) throw new Error("execution_agent_mismatch");
  const runtime = await currentRuntime(input.workspaceId, context);
  const snapshot = await captureSnapshot(input.workspaceId, runtime, context);
  const current = readSession(input.workspaceId, session.id);
  if (!current || current.revision !== session.revision || ["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(current.status)) throw new Error("review_state_conflict");
  session = current;
  if (session.snapshotId && session.round > 0 && session.snapshotId === snapshot.snapshotId && session.diffId === snapshot.diffId && session.status === "fixing") {
    return persistSession({ ...session, status: "blocked", lastError: { code: "repair_no_progress", message: "修复后代码快照没有变化" } }, { kind: "blocked", summary: "Repair produced no new code snapshot", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } });
  }
  session = persistSession({ ...session, executionTurnId: input.executionTurnId }, { kind: "execution_turn_ended", summary: "Execution turn completed", details: { turnId: input.executionTurnId, executionAgentId: input.executionAgentId } });
  session = { ...session, status: "ready_for_review", executionTurnId: input.executionTurnId, round: Math.max(1, session.round + (session.status === "fixing" ? 1 : 0)), snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, snapshot, latestResult: null, pendingOperation: null, lastError: null };
  session = persistSession(session, { kind: "ready_for_review", summary: input.report.summary, details: { executionAgentId: input.executionAgentId, turnId: input.executionTurnId, changes: input.report.changes, tests: input.report.tests, knownLimitations: input.report.knownLimitations, snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } });
  if (session.preferences.mode === "automatic") return startReviewer(session, context);
  return session;
}

export async function handleExecutionTurnEnded(event: { agent: { id: string }; turnId: string | null; outcome: { kind: string } }, context: AgentContext): Promise<void> {
  if (!event.turnId) return;
  writeReviewState(turnKey(event.agent.id, event.turnId), { outcome: event.outcome.kind, endedAt: now() });
  const pending = readReviewState<ExecutionReportRecord>(reportKey(event.agent.id));
  if (!pending || pending.consumedAt || pending.turnId !== event.turnId) return;
  await withReviewTransitionLock(pending.workspaceId, async () => {
    const currentPending = readReviewState<ExecutionReportRecord>(reportKey(event.agent.id));
    if (!currentPending || currentPending.consumedAt || currentPending.turnId !== event.turnId) return;
    if (event.outcome.kind !== "completed") {
      const session = readSession(currentPending.workspaceId);
      if (session && ["waiting_execution", "ready_for_review", "queued", "fixing"].includes(session.status)) persistSession({ ...session, status: "failed", lastError: { code: "execution_turn_failed", message: `Execution turn ended with ${event.outcome.kind}` } }, { kind: "failed", summary: "Execution turn did not complete", details: { turnId: event.turnId, outcome: event.outcome.kind } });
      writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: now() });
      return;
    }
    if (currentPending.report.status !== "ready_for_review") {
      writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: now() });
      return;
    }
    try {
      await createOrUpdateReadySession({ ...currentPending, projectConfig: currentProject()?.configPath || "", executionTurnId: currentPending.turnId }, context);
      writeReviewState(reportKey(event.agent.id), { ...currentPending, consumedAt: now() });
    } catch (error) {
      const session = readSession(currentPending.workspaceId);
      if (session && !["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(session.status)) persistSession({ ...session, status: "failed", lastError: errorInfo(error, "Review could not be started") }, { kind: "failed", summary: "Review could not be started", details: errorInfo(error) });
    }
  });
}

function validateExecutionToken(input: { token: string; executionAgentId: string; workspaceId: string }): string {
  const identity = readState<{ agentId?: string; cwd?: string; revoked?: boolean; workspaceId?: string }>(`context:${input.token}`);
  if (!identity || identity.revoked || (identity.agentId && identity.agentId !== input.executionAgentId && input.executionAgentId !== "pending") || (identity.workspaceId && identity.workspaceId !== input.workspaceId)) throw new Error("execution_context_invalid");
  const agentId = identity.agentId && identity.agentId !== "pending" ? identity.agentId : input.executionAgentId;
  if (!agentId || agentId === "pending") throw new Error("execution_context_unbound");
  return agentId;
}

export async function acceptExecutionReport(input: { projectConfig: string; workspaceId: string; executionAgentId: string; token: string; turnId?: string; report: ExecutionReportRecord["report"] }, context: AgentContext): Promise<{ ok: boolean; session: ReviewSession | null; accepted: boolean; error?: { code: string; message: string } }> {
  const executionAgentId = validateExecutionToken(input);
  const agent = await context.paseo.agents.ref(executionAgentId).refresh();
  if (!agent?.agent || agent.agent.cwd === null) throw new Error("execution_agent_unavailable");
  const runtime = await currentRuntime(input.workspaceId, context);
  if (!runtimeAgentCwdMatches(runtime, agent.agent.cwd)) throw new Error("execution_agent_identity_changed");
  if (input.turnId && agent.agent.activeTurn?.turnId && input.turnId !== agent.agent.activeTurn.turnId) throw new Error("execution_turn_mismatch");
  const turnId = input.turnId || agent.agent.activeTurn?.turnId || null;
  const record: ExecutionReportRecord = { workspaceId: input.workspaceId, executionAgentId, turnId, report: input.report, createdAt: now() };
  const existing = readSession(input.workspaceId);
  if (existing?.handoff?.handoffId && input.report.handoffId && existing.handoff.handoffId !== input.report.handoffId) throw new Error("execution_handoff_mismatch");
  if (existing && ["approved", "blocked", "failed", "stopped", "limit_reached", "stopping"].includes(existing.status)) return { ok: true, session: existing, accepted: false, error: { code: "execution_report_late", message: "This execution report arrived after the review flow ended" } };
  if (existing && !["waiting_execution", "fixing"].includes(existing.status)) return { ok: true, session: existing, accepted: false, error: { code: "execution_report_unexpected", message: "This execution report does not belong to the current review phase" } };
  const previousReport = readReviewState<ExecutionReportRecord>(reportKey(executionAgentId));
  if (previousReport?.consumedAt && previousReport.turnId === turnId && digest(previousReport.report) === digest(input.report)) return { ok: true, session: existing, accepted: true };
  if (previousReport && !previousReport.consumedAt) {
    if (previousReport.turnId !== turnId) throw new Error("execution_report_in_progress");
    if (digest(previousReport.report) === digest(input.report)) return { ok: true, session: existing, accepted: true };
    throw new Error("execution_report_conflict");
  }
  writeReviewState(reportKey(executionAgentId), record);
  if (input.report.status !== "ready_for_review") {
    const layers = preferenceLayers();
    const session = existing || persistSession(newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences: layers.effective }), { kind: "started", summary: "Execution report received", details: {} });
    const blocked = input.report.status === "needs_input";
    const failed = persistSession({ ...session, status: blocked ? "blocked" : "failed", lastError: { code: blocked ? "execution_needs_input" : "execution_failed", message: input.report.summary } }, { kind: blocked ? "blocked" : "failed", summary: input.report.summary, details: { report: input.report } });
    writeReviewState(reportKey(executionAgentId), { ...record, consumedAt: now() });
    return { ok: true, session: failed, accepted: true };
  }
  const waiting = existing || persistSession(newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences: preferenceLayers().effective }), { kind: "started", summary: "Execution report received", details: { executionAgentId } });
  const candidate = persistSession({ ...waiting, executionAgentId, executionTurnId: turnId }, { kind: "ready_for_review", summary: "Ready-for-review report received; waiting for turn completion", details: { turnId, report: input.report } });
  return { ok: true, session: candidate, accepted: true };
}

async function sendRepair(session: ReviewSession, context: AgentContext): Promise<ReviewSession> {
  if (!session.executionAgentId || !session.latestResult) throw new Error("execution_agent_unavailable");
  if (session.status !== "changes_requested") throw new Error("review_not_waiting_for_repair");
  if (!session.snapshotId || !session.diffId) throw new Error("review_snapshot_unavailable");
  const runtime = await currentRuntime(session.workspaceId, context);
  if (runtimeIdentity(runtime) !== runtimeIdentityFromSnapshot(session.snapshot!)) throw new Error("review_snapshot_stale");
  const agent = context.paseo.agents.ref(session.executionAgentId);
  const refreshed = await agent.refresh();
  if (!refreshed?.agent || refreshed.agent.activeTurn) throw new Error("execution_agent_busy");
  const current = readSession(session.workspaceId, session.id);
  if (!current || current.revision !== session.revision || current.status !== "changes_requested") throw new Error("review_state_conflict");
  const findings = session.latestResult.findings.filter((finding) => finding.needsFix);
  if (!findings.length) throw new Error("review_repair_findings_missing");
  const messageId = digest({ sessionId: session.id, round: session.round, snapshotId: session.snapshotId, diffId: session.diffId, findingIds: findings.map((finding) => finding.id) });
  const pending = persistSession({ ...session, status: "fixing", pendingOperation: { kind: "send_repair", requestId: messageId, messageId, createdAt: now() } }, { kind: "repair_requested", summary: "Repair requested from the execution Agent", details: { findingIds: findings.map((finding) => finding.id), snapshotId: session.snapshotId, diffId: session.diffId } });
  const prompt = [
    "Workspace Workbench repair handoff",
    `Review session: ${session.id}`,
    `Round: ${session.round}`,
    `Snapshot: ${session.snapshotId}`,
    `Diff: ${session.diffId}`,
    "Repair only the following required findings in the bound Workspace worktree:",
    ...findings.map((finding) => `- ${finding.id} [${finding.repositoryId}:${finding.path}${finding.line ? `:${finding.line}` : ""}]: ${finding.message}${finding.suggestion ? ` Suggestion: ${finding.suggestion}` : ""}`),
    "Keep the original requirement and scope. After the turn finishes, submit workbench_execution_report with ready_for_review and include tests and limitations.",
  ].join("\n");
  try {
    await agent.send(prompt, { messageId });
  } catch (error) {
    return persistSession({ ...pending, status: "failed", lastError: errorInfo(error, "Repair handoff failed") }, { kind: "failed", summary: "Repair handoff could not be sent", details: errorInfo(error) });
  }
  return persistSession({ ...pending, pendingOperation: null }, { kind: "repair_sent", summary: "Repair handoff sent to the same execution Agent", details: { agentId: session.executionAgentId, messageId, findingIds: findings.map((finding) => finding.id) } });
}

function runtimeIdentityFromSnapshot(snapshot: ReviewSnapshot): string {
  return digest({
    workspaceId: snapshot.workspaceId,
    treePath: snapshot.treePath,
    repositories: snapshot.repositories.map((repo) => ({ ...repo, baseRef: repo.baseRef || null })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

async function cancelAgentIfSupported(context: AgentContext, agentId: string): Promise<void> {
  const candidate = context.paseo as PaseoApi & { cancelAgent?: (id: string) => Promise<void> };
  if (typeof candidate.cancelAgent === "function") {
    await candidate.cancelAgent(agentId);
    return;
  }
  const project = currentProject();
  if (!project) throw new Error("cancel_unavailable");
  const bridge = bridgeEndpoint(project.configPath);
  const client = new DaemonClient({
    url: bridge.endpoint,
    clientId: `workspace-workbench-review-cancel-${randomUUID()}`,
    clientType: "mcp",
    reconnect: { enabled: false },
    webSocketFactory: nativeWebSocketFactory,
  });
  try {
    await client.connect();
    await client.cancelAgent(agentId);
  } catch {
    throw new Error("cancel_unavailable");
  } finally { await client.close(); }
}

export async function stopReview(session: ReviewSession, context: AgentContext): Promise<ReviewSession> {
  if (["approved", "blocked", "failed", "stopped", "limit_reached"].includes(session.status)) return session;
  const ids = session.status === "stopping" ? session.stopAgentIds : [
    session.reviewerAgentId,
    session.status === "fixing" ? session.executionAgentId : null,
  ].filter((id): id is string => Boolean(id));
  const stopping = session.status === "stopping"
    ? session
    : persistSession({ ...session, status: "stopping", stopAgentIds: ids, pendingOperation: { kind: "cancel", requestId: randomUUID(), createdAt: now() } }, { kind: "stopped", summary: "Stop requested", details: { agentIds: ids } });
  // An execution Agent is normally idle while a Reviewer is running. Do not
  // cancel that Agent unless this session is actually in its repair phase;
  // the same Agent may be carrying another user-visible turn.
  let cancelError: { code: string; message: string } | null = null;
  for (const id of ids) {
    try { await cancelAgentIfSupported(context, id); } catch (error) { cancelError = errorInfo(error, "Host cannot cancel the Agent turn"); break; }
  }
  if (cancelError) return persistSession({ ...stopping, status: "stopping", pendingOperation: stopping.pendingOperation, lastError: cancelError }, { kind: "failed", summary: "Stopping; host cancellation is not confirmed", details: { cancel: cancelError, agentIds: ids } });
  return persistSession({ ...stopping, status: "stopped", stopAgentIds: [], pendingOperation: null, lastError: null }, { kind: "stopped", summary: "Review stopped", details: {} });
}

async function startReviewInternal(input: { workspaceId: string; projectConfig: string; executionAgentId?: string; locale?: ReviewLocale }, context: AgentContext): Promise<ReviewSession> {
  const existing = readSession(input.workspaceId);
  const interruptedReviewerOperation = existing?.status === "queued" && (existing.pendingOperation?.kind === "create_reviewer" || existing.pendingOperation?.kind === "send_reviewer");
  if (existing && !interruptedReviewerOperation && existing.status === "ready_for_review") return startReviewer(existing, context);
  if (existing && !interruptedReviewerOperation && ["reviewing", "queued", "fixing", "changes_requested", "stopping"].includes(existing.status)) return existing;
  if (interruptedReviewerOperation) {
    try { return await startReviewer(existing, context); }
    catch (error) {
      const failed = persistSession({ ...existing, status: "failed", pendingOperation: null, lastError: errorInfo(error, "Reviewer creation needs recovery") }, { kind: "failed", summary: "Reviewer creation needs recovery", details: errorInfo(error) });
      void failed;
      throw error;
    }
  }
  const layers = preferenceLayers();
  if (layers.effective.mode === "off") throw new Error("review_disabled");
  const preferences = {
    ...layers.effective,
    ...(input.locale ? { locale: input.locale } : {}),
  };
  const runtime = await currentRuntime(input.workspaceId, context);
  const executionAgentId = input.executionAgentId || existing?.executionAgentId || null;
  if (!executionAgentId) throw new Error("execution_agent_required");
  const execution = await context.paseo.agents.ref(executionAgentId).refresh();
  if (!execution?.agent || execution.agent.archivedAt || !runtimeAgentCwdMatches(runtime, execution.agent.cwd) || (execution.agent.runtimeInfo?.provider && execution.agent.runtimeInfo.provider !== "codex")) {
    throw new Error("execution_agent_identity_changed");
  }
  if (execution.agent.activeTurn) throw new Error("execution_agent_busy");
  const executionModelId = execution.agent.runtimeInfo?.model || execution.agent.model || null;
  const snapshot = await captureSnapshot(input.workspaceId, runtime, context);
  const reusable = existing && !["approved", "blocked", "failed", "stopped", "limit_reached"].includes(existing.status) ? existing : null;
  let session = reusable || newSession({ workspaceId: input.workspaceId, projectConfig: input.projectConfig, executionAgentId, preferences, status: "queued" });
  session = { ...session, executionAgentId, executionModelId, preferences: existing?.preferences || preferences, status: "queued", round: Math.max(1, existing?.round || 1), snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, snapshot, lastError: null, pendingOperation: null };
  session = persistSession(session, reusable ? { kind: "review_queued", summary: "Review queued by user", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId } } : { kind: "started", summary: "Review started from the Workspace", details: { snapshotId: snapshot.snapshotId, diffId: snapshot.diffId, executionAgentId } });
  return startReviewer(session, context);
}

export function startReview(input: { workspaceId: string; projectConfig: string; executionAgentId?: string; locale?: ReviewLocale }, context: AgentContext): Promise<ReviewSession> {
  const key = `${currentProject()?.configPath || input.projectConfig}:${input.workspaceId}`;
  const active = reviewStartFlights.get(key);
  if (active) return active;
  const flight = withReviewTransitionLock(input.workspaceId, () => startReviewInternal(input, context)).finally(() => reviewStartFlights.delete(key));
  reviewStartFlights.set(key, flight);
  return flight;
}

async function recordReviewerResultInternal(input: { workspaceId: string; sessionId: string; reviewerAgentId: string; token: string; result: unknown; finalize?: boolean }, context: AgentContext): Promise<{ ok: boolean; session: ReviewSession | null; accepted: boolean; error?: { code: string; message: string } }> {
  const session = readSession(input.workspaceId, input.sessionId);
  if (!session) throw new Error("review_session_not_found");
  const auth = readReviewState<ReviewAuth>(authKey(session.id));
  if (!reviewerContextMatches(session, auth, { token: input.token, workspaceId: input.workspaceId, reviewerAgentId: input.reviewerAgentId })) throw new Error("reviewer_context_invalid");
  if (session.status !== "reviewing") return { ok: true, session, accepted: false, error: { code: "review_not_active", message: "This Reviewer result arrived after the review stopped or completed" } };
  const parsed = reviewResultSchema.safeParse(input.result);
  if (!parsed.success) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } };
  const result = parsed.data;
  if (!session.snapshot) throw new Error("review_snapshot_unavailable");
  const runtime = await currentRuntime(session.workspaceId, context);
  const current = readSession(session.workspaceId, session.id);
  if (!current || current.revision !== session.revision) {
    if (current && current.status !== "reviewing") return { ok: true, session: current, accepted: false, error: { code: "review_not_active", message: "This Reviewer result arrived after the review stopped or completed" } };
    return { ok: false, session: current, accepted: false, error: { code: "review_state_conflict", message: "The review state changed while the result was being checked" } };
  }
  if (runtimeIdentity(runtime) !== runtimeIdentityFromSnapshot(session.snapshot)) {
    const expired = persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The Workspace changed before the Reviewer result was accepted" } }, { kind: "expired", summary: "Reviewer result is stale", details: {} });
    return { ok: false, session: expired, accepted: false, error: { code: "review_snapshot_stale", message: "The reviewed code changed" } };
  }
  if (result.snapshotId !== session.snapshotId || result.diffId !== session.diffId) {
    const expired = persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The reviewed code changed before the result was accepted" } }, { kind: "expired", summary: "Reviewer result is stale", details: { expectedSnapshotId: session.snapshotId, receivedSnapshotId: result.snapshotId, expectedDiffId: session.diffId, receivedDiffId: result.diffId } });
    return { ok: false, session: expired, accepted: false, error: { code: "review_snapshot_stale", message: "The reviewed code changed" } };
  }
  if (result.verdict === "changes_requested" && !result.findings.some((finding) => finding.needsFix)) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "changes_requested requires at least one finding that needs a fix" } };
  if (result.verdict === "approved" && result.findings.some((finding) => finding.needsFix)) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot contain a required finding" } };
  if (result.verdict === "approved" && result.unreviewed.length) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot leave review material unreviewed" } };
  if (result.verdict === "approved" && result.checks.some((check) => check.status === "failed")) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "approved cannot contain a failed check" } };
  const repositoryIds = new Set(session.snapshot?.repositories.map((repository) => repository.id) || []);
  const reviewedFiles = new Set(session.snapshot?.files.map((file) => `${file.repositoryId}:${file.path}`) || []);
  if (result.findings.some((finding) => !repositoryIds.has(finding.repositoryId) || !safeRelativePath(session.snapshot?.repositories.find((repository) => repository.id === finding.repositoryId)?.worktreePath || "", finding.path) || !reviewedFiles.has(`${finding.repositoryId}:${finding.path}`))) return { ok: false, session, accepted: false, error: { code: "reviewer_invalid_result", message: "finding points outside the reviewed snapshot" } };
  const resultKey = result.resultId || digest(result);
  if (session.latestResult && (session.latestResult.resultId || digest(session.latestResult)) === resultKey) return { ok: true, session, accepted: true };
  if (session.pendingReviewerResult) {
    const pendingKey = session.pendingReviewerResult.resultId || digest(session.pendingReviewerResult);
    if (pendingKey !== resultKey) return { ok: false, session, accepted: false, error: { code: "reviewer_result_conflict", message: "A different Reviewer result is already pending for this turn" } };
    if (!input.finalize) return { ok: true, session, accepted: true };
  }
  if (!input.finalize) {
    const candidate = persistSession({ ...session, pendingReviewerResult: result, lastError: null }, { kind: "review_candidate", summary: "Reviewer submitted a candidate result; waiting for turn completion", details: { verdict: result.verdict, resultId: result.resultId || resultKey, snapshotId: result.snapshotId, diffId: result.diffId } });
    return { ok: true, session: candidate, accepted: true };
  }
  let nextStatus: ReviewSession["status"] = result.verdict === "approved" ? "approved" : result.verdict === "blocked" ? "blocked" : session.round >= session.maxRounds ? "limit_reached" : "changes_requested";
  let next = persistSession({ ...session, status: nextStatus, pendingReviewerResult: null, latestResult: result, pendingOperation: null, lastError: null }, { kind: "review_result", summary: result.summary, details: { verdict: result.verdict, findings: result.findings, checks: result.checks, unreviewed: result.unreviewed, snapshotId: result.snapshotId, diffId: result.diffId, formal: true } });
  if (["approved", "blocked", "limit_reached"].includes(nextStatus)) {
    next = persistSession(next, {
      kind: "finished",
      summary: nextStatus === "approved" ? "Review approved for this code version" : nextStatus === "limit_reached" ? "Review stopped at the round limit" : "Review cannot continue automatically",
      details: { status: nextStatus, snapshotId: next.snapshotId, diffId: next.diffId },
    });
  }
  if (result.verdict === "changes_requested" && nextStatus === "changes_requested" && session.preferences.autoFix) next = await sendRepair(next, context);
  return { ok: true, session: next, accepted: true };
}

export function recordReviewerResult(input: { workspaceId: string; sessionId: string; reviewerAgentId: string; token: string; result: unknown; finalize?: boolean }, context: AgentContext): Promise<{ ok: boolean; session: ReviewSession | null; accepted: boolean; error?: { code: string; message: string } }> {
  return withReviewTransitionLock(input.workspaceId, () => recordReviewerResultInternal(input, context));
}

export async function readReviewerSnapshot(input: { workspaceId: string; sessionId: string; reviewerAgentId: string; token: string }, context: AgentContext): Promise<{ ok: boolean; snapshot: ReviewSnapshot | null; error?: { code: string; message: string } }> {
  const session = readSession(input.workspaceId, input.sessionId);
  const auth = session ? readReviewState<ReviewAuth>(authKey(session.id)) : null;
  if (!session || !reviewerContextMatches(session, auth, { token: input.token, workspaceId: input.workspaceId, reviewerAgentId: input.reviewerAgentId })) throw new Error("reviewer_context_invalid");
  if (!session.snapshot) throw new Error("review_snapshot_unavailable");
  const runtime = await currentRuntime(session.workspaceId, context);
  if (runtimeIdentity(runtime) !== runtimeIdentityFromSnapshot(session.snapshot)) {
    const expired = persistSession({ ...session, status: "blocked", lastError: { code: "review_snapshot_stale", message: "The Workspace changed while the Reviewer was reading" } }, { kind: "expired", summary: "Review snapshot expired", details: {} });
    return { ok: false, snapshot: null, error: { code: expired.lastError!.code, message: expired.lastError!.message } };
  }
  return { ok: true, snapshot: session.snapshot };
}

export async function handleReviewTurnEnded(event: { agent: { id: string }; turnId: string | null; outcome: { kind: string } }, context: AgentContext): Promise<void> {
  if (!event.turnId) return;
  // Reviewer results normally arrive through the dedicated MCP result tool.
  // A completed turn without that tool is handled by monitorReviewer and never
  // becomes an approval merely because it ended.
  await handleExecutionTurnEnded(event, context);
}

export function getReviewSettings(): ReturnType<typeof preferenceLayers> {
  return preferenceLayers();
}

export function configuredExecutionModel(): string | null {
  try {
    return preferenceLayers().effective.executionModel;
  } catch (error) {
    if (error instanceof Error && error.message === "project_context_required") return null;
    throw error;
  }
}

export async function handleReviewSessionQuery(input: { projectConfig: string; workspaceId: string; sessionId?: string; token?: string }, context?: AgentContext): Promise<ReturnType<typeof reviewSessionQuery.output.parse>> {
  const layers = preferenceLayers();
  if (context) await authorizeReviewCaller(input.token, context);
  const session = readSession(input.workspaceId, input.sessionId);
  if (session && context) void recoverReviewerMonitor(session, context);
  // A running flow is immutable with respect to its settings. Return its
  // snapshot here so reconnecting clients do not show current preferences as
  // if they had governed an already-started review.
  return { ok: true, session, preferences: session?.preferences || layers.effective, sources: layers.sources };
}

export async function handleReviewSessionList(input: { projectConfig: string; workspaceId: string }): Promise<ReturnType<typeof reviewSessionList.output.parse>> {
  const index = sessionIndex(input.workspaceId);
  const sessions = index.sessionIds.map((id) => readSession(input.workspaceId, id)).filter((session): session is ReviewSession => Boolean(session)).map((session) => ({ ...session, snapshot: null }));
  return { ok: true, sessions, activeSessionId: index.activeSessionId };
}

export async function handleReviewSessionEvents(input: { projectConfig: string; workspaceId: string; sessionId: string; after: number; limit: number }): Promise<ReturnType<typeof reviewSessionEvents.output.parse>> {
  const session = readSession(input.workspaceId, input.sessionId);
  if (!session) return { ok: false, events: [], next: null, error: { code: "review_session_not_found", message: "Review session not found" } };
  const events = session.events.filter((event) => event.sequence > input.after).slice(0, input.limit);
  return { ok: true, events, next: events.length ? events[events.length - 1].sequence : null };
}

export async function handleReviewSettingsGet(input: { projectConfig: string }): Promise<ReturnType<typeof reviewSettingsGet.output.parse>> {
  const layers = preferenceLayers();
  return { ok: true, effective: layers.effective, project: layers.project, global: layers.global, models: layers.models, sources: layers.sources };
}

export async function handleReviewSettingsUpdate(input: { projectConfig: string; scope: "project" | "global" | "project-model"; patch: ReviewPreferencePatch | ReviewModelOverride; resetFields: string[] }): Promise<ReturnType<typeof reviewSettingsUpdate.output.parse>> {
  updateReviewSettings(input.scope, input.patch, input.resetFields);
  return handleReviewSettingsGet(input);
}

export async function handleReviewModels(input: { projectConfig: string; workspaceId?: string }, context: AgentContext): Promise<ReturnType<typeof reviewModels.output.parse>> {
  try {
    const runtime = input.workspaceId ? await currentRuntime(input.workspaceId, context) : null;
    const cwd = runtime?.treePath || currentProject()?.sourceRoot;
    if (!cwd) throw new Error("reviewer_workspace_unavailable");
    return { ok: true, provider: "codex", models: await availableCodexModels(context, cwd) };
  } catch (error) {
    return { ok: false, provider: "codex", models: [], error: errorInfo(error, "Codex models are unavailable") };
  }
}

export async function handleReviewPreview(input: { projectConfig: string; workspaceId: string; token?: string }, context: AgentContext): Promise<ReturnType<typeof reviewPreview.output.parse>> {
  const preferences = preferenceLayers().effective;
  try {
    await authorizeReviewCaller(input.token, context);
    const runtime = await currentRuntime(input.workspaceId, context);
    return {
      ok: true,
      session: readSession(input.workspaceId),
      workspace: {
        workspaceId: runtime.workspaceId,
        treePath: runtime.treePath!,
        repositories: runtime.repositories.map((repo) => ({ id: repo.id, worktreePath: repo.worktreePath, branch: repo.branch, baseSha: repo.baseSha, head: repo.head, dirtyPaths: repo.dirtyPaths })),
      },
      preferences,
    };
  } catch (error) {
    return { ok: false, session: readSession(input.workspaceId), workspace: null, preferences, error: errorInfo(error, "Review preview is unavailable") };
  }
}

export async function handleReviewSessionStart(input: { projectConfig: string; workspaceId: string; executionAgentId?: string; locale?: ReviewLocale; token?: string }, context: AgentContext): Promise<ReturnType<typeof reviewSessionStart.output.parse>> {
  try { await authorizeReviewCaller(input.token, context); return { ok: true, session: await startReview(input, context) }; }
  catch (error) { return { ok: false, session: readSession(input.workspaceId), error: errorInfo(error, "Review could not start") }; }
}

export async function handleReviewSessionControl(input: { projectConfig: string; workspaceId: string; sessionId?: string; action: "stop" | "resume" | "review" | "repair"; token?: string }, context: AgentContext): Promise<ReturnType<typeof reviewSessionControl.output.parse>> {
  await authorizeReviewCaller(input.token, context);
  return withReviewTransitionLock(input.workspaceId, async () => {
    const session = readSession(input.workspaceId, input.sessionId);
    if (!session) throw new Error("review_session_not_found");
    if (input.action === "review" && !["ready_for_review", "queued", "reviewing"].includes(session.status)) {
      return { ok: false, session, error: errorInfo(new Error(session.status === "waiting_execution" ? "execution_not_ready" : "review_not_ready")) };
    }
    if (input.action === "repair" && session.status !== "changes_requested") {
      return { ok: false, session, error: errorInfo(new Error("review_not_waiting_for_repair")) };
    }
    try {
      if (input.action === "stop") return { ok: true, session: await stopReview(session, context) };
      if (input.action === "repair") return { ok: true, session: await sendRepair(session, context) };
      if (input.action === "review") return { ok: true, session: await startReviewer(session, context) };
      if (session.status === "stopped" || session.status === "failed" || session.status === "blocked") {
        const resumed = persistSession({ ...session, status: "queued", lastError: null }, { kind: "resumed", summary: "Review resumed", details: {} });
        return { ok: true, session: await startReviewer(resumed, context) };
      }
      return { ok: true, session };
    } catch (error) {
      const current = readSession(input.workspaceId, session.id) || session;
      if (["stopping", "stopped", "failed", "blocked", "approved", "limit_reached"].includes(current.status)) return { ok: false, session: current, error: errorInfo(error, "Review action failed") };
      const failed = persistSession({ ...current, status: "failed", lastError: errorInfo(error, "Review action failed") }, { kind: "failed", summary: "Review action failed", details: errorInfo(error) });
      return { ok: false, session: failed, error: errorInfo(error) };
    }
  });
}

export async function handleExecutionReportRpc(input: ExecutionReportRpcInput, context: AgentContext): Promise<ReturnType<typeof executionReport.output.parse>> {
  try { return await acceptExecutionReport(input, context); }
  catch (error) { return { ok: false, session: readSession(input.workspaceId), accepted: false, error: errorInfo(error, "Execution report rejected") }; }
}

export async function handleReviewerReadRpc(input: ReviewerReadRpcInput, context: AgentContext): Promise<ReturnType<typeof reviewerRead.output.parse>> {
  try { return await readReviewerSnapshot(input, context); }
  catch (error) { return { ok: false, snapshot: null, error: errorInfo(error, "Reviewer snapshot is unavailable") }; }
}

export async function handleReviewerResultRpc(input: ReviewerResultRpcInput, context: AgentContext): Promise<ReturnType<typeof reviewerResult.output.parse>> {
  try { return await recordReviewerResult(input, context); }
  catch (error) { return { ok: false, session: readSession(input.workspaceId, input.sessionId), accepted: false, error: errorInfo(error, "Reviewer result rejected") }; }
}

function storedReviewSessions(): ReviewSession[] {
  const project = currentProject();
  if (!project) return [];
  try {
    return readdirSync(join(project.stateRoot, "reviews"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .flatMap((entry) => {
        try {
          const parsed = reviewSessionSchema.safeParse(JSON.parse(readFileSync(join(project.stateRoot, "reviews", entry.name), "utf8")));
          return parsed.success ? [parsed.data] : [];
        } catch { return []; }
      });
  } catch { return []; }
}

async function recoverReviewerForAgent(agentId: string, context: AgentContext): Promise<void> {
  for (const session of storedReviewSessions()) {
    if (session.status === "reviewing" && session.reviewerAgentId === agentId) await recoverReviewerMonitor(session, context);
  }
}

export function registerReviewLifecycle(server: PluginServerContext): () => void {
  const cleanup = server.on("agent.turn_ended", async (event, context) => {
    for (const project of registeredProjects()) {
      try {
        await withProject({ projectConfig: project.configPath }, async () => {
          await handleReviewTurnEnded(event, context);
          // A daemon/plugin restart can lose the in-memory monitor. The
          // lifecycle event is enough to reattach it even when no UI tab is
          // open, and a persisted candidate can then be finalized normally.
          await recoverReviewerForAgent(event.agent.id, context);
        });
      } catch (error) {
        console.warn("workspace_workbench_review_lifecycle_failed", errorInfo(error));
      }
    }
  });
  const cleanupStarted = server.on("agent.turn_started", async (event, context) => {
    for (const project of registeredProjects()) {
      try { await withProject({ projectConfig: project.configPath }, () => recoverReviewerForAgent(event.agent.id, context)); }
      catch (error) { console.warn("workspace_workbench_review_recovery_failed", errorInfo(error)); }
    }
  });
  return () => { cleanup(); cleanupStarted(); };
}
