export type WorkspaceCreator = { agentId: string; name?: string; recordedAt: string };
export function workspaceCreator(value: unknown): WorkspaceCreator | undefined {
  if (!value || typeof value !== 'object') return;
  const source = value as Partial<WorkspaceCreator>;
  if (typeof source.agentId !== 'string' || !source.agentId || typeof source.recordedAt !== 'string' || !Number.isFinite(Date.parse(source.recordedAt))) return;
  return { agentId: source.agentId, recordedAt: source.recordedAt, ...(typeof source.name === 'string' && source.name ? { name: source.name } : {}) };
}
export function createdInSession(workspace: { creator?: WorkspaceCreator }, agentId: string): boolean {
  return Boolean(agentId && workspaceCreator(workspace.creator)?.agentId === agentId);
}
