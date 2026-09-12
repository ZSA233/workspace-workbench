import { useRef } from "react";

import type { ObserverResponse } from "../shared/observer";
import { responseObservationState } from "./model";

const STALE_FAILURE_LIMIT = 3;
const STALE_AFTER_MS = 60_000;

type SnapshotEntry = {
  response?: ObserverResponse;
  lastResponse?: ObserverResponse;
  lastError?: unknown;
  lastSuccessfulAt: string | null;
  failureCount: number;
  firstFailureAt: number | null;
};

type SnapshotOptions = {
  error?: unknown;
  mergePartial?: (previous: ObserverResponse, next: ObserverResponse) => ObserverResponse;
};

export type ObserverSnapshot = {
  response: ObserverResponse | undefined;
  stale: boolean;
  expired: boolean;
  failed: boolean;
  initialFailure: boolean;
  failureCount: number;
  lastSuccessfulAt: string | null;
};

function observedAt(response: ObserverResponse): string {
  const result = response.result;
  if (result && typeof result === "object") {
    const success = (result as { observation?: { lastSuccessfulAt?: unknown } }).observation?.lastSuccessfulAt;
    if (typeof success === "string" && success) return success;
    const value = (result as { observedAt?: unknown }).observedAt;
    if (typeof value === "string" && value) return value;
    const nested = (result as { observation?: { observedAt?: unknown } }).observation?.observedAt;
    if (typeof nested === "string" && nested) return nested;
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
      lastSuccessfulAt: null,
      failureCount: 0,
      firstFailureAt: null,
    };
    cache.current.set(key, entry);
  }

  if (response !== entry.lastResponse) {
    entry.lastResponse = response;
    const state = responseObservationState(response);
    if (response && state === "ready") {
      entry.response = response;
      entry.lastSuccessfulAt = observedAt(response);
      clearFailures(entry);
    } else if (response) {
      markFailure(entry);
      if (state === "partial" && entry.response && options.mergePartial) {
        entry.response = options.mergePartial(entry.response, response);
      } else if (state === "error" && response.ok) {
        // Structured durable issues (for example worktree_missing) are real
        // observations. Keep that response visible, but do not advance the
        // last-successful timestamp.
        entry.response = response;
      }
    }
  }

  if (options.error !== entry.lastError) {
    const previousError = entry.lastError;
    entry.lastError = options.error;
    if (options.error) {
      markFailure(entry);
    } else if (previousError && responseObservationState(response) === "ready") {
      clearFailures(entry);
    }
  }

  const displayResponse = entry.response || (response?.ok ? response : undefined);
  const failed = entry.failureCount > 0 || Boolean(options.error);
  const stale = Boolean(displayResponse && failed);
  const lastSuccessTimestamp = entry.lastSuccessfulAt ? Date.parse(entry.lastSuccessfulAt) : NaN;
  const failureAge = Number.isFinite(lastSuccessTimestamp)
    ? Math.max(0, Date.now() - lastSuccessTimestamp)
    : 0;
  const expired = Boolean(displayResponse && (entry.failureCount >= STALE_FAILURE_LIMIT || failureAge >= STALE_AFTER_MS));

  return {
    response: displayResponse,
    stale,
    expired,
    failed,
    initialFailure: !entry.response && failed,
    failureCount: entry.failureCount,
    lastSuccessfulAt: entry.lastSuccessfulAt,
  };
}
