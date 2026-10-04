import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkbenchCopy } from '../shared/copy';
import type { ObservationTiming } from '../shared/observation-timing';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import { isRecoverableObserverFailure, queryFailureForDisplay, resultOf } from './components/ui';
import { type ChangeScope, type ChangesResult, type DetailResult, type GraphResult, type WorkspaceSummary } from './model';
import { reportNativeDiagnostic } from './native-diagnostics';
import { RECOVERABLE_FAILURE_GRACE_MS, useLastSuccessfulResponse } from './observation';
import { useQueryContinuity } from './query-continuity';
import { displayedObservation, observationQueryOptions } from './observation-content';
import { hydrateRepositorySummaries } from './observation-publication';
import { queryDiagnosticDetails } from './panel/observation-display';
import { refreshRegionFeedback } from './repository-refresh-client';
import { useRepositoryRefresh } from './use-repository-refresh';
import { useWorkspaceSummaries } from './use-workspace-summaries';
export function useRepositoryObservation({ projectConfig, selectedWorkspaceId, selectedWorkspace, selectedRepoPath, selectedCommit, changeScope, graphView, foreground, tab, backendReady, listReady, refreshCapable, basicCapable, selectedWorkspaceUnavailable, rpc, localizedCopy, observationTiming }: {
    projectConfig: string;
    selectedWorkspaceId: string;
    selectedWorkspace: WorkspaceSummary | undefined;
    selectedRepoPath: string;
    selectedCommit: string;
    changeScope: Exclude<ChangeScope, 'commit'>;
    graphView: {
        historyMode: 'branch' | 'full';
        maxCommits: number;
    };
    foreground: boolean;
    tab: 'workspace' | 'review';
    backendReady: boolean;
    listReady: boolean;
    refreshCapable: boolean;
    basicCapable: boolean;
    selectedWorkspaceUnavailable: boolean;
    rpc: (input: {
        method: ObserverMethod;
        params: Record<string, unknown>;
    }) => Promise<ObserverResponse>;
    localizedCopy: WorkbenchCopy;
    observationTiming: ObservationTiming;
}) {
    const queryClient = useQueryClient();
    const detailQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "workspace-detail", selectedWorkspaceId],
        queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: selectedWorkspaceId, mode: basicCapable ? "roster" : "summary", refreshToolchain: false } }),
        enabled: foreground && Boolean(selectedWorkspaceId && selectedWorkspace && backendReady && listReady),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        ...observationQueryOptions,
    });
    const detailState = useLastSuccessfulResponse(`workspace-detail:${projectConfig}:${selectedWorkspaceId}`, detailQuery.data, {
        error: detailQuery.error,
        staleAfterMs: observationTiming.staleWindowsMs.detail,
    });
    const detail = resultOf<DetailResult>(detailState.response);
    const detailFailure = queryFailureForDisplay(detailState, detailQuery.data, detailQuery.error, localizedCopy);
    reportNativeDiagnostic("project-panel-detail-state", queryDiagnosticDetails(detailQuery.data, detailQuery.error, detailQuery, detailState));
    const detailUnavailable = !detail
        && detailState.initialFailure
        && (!isRecoverableObserverFailure(detailQuery.data, detailQuery.error)
            || (detailState.failureAgeMs ?? RECOVERABLE_FAILURE_GRACE_MS) >= RECOVERABLE_FAILURE_GRACE_MS);
    const displayDetail = listReady && detail?.workspace.id === selectedWorkspaceId
        ? hydrateRepositorySummaries(queryClient, projectConfig, detail)
        : null;
    const selectorWorkspace = selectedWorkspace && displayDetail
        ? { ...selectedWorkspace, ...displayDetail.workspace }
        : selectedWorkspace;
    const selectedRepository = displayDetail?.workspace.id === selectedWorkspaceId
        ? displayDetail.repositories.find((repository) => repository.repoPath === selectedRepoPath)
        : undefined;
    const graphKey = ["workspace-workbench", projectConfig, "repository-graph", selectedWorkspaceId, selectedRepoPath, graphView.historyMode, graphView.maxCommits];
    const graphQuery = useQuery({
        queryKey: graphKey,
        queryFn: () => rpc({
            method: "repository.graph",
            params: {
                workspaceId: selectedWorkspaceId,
                repoPath: selectedRepoPath,
                historyMode: graphView.historyMode,
                maxCommits: graphView.maxCommits,
            },
        }),
        enabled: !refreshCapable && foreground && tab === "workspace" && Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && backendReady && listReady && !selectedWorkspaceUnavailable),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        ...observationQueryOptions,
    });
    const graphState = useLastSuccessfulResponse(`repository-graph:${projectConfig}:${selectedWorkspaceId}:${selectedRepoPath}:${graphView.historyMode}:${graphView.maxCommits}`, graphQuery.data, { error: graphQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository });
    const graphContent = useQueryContinuity<GraphResult>(
        JSON.stringify([projectConfig, selectedWorkspaceId, selectedRepoPath, selectedRepository?.head, selectedRepository?.baseSha]),
        graphKey, Array.isArray((graphState.response?.result as GraphResult)?.nodes) ? resultOf<GraphResult>(graphState.response) ?? undefined : undefined,
        data => {
            const cached = resultOf<GraphResult>(displayedObservation(data as ObserverResponse | undefined));
            return Array.isArray(cached?.nodes) && cached.head === selectedRepository?.head && cached.baseSha === selectedRepository?.baseSha ? cached! : undefined;
        },
    );
    const graph = graphContent.displayed ?? null;
    const graphFailure = queryFailureForDisplay(graphState, graphQuery.data, graphQuery.error, localizedCopy);
    reportNativeDiagnostic("project-panel-graph-state", { projectConfig, workspaceId: selectedWorkspaceId, repoPath: selectedRepoPath, nodeCount: String(graph?.nodes?.length ?? ""), ...queryDiagnosticDetails(graphQuery.data, graphQuery.error, graphQuery, graphState) });
    const changesScope: ChangeScope = selectedCommit ? "commit" : changeScope;
    const changesQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "repository-changes", selectedWorkspaceId, selectedRepoPath, changesScope, selectedCommit],
        queryFn: () => rpc({
            method: "repository.changes",
            params: {
                workspaceId: selectedWorkspaceId,
                repoPath: selectedRepoPath,
                scope: changesScope,
                commitSha: selectedCommit || undefined,
            },
        }),
        enabled: !refreshCapable && foreground && tab === "workspace" && Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && backendReady && listReady && !selectedWorkspaceUnavailable),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        ...observationQueryOptions,
    });
    const changesState = useLastSuccessfulResponse(`repository-changes:${projectConfig}:${selectedWorkspaceId}:${selectedRepoPath}:${changesScope}:${selectedCommit}`, changesQuery.data, { error: changesQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository });
    const changesResult = resultOf<ChangesResult>(changesState.response);
    const changes = Array.isArray(changesResult?.files) ? changesResult : null;
    const changesFailure = queryFailureForDisplay(changesState, changesQuery.data, changesQuery.error, localizedCopy);
    const refreshInput = { workspaceId: selectedWorkspaceId, repoPath: selectedRepoPath, historyMode: graphView.historyMode, maxCommits: graphView.maxCommits, scope: changesScope, commitSha: selectedCommit || undefined };
    const refreshRpc = (params: Record<string, unknown>) => rpc({ method: 'observer.refresh', params });
    const selectedRefresh = useRepositoryRefresh(projectConfig, refreshInput, refreshCapable && foreground && tab === 'workspace' && !!selectedRepoPath && !!selectedWorkspaceId && backendReady && (!basicCapable || !!selectedRepository && !selectedRepository.observationPending && typeof selectedRepository.dirty === 'boolean'), refreshRpc);
    const basicSummaries = useWorkspaceSummaries(projectConfig, selectedWorkspaceId, (displayDetail?.repositories || []).map(repo => repo.repoPath), selectedRepoPath, basicCapable && foreground && tab === 'workspace' && backendReady, refreshRpc, { historyMode: graphView.historyMode, maxCommits: graphView.maxCommits });
    const basicFailed = basicSummaries.failures.some(failure => failure.repoPath === selectedRepoPath);
    const graphFeedback = refreshRegionFeedback(selectedRefresh.query.data, 'graph', Boolean(graph), basicFailed);
    const graphRegion = selectedRefresh.result?.regions?.graph;
    const graphBusy = refreshCapable
        ? graphRegion?.state === 'ready' ? false : selectedRefresh.query.isFetching || !graphFeedback.failed && (graphRegion ? ['queued', 'running'].includes(graphRegion.state) : selectedRefresh.pending)
        : graphQuery.isFetching;
    const retryGraph = refreshCapable ? selectedRefresh.refresh : () => { void graphQuery.refetch({ cancelRefetch: false }); };
    const changesFeedback = refreshRegionFeedback(selectedRefresh.query.data, 'changes', Boolean(changes), basicFailed);
    reportNativeDiagnostic("project-panel-changes-state", { projectConfig, workspaceId: selectedWorkspaceId, repoPath: selectedRepoPath, ...queryDiagnosticDetails(changesQuery.data, changesQuery.error, changesQuery, changesState) });
    return { detailQuery, detailState, detail, detailFailure, detailUnavailable, displayDetail, selectorWorkspace, selectedRepository, graphQuery, graphState, graph, graphFailure, changesScope, changesQuery, changesState, changes, changesFailure, selectedRefresh, basicSummaries, graphFeedback, changesFeedback, graphBusy, retryGraph };
}
