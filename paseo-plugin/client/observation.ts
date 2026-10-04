import { useRef } from "react";
import { OBSERVATION_POLICY } from '../shared/observation-policy.ts';
import { displayedObservation } from "./observation-content.ts";
import { classifyObservationResponse,observationMetadata } from "./observation-response.ts";

import { DEFAULT_OBSERVATION_TIMING } from "../shared/observation-timing.ts";
import type { ObserverResponse } from "../shared/observer.ts";
import { responseObservationState } from "./model.ts";

const STALE_FAILURE_LIMIT = DEFAULT_OBSERVATION_TIMING.staleFailureLimit;
const STALE_AFTER_MS = DEFAULT_OBSERVATION_TIMING.staleWindowsMs.detail;
export const RECOVERABLE_FAILURE_GRACE_MS = OBSERVATION_POLICY.warningMs;

export type ObservationStatus = "loading" | "fresh" | "refreshing" | "degraded" | "expired" | "unavailable";
export { classifyObservationResponse } from "./observation-response.ts";
export type { ObservationResponseClass } from "./observation-response.ts";

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
  lastResponseId?: number;
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

function observedAt(response: ObserverResponse): string | null {
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
  return null;
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
  const identities = useRef({values:new WeakMap<ObserverResponse,number>(),next:0});
  let responseId = response ? identities.current.values.get(response) : 0;
  if(response && responseId === undefined){responseId=++identities.current.next;identities.current.values.set(response,responseId);}
  let entry = cache.current.get(key);
  if (!entry) {
    const retained=displayedObservation(response);
    const priorSuccess=retained && classifyObservationResponse(retained)==="ready" ? observedAt(retained):null;
    entry = {
      lastObservedAt: priorSuccess,
      lastSuccessfulAt: priorSuccess,
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

  if (responseId !== entry.lastResponseId) {
    entry.lastResponseId = responseId;
    const responseClass = classifyObservationResponse(response);
    const metadata = observationMetadata(response);
    entry.refreshing = metadata.refreshing;
    entry.lastErrorCode = metadata.lastErrorCode;
    entry.cacheAgeMs = metadata.cacheAgeMs;
    entry.cacheUpdatedAt = metadata.cacheUpdatedAt;
    if (response && responseClass && responseClass !== "refreshing") entry.lastObservedAt = observedAt(response);
    if (response && responseClass === "ready") {
      entry.lastSuccessfulAt = entry.lastObservedAt;
      clearFailures(entry);
    } else if (response) {
      if (responseClass !== "refreshing") markFailure(entry);

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

  const displayResponse = displayedObservation(response);
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
    initialFailure: !displayResponse && failed,
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
