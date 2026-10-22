import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTransferStore } from '../client/files-store.ts';
import { checksum, encode } from '../client/files-platform.ts';
import type { FileTask } from '../shared/files.ts';

test('a partially written save never completes; only a closed writer permits the receipt', async () => {
  const web = globalThis as any, originalPicker = web.showSaveFilePicker, originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } });
  const bytes = new TextEncoder().encode('saved content'), events: string[] = [];
  let fail = true;
  web.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { events.push('write'); }, close: async () => { events.push('close'); if (fail) throw new Error('save cancelled'); }, abort: async () => { events.push('abort'); } }) });
  const task: FileTask = { id: 'save', direction: 'download', workspaceId: 'w', instance: 'one', workspaceName: 'W', path: '', name: 'file', size: bytes.length, offset: 0, state: 'active', createdAt: 1, updatedAt: 1 };
  const store = new FileTransferStore('save-test');
  const unbind = store.bind(async input => {
    if (input.action === 'tasks') return { tasks: [task], temporaryBytes: 0, incompleteTasks: 1 };
    if (input.action === 'read') return { data: encode(bytes), offset: 0, size: bytes.length, sha256: checksum(bytes) };
    if (input.action === 'ack') { events.push('ack'); task.offset = input.offset; task.state = 'ready_to_save'; return { ...task }; }
    if (input.action === 'control') { assert.equal(input.command, 'complete'); events.push('complete'); task.state = 'complete'; return { ...task }; }
    throw new Error('Unexpected request');
  });
  try {
    await store.poll(); await store.save(task.id);
    assert.deepEqual(events, ['write', 'close', 'abort']); assert.equal(task.offset, 0); assert.equal(task.state, 'active');
    events.length = 0; fail = false; await store.save(task.id);
    assert.deepEqual(events, ['write', 'close', 'ack', 'complete']); assert.equal(task.state, 'complete');
  } finally { unbind(); web.showSaveFilePicker = originalPicker; if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete web.navigator; }
});

test('an explicit batch choice handles later initial conflicts but never accepts new target changes', async () => {
  let task: FileTask | undefined, controls: string[] = [];
  const store = new FileTransferStore('batch-policy-test');
  const unbind = store.bind(async input => {
    if (input.action === 'tasks') return { tasks: task ? [{ ...task }] : [], incompleteTasks: task ? 1 : 0, temporaryBytes: 0 };
    if (input.action === 'mutate') { task = { id: input.id, batchId: input.batchId, direction: 'operation', workspaceId: 'w', workspaceName: 'W', instance: 'one', path: '', name: 'a', size: null, offset: 0, state: 'queued', createdAt: 1, updatedAt: 1 }; return { ...task }; }
    if (input.action === 'control') { controls.push(input.command); task!.state = 'queued'; return { ...task! }; }
    throw new Error('Unexpected request');
  });
  try {
    await store.poll(); await store.operation({ operation: 'copy', entries: [{ workspaceId: 'w', path: 'a' }], destination: { workspaceId: 'w', path: '' } }); await store.poll();
    store.applyBatchPolicy(task!.batchId!, 'replace');
    task!.state = 'conflict'; task!.conflict = 'exists'; await store.poll(); assert.deepEqual(controls, ['replace']);
    task!.state = 'conflict'; task!.conflict = 'changed'; await store.poll(); assert.deepEqual(controls, ['replace']);
    task!.conflict = 'exists'; task!.canReplace = false; await store.poll(); assert.deepEqual(controls, ['replace']);
  } finally { unbind(); }
});
