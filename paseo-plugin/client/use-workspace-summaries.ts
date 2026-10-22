import { createPrefetchRound } from './prefetch-round.ts';
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
}, instance = workspaceId) {
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
    const round = useRef(createPrefetchRound()).current;
    const [, advance] = useState(0);
    const eligible = inputs.flatMap((input,index) => {
        const summary = (queries[index]?.data?.result as any)?.regions?.summary;
        if(summary?.state!=='ready')return [];
        const repository=summary.result?.repository;
        return [{...input,...content,summaryOnly:false,scope:repository?.dirty || repository?.branchScopeAvailable===false?'working':'branch'}];
    });
    const candidates=eligible.filter(input=>input.repoPath!==selected);
    const candidateKeys = candidates.map(input => JSON.stringify([project,input]));
    round.reconcile(JSON.stringify([project,workspaceId,instance,content]),eligible.map(input=>JSON.stringify([project,input])),enabled);
    const nextKey = round.next(candidateKeys);
    const warm = candidates[candidateKeys.indexOf(nextKey || '')];
    const warmKey = warm ? JSON.stringify([project, warm]) : '';
    const basicsSettled = queries.length > 0 && queries.every(query => query.data && !(query.data.result as any)?.observation?.readTask);
    const preload = useRepositoryRefresh(project, warm || { workspaceId, repoPath: '', scope: 'working', historyMode: content.historyMode, maxCommits: content.maxCommits }, enabled && basicsSettled && !!warm, rpc, true);
    useEffect(() => {
        if (!warmKey || !preload.query.data || preload.pending || preload.query.isFetching)
            return;
        round.complete(warmKey, !preload.query.data.error && !(preload.query.data.result as any)?.regions?.graph?.error && !(preload.query.data.result as any)?.regions?.changes?.error);
        advance(value => value+1);
    }, [warmKey, preload.query.data, preload.pending, preload.query.isFetching]);
    const current = queries[inputs.findIndex(input => input.repoPath === selected)];
    const currentMeta = (current?.data?.result as any)?.observation;
    const failures = queries.flatMap((query, index) => {
        const error = query.data?.error || (query.data?.result as any)?.regions?.summary?.error;
        return error ? [{ repoPath: inputs[index].repoPath, ...error }] : [];
    });
    return { failures, currentRunning: enabled && (current?.isFetching && !current.data || currentMeta?.readTask?.state === 'running'), refresh: () => { round.retry(); advance(value=>value+1); queries.forEach((query, index) => { if (query.isFetching || (query.data?.result as any)?.observation?.readTask)
            return; reader.retry(keys[index]); forced.current.add(keys[index]); void query.refetch({ cancelRefetch: false }); }); }, confirmed: queries.filter(q => (q.data?.result as any)?.regions?.summary?.state === 'ready').length, total: paths.length };
}
