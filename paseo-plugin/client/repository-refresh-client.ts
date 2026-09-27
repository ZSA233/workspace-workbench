import type { QueryClient } from '@tanstack/react-query';
import type { ObserverResponse } from '../shared/observer.ts';
import { DiffReadClient } from './diff-read-client.ts';

export type RefreshInput = { workspaceId: string; repoPath: string; historyMode: string; maxCommits: number; scope: string; commitSha?: string };
export type RefreshRegion = { state: string; phase: string; completedAt?: number; durationMs?: number; result?: any; error?: { code: string; message: string } };
export type RefreshResult = { refreshId?: string; regions?: Record<string, RefreshRegion>; acceptedAt?: number; completedAt?: number; observation?: any };
export type RefreshRpc = (params: Record<string, unknown>) => Promise<ObserverResponse>;
/** Identities, cancellation and uncertain-start recovery are shared with file reads. */
export class RepositoryRefreshClient extends DiffReadClient {
  constructor() { super(true); }
  readRefresh(key: string, input: RefreshInput, rpc: RefreshRpc, force = false, prefetch = false) {
    return this.read(key, { ...input, force, prefetch }, (_method, params) => rpc(params), true);
  }
  releaseRefresh(key: string, rpc: RefreshRpc) { this.release(key, (_method, params) => rpc(params)); }
}
export function repositoryQueryKeys(project: string, input: RefreshInput) {
  const base = ['workspace-workbench', project];
  return {
    refresh: [...base, 'repository-refresh', input.workspaceId, input.repoPath, input.historyMode, input.maxCommits, input.scope, input.commitSha || ''],
    summary: [...base, 'repository-summary', input.workspaceId, input.repoPath],
    graph: [...base, 'repository-graph', input.workspaceId, input.repoPath, input.historyMode, input.maxCommits],
    changes: [...base, 'repository-changes', input.workspaceId, input.repoPath, input.scope, input.commitSha || ''],
  };
}
export function publishRefresh(client: QueryClient, project: string, input: RefreshInput, value: RefreshResult) {
  const keys = repositoryQueryKeys(project, input);
  for (const area of ['summary', 'graph', 'changes'] as const) {
    const region = value.regions?.[area];
    if (!region?.result) continue;
    const previous = client.getQueryData<ObserverResponse>(keys[area]);
    const validatedAt = value.observation?.validatedAt;
    if (previous?.result === region.result && !validatedAt) continue;
    const result = validatedAt && region.state === 'ready'
      ? { ...region.result, observation: { ...region.result.observation, validatedAt } } : region.result;
    if ((previous?.result as any)?.observation?.validatedAt === validatedAt && previous?.result === region.result) continue;
    const before = (previous?.result as any)?.observation?.readStartedAt || 0;
    if (before > (region.result.observation?.readStartedAt || 0)) continue;
    client.setQueryData(keys[area], { ok: true, result });
    if (area === 'summary') {
      const key = ['workspace-workbench', project, 'workspace-detail', input.workspaceId];
      client.setQueryData<ObserverResponse>(key, old => {
        const detail = old?.result as any;
        if (!old?.ok || !Array.isArray(detail?.repositories)) return old;
        return { ...old, result: { ...detail, repositories: detail.repositories.map((repo: any) => repo.repoPath === input.repoPath ? { ...repo, ...region.result.repository } : repo) } };
      });
    }
  }
}
