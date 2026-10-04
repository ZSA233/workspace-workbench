import type { ObserverResponse } from '../shared/observer.ts';
import { observationQueryOptions as schedulingOptions } from '../shared/observation-policy.ts';
import { responseObservationState, mergePartialDetail, type DetailResult } from './model.ts';
import { classifyObservationResponse } from './observation-response.ts';
type ContentResponse = ObserverResponse & {
    retainedContent?: ObserverResponse;
};
function isResponse(value: unknown): value is ContentResponse {
    return !!value && typeof value === 'object' && typeof (value as ObserverResponse).ok === 'boolean';
}
/** Protocol status remains current; retained content belongs to this same query entry. */
export function displayedObservation(value: ObserverResponse | undefined): ObserverResponse | undefined {
    return (value as ContentResponse | undefined)?.retainedContent || (value?.ok ? value : undefined);
}
function withoutRetention(value: ContentResponse): ObserverResponse {
    const { retainedContent: _, ...response } = value;
    return response;
}
export function retainObservationContent(previous: unknown, incoming: unknown): unknown {
    if (!isResponse(incoming))
        return incoming;
    const next = withoutRetention(incoming), prior = isResponse(previous) ? displayedObservation(previous) : undefined;
    const state = responseObservationState(next), classification = classifyObservationResponse(next);
    if (classification === 'ready') {
        const before = (prior?.result as any)?.observation?.readStartedAt || 0;
        const after = (next.result as any)?.observation?.readStartedAt || 0;
        // Aggregate task completion may reuse a summary from an older read while
        // publishing a new graph. Its region producers enforce ordering separately.
        const aggregate = !!(next.result as {
            regions?: unknown;
        } | undefined)?.regions;
        return !aggregate && after > 0 && before > after ? previous : next;
    }
    let content = prior;
    if (state === 'partial' && next.ok) {
        const result = next.result as any, old = prior?.result as any;
        if (Array.isArray(result?.repositories) && old?.workspace?.id === result?.workspace?.id) {
            content = { ...next, result: mergePartialDetail(old as DetailResult, result as DetailResult) };
        }
        else if (Array.isArray(result?.workspaces)) {
            const rows = new Map((old?.workspaces || []).map((row: any) => [row.id, row]));
            content = { ...next, result: { ...result, workspaces: result.workspaces.map((row: any) => {
                        const transient = row.observationStale || row.issues?.some((issue: any) => ['git_timeout', 'observation_timeout', 'observer_busy'].includes(issue.code));
                        return transient && rows.has(row.id) ? { ...rows.get(row.id) as object, observationStale: true } : row;
                    }) } };
        }
        else
            content = next;
    }
    else if (state === 'error' && next.ok)
        content = next;
    else if (next.ok && (classification !== 'refreshing' || !prior))
        content = next;
    return content && content !== next ? { ...next, retainedContent: withoutRetention(content) } : next;
}
export const observationQueryOptions = { ...schedulingOptions, structuralSharing: retainObservationContent } as const;
