import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentProject } from "./projects.ts";
import { readReviewState, writeReviewState } from "./orchestration-state.ts";
import { reviewSessionSchema, type ReviewSession, type ReviewEvent } from "../shared/agent-review.ts";
export const sessionKey = (workspaceId: string, id: string) => `agent-review:session:${workspaceId}:${id}`;
export const indexKey = (workspaceId: string) => `agent-review:index:${workspaceId}`;
type StoredReviewIndex = { sessionIds: string[]; activeSessionId: string | null };
const now = () => new Date().toISOString();
const epoch = randomUUID();
const revisions = new Map<string, number>();
const activeSessions = new Map<string, Map<string, ReviewSession>>();
const isActive = (session: ReviewSession) => ["queued", "reviewing", "stopping"].includes(session.status);
export function activeReviewSessions(): ReviewSession[] {
  const project = currentProject(); if (!project) return [];
  let active = activeSessions.get(project.configPath);
  if (!active) { active = new Map(storedReviewSessions().filter(isActive).map(s => [s.id, s])); activeSessions.set(project.configPath, active); }
  return [...active.values()];
}
export function forgetReviewWorkspace(workspaceId: string) {
  const key = currentProject()?.configPath || '';
  for (const [id, session] of activeSessions.get(key) || []) if (session.workspaceId === workspaceId) activeSessions.get(key)!.delete(id);
  revisions.set(key, (revisions.get(key) || 0) + 1);
}
const listeners = new Set<(session: ReviewSession) => void>();
export function reviewRevision() { return `${epoch}:${revisions.get(currentProject()?.configPath || "") || 0}`; }
export function onReviewChanged(listener: (session: ReviewSession) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function sessionIndex(workspaceId: string): StoredReviewIndex {
  const value = readReviewState<StoredReviewIndex>(indexKey(workspaceId));
  return value && Array.isArray(value.sessionIds) ? value : { sessionIds: [], activeSessionId: null };
}

export function readSession(workspaceId: string, id?: string): ReviewSession | null {
  const index = sessionIndex(workspaceId);
  const sessionId = id || index.activeSessionId || index.sessionIds.at(-1);
  if (!sessionId) return null;
  const raw = readReviewState<unknown>(sessionKey(workspaceId, sessionId));
  const legacy = raw as { preferences?: { reviewerTarget?: string } } | null;
  const parsed = reviewSessionSchema.safeParse(legacy?.preferences && !legacy.preferences.reviewerTarget
    ? { ...legacy, preferences: { ...legacy.preferences, reviewerTarget: "independent" } } : raw);
  return parsed.success ? parsed.data : null;
}

export function readReviewSession(workspaceId: string, id?: string): ReviewSession | null {
  return readSession(workspaceId, id);
}


export function persistSession(session: ReviewSession, event?: { kind: ReviewEvent["kind"]; summary: string; messageKey?: string; messageArgs?: Record<string, string | number | boolean>; details?: Record<string, unknown> }): ReviewSession {
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
  const previous = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
  writeReviewState(sessionKey(next.workspaceId, next.id), { ...previous, ...next,
    preferences: { ...(previous.preferences && typeof previous.preferences === "object" ? previous.preferences : {}), ...next.preferences } });
  const index = sessionIndex(next.workspaceId);
  const sessionIds = index.sessionIds.includes(next.id) ? index.sessionIds : [...index.sessionIds, next.id];
  const active = ["approved", "blocked", "failed", "stopped", "limit_reached"].includes(next.status) ? index.activeSessionId === next.id ? null : index.activeSessionId : next.id;
  writeReviewState(indexKey(next.workspaceId), { sessionIds, activeSessionId: active });
  const key = currentProject()?.configPath || next.projectConfig;
  revisions.set(key, (revisions.get(key) || 0) + 1);
  const activeIndex = activeSessions.get(key);
  if (activeIndex) { if (isActive(next)) activeIndex.set(next.id, next); else activeIndex.delete(next.id); }
  for (const listener of listeners) { try { listener(next); } catch { console.warn("review_observer_failed"); } }
  return next;
}


export function storedReviewSessions(): ReviewSession[] {
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

