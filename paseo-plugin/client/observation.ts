import { useRef } from "react";

import type { ObserverResponse } from "../shared/observer.ts";
import { responseObservationState } from "./model.ts";

const STALE_FAILURE_LIMIT = 3;
const STALE_AFTER_MS = 60_000;

export type ObservationStatus = "loading" | "fresh" | "refreshing" | "degraded" | "expired" | "unavailable";
export type ObservationResponseClass = "ready" | "refreshing" | "degraded" | "unavailable";

type SnapshotEntry = {
  response?: ObserverResponse;
  lastResponse?: ObserverResponse;
  lastError?: unknown;
  lastSuccessfulAt: string | null;
  failureCount: number;
  firstFailureAt: number | null;
  refreshing: boolean;
  lastErrorCode: string | null;
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
  failureCount: number;
  lastSuccessfulAt: string | null;
  status: ObservationStatus;
  refreshing: boolean;
  lastErrorCode: string | null;
};

function observationMetadata(response: ObserverResponse | undefined): { refreshing: boolean; lastErrorCode: string | null } {
  if (!response) return { refreshing: false, lastErrorCode: null };
  if (!response.ok) return { refreshing: false, lastErrorCode: response.error?.code || null };
  const result = response.result;
  if (!result || typeof result !== "object") return { refreshing: false, lastErrorCode: null };
  const observation = (result as { observation?: { refreshing?: unknown; cacheState?: unknown; issues?: unknown } }).observation;
  const issues = (result as { issues?: unknown }).issues;
  const issue = Array.isArray(issues)
    ? issues.find((item) => item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string")
    : Array.isArray(observation?.issues)
      ? observation.issues.find((item) => item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string")
      : undefined;
  return {
    refreshing: observation?.refreshing === true || observation?.cacheState === "refreshing",
    lastErrorCode: issue && typeof issue === "object" ? String((issue as { code?: unknown }).code || "") || null : null,
  };
}

export function classifyObservationResponse(response: ObserverResponse | undefined): ObservationResponseClass | null {
  if (!response) return null;
  const metadata = observationMetadata(response);
  if (metadata.refreshing) return "refreshing";
  const state = responseObservationState(response);
  return state === "ready" ? "ready" : state === "partial" ? "degraded" : "unavailable";
}

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
      lastSuccessfulAt: null,
      failureCount: 0,
      firstFailureAt: null,
      refreshing: false,
      lastErrorCode: null,
    };
    cache.current.set(key, entry);
  }

  if (response !== entry.lastResponse) {
    entry.lastResponse = response;
    const state = responseObservationState(response);
    const responseClass = classifyObservationResponse(response);
    const metadata = observationMetadata(response);
    entry.refreshing = metadata.refreshing;
    entry.lastErrorCode = metadata.lastErrorCode;
    if (response && responseClass === "ready") {
      entry.response = response;
      entry.lastSuccessfulAt = observedAt(response);
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
  const stale = Boolean(displayResponse && failed);
  const lastSuccessTimestamp = entry.lastSuccessfulAt ? Date.parse(entry.lastSuccessfulAt) : NaN;
  const failureAge = Number.isFinite(lastSuccessTimestamp)
    ? Math.max(0, Date.now() - lastSuccessTimestamp)
    : 0;
  const staleAfterMs = Math.max(1_000, options.staleAfterMs || STALE_AFTER_MS);
  const expired = Boolean(displayResponse && (entry.failureCount >= STALE_FAILURE_LIMIT || failureAge >= staleAfterMs));
  const status: ObservationStatus = !displayResponse
    ? failed ? "unavailable" : "loading"
    : expired
      ? "expired"
      : entry.refreshing
        ? "refreshing"
        : failed
          ? "degraded"
          : "fresh";

  return {
    response: displayResponse,
    stale,
    expired,
    failed,
    initialFailure: !entry.response && failed,
    failureCount: entry.failureCount,
    lastSuccessfulAt: entry.lastSuccessfulAt,
    status,
    refreshing: entry.refreshing,
    lastErrorCode: entry.lastErrorCode,
  };
}
