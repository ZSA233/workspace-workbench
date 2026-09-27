import { DEFAULT_OBSERVATION_TIMING } from '../shared/observation-timing.ts';
import type { QueryClient } from '@tanstack/react-query';
import type { ObserverResponse } from '../shared/observer.ts';
import { observationMeta, type QueryView } from './observation-coordinator.ts';
const eventKinds = new Set(['agent-review', 'agent-review-history', 'execution-binding', 'agent-context']);
const kinds = new Set([...eventKinds, 'workspace-list', 'workspace-detail', 'repository-refresh', 'repository-summary', 'repository-graph', 'repository-changes', 'file-review', 'review']);

function queryKind(key: readonly unknown[], project: string): string {
  if (key[0] !== 'workspace-workbench') return '';
  if (key[1] === project) return String(key[2]);
  return key[1] === 'file-review' && key[2] === project ? 'file-review' : '';
}

export function observationQueries(client: QueryClient, project: string): QueryView[] {
  const roster = client.getQueryData<ObserverResponse>(['workspace-workbench', project, 'workspace-list']);
  const workspaces = (roster?.result as { workspaces?: { id: string }[] } | undefined)?.workspaces;
  if (roster?.ok && observationMeta(roster).state === 'ready' && Array.isArray(workspaces)) {
    const ids = new Set(workspaces.map(workspace => workspace.id));
    for (const q of client.getQueryCache().getAll()) {
      if (q.isActive() || !kinds.has(queryKind(q.queryKey, project))) continue;
      const result = (q.state.data as ObserverResponse | undefined)?.result as { workspaceId?: string; workspace?: { id?: string } } | undefined;
      const id = result?.workspaceId || result?.workspace?.id;
      if (id && !ids.has(id)) client.getQueryCache().remove(q);
    }
  }
  return client.getQueryCache().getAll().filter(q => kinds.has(queryKind(q.queryKey, project))).map(q => {
    const kind = queryKind(q.queryKey, project);
    const area = kind === 'review' ? 'review' : kind === 'workspace-list' ? 'list' : kind === 'workspace-detail' ? 'detail' : 'repository';
    return {
      id: q.queryHash,
      key: q.queryKey,
      validationWindowMs: DEFAULT_OBSERVATION_TIMING.staleWindowsMs[area],
      eventOnly: eventKinds.has(kind),
      active: q.isActive(),
      fetching: q.state.fetchStatus !== 'idle',
      data: q.state.data as ObserverResponse | undefined,
      error: q.state.error,
      updatedAt: q.state.dataUpdatedAt,
      fetch: () => q.fetch(undefined, { cancelRefetch: false }),
      validate: at => {
        const old = q.state.data as ObserverResponse | undefined;
        if (!old?.ok || observationMeta(old).validatedAt === at) return;
        const result = old.result as Record<string, unknown>;
        q.setData({ ...old, result: { ...result, observation: { ...observationMeta(old), validatedAt: at } } }, { updatedAt: q.state.dataUpdatedAt, manual: true });
      },
    };
  });
}
