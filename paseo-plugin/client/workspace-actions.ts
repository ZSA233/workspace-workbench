import type { WorkspaceSummary } from './model.ts';
import type { WorkspaceLifecycleInput, WorkspaceLifecycleResponse } from '../shared/workspace-lifecycle.ts';
export type WorkspaceActionState = {
    target: WorkspaceSummary;
    mode: 'inspect' | 'permanent';
    phase: 'idle' | 'running' | 'uncertain' | 'failed' | 'complete';
    response: WorkspaceLifecycleResponse | null;
    error: string | null;
};
type Dependencies = {
    rpc(input: WorkspaceLifecycleInput): Promise<WorkspaceLifecycleResponse>;
    publish(response: WorkspaceLifecycleResponse): Promise<void>;
    reconcile(id: string): Promise<WorkspaceSummary | null>;
    selection(): string;
    select(id: string): void;
    notify(response: WorkspaceLifecycleResponse): void;
};
const uncertain = (code: string) => /uncertain|timeout|timed out|unavailable|connection|socket/i.test(code);
/** The target owns the operation; current UI selection is read only at completion. */
export function createWorkspaceActions(deps: Dependencies) {
    const records = new Map<string, WorkspaceActionState>(), flights = new Map<string, Promise<void>>(), listeners = new Set<() => void>();
    const pendingWrites = new Map<string, WorkspaceLifecycleInput['action']>();
    let selected = '', intent = 0, snapshot = { selected, records: new Map(records) };
    const emit = () => { snapshot = { selected, records: new Map(records) }; for (const listener of listeners)
        listener(); };
    const update = (id: string, patch: Partial<WorkspaceActionState>) => { records.set(id, { ...records.get(id)!, ...patch }); emit(); };
    const reconcile = async (id: string, action: WorkspaceLifecycleInput['action']): Promise<WorkspaceLifecycleResponse | null> => {
        const target = await deps.reconcile(id);
        const complete = action === 'delete' ? !target : target?.state === (action === 'restore' ? 'active' : 'removed');
        return complete ? { ok: true, workspaceId: id, action, state: target?.state, activeTasks: [] } : null;
    };
    async function perform(target: WorkspaceSummary, action: WorkspaceLifecycleInput['action'], confirmDataLoss = false) {
        if (flights.has(target.id))
            return flights.get(target.id);
        const prior = records.get(target.id), actionIntent = intent;
        const reveal = () => { if (intent === actionIntent) {
            selected = target.id;
            emit();
        } };
        records.set(target.id, { target, mode: action === 'delete' ? 'permanent' : prior?.mode || 'inspect', phase: 'running', response: null, error: null });
        emit();
        const run = (async () => {
            let response: WorkspaceLifecycleResponse;
            try {
                if (action !== 'inspect' && pendingWrites.has(target.id)) {
                    const known = await reconcile(target.id, pendingWrites.get(target.id)!);
                    if (!known)
                        throw Error('Operation outcome remains uncertain; inspect the Workspace before retrying');
                    response = known;
                }
                else {
                    if (action !== 'inspect')
                        pendingWrites.set(target.id, action);
                    response = await deps.rpc({ workspaceId: target.id, action, ...(action === 'delete' ? { confirm: true, confirmDataLoss } : {}) });
                }
                if (!response.ok) {
                    const message = response.error?.message || 'Workspace operation failed';
                    update(target.id, { response, error: message, phase: uncertain(response.error?.code || message) ? 'uncertain' : 'failed' });
                    if (uncertain(response.error?.code || message)) {
                        const known = await reconcile(target.id, action);
                        if (!known) {
                            reveal();
                            return;
                        }
                        response = known;
                    }
                    else {
                        pendingWrites.delete(target.id);
                        reveal();
                        return;
                    }
                }
                if (action !== 'inspect') {
                    await deps.publish(response);
                    pendingWrites.delete(target.id);
                }
                update(target.id, { response, phase: 'complete', error: null });
                if (action === 'inspect' || response.pending) {
                    reveal();
                }
                else {
                    if (['remove', 'delete'].includes(response.action) && deps.selection() === target.id)
                        deps.select('main');
                    if (selected === target.id) {
                        selected = '';
                        emit();
                    }
                    deps.notify(response);
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const retry = uncertain(message);
                update(target.id, { phase: retry ? 'uncertain' : 'failed', error: message, response: { ok: false, workspaceId: target.id, action, activeTasks: [], error: { code: retry ? 'request_uncertain_retry_same_identity' : 'workspace_operation_failed', message } } });
                reveal();
                if (retry && action !== 'inspect') {
                    try {
                        const known = await reconcile(target.id, action);
                        if (known) {
                            await deps.publish(known);
                            pendingWrites.delete(target.id);
                            update(target.id, { phase: 'complete', response: known, error: null });
                            if (['remove', 'delete'].includes(action) && deps.selection() === target.id)
                                deps.select('main');
                            if (selected === target.id) {
                                selected = '';
                                emit();
                            }
                            deps.notify(known);
                        }
                    }
                    catch { }
                }
            }
        })();
        flights.set(target.id, run);
        try {
            await run;
        }
        finally {
            if (flights.get(target.id) === run)
                flights.delete(target.id);
        }
    }
    return {
        snapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        close() { if (records.get(selected)?.phase !== 'running') {
            intent++;
            selected = '';
            emit();
        } },
        inspect(target: WorkspaceSummary, mode: 'inspect' | 'permanent' = 'inspect') {
            intent++;
            selected = target.id;
            if (flights.has(target.id)) {
                emit();
                return flights.get(target.id)!;
            }
            records.set(target.id, { target, mode, phase: 'idle', response: null, error: null });
            emit();
            return perform(target, 'inspect');
        },
        remove: (target: WorkspaceSummary) => perform(target, 'remove'), restore: (target: WorkspaceSummary) => perform(target, 'restore'),
        delete: (confirmDataLoss: boolean) => { const target = records.get(selected)?.target; return target ? perform(target, 'delete', confirmDataLoss) : Promise.resolve(); },
    };
}
