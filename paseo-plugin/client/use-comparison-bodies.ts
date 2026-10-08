import {useEffect, useRef, useCallback, useSyncExternalStore} from 'react';
import {useQueries, useQueryClient} from '@tanstack/react-query';
import {trimComparisonBodies, markComparisonBodyUsed} from './comparison-body-budget';
import {createDiffReadClient, type DiffRpc} from './diff-read-client';
import {fileReviewQueryKey, fileReviewParams} from './file-review-query';
import {observationQueryOptions, displayedObservation} from './observation-content';
import type {FileReviewSelection} from './file-review-store';
import type {ObserverResponse} from '../shared/observer';
import type {ContextRequest} from '../shared/diff-context';

export type BodyJob = {
    id: string;
    path: string;
    selection: FileReviewSelection;
    context?: ContextRequest;
    intent?: 'interactive' | 'background';
};
export function bodyKey(job: BodyJob, host: string) {
    return [...fileReviewQueryKey(job.selection, host), ...(job.context ? ['context', job.context] : [])];
}

/** Owns demand and read identities only. Results and task polling stay in the shared query system. */
export function useComparisonBodies(jobs: BodyJob[], host: string, rpc: DiffRpc, foreground: boolean, capable: boolean, protectedKeys: Set<string>) {
    const client = useQueryClient();
    const reader = useRef(createDiffReadClient()).current;
    const rpcRef = useRef(rpc);
    rpcRef.current = rpc;
    const version = useRef(0);
    const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(event => {
        if (event.query.queryKey[1] === 'file-review' && (event.type === 'removed' ||
            event.type === 'updated' && ['success', 'error'].includes(event.action.type))) {
            version.current++;
            notify();
        }
    }), [client]);
    // Consumers must advance from the cache event itself. Observer timestamps can lag
    // behind the render that disables a completed slot and enables its successor.
    const cacheVersion = useSyncExternalStore(subscribe, () => version.current);
    const pending = jobs.filter(job => {
        if (client.getQueryState(bodyKey(job, host))?.status === 'error') return false;
        const response = client.getQueryData<ObserverResponse>(bodyKey(job, host));
        const value = response?.result as {patch?: string; lines?: unknown[]} | undefined;
        return !response || response.ok && value?.patch === undefined && value?.lines === undefined;
    });
    const slots = new Set(pending.slice(0, 2).map(job => job.id));
    const enabled = jobs.filter(job => foreground && slots.has(job.id));
    const enabledIdentity = JSON.stringify(enabled.map(job => job.id));
    const demandIdentity = JSON.stringify(jobs.map(job => job.id));
    const previous = useRef(new Set<string>());
    const protectedRef = useRef(protectedKeys);
    protectedRef.current = protectedKeys;
    useEffect(() => {
        const next = new Set(enabled.map(job => job.id));
        for (const id of previous.current) if (!next.has(id)) reader.release(id, rpcRef.current);
        previous.current = next;
    }, [enabledIdentity, reader]);
    useEffect(() => () => {
        for (const id of previous.current) reader.release(id, rpcRef.current);
        trimComparisonBodies(client, protectedRef.current);
    }, [reader, client]);
    useQueries({queries: jobs.map(job => ({
        queryKey: bodyKey(job, host),
        queryFn: () => reader.read(job.id, {
            ...fileReviewParams(job.selection),
            ...(job.context ? {readKind: 'context', context: job.context} : {}),
            intent: job.intent || 'interactive',
        }, rpc, capable),
        enabled: foreground && slots.has(job.id),
        ...observationQueryOptions,
        meta: {comparisonBody: true},
    }))});
    useEffect(() => {
        for (const job of foreground ? jobs : []) {
            const query = client.getQueryCache().find({queryKey: bodyKey(job, host), exact: true});
            if (query) markComparisonBodyUsed(client, query.queryHash);
        }
        trimComparisonBodies(client, new Set([...protectedKeys, ...(foreground ? jobs : []).map(job => JSON.stringify(bodyKey(job, host)))]));
    }, [demandIdentity, cacheVersion, foreground, client]);
    function response(job: BodyJob): ObserverResponse | undefined {
        const key = bodyKey(job, host), data = client.getQueryData<ObserverResponse>(key);
        if (data) return data;
        const error = client.getQueryState(key)?.error;
        return error ? {ok: false, error: {code: 'read_failed', message: String(error)}} : undefined;
    }
    return {
        cacheVersion,
        read: (job: BodyJob) => displayedObservation(response(job)),
        response,
        retry: (job: BodyJob) => {
            reader.retry(job.id);
            client.removeQueries({queryKey: bodyKey(job, host), exact: true});
        },
    };
}
