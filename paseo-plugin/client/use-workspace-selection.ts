import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchCopy } from '../shared/copy';
import type { ObservationTiming } from '../shared/observation-timing';
import type { ObserverMethod, ObserverResponse } from '../shared/observer';
import { queryFailureForDisplay, resultOf } from './components/ui';
import { matchesWorkspaceFilter, resolveWorkspaceSelection, sortWorkspaces, sortWorkspacesByLatestCommit, type ListResult, type WorkspaceFilter } from './model';
import { reportNativeDiagnostic } from './native-diagnostics';
import { initialContentState, useLastSuccessfulResponse } from './observation';
import { observationQueryOptions } from './observation-content';
import { queryDiagnosticDetails } from './panel/observation-display';
import type { useObserverPreferences } from './preferences';
export function useWorkspaceSelection({ projectConfig, foreground, backendReady, rpc, preferences, preferenceScopeKey, workspaceDirectory, observationTiming, localizedCopy, onProjectReady, refreshArea, onSelect, onSelectionLost }: {
    projectConfig: string;
    foreground: boolean;
    backendReady: boolean;
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
    const rpcRef = useRef(rpc);
    rpcRef.current = rpc;
    const [selectionResolved, setSelectionResolved] = useState(false);
    const [selectorOpen, setSelectorOpen] = useState(false);
    const [activityScanId, setActivityScanId] = useState("");
    const activityScanIdRef = useRef("");
    const [activityScanProgress, setActivityScanProgress] = useState<{
        completed: number;
        total: number;
    } | null>(null);
    const [sortByLatestCommit, setSortByLatestCommit] = useState(false);
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
    const observedWorkspaces = useMemo(() => {
        const rows = listReady ? listResult?.workspaces || [] : [];
        return sortByLatestCommit ? sortWorkspacesByLatestCommit(rows) : sortWorkspaces(rows);
    }, [listReady, listResult?.workspaces, sortByLatestCommit]);
    const allWorkspaces = useMemo(() => observedWorkspaces.filter((workspace) => workspace.state !== "removed"), [observedWorkspaces]);
    const historyWorkspaces = useMemo(() => observedWorkspaces.filter((workspace) => workspace.state === "removed"), [observedWorkspaces]);
    const workspacePool = workspaceFilter === "history" ? historyWorkspaces : allWorkspaces;
    const visibleWorkspaces = useMemo(() => workspacePool.filter((workspace) => matchesWorkspaceFilter(workspace, workspaceFilter)), [workspacePool, workspaceFilter]);
    const cancelWorkspaceActivityScan = useCallback((closeSelector = true) => {
        const scanId = activityScanIdRef.current;
        activityScanIdRef.current = "";
        if (closeSelector)
            setSelectorOpen(false);
        setActivityScanId("");
        setActivityScanProgress(null);
        if (scanId)
            void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
    }, []);
    const openWorkspaceSelector = useCallback(() => {
        if (selectorOpen) {
            cancelWorkspaceActivityScan();
            return;
        }
        setSelectorOpen(true);
        setSortByLatestCommit(false);
        const scanId = `selector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        activityScanIdRef.current = scanId;
        void rpcRef.current({
            method: "workspace.activity",
            params: { action: "start", scanId, workspaceIds: observedWorkspaces.map((workspace) => workspace.id) },
        }).then((response) => {
            if (activityScanIdRef.current !== scanId)
                return;
            if (!response.ok) {
                activityScanIdRef.current = "";
                setActivityScanId("");
                setActivityScanProgress(null);
                void refreshArea("workspace-list").finally(() => setSortByLatestCommit(true));
                return;
            }
            const status = response.result as {
                state?: string;
                completed?: number;
                total?: number;
            } | undefined;
            setActivityScanProgress({ completed: status?.completed || 0, total: status?.total || 0 });
            if (status?.state === "running") {
                setActivityScanId(scanId);
            }
            else {
                activityScanIdRef.current = "";
                setActivityScanId("");
                setActivityScanProgress(null);
                void refreshArea("workspace-list").finally(() => setSortByLatestCommit(true));
            }
        }).catch(() => {
            if (activityScanIdRef.current !== scanId)
                return;
            activityScanIdRef.current = "";
            void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
            setActivityScanId("");
            setActivityScanProgress(null);
            setSortByLatestCommit(true);
        });
    }, [cancelWorkspaceActivityScan, listQuery.refetch, observedWorkspaces, selectorOpen]);
    useEffect(() => {
        if (!selectorOpen || !foreground || !activityScanId)
            return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            const response = await rpcRef.current({ method: "workspace.activity", params: { action: "status", scanId: activityScanId } }).catch(() => null);
            if (stopped || activityScanIdRef.current !== activityScanId)
                return;
            const status = response?.ok ? response.result as {
                state?: string;
                completed?: number;
                total?: number;
            } | undefined : undefined;
            if (!status) {
                timer = setTimeout(poll, 1000);
                return;
            }
            setActivityScanProgress({ completed: status.completed || 0, total: status.total || 0 });
            if (status.state === "running") {
                timer = setTimeout(poll, 750);
                return;
            }
            activityScanIdRef.current = "";
            setActivityScanId("");
            setActivityScanProgress(null);
            void refreshArea("workspace-list").finally(() => setSortByLatestCommit(true));
        };
        void poll();
        return () => { stopped = true; if (timer)
            clearTimeout(timer); };
    }, [activityScanId, foreground, listQuery.refetch, selectorOpen]);
    useEffect(() => {
        if (foreground || !activityScanIdRef.current)
            return;
        cancelWorkspaceActivityScan();
    }, [cancelWorkspaceActivityScan, foreground]);
    useEffect(() => () => {
        const scanId = activityScanIdRef.current;
        if (scanId)
            void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
    }, []);
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
        setSelectorOpen(false);
    }
    const selectCreatedWorkspace = (id: string) => { newlyCreatedWorkspace.current = id; selectWorkspace(id); };
    return { selectionResolved, selectorOpen, activityScanProgress, workspaceFilter, setWorkspaceFilter, listQuery, listState, listResult, listFailure, listReady, listContentState, listUnavailable, observedWorkspaces, allWorkspaces, historyWorkspaces, visibleWorkspaces, cancelWorkspaceActivityScan, openWorkspaceSelector, identifyQuery, selectWorkspace, selectCreatedWorkspace };
}
