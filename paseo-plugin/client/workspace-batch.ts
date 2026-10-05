import type { WorkspaceSummary, WorkspaceDeletionImpact } from './model.ts';
import type { WorkspaceActionState } from './workspace-actions.ts';
export type BatchAction = 'remove' | 'restore' | 'delete';
export type BatchEntry = {
  target: WorkspaceSummary;
  phase: 'queued' | 'checking' | 'eligible' | 'consent' | 'blocked' | 'running' | 'complete' | 'failed' | 'uncertain' | 'skipped';
  impact?: WorkspaceDeletionImpact;
  error?: string;
  consent: boolean;
};
export type BatchState = { open: boolean; action: BatchAction; phase: 'idle' | 'preview' | 'confirm' | 'running' | 'complete'; entries: BatchEntry[] };
export function batchEligible(workspace: WorkspaceSummary, action: BatchAction): boolean {
  return workspace.id !== 'main' && workspace.managed !== false && workspace.kind !== 'live' && workspace.kind !== 'linked-live' && (action === 'remove'
    ? ['active', 'create_failed'].includes(workspace.state)
    : action === 'delete' ? workspace.state === 'removed'
    : workspace.state === 'removed' || workspace.state === 'deletion_pending');
}
export const batchExecutable = (entry: BatchEntry) => entry.phase === 'eligible' || entry.phase === 'consent' && entry.consent;
/** One UI batch orchestrates the existing per-target write controller; no second write path. */
export function createWorkspaceBatch(deps: {
  execute(target: WorkspaceSummary, action: BatchAction | 'inspect', consent?: boolean): Promise<WorkspaceActionState>;
  busy(id: string): boolean;
}) {
  let state: BatchState = { open: false, action: 'remove', phase: 'idle', entries: [] };
  let generation = 0, stopped = false, disposed = false;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<BatchState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const update = (id: string, patch: Partial<BatchEntry>) => emit({ entries: state.entries.map(entry => entry.target.id === id ? { ...entry, ...patch } : entry) });
  async function preview(targets: WorkspaceSummary[], action: BatchAction) {
    if (disposed || state.phase === 'running' || state.phase === 'preview') return;
    const current = ++generation;
    stopped = false;
    const unique = new Map(targets.filter(target => batchEligible(target, action) && !deps.busy(target.id)).map(target => [target.id, { ...target }]));
    emit({ open: true, action, phase: action === 'delete' ? 'preview' : 'confirm', entries: [...unique.values()].map(target => ({ target, phase: action === 'delete' ? 'queued' : 'eligible', consent: false })) });
    if (action !== 'delete') return;
    for (const entry of state.entries) {
      if (disposed || current !== generation) return;
      update(entry.target.id, { phase: 'checking' });
      const result = await deps.execute(entry.target, 'inspect');
      if (disposed || current !== generation) return;
      const impact = result.response?.result as WorkspaceDeletionImpact | undefined;
      const valid = result.response?.ok && !result.response.activeTasks.length && impact?.workspaceId === entry.target.id && impact.preview === true && typeof impact.canDelete === 'boolean';
      update(entry.target.id, valid ? {
        impact, phase: impact.canDelete ? impact.requiresDataLossConfirmation ? 'consent' : 'eligible' : 'blocked',
        error: impact.canDelete ? undefined : impact.issues?.map(issue => issue.message || issue.code).join('\n') || impact.blockedReason,
      } : { phase: 'blocked', error: result.response?.activeTasks.length ? 'workspace_task_active' : result.error || 'Deletion preview unavailable' });
    }
    emit({ phase: 'confirm' });
  }
  return {
    activate() { disposed = false; },
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    preview,
    consent(id: string, value: boolean) { if (state.phase === 'confirm') update(id, { consent: value }); },
    open() { emit({ open: true }); },
    close() { if (state.phase === 'preview' || state.phase === 'confirm') { generation++; emit({ phase: 'idle', entries: [] }); } emit({ open: false }); },
    stop() { stopped = true; if (state.phase === 'running') emit({ entries: state.entries.map(entry => entry.phase === 'queued' ? { ...entry, phase: 'skipped' } : entry) }); },
    dispose() { disposed = true; stopped = true; generation++; },
    async confirm() {
      if (disposed || state.phase !== 'confirm') return;
      const action = state.action;
      const targets = state.entries.filter(batchExecutable);
      stopped = false;
      emit({ phase: 'running', entries: state.entries.map(entry => batchExecutable(entry) ? { ...entry, phase: 'queued' } : entry.phase === 'consent' ? { ...entry, phase: 'skipped' } : entry) });
      for (const entry of targets) {
        if (stopped || disposed) { update(entry.target.id, { phase: 'skipped' }); continue; }
        update(entry.target.id, { phase: 'running' });
        const result = await deps.execute(entry.target, action, entry.consent);
        const phase = result.phase === 'uncertain' ? 'uncertain'
          : result.phase === 'complete' && result.response?.action === action && !result.response.pending ? 'complete'
          : result.response?.pending ? 'blocked' : 'failed';
        update(entry.target.id, { phase, error: result.error || (result.response?.pending ? 'workspace_task_active' : undefined) });
      }
      emit({ phase: 'complete' });
    },
    async retryFailed() {
      if (state.phase !== 'complete') return;
      await preview(state.entries.filter(entry => entry.phase === 'failed').map(entry => entry.target), state.action);
    },
    async reconcileUncertain() {
      if (state.phase !== 'complete') return;
      emit({ phase: 'running' });
      for (const entry of state.entries.filter(entry => entry.phase === 'uncertain')) {
        if (disposed) break;
        // execute uses pendingWrites to reconcile; it must never replay this write.
        const result = await deps.execute(entry.target, state.action, entry.consent);
        update(entry.target.id, { phase: result.phase === 'complete' && !result.response?.pending ? 'complete' : 'uncertain', error: result.error || undefined });
      }
      emit({ phase: 'complete' });
    },
  };
}
