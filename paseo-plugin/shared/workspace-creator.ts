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

/** Cached record metadata only; never infer creators from execution bindings. */
export function workspaceCreators(workspaces: readonly {id:string;creator?:WorkspaceCreator}[]) {
  const sessions = new Map<string, WorkspaceCreator & {count:number}>();
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    const creator = workspaceCreator(workspace.creator);
    if (!creator) continue;
    const previous = sessions.get(creator.agentId);
    const snapshot = previous && Date.parse(previous.recordedAt) > Date.parse(creator.recordedAt) ? previous : creator;
    sessions.set(creator.agentId, {...snapshot, name:snapshot.name || previous?.name || creator.name, count:(previous?.count || 0)+1});
  }
  return [...sessions.values()].sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.agentId.localeCompare(b.agentId));
}
