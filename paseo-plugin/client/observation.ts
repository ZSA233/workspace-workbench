import { useEffect, useRef } from "react";

import type { ObserverResponse } from "../shared/observer.ts";
import { DEFAULT_OBSERVATION_TIMING } from "../shared/observation-timing.ts";
import { responseObservationState } from "./model.ts";

const STALE_FAILURE_LIMIT = DEFAULT_OBSERVATION_TIMING.staleFailureLimit;
const STALE_AFTER_MS = DEFAULT_OBSERVATION_TIMING.staleWindowsMs.detail;

export type ObservationStatus = "loading" | "fresh" | "refreshing" | "degraded" | "expired" | "unavailable";
export type ObservationResponseClass = "ready" | "refreshing" | "degraded" | "unavailable";

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
  failureCount: number;
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
  if (metadata.refreshing) return "refreshing";
  const state = responseObservationState(response);
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
): ObservationStatus {
  if (!response) return failed ? "unavailable" : "loading";
  if (expired) return "expired";
  return failed || responseObservationState(response) !== "ready"
    ? "degraded"
    : "fresh";
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
      } else if (response.ok) {
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
  const lastSuccessTimestamp = entry.lastSuccessfulAt ? Date.parse(entry.lastSuccessfulAt) : NaN;
  const failureAge = Number.isFinite(lastSuccessTimestamp)
    ? Math.max(0, Date.now() - lastSuccessTimestamp)
    : 0;
  const staleAfterMs = Math.max(1_000, options.staleAfterMs || STALE_AFTER_MS);
  const cacheTimestamp = entry.cacheUpdatedAt ? Date.parse(entry.cacheUpdatedAt) : NaN;
  const cacheAgeMs = Number.isFinite(cacheTimestamp)
    ? Math.max(0, Date.now() - cacheTimestamp)
    : entry.cacheAgeMs;
  const validation = (displayResponse?.result as { observation?: { validatedAt?: string } } | undefined)?.observation?.validatedAt;
  const recentlyValidated = !!validation && Date.now() - Date.parse(validation) < 30_000;
  const expired = Boolean(
    displayResponse &&
      (entry.failureCount >= STALE_FAILURE_LIMIT ||
        (!recentlyValidated && (failureAge >= staleAfterMs ||
        (cacheAgeMs !== null && cacheAgeMs >= staleAfterMs)))),
  );
  const stale = Boolean(displayResponse && (failed || expired));
  const status = observationStatusFor(displayResponse, failed, expired);

  return {
    response: displayResponse,
    stale,
    expired,
    failed,
    initialFailure: !entry.response && failed,
    lastObservedAt: entry.lastObservedAt,
    failureCount: entry.failureCount,
    lastSuccessfulAt: entry.lastSuccessfulAt,
    status,
    refreshing: entry.refreshing,
    lastErrorCode: entry.lastErrorCode,
    cacheAgeMs,
  };
}

/**
 * A stale-while-revalidate response is useful immediately, but a single
 * transport read can race the backend refresh.  Re-read at bounded intervals
 * and let the fresh response stop the cycle naturally; never schedule an
 * unbounded retry loop.
 */
export function useBoundedCacheRefresh(
  key: string,
  response: ObserverResponse | undefined,
  refetch: () => Promise<unknown>,
  delaysMs: readonly number[] = DEFAULT_OBSERVATION_TIMING.followUpDelaysMs,
  enabled = true,
): void {
  const attempted = useRef(new Set<string>());
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const metadata = observationMetadata(response);
  const refreshing = metadata.refreshing;
  const cacheUpdatedAt = metadata.cacheUpdatedAt;
  useEffect(() => {
    if (!enabled || !refreshing) return;
    const token = `${key}:${cacheUpdatedAt || "unknown"}`;
    if (attempted.current.has(token)) return;
    attempted.current.add(token);
    if (attempted.current.size > 64)
      attempted.current.delete(attempted.current.values().next().value!);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveWait: (() => void) | undefined;
    void (async () => {
      for (const delay of delaysMs) {
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          timer = setTimeout(() => { timer = undefined; resolveWait = undefined; resolve(); }, Math.max(0, delay));
        });
        if (cancelled) return;
        const result = await refetchRef.current().catch(() => undefined);
        if (cancelled) return;
        const nextResponse = result && typeof result === "object" && "data" in result
          ? (result as { data?: ObserverResponse }).data
          : undefined;
        if (classifyObservationResponse(nextResponse) === "ready") return;
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      resolveWait?.();
      attempted.current.delete(token);
    };
  }, [cacheUpdatedAt, delaysMs, enabled, key, refreshing]);
}
