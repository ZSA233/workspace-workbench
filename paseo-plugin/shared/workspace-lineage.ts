/** Creation provenance is metadata, never a Git operation target or permission. */
export type WorkspaceSource = { id: string; instanceKey: string; displayName: string };
export type WorkspaceLineage = {
  version: 1;
  parent: WorkspaceSource | null;
  ancestors: WorkspaceSource[];
  recordedBy: 'creation' | 'reference' | 'user' | 'gitlink';
  repositories: Array<{ repositoryId: string; baseRef: string | null; baseSha: string | null; parentHead?: string; overridden?: boolean }>;
};
export function workspaceInstanceKey(workspace: { id: string; instanceId?: string; instanceKey?: string; createdAt?: string | null; requestHash?: string; sourceRoot?: string; treePath?: string }): string {
  return workspace.instanceKey || `${workspace.id}:${workspace.instanceId || workspace.createdAt || workspace.requestHash || workspace.treePath || workspace.sourceRoot || 'legacy'}`;
}
export function workspaceSource(workspace: { id: string; displayName?: string; instanceId?: string; instanceKey?: string; createdAt?: string | null; requestHash?: string; sourceRoot?: string; treePath?: string }): WorkspaceSource {
  return { id: workspace.id, displayName: workspace.displayName || workspace.id, instanceKey: workspaceInstanceKey(workspace) };
}
/** Optional metadata must never prevent a legacy or partially edited record from rendering. */
export function readWorkspaceLineage(value: unknown): WorkspaceLineage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const source = (item: unknown): item is WorkspaceSource => Boolean(item && typeof item === 'object'
    && typeof (item as WorkspaceSource).id === 'string' && (item as WorkspaceSource).id
    && typeof (item as WorkspaceSource).instanceKey === 'string' && (item as WorkspaceSource).instanceKey
    && typeof (item as WorkspaceSource).displayName === 'string');
  if (record.version !== 1 || record.parent !== null && !source(record.parent)) return undefined;
  return { ...record, version: 1, parent: record.parent as WorkspaceSource | null,
    recordedBy: record.recordedBy === 'creation' || record.recordedBy === 'reference' || record.recordedBy === 'gitlink' ? record.recordedBy : 'user',
    ancestors: Array.isArray(record.ancestors) ? record.ancestors.filter(source) : [],
    repositories: Array.isArray(record.repositories) ? record.repositories.filter(item => item && typeof item.repositoryId === 'string') : [],
  };
}
