import { displayedObservation } from './observation-content.ts';
import { repositoryQueryKeys, type RefreshInput, type RefreshResult } from './repository-refresh-client.ts';
import type { QueryClient } from '@tanstack/react-query';
import type { ObserverResponse } from '../shared/observer.ts';
import type { WorkspaceLifecycleResponse } from '../shared/workspace-lifecycle.ts';
import type { ListResult } from './model.ts';
export async function publishLifecycle(client: QueryClient, project: string, response: WorkspaceLifecycleResponse) {
    if (!response.ok)
        return;
    const key = ['workspace-workbench', project, 'workspace-list'];
    await client.cancelQueries({ queryKey: key, exact: true });
    client.setQueryData<ObserverResponse>(key, previous => {
        const content=displayedObservation(previous);
        if (!content?.ok) return previous;
        const list = content.result as ListResult;
        const workspaces = response.action === 'delete' ? list.workspaces.filter(w => w.id !== response.workspaceId)
            : list.workspaces.map(w => w.id === response.workspaceId && response.state ? { ...w, state: response.state, ...(['active', 'removed'].includes(response.state) ? { deletion: undefined } : {}) } : w);
        const updated={...content,result:{...list,workspaces}};
        return previous && (!previous.ok || previous!==content) ? {...previous,retainedContent:updated}:updated;
    });
}
function mergeRepository(previous: any, incoming: any, readStartedAt: number) {
    const retain = incoming.observationPending && typeof previous.dirty === 'boolean' && previous.head === incoming.head && previous.branch === incoming.branch;
    return { ...previous, ...incoming, ...(retain ? { status: previous.status, dirty: previous.dirty, dirtyPaths: previous.dirtyPaths, workingChanges: previous.workingChanges, changes: previous.changes, basicOnly: previous.basicOnly, issues: previous.issues, observationStale: previous.observationStale } : {}), readStartedAt };
}
export function publishRefresh(client: QueryClient, project: string, input: RefreshInput, value: RefreshResult) {
    const keys = repositoryQueryKeys(project, input);
    for (const area of ['summary', 'graph', 'changes'] as const) {
        const region = value.regions?.[area];
        if (!region?.result || ['failed', 'cancelled'].includes(region.state))
            continue;
        const previous = client.getQueryData<ObserverResponse>(keys[area]);
        const summary = Number((previous?.result as any)?.observation?.readStartedAt || 0) > Number(region.result.observation?.readStartedAt || 0) ? previous!.result as any : region.result;
        if (area === 'summary') {
            const key = ['workspace-workbench', project, 'workspace-detail', input.workspaceId];
            client.setQueryData<ObserverResponse>(key, old => {
                const detail = old?.result as any;
                if (!old?.ok || !Array.isArray(detail?.repositories))
                    return old;
                return { ...old, result: { ...detail, repositories: detail.repositories.map((repo: any) => repo.repoPath === input.repoPath && Number(repo.readStartedAt || 0) <= Number(summary.observation?.readStartedAt || 0) ? mergeRepository(repo, summary.repository, Number(summary.observation?.readStartedAt || 0)) : repo) } };
            });
        }
        const validatedAt = value.observation?.validatedAt;
        if (previous?.result === region.result && !validatedAt)
            continue;
        const result = validatedAt && region.state === 'ready'
            ? { ...region.result, observation: { ...region.result.observation, validatedAt } } : region.result;
        if ((previous?.result as any)?.observation?.validatedAt === validatedAt && previous?.result === region.result)
            continue;
        const before = (previous?.result as any)?.observation?.readStartedAt || 0;
        if (before > (region.result.observation?.readStartedAt || 0))
            continue;
        const published = area === 'summary' && (previous?.result as any)?.repository
            ? { ...result, repository: mergeRepository((previous!.result as any).repository, result.repository, Number(result.observation?.readStartedAt || 0)) } : result;
        client.setQueryData(keys[area], { ok: true, result: published });
        if (area === 'changes' && region.state === 'ready' && result.scope === 'working') {
            client.setQueryData<ObserverResponse>(['workspace-workbench', project, 'workspace-detail', input.workspaceId], old => {
                const detail = old?.result as any;
                if (!old?.ok || !Array.isArray(detail?.repositories))
                    return old;
                return { ...old, result: { ...detail, repositories: detail.repositories.map((repo: any) => repo.repoPath === input.repoPath && repo.head === result.head && Number(repo.readStartedAt || 0) <= Number(result.observation?.readStartedAt || 0) ? { ...repo, workingChanges: result.summary } : repo) } };
            });
        }
    }
}
/** A roster can arrive after its leaf query; reconcile at consumption as well as publication. */
export function hydrateRepositorySummaries<T extends {
    workspace: {
        id: string;
    };
    repositories: any[];
}>(client: QueryClient, project: string, detail: T): T {
    let changed = false;
    const repositories = detail.repositories.map(repo => {
        const cached = client.getQueryData<ObserverResponse>(['workspace-workbench', project, 'repository-summary', detail.workspace.id, repo.repoPath]);
        const result = cached?.ok ? cached.result as any : null;
        if (!result?.repository)
            return repo;
        const previous = Number(repo.readStartedAt || Date.parse(repo.observedAt || '') || 0);
        const next = Number(result.observation?.readStartedAt || 0);
        if (previous > next || previous === next && repo.observationPending === result.repository.observationPending && repo.branch === result.repository.branch && repo.dirty === result.repository.dirty)
            return repo;
        changed = true;
        return mergeRepository(repo, result.repository, next);
    });
    return changed ? { ...detail, repositories } : detail;
}
/** A late failed summary cannot downgrade a newer successful repository snapshot. */
export function publishSummaryFailure(client: QueryClient, project: string, input: RefreshInput, response: ObserverResponse | undefined, error: {
    code: string;
    message: string;
}) {
    const started = Number((response?.result as RefreshResult | undefined)?.acceptedAt || (response?.result as any)?.observation?.readStartedAt || 0);
    client.setQueryData<ObserverResponse>(['workspace-workbench', project, 'workspace-detail', input.workspaceId], old => {
        const detail = old?.result as any;
        if (!old?.ok || !Array.isArray(detail?.repositories))
            return old;
        return { ...old, result: { ...detail, repositories: detail.repositories.map((repo: any) => {
                    if (repo.repoPath !== input.repoPath || Number(repo.readStartedAt || 0) > started)
                        return repo;
                    return { ...repo, observationPending: false, observationStale: true, issues: [...(repo.issues || []).filter((issue: any) => issue.source !== 'basic-observation'), { ...error, source: 'basic-observation' }] };
                }) } };
    });
}
