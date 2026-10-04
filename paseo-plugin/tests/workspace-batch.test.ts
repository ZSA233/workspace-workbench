import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceBatch, batchEligible } from '../client/workspace-batch.ts';
import { createWorkspaceActions } from '../client/workspace-actions.ts';
import type { WorkspaceSummary } from '../client/model.ts';
import type { WorkspaceLifecycleInput, WorkspaceLifecycleResponse } from '../shared/workspace-lifecycle.ts';
const workspace = (id: string, state = 'active'): WorkspaceSummary => ({ id, state, displayName: id, description: '', repositoryCount: 1, dirtyRepositoryCount: 0, dirty: false, unpushed: false, claim: null, blockerCount: 0 });
const success = (input: WorkspaceLifecycleInput): WorkspaceLifecycleResponse => ({ ok: true, workspaceId: input.workspaceId, action: input.action, activeTasks: [], state: input.action === 'restore' ? 'active' : 'removed' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(handler: (input: WorkspaceLifecycleInput) => Promise<WorkspaceLifecycleResponse>) {
  const calls: WorkspaceLifecycleInput[] = [], published: WorkspaceLifecycleResponse[] = [];
  let selection = 'a', notices = 0;
  const actual = new Map<string, WorkspaceSummary>([['a', workspace('a')], ['b', workspace('b')]]);
  const actions = createWorkspaceActions({ rpc: async input => { calls.push(input); return handler(input); }, publish: async result => { published.push(result); }, reconcile: async id => actual.get(id) || null,
    selection: () => selection, select: id => { selection = id; }, notify: () => { notices++; } });
  const batch = createWorkspaceBatch({ execute: actions.execute, busy: id => actions.snapshot().records.get(id)?.phase === 'running' });
  return { batch, actions, calls, published, actual, select: (id: string) => { selection = id; }, selection: () => selection, notices: () => notices };
}
test('eligibility excludes main and uses action-specific state', () => {
  assert.equal(batchEligible(workspace('main'), 'remove'), false);
  assert.equal(batchEligible(workspace('a', 'deletion_pending'), 'remove'), false);
  assert.equal(batchEligible(workspace('a', 'deletion_pending'), 'restore'), true);
  assert.equal(batchEligible(workspace('a'), 'delete'), false);
});
test('serial execution merges clicks, snapshots targets and preserves later selection without per-item notifications', async () => {
  const gate = deferred<WorkspaceLifecycleResponse>();
  const c = setup(async input => input.workspaceId === 'a' ? gate.promise : success(input));
  const a = workspace('a');
  await c.batch.preview([a, a, workspace('b'), workspace('main')], 'remove'); a.id = 'mutated';
  const run = c.batch.confirm(); await c.batch.confirm();
  assert.deepEqual(c.calls.map(x => x.workspaceId), ['a']);
  c.select('other'); c.batch.close();
  gate.resolve(success(c.calls[0])); await run;
  assert.deepEqual(c.calls.map(x => x.workspaceId), ['a','b']);
  assert.equal(c.selection(), 'other'); assert.equal(c.notices(), 0); assert.equal(c.actions.snapshot().selected, '');
  assert.equal(c.published.length, 2); assert.equal(c.batch.snapshot().open, false);
});
test('stop and project disposal do not interrupt in-flight writes or dispatch queued targets', async () => {
  for (const dispose of [false, true]) {
    const gate = deferred<WorkspaceLifecycleResponse>(); const c = setup(async () => gate.promise);
    await c.batch.preview([workspace('a'), workspace('b')], 'remove');
    const run = c.batch.confirm(); dispose ? c.batch.dispose() : c.batch.stop();
    gate.resolve(success(c.calls[0])); await run;
    assert.equal(c.calls.length, 1); assert.equal(c.batch.snapshot().entries[1].phase, 'skipped'); assert.equal(c.published.length, 1);
  }
});
test('definite failure continues batch and retry contains only failed targets', async () => {
  const c = setup(async input => input.workspaceId === 'a' ? { ...success(input), ok: false, error: { code: 'blocked', message: 'blocked' } } : success(input));
  await c.batch.preview([workspace('a'), workspace('b')], 'restore');
  assert.equal(c.batch.snapshot().entries.length, 0);
  await c.batch.preview([workspace('a','removed'), workspace('b','removed')], 'restore'); await c.batch.confirm();
  assert.deepEqual(c.batch.snapshot().entries.map(x => x.phase), ['failed','complete']);
  await c.batch.retryFailed(); assert.deepEqual(c.batch.snapshot().entries.map(x => x.target.id), ['a']);
});
test('uncertain write is reconciled without replay; batch can continue and later verify it', async () => {
  const c = setup(async input => { if (input.workspaceId === 'a') throw Error('RPC timed out'); return success(input); });
  await c.batch.preview([workspace('a'), workspace('b')], 'remove'); await c.batch.confirm();
  assert.equal(c.batch.snapshot().entries[0].phase, 'uncertain');
  await c.batch.reconcileUncertain(); assert.equal(c.calls.length, 2);
  c.actual.set('a', workspace('a','removed')); await c.batch.reconcileUncertain();
  assert.equal(c.calls.length, 2); assert.equal(c.batch.snapshot().entries[0].phase, 'complete');
});
test('permanent deletion requires a valid preview and individual content-loss consent', async () => {
  const c = setup(async input => input.action === 'inspect' ? { ...success(input), result: {
    workspaceId: input.workspaceId, preview: true, canDelete: input.workspaceId !== 'blocked', requiresDataLossConfirmation: input.workspaceId === 'dirty',
  } } : success(input));
  await c.batch.preview(['clean','dirty','blocked'].map(id => workspace(id,'removed')), 'delete');
  assert.deepEqual(c.batch.snapshot().entries.map(x => x.phase), ['eligible','consent','blocked']);
  await c.batch.confirm();
  assert.deepEqual(c.calls.filter(x => x.action === 'delete').map(x => x.workspaceId), ['clean']);
  await c.batch.preview([workspace('dirty','removed')], 'delete'); c.batch.consent('dirty', true); await c.batch.confirm();
  assert.equal(c.calls.at(-1)?.confirmDataLoss, true);
});
test('missing preview or active task is blocked; cancelling preview ignores late response', async () => {
  const c = setup(async input => success(input)); await c.batch.preview([workspace('a','removed')], 'delete');
  assert.equal(c.batch.snapshot().entries[0].phase, 'blocked'); await c.batch.confirm(); assert.equal(c.calls.length, 1);
  const gate = deferred<WorkspaceLifecycleResponse>(); const other = setup(async () => gate.promise);
  const preview = other.batch.preview([workspace('a','removed'), workspace('b','removed')], 'delete'); other.batch.close();
  gate.resolve(success(other.calls[0])); await preview;
  assert.equal(other.calls.length, 1); assert.equal(other.batch.snapshot().open, false);
});
test('new data-loss authorization is required on permanent deletion retry', async () => {
  let inspections = 0;
  const c = setup(async input => input.action === 'inspect' ? { ...success(input), result: { workspaceId: input.workspaceId, preview: true, canDelete: true, requiresDataLossConfirmation: !!inspections++ } }
    : { ...success(input), ok: false, error: { code: 'workspace_dirty', message: 'new content' } });
  await c.batch.preview([workspace('a','removed')], 'delete'); await c.batch.confirm(); await c.batch.retryFailed();
  assert.equal(inspections, 2); assert.equal(c.batch.snapshot().entries[0].phase, 'consent'); assert.equal(c.batch.snapshot().entries[0].consent, false);
});
test('unclassified transport exceptions after dispatch stay uncertain and cannot be retried as a failed write', async () => {
  const c = setup(async () => { throw Error('EPIPE'); });
  await c.batch.preview([workspace('a')], 'remove'); await c.batch.confirm();
  assert.equal(c.batch.snapshot().entries[0].phase, 'uncertain');
  await c.batch.reconcileUncertain(); assert.equal(c.calls.length, 1);
});
test('active operations are excluded and active tasks block permanent-delete preview', async () => {
  const gate = deferred<WorkspaceLifecycleResponse>(); const c = setup(async input => input.workspaceId === 'a' ? gate.promise : { ...success(input), activeTasks: [{ kind:'agent' }], result: { workspaceId: input.workspaceId, preview:true, canDelete:true } });
  const single = c.actions.remove(workspace('a'));
  await c.batch.preview([workspace('a'), workspace('b')], 'remove'); assert.deepEqual(c.batch.snapshot().entries.map(entry => entry.target.id), ['b']);
  c.batch.close(); gate.resolve(success(c.calls[0])); await single;
  await c.batch.preview([workspace('b','removed')], 'delete'); assert.equal(c.batch.snapshot().entries[0].phase, 'blocked'); assert.equal(c.batch.snapshot().entries[0].error, 'workspace_task_active');
});
test('closing confirmation cancels its queued intent; future batches do not inherit consent', async () => {
  const c = setup(async input => ({ ...success(input), result: { workspaceId:input.workspaceId, preview:true,canDelete:true,requiresDataLossConfirmation:true } }));
  await c.batch.preview([workspace('a','removed')], 'delete'); c.batch.consent('a',true); c.batch.close(); await c.batch.confirm();
  assert.equal(c.calls.length,1); assert.equal(c.batch.snapshot().phase,'idle');
  await c.batch.preview([workspace('a','removed')], 'delete'); assert.equal(c.batch.snapshot().entries[0].consent,false);
});
