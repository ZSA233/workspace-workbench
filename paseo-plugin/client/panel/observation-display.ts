import { copy, type WorkbenchCopy } from "../../shared/copy";
import type { ObserverResponse } from "../../shared/observer";
import { formatObservedTime } from "../model";
import type { ObserverSnapshot } from "../observation";

export type ObservationArea = {
  label: string;
  snapshot: ObserverSnapshot;
  fetching: boolean;
};

export type ObserverQueryState = {
  data?: ObserverResponse;
  error?: unknown;
  isFetching: boolean;
  isPending?: boolean;
  isError?: boolean;
  refetch: () => Promise<unknown>;
};

export function queryDiagnosticDetails(
  response: ObserverResponse | undefined,
  error: unknown,
  query: { isPending?: boolean; isFetching: boolean; isError?: boolean },
  snapshot: ObserverSnapshot,
): Record<string, string> {
  const result = response?.ok && response.result && typeof response.result === "object"
    ? response.result as { observation?: { state?: unknown; cacheState?: unknown; refreshing?: unknown }; issues?: unknown[] }
    : undefined;
  const issue = result?.issues?.find((item) => item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string") as { code?: unknown } | undefined;
  return {
    pending: String(query.isPending === true),
    fetching: String(query.isFetching),
    queryError: query.isError ? (error instanceof Error ? error.message : "query_error") : "",
    response: response ? (response.ok ? "ok" : `error:${response.error?.code || "unknown"}`) : "none",
    observationState: String(result?.observation?.state || ""),
    cacheState: String(result?.observation?.cacheState || ""),
    cacheRefreshing: String(result?.observation?.refreshing === true),
    resultIssue: String(issue?.code || ""),
    snapshotStatus: snapshot.status,
    snapshotFailureCount: String(snapshot.failureCount),
    snapshotFailureAgeMs: String(snapshot.failureAgeMs ?? ""),
    snapshotRefreshing: String(snapshot.refreshing),
  };
}

export function observationStatusLabel(status: ObserverSnapshot["status"], strings: WorkbenchCopy = copy): string {
  if (status === "loading") return strings.text_fcabadb2a7;
  if (status === "refreshing") return strings.observationRefreshing;
  if (status === "degraded") return strings.observationDegraded;
  if (status === "expired") return strings.observationStale;
  if (status === "unavailable") return strings.observationUnavailable;
  return strings.observationStatus;
}

export function observationAreaDetail(area: ObservationArea, strings: WorkbenchCopy = copy): string {
  const status = area.snapshot.status === "expired"
    ? "expired"
    : area.fetching || area.snapshot.refreshing
      ? "refreshing"
      : area.snapshot.status;
  const timestamp = area.snapshot.lastObservedAt ? ` · ${formatObservedTime(area.snapshot.lastObservedAt, strings)}` : "";
  return `${area.label}: ${observationStatusLabel(status, strings)}${timestamp}`;
}
