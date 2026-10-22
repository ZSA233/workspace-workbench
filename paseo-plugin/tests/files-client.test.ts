import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTransferStore } from '../client/files-store.ts';
import { checksum, encode } from '../client/files-platform.ts';
import type { FileTask } from '../shared/files.ts';
const eventually = async (check: () => boolean) => { for (let n = 0; n < 200 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check(), 'expected transfer state'); };

test('Download chooses a path before its first RPC and saves automatically only after the writer closes', async () => {
  const web = globalThis as any, originalPicker = web.showSaveFilePicker, originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: {} } });
  const events: string[] = [], bytes = new TextEncoder().encode('automatic download');
  let choose!: (value: any) => void, task: FileTask | undefined;
  web.showSaveFilePicker = (options: any) => { assert.equal(options.suggestedName, 'download.txt'); events.push('picker'); return new Promise(resolve => { choose = resolve; }); };
  const store = new FileTransferStore('initial-destination-test');
  const unbind = store.bind(async input => {
    if (input.action === 'tasks') return { tasks: task ? [structuredClone(task)] : [], temporaryBytes: 0 };
    if (input.action === 'download') { events.push('create'); task = { id: input.id, direction: 'download', workspaceId: input.workspaceId, instance: input.instance, workspaceName: 'W', path: '', name: 'download.txt', size: null, offset: 0, state: 'preparing', createdAt: 1, updatedAt: 1 }; return structuredClone(task); }
    if (input.action === 'read') { events.push('read'); return { data: encode(bytes), offset: 0, size: bytes.length, sha256: checksum(bytes) }; }
    if (input.action === 'ack') { events.push('ack'); task!.offset = input.offset; task!.state = 'ready_to_save'; task!.updatedAt++; return structuredClone(task); }
    if (input.action === 'control') { assert.equal(input.command, 'complete'); events.push('complete'); task!.state = 'complete'; task!.updatedAt++; return structuredClone(task); }
    throw Error('Unexpected request: ' + input.action);
  });
  try {
    await store.poll();
    const download = store.download('w', 'instance-one', ['download.txt'], 'download.txt');
    assert.deepEqual(events, ['picker'], 'a network await must not consume the initial user gesture');
    choose({ createWritable: async () => { events.push('writer'); return { write: async () => { events.push('write'); }, close: async () => { assert.notEqual(task?.state, 'complete'); events.push('close'); }, abort: async () => events.push('abort') }; } });
    await download; assert.deepEqual(events, ['picker', 'create'], 'preparation must not open the destination writer');
    task!.state = 'active'; task!.size = bytes.length; task!.updatedAt++;
    await store.poll(); await eventually(() => task?.state === 'complete');
    assert.deepEqual(events, ['picker', 'create', 'writer', 'read', 'write', 'close', 'ack', 'complete']);
    assert.equal(store.getSnapshot().tasks[0].destinationSelected, false);
  } finally { unbind(); web.showSaveFilePicker = originalPicker; if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete web.navigator; }
});

test('cancelling the initial save picker creates no remote download or queue entry', async () => {
  const web = globalThis as any, originalPicker = web.showSaveFilePicker;
  web.showSaveFilePicker = async () => { throw new DOMException('User cancelled', 'AbortError'); };
  const store = new FileTransferStore('cancel-initial-picker'); let created = 0;
  const unbind = store.bind(async input => { if (input.action === 'tasks') return { tasks: [], temporaryBytes: 0 }; created++; throw new Error('No transfer should be created'); });
  try { await store.download('w', 'one', ['a'], 'a'); assert.equal(created, 0); assert.equal(store.getSnapshot().tasks.length, 0); }
  finally { unbind(); web.showSaveFilePicker = originalPicker; }
});

