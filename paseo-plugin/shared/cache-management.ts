/** Cache providers own tool semantics; the UI consumes this tool-neutral model. */
export type CacheLabel = { en: string; zh: string };
export type CacheScope = 'global' | 'project' | 'workspace';
export type CacheUsage = { bytes: number | null; uniqueBytes?: number; state: 'pending' | 'ready' | 'partial' | 'failed' | 'missing'; observedAt?: number; error?: string };
export type CacheReference = { projectConfig: string; workspaceId: string; instance: string; displayName: string };
export type CacheResource = {
  id: string; providerId: string; providerLabel: CacheLabel; kind: string; kindLabel: CacheLabel;
  scope: CacheScope; displayPath: string; paths: string[]; references: CacheReference[];
  cleanup: { action: string; label: CacheLabel; available: boolean; reason?: string };
  usage: CacheUsage;
};
export type CacheWorkspaceUsage = { id: string; instance: string; displayName: string; path: string; state: string; usage: CacheUsage; resourceIds: string[] };
export type CacheTask = {
  protocol: 1; taskId: string; generation: string; requestId: string; kind: 'scan' | 'cleanup';
  state: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  phase: string; acceptedAt: number; updatedAt: number; completed: number; total: number;
  resourceId?: string; error?: string;
};
export type CacheSnapshot = {
  protocol: 1; projectConfig: string; observedAt?: number; state: 'empty' | 'ready' | 'partial';
  resources: CacheResource[]; workspaces: CacheWorkspaceUsage[]; totalBytes: number | null; workspaceTotalBytes?: number | null; errors: string[];
};
export type CacheListResult = CacheSnapshot & { task?: CacheTask; stale: boolean };
export type CacheCleanupPreview = { previewId: string; expiresAt: number; resource: CacheResource; affectedProjects: string[] };
export const cacheTaskActive = (task?: CacheTask) => task?.state === 'queued' || task?.state === 'running';
export const cacheLabel = (label: CacheLabel, locale: string) => locale === 'zh-CN' ? label.zh : label.en;
