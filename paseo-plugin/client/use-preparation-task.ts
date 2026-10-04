import { uncertainControlFailure } from "../shared/task-state.ts";
import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ObserverResponse } from '../shared/observer.ts';
import { observationQueryOptions } from './observation-content.ts';
type Rpc = (input: any) => Promise<ObserverResponse>;
export function usePreparationTask(project: string, workspaceId: string, enabled: boolean, rpc: Rpc) {
    const client = useQueryClient();
    const uncertain = useRef(new Map<string, any>());
    const scope = JSON.stringify([project, workspaceId]);
    const key = ['workspace-workbench', project, 'workspace-prepare', workspaceId];
    const decorate = (response: ObserverResponse): ObserverResponse => {
        if (!response.ok && !uncertainControlFailure(response.error?.code))
            return { ...response, error: { ...response.error!, details: { ...(response.error?.details as object || {}), terminal: true } } };
        const task = response.result as any;
        return response.ok && task ? { ...response, result: { ...task, observation: { state: 'ready', ...(['queued', 'running'].includes(task.state) ? { readTask: { state: task.state, nextPollMs: 1000, deadline: Date.now() + 300000 } } : {}) } } } : response;
    };
    const query = useQuery({ queryKey: key, enabled, ...observationQueryOptions, queryFn: async () => {
            const request = uncertain.current.get(scope);
            const response = await rpc({ method: 'workspace.prepare.task', params: request || { action: 'status', workspaceId } });
            if (response.ok || !uncertainControlFailure(response.error?.code))
                uncertain.current.delete(scope);
            return decorate(response);
        } });
    const task = query.data?.result as any;
    const start = async (repositories: string[]) => {
        const request = uncertain.current.get(scope) || { action: ['failed', 'interrupted'].includes(task?.state) ? 'continue' : 'start', operationId: task?.operationId, workspaceId, repositories, requestId: `prepare:${Date.now()}:${Math.random().toString(36).slice(2)}` };
        uncertain.current.set(scope, request);
        try {
            const response = await rpc({ method: 'workspace.prepare.task', params: request });
            if (response.ok || !uncertainControlFailure(response.error?.code))
                uncertain.current.delete(scope);
            client.setQueryData(key, decorate(response));
        }
        catch {
            client.setQueryData(key, { ok: true, result: { state: 'recovering', observation: { state: 'ready', readTask: { state: 'connecting', nextPollMs: 1000, deadline: Date.now() + 300000 } } } });
        }
    };
    return { start, task, busy: ['queued', 'running', 'recovering'].includes(task?.state), error: query.error || query.data?.error };
}