test('a multi-batch selection uses one picker and one download ID, including a lost selection response', async () => {
  const web = globalThis as any, previous = web.showSaveFilePicker;
  let pickers = 0, lost = false, task: FileTask | undefined;
  web.showSaveFilePicker = async () => { pickers++; return { createWritable: async () => { throw Error('Preparation is still pending'); } }; };
  const calls: any[] = [], store = new FileTransferStore('large-download-selection');
  const unbind = store.bind(async input => {
    if (input.action === 'tasks') return { tasks: task ? [structuredClone(task)] : [], temporaryBytes: 0 };
    if (input.action === 'task') return structuredClone(task);
    calls.push(input);
    if (input.action === 'download') { task = { id: input.id, direction: 'download', workspaceId: input.workspaceId, instance: input.instance, workspaceName: 'W', path: '', name: 'files', size: null, offset: 0, state: 'queued', createdAt: 1, updatedAt: 1, selectionPending: true, selectionCount: input.paths.length }; return structuredClone(task); }
    if (input.action === 'download-selection') { task!.selectionCount = input.offset + input.paths.length; task!.selectionPending = !input.final; task!.updatedAt++; if (!lost) { lost = true; throw Error('Injected lost selection response'); } return structuredClone(task); }
    throw Error('Unexpected request');
  }, { downloadSelection: true });
  try {
    await store.download('w', 'pinned', Array.from({ length: 401 }, (_, n) => `file-${n}.txt`), 'files.zip');
    assert.equal(pickers, 1); assert.equal(calls.filter(input => input.action === 'download').length, 1);
    assert.equal(new Set(calls.map(input => input.id)).size, 1); assert.deepEqual(calls.filter(input => input.action === 'download-selection').map(input => [input.offset, input.final]), [[200, false], [400, true]]);
    assert.equal(task!.selectionCount, 401); assert.equal(task!.selectionPending, false); assert.equal(store.getSnapshot().tasks.length, 1); assert.equal(store.getSnapshot().tasks[0].destinationSelected, true);
  } finally { unbind(); web.showSaveFilePicker = previous; }
});

test('Pocket cancellation leaves no task and no writable destination', async () => {
  const web = globalThis as any, original = web.WorkbenchFileSave;
  web.WorkbenchFileSave = { open: async () => { throw Error('Save cancelled'); } };
  const store = new FileTransferStore('pocket-cancel'); let requests = 0;
  const unbind = store.bind(async input => { if (input.action === 'tasks') return { tasks: [], temporaryBytes: 0 }; requests++; throw Error('No remote task expected'); });
  try { await store.download('w', 'pinned', ['file.txt'], 'file.txt'); assert.equal(requests, 0); assert.equal(store.getSnapshot().tasks.length, 0); }
  finally { unbind(); web.WorkbenchFileSave = original; }
});

test('confirmed mutations notify immediately and old task polls cannot undo a newer receipt', async () => {
  const store = new FileTransferStore('confirmed-file-change'); const changes: any[] = [];
  let release!: (value: any) => void, slow = false;
  const task: FileTask = { id: 'delete', direction: 'operation', operation: 'delete', workspaceId: 'w', instance: 'one', workspaceName: 'W', path: '', name: 'a', size: null, offset: 0, state: 'complete', createdAt: 1, updatedAt: 10, changes: [{ workspaceId: 'w', instance: 'one', paths: ['a'], removed: ['a'] }] };
  const unsubscribe = store.subscribeChanges(value => changes.push(value));
  const unbind = store.bind(async input => {
    if (input.action === 'tasks') { if (slow) return new Promise(resolve => { release = resolve; }); return { tasks: [], temporaryBytes: 0 }; }
    if (input.action === 'mutate') return structuredClone(task);
    throw Error('Unexpected request');
  });
  try {
    await store.poll(); slow = true; const poll = store.poll();
    await store.operation({ operation: 'delete', entries: [{ workspaceId: 'w', path: 'a' }], confirm: true });
    assert.deepEqual(changes, [task.changes]);
    release({ tasks: [{ ...task, state: 'queued', changes: undefined, updatedAt: 1 }], temporaryBytes: 0 }); await poll;
    assert.equal(store.getSnapshot().tasks[0].state, 'complete'); assert.equal(changes.length, 1);
  } finally { unsubscribe(); unbind(); }
});

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

test('moving back into the same directory skips RPC and queue while mixed moves and explicit copies still run', async () => {
  const store = new FileTransferStore('same-directory-move'), requests: any[] = [];
  const unbind = store.bind(async input => { if (input.action === 'tasks') return { tasks: [], temporaryBytes: 0 }; requests.push(input); return { noop: true }; });
  const source = { workspaceId: 'w', instance: 'one', path: 'dist/photo.jpg' }, destination = { workspaceId: 'w', instance: 'one', path: 'dist' };
  try {
    await store.poll(); await store.operation({ operation: 'move', entries: [source], destination });
    assert.equal(requests.length, 0); assert.equal(store.getSnapshot().tasks.length, 0);
    await store.operation({ operation: 'move', entries: [source, { ...source, path: 'other/photo.jpg' }], destination });
    assert.deepEqual(requests[0].entries.map((entry: any) => entry.path), ['other/photo.jpg']);
    await store.operation({ operation: 'copy', entries: [source], destination }); assert.equal(requests[1].operation, 'copy', 'explicit copy retains name-conflict handling');
    await store.operation({ operation: 'move', entries: [source], destination: { ...destination, workspaceId: 'other' } }); assert.equal(requests.length, 3, 'same relative path in another Workspace is a real move');
    assert.equal(store.getSnapshot().tasks.length, 0, 'a backend no-op receipt never becomes a queue row');
  } finally { unbind(); }
});
