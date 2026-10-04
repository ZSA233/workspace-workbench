import { useMemo, useRef, useSyncExternalStore, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { workspaceLifecycle } from '../shared/workspace-lifecycle';
import type { ObserverResponse } from '../shared/observer';
import type { ListResult, WorkspaceSummary } from './model';
import type { WorkbenchCopy } from '../shared/copy';
import { createWorkspaceBatch } from './workspace-batch';
import { createWorkspaceActions } from './workspace-actions';
import { publishLifecycle } from './observation-publication';
import { useToast } from './native-components';
export function useWorkspaceActions(project: string, selection: string, select: (id: string) => void, refetch: () => Promise<{
    data?: ObserverResponse;
}>, copy: WorkbenchCopy) {
    const rpc = useRpc(workspaceLifecycle), client = useQueryClient(), toast = useToast();
    const current = useRef({ project, rpc, selection, select, refetch, copy, toast });
    current.current = { project, rpc, selection, select, refetch, copy, toast };
    const controller = useMemo(() => createWorkspaceActions({
        rpc: input => current.current.rpc({ ...input, projectConfig: project }),
        publish: response => publishLifecycle(client, project, response),
        reconcile: async (id) => { const result = await refetch(); if (!result.data?.ok)
            throw Error('Workspace state is unavailable'); return (result.data.result as ListResult).workspaces.find(workspace => workspace.id === id) || null; },
        selection: () => current.current.project === project ? current.current.selection : '', select: id => { if (current.current.project === project) current.current.select(id); },
        notify: response => { const c = current.current; if (c.project !== project) return; c.toast.show(response.action === 'restore' ? c.copy.workspaceRestoreSuccess : response.action === 'delete' ? c.copy.workspacePermanentDeleteSuccess : c.copy.workspaceDeleteSuccess, { variant: 'success' }); void c.refetch().catch(() => { }); },
    }), [project, client]);
    const batch = useMemo(() => createWorkspaceBatch({ execute: controller.execute, busy: id => controller.snapshot().records.get(id)?.phase === 'running' }), [controller]);
    const batchState = useSyncExternalStore(batch.subscribe, batch.snapshot, batch.snapshot);
    useEffect(() => {
        batch.activate();
        let previousPhase = batch.snapshot().phase;
        const unsubscribe = batch.subscribe(() => {
            const next = batch.snapshot();
            if (previousPhase === 'running' && next.phase === 'complete') void refetch().catch(() => {});
            previousPhase = next.phase;
        });
        return () => { unsubscribe(); batch.dispose(); };
    }, [batch]);
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
    const visible = state.records.get(state.selected);
    return { batch, batchState, lifecycleWorkspaceId: state.selected, lifecycleWorkspace: visible?.target as WorkspaceSummary | undefined, lifecycleMode: visible?.mode || 'inspect' as const,
        lifecycleResponse: visible?.response || null, lifecycleError: visible?.error || null,
        lifecycleBusyWorkspaceIds: [...new Set([...state.records].filter(([, record]) => record.phase === 'running').map(([id]) => id).concat(['preview', 'confirm', 'running'].includes(batchState.phase) ? batchState.entries.map(entry => entry.target.id) : []))],
        closeLifecycle: controller.close, inspectWorkspaceLifecycle: controller.inspect, removeWorkspace: controller.remove, restoreWorkspace: controller.restore, permanentDeleteWorkspace: controller.delete };
}
