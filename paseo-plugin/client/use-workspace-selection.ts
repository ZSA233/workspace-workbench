import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchCopy } from '../shared/copy';
import type { ObservationTiming } from '../shared/observation-timing';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import { queryFailureForDisplay, resultOf } from './components/ui';
import { applyWorkspaceActivity, matchesWorkspaceFilter, resolveWorkspaceSelection, sortWorkspacesByLatestCommit, type ListResult, type WorkspaceFilter } from './model';
import { reportNativeDiagnostic } from './native-diagnostics';
import { initialContentState, useLastSuccessfulResponse } from './observation';
import { observationQueryOptions } from './observation-content';
import { queryDiagnosticDetails } from './panel/observation-display';
import type { useObserverPreferences } from './preferences';
import { useWorkspaceActivity } from './use-workspace-activity';
export function useWorkspaceSelection({ projectConfig, foreground, backendReady, activityCapable, rpc, preferences, preferenceScopeKey, workspaceDirectory, observationTiming, localizedCopy, onProjectReady, refreshArea, onSelect, onSelectionLost }: {
    projectConfig: string;
    foreground: boolean;
    backendReady: boolean;
    activityCapable: boolean;
    rpc: (input: {
        method: ObserverMethod;
        params: Record<string, unknown>;
    }) => Promise<ObserverResponse>;
    preferences: ReturnType<typeof useObserverPreferences>;
    preferenceScopeKey: string;
    workspaceDirectory: string;
    observationTiming: ObservationTiming;
    localizedCopy: WorkbenchCopy;
    onProjectReady?: () => void;
    refreshArea: (kind: string) => Promise<unknown>;
    onSelect: () => void;
    onSelectionLost: () => void;
}) {
    const selectedWorkspaceId = preferences.selectedWorkspaceId;
    const [selectionResolved, setSelectionResolved] = useState(false);
    const [selectorProject, setSelectorProject] = useState('');
    const selectorOpen = foreground && selectorProject === projectConfig && Boolean(projectConfig);
    const closeWorkspaceSelector = useCallback(() => setSelectorProject(''), []);
    const openWorkspaceSelector = useCallback(() => {
        setSelectorProject(previous => previous === projectConfig ? '' : projectConfig);
    }, [projectConfig]);
    useEffect(() => {
        if (!foreground) closeWorkspaceSelector();
    }, [foreground, closeWorkspaceSelector]);
    useEffect(closeWorkspaceSelector, [projectConfig, closeWorkspaceSelector]);
    const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>("all");
    const newlyCreatedWorkspace = useRef<string | null>(null);
    useEffect(() => setSelectionResolved(false), [preferenceScopeKey]);
    const listQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "workspace-list"],
        queryFn: () => rpc({ method: "workspace.list", params: { includeRemoved: true } }),
        enabled: foreground && Boolean(projectConfig && backendReady),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        ...observationQueryOptions,
    });
    const listState = useLastSuccessfulResponse(`workspace-list:${projectConfig}`, listQuery.data, { error: listQuery.error, staleAfterMs: observationTiming.staleWindowsMs.list });
    const listResult = resultOf<ListResult>(listState.response);
    const listFailure = !listResult && listState.failed ? localizedCopy.workspaceListUnavailable : queryFailureForDisplay(listState, listQuery.data, listQuery.error, localizedCopy);
    reportNativeDiagnostic("project-panel-list-state", { projectConfig, ...queryDiagnosticDetails(listQuery.data, listQuery.error, listQuery, listState) });
    const listReady = Boolean(listResult);
    useEffect(() => { if (listReady)
        onProjectReady?.(); }, [listReady, onProjectReady]);
    const listContentState = initialContentState(listReady, listState.failed);
    const listUnavailable = listContentState === 'unavailable';
    const snapshot = listResult?.activitySnapshot;
    const reloadRoster = useCallback(() => refreshArea('workspace-list'), [refreshArea]);
    const activity = useWorkspaceActivity({
        project: projectConfig, enabled: foreground && backendReady && activityCapable && Boolean(snapshot),
        open: selectorOpen, selectedWorkspaceId, snapshot, rpc, reloadRoster,
    });
    const refreshWorkspaceActivity = useCallback((force = false) => activity.control(force), [activity.control]);
    const cancelFullActivity = useCallback(() => {
        if (activity.fullScan?.state === 'running') activity.control(false, activity.fullScan.scanId);
    }, [activity.control, activity.fullScan]);
    const observedWorkspaces = useMemo(() => {
        const rows = listReady ? listResult?.workspaces || [] : [];
        return sortWorkspacesByLatestCommit(applyWorkspaceActivity(rows, snapshot, activity.publication, projectConfig));
    }, [listReady, listResult?.workspaces, snapshot, activity.publication, projectConfig]);
    const allWorkspaces = useMemo(() => observedWorkspaces.filter((workspace) => workspace.state !== "removed"), [observedWorkspaces]);
    const historyWorkspaces = useMemo(() => observedWorkspaces.filter((workspace) => workspace.state === "removed"), [observedWorkspaces]);
    const workspacePool = workspaceFilter === "history" ? historyWorkspaces : allWorkspaces;
    const visibleWorkspaces = useMemo(() => workspacePool.filter((workspace) => matchesWorkspaceFilter(workspace, workspaceFilter)), [workspacePool, workspaceFilter]);
    const identifyQuery = useQuery({
        queryKey: ["workspace-workbench", projectConfig, "identify", workspaceDirectory],
        queryFn: () => rpc({ method: "workspace.identify", params: { directory: workspaceDirectory } }),
        enabled: Boolean(workspaceDirectory && backendReady && preferences.hydrated && !selectionResolved && listReady),
        refetchInterval: false,
        refetchIntervalInBackground: false,
        retry: false,
        staleTime: observationTiming.clientQueryStaleTimeMs,
        refetchOnWindowFocus: false,
    });
    const identified = resultOf<{
        matched: boolean;
        workspaceId: string | null;
    }>(identifyQuery.data);
    useEffect(() => {
        if (!listReady || !preferences.hydrated || selectionResolved)
            return;
        const hasSavedSelection = Boolean(preferences.savedWorkspaceId &&
            observedWorkspaces.some((workspace) => workspace.id === preferences.savedWorkspaceId && workspace.state !== "removed"));
        const identifySettled = Boolean(identifyQuery.data || identifyQuery.error);
        if (!hasSavedSelection && workspaceDirectory && !identifySettled)
            return;
        const resolution = resolveWorkspaceSelection({
            currentWorkspaceId: selectedWorkspaceId,
            savedWorkspaceId: preferences.savedWorkspaceId,
            identifiedWorkspaceId: identified?.matched ? identified.workspaceId : null,
            workspaces: observedWorkspaces,
        });
        if (!resolution)
            return;
        if (resolution.source === "current" || resolution.source === "saved") {
            setSelectionResolved(true);
            return;
        }
        preferences.selectWorkspace(resolution.workspaceId);
        setSelectionResolved(true);
    }, [
        identifyQuery.data,
        identifyQuery.error,
        identified,
        listReady,
        observedWorkspaces,
        preferences.hydrated,
        preferences.savedWorkspaceId,
        preferences.selectWorkspace,
        selectedWorkspaceId,
        selectionResolved,
        workspaceDirectory,
    ]);
    useEffect(() => {
        if (!listReady || !preferences.hydrated || !selectionResolved || !selectedWorkspaceId)
            return;
        const currentSelection = observedWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId);
        if (currentSelection && (currentSelection.state !== "removed" || workspaceFilter === "history")) {
            newlyCreatedWorkspace.current = null;
            return;
        }
        // A successful create can precede the last-good roster's React update.
        // Its absence from that older snapshot is not evidence of deletion.
        if (newlyCreatedWorkspace.current === selectedWorkspaceId)
            return;
        setSelectionResolved(false);
        onSelectionLost();
    }, [listReady, observedWorkspaces, preferences.hydrated, selectedWorkspaceId, selectionResolved, workspaceFilter]);
    function selectWorkspace(id: string): void {
        if (newlyCreatedWorkspace.current !== id)
            newlyCreatedWorkspace.current = null;
        preferences.selectWorkspace(id);
        setSelectionResolved(true);
        onSelect();
        closeWorkspaceSelector();
    }
    const selectCreatedWorkspace = (id: string) => { newlyCreatedWorkspace.current = id; selectWorkspace(id); };
    return { selectionResolved, selectorOpen, fullActivityScan: activity.fullScan, activityCommandBusy: activity.commandBusy, noteVisibleWorkspaces: activity.noteVisible, noteWorkspaceScroll: activity.noteScroll, cancelFullActivity, workspaceFilter, setWorkspaceFilter, listQuery, listState, listResult, listFailure, listReady, listContentState, listUnavailable, observedWorkspaces, allWorkspaces, historyWorkspaces, visibleWorkspaces, closeWorkspaceSelector, openWorkspaceSelector, refreshWorkspaceActivity, identifyQuery, selectWorkspace, selectCreatedWorkspace };
}
