import { useEffect, useRef } from "react";
import { isRecoverableObserverFailure } from "../components/ui";
import { RECOVERABLE_FAILURE_GRACE_MS, type ObserverSnapshot } from "../observation";
import type { ObserverQueryState } from "./observation-display";

/** Retry only transport failures during the bounded recovery window. */
export function useTransientObserverRetry(query: ObserverQueryState, snapshot: ObserverSnapshot, enabled: boolean): void {
  const refetchRef = useRef(query.refetch);
  refetchRef.current = query.refetch;
  useEffect(() => {
    if (!enabled || query.isFetching || !snapshot.initialFailure || !isRecoverableObserverFailure(query.data, query.error)) return;
    if ((snapshot.failureAgeMs ?? 0) >= RECOVERABLE_FAILURE_GRACE_MS) return;
    const age = snapshot.failureAgeMs ?? 0;
    const delay = Math.min(2_000, Math.max(250, 250 * 2 ** Math.min(3, snapshot.failureCount)));
    const remaining = Math.max(0, RECOVERABLE_FAILURE_GRACE_MS - age);
    if (!remaining) return;
    const timer = setTimeout(() => { void refetchRef.current().catch(() => {}); }, Math.min(delay, remaining));
    return () => clearTimeout(timer);
  }, [enabled, query.data, query.error, query.isFetching, snapshot.failureAgeMs, snapshot.failureCount, snapshot.initialFailure]);
}
