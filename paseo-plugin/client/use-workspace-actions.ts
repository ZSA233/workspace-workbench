import { useMemo, useRef, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRpc } from '@getpaseo/plugin/client';
import { workspaceLifecycle } from '../shared/workspace-lifecycle';
import type { ObserverResponse } from '../shared/observer';
import type { ListResult, WorkspaceSummary } from './model';
import type { WorkbenchCopy } from '../shared/copy';
import { createWorkspaceActions } from './workspace-actions';
import { publishLifecycle } from './observation-publication';
import { useToast } from './native-components';
export function useWorkspaceActions(project: string, selection: string, select: (id: string) => void, refetch: () => Promise<{
    data?: ObserverResponse;
}>, copy: WorkbenchCopy) {
    const rpc = useRpc(workspaceLifecycle), client = useQueryClient(), toast = useToast();
    const current = useRef({ rpc, selection, select, refetch, copy, toast });
    current.current = { rpc, selection, select, refetch, copy, toast };
    const controller = useMemo(() => createWorkspaceActions({
        rpc: input => current.current.rpc({ ...input, projectConfig: project }),
        publish: response => publishLifecycle(client, project, response),
        reconcile: async (id) => { const result = await current.current.refetch(); if (!result.data?.ok)
            throw Error('Workspace state is unavailable'); return (result.data.result as ListResult).workspaces.find(workspace => workspace.id === id) || null; },
        selection: () => current.current.selection, select: id => current.current.select(id),
        notify: response => { const c = current.current; c.toast.show(response.action === 'restore' ? c.copy.workspaceRestoreSuccess : response.action === 'delete' ? c.copy.workspacePermanentDeleteSuccess : c.copy.workspaceDeleteSuccess, { variant: 'success' }); void c.refetch().catch(() => { }); },
    }), [project, client]);
    const [state, setState] = useState(controller.snapshot);
    useEffect(() => { setState(controller.snapshot()); return controller.subscribe(() => setState(controller.snapshot())); }, [controller]);
    const visible = state.records.get(state.selected);
    return { lifecycleWorkspaceId: state.selected, lifecycleWorkspace: visible?.target as WorkspaceSummary | undefined, lifecycleMode: visible?.mode || 'inspect' as const,
        lifecycleResponse: visible?.response || null, lifecycleError: visible?.error || null,
        lifecycleBusyWorkspaceIds: [...state.records].filter(([, record]) => record.phase === 'running').map(([id]) => id),
        closeLifecycle: controller.close, inspectWorkspaceLifecycle: controller.inspect, removeWorkspace: controller.remove, restoreWorkspace: controller.restore, permanentDeleteWorkspace: controller.delete };
}
