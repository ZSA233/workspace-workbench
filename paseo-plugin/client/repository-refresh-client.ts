import type { ObserverResponse } from '../shared/observer.ts';
import { createDiffReadClient } from './diff-read-client.ts';

export type RefreshInput = { workspaceId: string; repoPath: string; historyMode: string; maxCommits: number; scope: string; commitSha?: string; summaryOnly?: boolean };
export type RefreshRegion = { state: string; phase: string; completedAt?: number; durationMs?: number; result?: any; error?: { code: string; message: string }; recovery?: {retryable:boolean;stage:string;requestId:string} };
export type RefreshResult = { outcome?: 'ready' | 'partial-failure'; refreshId?: string; regions?: Record<string, RefreshRegion>; acceptedAt?: number; completedAt?: number; observation?: any };
export type RefreshRpc = (params: Record<string, unknown>) => Promise<ObserverResponse>;
export function refreshRegionFeedback(response: ObserverResponse | undefined, area: 'graph' | 'changes', hasContent: boolean, prerequisiteFailed = false) {
  const region = (response?.result as RefreshResult | undefined)?.regions?.[area];
  const failed = region?.state === 'ready' ? false : response?.ok === false || prerequisiteFailed || !!region && ['failed', 'cancelled'].includes(region.state);
  return {failed, loading: !hasContent && !failed && (!response || !region || ['queued', 'running'].includes(region.state))};
}
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
