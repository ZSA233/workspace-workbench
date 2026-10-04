import { publishRefresh, publishSummaryFailure } from './observation-publication.ts';
import { useRepositoryRefresh } from "./use-repository-refresh";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { observationQueryOptions } from './observation-content.ts';
import { createRepositoryRefreshClient, repositoryQueryKeys, type RefreshInput, type RefreshRpc } from './repository-refresh-client.ts';
/** All roster members subscribe independently; the existing coordinator polls tasks. */
export function useWorkspaceSummaries(project: string, workspaceId: string, paths: string[], selected: string, enabled: boolean, rpc: RefreshRpc, content: {
    historyMode: string;
    maxCommits: number;
}) {
    const client = useQueryClient();
    const forced = useRef(new Set<string>());
    const reader = useRef(createRepositoryRefreshClient()).current;
    const identity = JSON.stringify([project, workspaceId, paths]);
    const inputs = useMemo(() => paths.map(repoPath => ({ workspaceId, repoPath, scope: 'working', historyMode: 'branch', maxCommits: 50, summaryOnly: true } satisfies RefreshInput)), [identity]);
    const keys = inputs.map(input => JSON.stringify([project, input]));
    const queries = useQueries({ queries: inputs.map((input, index) => ({
            queryKey: repositoryQueryKeys(project, input).refresh,
            queryFn: async () => { const force = forced.current.delete(keys[index]); return reader.readRefresh(keys[index], input, rpc, force, input.repoPath !== selected); },
            enabled, ...observationQueryOptions,
        })) });
    useEffect(() => {
        queries.forEach((query, index) => {
            if (query.data?.result)
                publishRefresh(client, project, inputs[index], query.data.result as any);
            const error = query.data?.error || (query.data?.result as any)?.regions?.summary?.error;
            if (error) publishSummaryFailure(client,project,inputs[index],query.data,error);

        });
    }, [identity, JSON.stringify(queries.map(query => [query.dataUpdatedAt, query.errorUpdatedAt]))]);
    useEffect(() => {
        if (!enabled)
            return;
        return () => keys.forEach(key => reader.releaseRefresh(key, rpc));
    }, [identity, enabled]);
    // Speculative content has one subscriber and never gates basic summaries.
    const [prefetched, setPrefetched] = useState<Set<string>>(() => new Set());
    const candidates = inputs.filter(input => input.repoPath !== selected && (queries[inputs.indexOf(input)]?.data?.result as any)?.regions?.summary?.state === 'ready').map(input => {
        const repository = (queries[inputs.indexOf(input)]?.data?.result as any)?.regions?.summary?.result?.repository;
        return { ...input, ...content, summaryOnly: false, scope: repository?.dirty || repository?.branchScopeAvailable === false ? 'working' : 'branch' };
    });
    const warm = candidates.find(input => !prefetched.has(JSON.stringify([project, input])));
    const warmKey = warm ? JSON.stringify([project, warm]) : '';
    const basicsSettled = queries.length > 0 && queries.every(query => query.data && !(query.data.result as any)?.observation?.readTask);
    const preload = useRepositoryRefresh(project, warm || { workspaceId, repoPath: '', scope: 'working', historyMode: content.historyMode, maxCommits: content.maxCommits }, enabled && basicsSettled && !!warm, rpc, true);
    useEffect(() => {
        if (!warmKey || !preload.query.data || preload.pending || preload.query.isFetching)
            return;
        setPrefetched(previous => { if (previous.has(warmKey))
            return previous; const next = new Set(previous); next.add(warmKey); if (next.size > 128)
            next.delete(next.values().next().value!); return next; });
    }, [warmKey, preload.query.data, preload.pending, preload.query.isFetching]);
    const current = queries[inputs.findIndex(input => input.repoPath === selected)];
    const currentMeta = (current?.data?.result as any)?.observation;
    const failures = queries.flatMap((query, index) => {
        const error = query.data?.error || (query.data?.result as any)?.regions?.summary?.error;
        return error ? [{ repoPath: inputs[index].repoPath, ...error }] : [];
    });
    return { failures, currentRunning: enabled && (current?.isFetching && !current.data || currentMeta?.readTask?.state === 'running'), refresh: () => queries.forEach((query, index) => { if (query.isFetching || (query.data?.result as any)?.observation?.readTask)
            return; reader.retry(keys[index]); forced.current.add(keys[index]); void query.refetch({ cancelRefetch: false }); }), confirmed: queries.filter(q => (q.data?.result as any)?.regions?.summary?.state === 'ready').length, total: paths.length };
}
