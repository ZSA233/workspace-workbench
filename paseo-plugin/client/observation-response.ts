import type { ObserverResponse } from "../shared/observer.ts";
import { responseObservationState } from "./model.ts";
export type ObservationResponseClass = "ready" | "refreshing" | "degraded" | "unavailable";
type ObservationMetadata = {
  refreshing: boolean;
  lastErrorCode: string | null;
  cacheAgeMs: number | null;
  cacheUpdatedAt: string | null;
};

export function observationMetadata(response: ObserverResponse | undefined): ObservationMetadata {
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

