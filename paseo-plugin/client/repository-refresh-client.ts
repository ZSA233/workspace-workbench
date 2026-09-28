import type { QueryClient } from '@tanstack/react-query';
import type { ObserverResponse } from '../shared/observer.ts';
import { createDiffReadClient } from './diff-read-client.ts';

export type RefreshInput = { workspaceId: string; repoPath: string; historyMode: string; maxCommits: number; scope: string; commitSha?: string; summaryOnly?: boolean };
export type RefreshRegion = { state: string; phase: string; completedAt?: number; durationMs?: number; result?: any; error?: { code: string; message: string } };
export type RefreshResult = { refreshId?: string; regions?: Record<string, RefreshRegion>; acceptedAt?: number; completedAt?: number; observation?: any };
export type RefreshRpc = (params: Record<string, unknown>) => Promise<ObserverResponse>;
/** Identities, cancellation and uncertain-start recovery are shared with file reads. */
export function createRepositoryRefreshClient() {
  // Dynamic source evaluation on Hermes cannot safely construct these classes.
  // Keep the transport adapter composed with the shared request lifecycle.
  const reader = createDiffReadClient(true);
  return {
    readRefresh(key: string, input: RefreshInput, rpc: RefreshRpc, force = false, prefetch = false) {
      return reader.read(key, { ...input, force, prefetch }, (_method, params) => rpc(params), true);
    },
    releaseRefresh(key: string, rpc: RefreshRpc) { reader.release(key, (_method, params) => rpc(params)); },
    retry: reader.retry,
  };
}
export function repositoryQueryKeys(project: string, input: RefreshInput) {
  const base = ['workspace-workbench', project];
  return {
    refresh: [...base, 'repository-refresh', input.workspaceId, input.repoPath, input.historyMode, input.maxCommits, input.scope, input.commitSha || '', input.summaryOnly ? 'summary' : 'all'],
    summary: [...base, 'repository-summary', input.workspaceId, input.repoPath],
    graph: [...base, 'repository-graph', input.workspaceId, input.repoPath, input.historyMode, input.maxCommits],
    changes: [...base, 'repository-changes', input.workspaceId, input.repoPath, input.scope, input.commitSha || ''],
  };
}
function mergeRepository(previous: any, incoming: any, readStartedAt: number) {
  const retain = incoming.observationPending && typeof previous.dirty === 'boolean' && previous.head === incoming.head && previous.branch === incoming.branch;
  return {...previous,...incoming,...(retain ? {status:previous.status,dirty:previous.dirty,dirtyPaths:previous.dirtyPaths,workingChanges:previous.workingChanges,changes:previous.changes,basicOnly:previous.basicOnly,issues:previous.issues,observationStale:previous.observationStale} : {}),readStartedAt};
}
export function publishRefresh(client: QueryClient, project: string, input: RefreshInput, value: RefreshResult) {
  const keys = repositoryQueryKeys(project, input);
  for (const area of ['summary', 'graph', 'changes'] as const) {
    const region = value.regions?.[area];
    if (!region?.result) continue;
    const previous = client.getQueryData<ObserverResponse>(keys[area]);
    const summary = Number((previous?.result as any)?.observation?.readStartedAt || 0) > Number(region.result.observation?.readStartedAt || 0) ? previous!.result as any : region.result;
    if (area === 'summary') {
      const key = ['workspace-workbench', project, 'workspace-detail', input.workspaceId];
      client.setQueryData<ObserverResponse>(key, old => {
        const detail = old?.result as any;
        if (!old?.ok || !Array.isArray(detail?.repositories)) return old;
        return { ...old, result: { ...detail, repositories: detail.repositories.map((repo: any) => repo.repoPath === input.repoPath && Number(repo.readStartedAt || 0) <= Number(summary.observation?.readStartedAt || 0) ? mergeRepository(repo, summary.repository, Number(summary.observation?.readStartedAt || 0)) : repo) } };
      });
    }
    const validatedAt = value.observation?.validatedAt;
    if (previous?.result === region.result && !validatedAt) continue;
    const result = validatedAt && region.state === 'ready'
      ? { ...region.result, observation: { ...region.result.observation, validatedAt } } : region.result;
    if ((previous?.result as any)?.observation?.validatedAt === validatedAt && previous?.result === region.result) continue;
    const before = (previous?.result as any)?.observation?.readStartedAt || 0;
    if (before > (region.result.observation?.readStartedAt || 0)) continue;
    const published = area === 'summary' && (previous?.result as any)?.repository
      ? {...result,repository:mergeRepository((previous!.result as any).repository,result.repository,Number(result.observation?.readStartedAt || 0))} : result;
    client.setQueryData(keys[area], { ok: true, result:published });
    if(area === 'changes' && region.state === 'ready' && result.scope === 'working') {
      client.setQueryData<ObserverResponse>(['workspace-workbench',project,'workspace-detail',input.workspaceId],old=>{
        const detail=old?.result as any;if(!old?.ok || !Array.isArray(detail?.repositories))return old;
        return {...old,result:{...detail,repositories:detail.repositories.map((repo:any)=>repo.repoPath===input.repoPath && repo.head===result.head && Number(repo.readStartedAt || 0)<=Number(result.observation?.readStartedAt || 0) ? {...repo,workingChanges:result.summary} : repo)}};
      });
    }

  }
}

/** A roster can arrive after its leaf query; reconcile at consumption as well as publication. */
export function hydrateRepositorySummaries<T extends {workspace:{id:string};repositories:any[]}>(client: QueryClient, project: string, detail: T): T {
  let changed=false;
  const repositories=detail.repositories.map(repo=>{
    const cached=client.getQueryData<ObserverResponse>(['workspace-workbench',project,'repository-summary',detail.workspace.id,repo.repoPath]);
    const result=cached?.ok ? cached.result as any : null;
    if(!result?.repository) return repo;
    const previous=Number(repo.readStartedAt || Date.parse(repo.observedAt || '') || 0);
    const next=Number(result.observation?.readStartedAt || 0);
    if(previous>next || previous===next && repo.observationPending===result.repository.observationPending && repo.branch===result.repository.branch && repo.dirty===result.repository.dirty) return repo;
    changed=true;return mergeRepository(repo,result.repository,next);
  });
  return changed ? {...detail,repositories} : detail;
}
