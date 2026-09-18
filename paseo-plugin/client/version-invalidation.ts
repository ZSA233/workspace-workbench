import type { ObserverResponse } from '../shared/observer';

export type Versions = {
  instanceId: string; revision: number; rosterRevision?: number;
  reviewRevision?: string; sessionRevision?: string;
  tokens?: Record<string, string>;
  workspaceVersions?: Record<string, number>;
  repositoryVersions?: Record<string, number>;
  hostTransport?: { state: string };
};

function changedKeys<T>(before: Record<string, T> = {}, after: Record<string, T> = {}): Set<string> {
  return new Set(Object.keys(after).filter(key => before[key] !== undefined && before[key] !== after[key]));
}

export function versionDelta(previous: Versions | null, value: Versions) {
  const reset = !previous || previous.instanceId !== value.instanceId;
  const roster = reset || value.rosterRevision !== undefined && previous?.rosterRevision !== value.rosterRevision;
  const tokens = changedKeys(previous?.tokens, value.tokens);
  const workspaces = changedKeys(previous?.workspaceVersions, value.workspaceVersions);
  const repositories = changedKeys(previous?.repositoryVersions, value.repositoryVersions);
  for (const key of tokens) if (key.startsWith('workspace:')) workspaces.add(key.slice('workspace:'.length));
  return { reset, roster, tokens, workspaces, repositories,
    fallback: value.rosterRevision === undefined && previous?.revision !== value.revision,
    review: reset || previous?.reviewRevision !== value.reviewRevision,
    session: reset || previous?.sessionRevision !== value.sessionRevision };
}

export function shouldRefreshVersionedQuery(projectConfig: string, delta: ReturnType<typeof versionDelta>, key: readonly unknown[], data: ObserverResponse | undefined, active: boolean) {
  if (!active || key[0] !== 'workspace-workbench' || !key.includes(projectConfig)) return false;
  const kind = key.map(String);
  if (delta.reset) return kind.some(part => ['workspace-list', 'workspace-detail', 'repository-graph', 'repository-changes', 'file-review', 'review', 'agent-review', 'agent-review-history', 'execution-binding', 'agent-context'].includes(part));
  if (key.includes('execution-binding') || key.includes('agent-context')) return delta.session;
  if (key.includes('agent-review') || key.includes('agent-review-history')) return delta.review;
  if (key.includes('workspace-list')) return delta.roster || delta.fallback;
  const observation = (data?.result as { observation?: { validationKey?: string } } | undefined)?.observation;
  const validationKey = observation?.validationKey;
  const repository = validationKey?.split('#')[0];
  if (validationKey && delta.tokens.has(validationKey)) return true;
  if (repository && delta.repositories.has(repository)) return true;
  if (key.includes('workspace-detail')) return delta.workspaces.has(String(key[key.indexOf('workspace-detail') + 1]));
  if (key.includes('review')) return key.some(part => typeof part === 'string' && delta.workspaces.has(part) || Array.isArray(part) && part.some(id => delta.workspaces.has(String(id))));
  return delta.fallback || [...delta.workspaces].some(id => key.includes(id)) && !validationKey;
}
