import { OBSERVATION_POLICY } from '../shared/observation-policy.ts';
import { useRef } from "react";

import type { ObserverResponse } from "../shared/observer.ts";
import { DEFAULT_OBSERVATION_TIMING } from "../shared/observation-timing.ts";
import { responseObservationState } from "./model.ts";

const STALE_FAILURE_LIMIT = DEFAULT_OBSERVATION_TIMING.staleFailureLimit;
const STALE_AFTER_MS = DEFAULT_OBSERVATION_TIMING.staleWindowsMs.detail;
export const RECOVERABLE_FAILURE_GRACE_MS = OBSERVATION_POLICY.warningMs;

export type ObservationStatus = "loading" | "fresh" | "refreshing" | "degraded" | "expired" | "unavailable";
export type ObservationResponseClass = "ready" | "refreshing" | "degraded" | "unavailable";

/** Missing content is not an empty result, even during a recoverable failure. */
export function initialContentState(hasContent: boolean, failed: boolean): 'ready' | 'loading' | 'unavailable' {
  return hasContent ? 'ready' : failed ? 'unavailable' : 'loading';
}

export function boundedRefresh<T>(
  request: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    request.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

type SnapshotEntry = {
  response?: ObserverResponse;
  lastResponse?: ObserverResponse;
  lastError?: unknown;
  lastObservedAt: string | null;
  lastSuccessfulAt: string | null;
  failureCount: number;
  firstFailureAt: number | null;
  refreshing: boolean;
  lastErrorCode: string | null;
  cacheAgeMs: number | null;
  cacheUpdatedAt: string | null;
};

type SnapshotOptions = {
  error?: unknown;
  mergePartial?: (previous: ObserverResponse, next: ObserverResponse) => ObserverResponse;
  staleAfterMs?: number;
};

export type ObserverSnapshot = {
  response: ObserverResponse | undefined;
  stale: boolean;
  expired: boolean;
  failed: boolean;
  initialFailure: boolean;
  lastObservedAt: string | null;
  lastValidatedAt: string | null;
  failureCount: number;
  /** Milliseconds since the current failure streak began, or null when healthy. */
  failureAgeMs: number | null;
  lastSuccessfulAt: string | null;
  status: ObservationStatus;
  refreshing: boolean;
  lastErrorCode: string | null;
  cacheAgeMs: number | null;
};

type ObservationMetadata = {
  refreshing: boolean;
  lastErrorCode: string | null;
  cacheAgeMs: number | null;
  cacheUpdatedAt: string | null;
};

function observationMetadata(response: ObserverResponse | undefined): ObservationMetadata {
  if (!response)
    return {
      refreshing: false,
      lastErrorCode: null,
      cacheAgeMs: null,
      cacheUpdatedAt: null,
    };
  if (!response.ok)
    return {
      refreshing: false,
      lastErrorCode: response.error?.code || null,
      cacheAgeMs: null,
      cacheUpdatedAt: null,
    };
  const result = response.result;
  if (!result || typeof result !== "object")
    return {
      refreshing: false,
      lastErrorCode: null,
      cacheAgeMs: null,
      cacheUpdatedAt: null,
    };
  const observation = (result as { observation?: { refreshing?: unknown; cacheState?: unknown; issues?: unknown; cacheAgeMs?: unknown } }).observation;
  const cache = (result as { cache?: { ageMs?: unknown; updatedAt?: unknown } }).cache;
  const issues = (result as { issues?: unknown }).issues;
  const issue = Array.isArray(issues)
    ? issues.find((item) => item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string")
    : Array.isArray(observation?.issues)
      ? observation.issues.find((item) => item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string")
      : undefined;
  return {
    refreshing: observation?.refreshing === true || observation?.cacheState === "refreshing",
    lastErrorCode: issue && typeof issue === "object" ? String((issue as { code?: unknown }).code || "") || null : null,
    cacheAgeMs: typeof cache?.ageMs === "number"
      ? cache.ageMs
      : typeof observation?.cacheAgeMs === "number"
        ? observation.cacheAgeMs
        : null,
    cacheUpdatedAt: typeof cache?.updatedAt === "string" ? cache.updatedAt : null,
  };
}

export function classifyObservationResponse(response: ObserverResponse | undefined): ObservationResponseClass | null {
  if (!response) return null;
  const metadata = observationMetadata(response);
  const state = responseObservationState(response);
  if (metadata.refreshing && state === "ready") return "refreshing";
  return state === "ready" ? "ready" : state === "partial" ? "degraded" : "unavailable";
}

/**
 * Cache revalidation is a transport/cache lifecycle marker, not an
 * observation failure. Keep this status calculation based on the semantic
 * observation state so a stale ready response cannot become degraded merely
 * because the backend is refreshing it in the background.
 */
export function observationStatusFor(
  response: ObserverResponse | undefined,
  failed: boolean,
  expired: boolean,
  failureAgeMs: number | null = null,
): ObservationStatus {
  const recovering = failed && failureAgeMs !== null && failureAgeMs < RECOVERABLE_FAILURE_GRACE_MS;
  if (!response) return failed ? (recovering ? "loading" : "unavailable") : "loading";
  if (expired) return "expired";
  if (recovering) return "refreshing";
  return failed || responseObservationState(response) !== "ready"
    ? "degraded"
    : "fresh";
}

/** Age alone does not prove a failed observation. */
export function persistentObservationFailure(count: number, failureAgeMs: number | null, windowMs: number): boolean {
  return count >= STALE_FAILURE_LIMIT && (failureAgeMs ?? 0) >= windowMs;
}

function observedAt(response: ObserverResponse): string {
  const result = response.result;
  if (result && typeof result === "object") {
    const value = (result as { observedAt?: unknown }).observedAt;
    if (typeof value === "string" && value) return value;
    const nested = (result as { observation?: { observedAt?: unknown; lastObservedAt?: unknown; lastSuccessfulAt?: unknown } }).observation;
    const observed = nested?.observedAt || nested?.lastObservedAt;
    if (typeof observed === "string" && observed) return observed;
    const success = nested?.lastSuccessfulAt;
    if (typeof success === "string" && success) return success;
  }
  return new Date().toISOString();
}

function markFailure(entry: SnapshotEntry): void {
  entry.failureCount += 1;
  if (entry.firstFailureAt === null) entry.firstFailureAt = Date.now();
}

function clearFailures(entry: SnapshotEntry): void {
  entry.failureCount = 0;
  entry.firstFailureAt = null;
  entry.lastErrorCode = null;
}

export function useLastSuccessfulResponse(
  key: string,
  response: ObserverResponse | undefined,
  options: SnapshotOptions = {},
): ObserverSnapshot {
  const cache = useRef(new Map<string, SnapshotEntry>());
  let entry = cache.current.get(key);
  if (!entry) {
    entry = {
      lastObservedAt: null,
      lastSuccessfulAt: null,
      failureCount: 0,
      firstFailureAt: null,
      refreshing: false,
      lastErrorCode: null,
      cacheAgeMs: null,
      cacheUpdatedAt: null,
    };
    cache.current.set(key, entry);
    if (cache.current.size > 32) cache.current.delete(cache.current.keys().next().value!);
  }

  if (response !== entry.lastResponse) {
    entry.lastResponse = response;
    const state = responseObservationState(response);
    const responseClass = classifyObservationResponse(response);
    const metadata = observationMetadata(response);
    entry.refreshing = metadata.refreshing;
    entry.lastErrorCode = metadata.lastErrorCode;
    entry.cacheAgeMs = metadata.cacheAgeMs;
    entry.cacheUpdatedAt = metadata.cacheUpdatedAt;
    if (response && responseClass && responseClass !== "refreshing") entry.lastObservedAt = observedAt(response);
    if (response && responseClass === "ready") {
      entry.response = response;
      entry.lastSuccessfulAt = entry.lastObservedAt;
      clearFailures(entry);
    } else if (response) {
      if (responseClass !== "refreshing") markFailure(entry);
      if (state === "partial" && entry.response && options.mergePartial) {
        entry.response = options.mergePartial(entry.response, response);
      } else if (state === "partial" && response.ok && Array.isArray((response.result as { workspaces?: unknown })?.workspaces)) {
        // Registry identities are authoritative even before Git observations
        // finish. Do not advance the last-success timestamp for this roster.
        type Row = { id: string; observationStale?: boolean; issues?: { code: string }[] };
        const result = response.result as { workspaces: Row[] };
        const previous = new Map(((entry.response?.result as { workspaces?: Row[] })?.workspaces || []).map((row) => [row.id, row]));
        const workspaces = result.workspaces.map((row) => {
          const transient = row.observationStale || row.issues?.some((issue) => ["git_timeout", "observation_timeout", "observer_busy"].includes(issue.code));
          return transient && previous.has(row.id) ? { ...previous.get(row.id)!, observationStale: true } : row;
        });
        entry.response = { ...response, result: { ...result, workspaces } };
      } else if (state === "error" && response.ok) {
        // Structured durable issues (for example worktree_missing) are real
        // observations. Keep that response visible, but do not advance the
        // last-successful timestamp.
        entry.response = response;
      } else if (response.ok && (responseClass !== "refreshing" || !entry.response)) {
        // A first structured non-ready response is still useful content.
        // Retain it so a later transport failure cannot turn the page blank.
        entry.response = response;
      }
    }
  }

  if (options.error !== entry.lastError) {
    const previousError = entry.lastError;
    entry.lastError = options.error;
    if (options.error) {
      entry.refreshing = false;
      entry.lastErrorCode = entry.lastErrorCode || "observer_request_failed";
      markFailure(entry);
    } else if (previousError && responseObservationState(response) === "ready") {
      clearFailures(entry);
    }
  }

  const displayResponse = entry.response || (response?.ok ? response : undefined);
  const failed = entry.failureCount > 0 || Boolean(options.error);
  const failureAgeMs = entry.firstFailureAt === null
    ? null
    : Math.max(0, Date.now() - entry.firstFailureAt);
  const staleAfterMs = Math.max(1_000, options.staleAfterMs || STALE_AFTER_MS);
  const cacheTimestamp = entry.cacheUpdatedAt ? Date.parse(entry.cacheUpdatedAt) : NaN;
  const cacheAgeMs = Number.isFinite(cacheTimestamp)
    ? Math.max(0, Date.now() - cacheTimestamp)
    : entry.cacheAgeMs;
  const persistentFailure = persistentObservationFailure(entry.failureCount, failureAgeMs, staleAfterMs);
  const durableFailure = ["path_invalid", "worktree_missing", "repository_missing", "commit_missing", "base_missing", "workspace_not_found"].includes(entry.lastErrorCode || "");
  const expired = Boolean(displayResponse && persistentFailure);
  const stale = Boolean(displayResponse && (persistentFailure || durableFailure));
  const status = durableFailure
    ? displayResponse ? "degraded" : "unavailable"
    : !persistentFailure && (failed || displayResponse && responseObservationState(displayResponse) !== "ready")
      ? displayResponse ? "refreshing" : "loading"
      : observationStatusFor(displayResponse, failed && persistentFailure, expired, failureAgeMs);

  return {
    response: displayResponse,
    stale,
    expired,
    failed,
    initialFailure: !entry.response && failed,
    lastObservedAt: entry.lastObservedAt,
    lastValidatedAt: (displayResponse?.result as { observation?: { validatedAt?: string } } | undefined)?.observation?.validatedAt || null,
    failureCount: entry.failureCount,
    failureAgeMs,
    lastSuccessfulAt: entry.lastSuccessfulAt,
    status,
    refreshing: entry.refreshing,
    lastErrorCode: entry.lastErrorCode,
    cacheAgeMs,
  };
}
