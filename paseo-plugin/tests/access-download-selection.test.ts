import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTransferStore } from '../client/files-store.ts';
import { canSave } from '../client/files-platform.ts';
import type { FileTask } from '../shared/files.ts';

test('Access delegates the real download even when WebView advertises a browser save picker', async () => {
  const web = globalThis as any;
  const names = ['navigator', 'showSaveFilePicker', 'document', 'location', 'fetch', 'WorkbenchFileSave'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(web, name)]));
  const calls: string[] = [], clicks: string[] = [];
  let browserPickers = 0, task: FileTask | undefined;
  const token = '00000000-1111-2222-3333-444444444444';
  Object.defineProperty(web, 'navigator', { configurable: true, value: { userAgent: 'Android; wv) AccessPocket/0.2.9', storage: {} } });
  web.WorkbenchFileSave = undefined;
  web.showSaveFilePicker = async () => { browserPickers++; throw Error('The shell owns the HTTP save picker'); };
  web.location = { href: 'https://paseo.test/', origin: 'https://paseo.test' };
  web.document = { body: { appendChild() {} }, createElement() { return { href: '', download: '', rel: '', click() { clicks.push(this.href); }, remove() {} }; } };
  web.fetch = async (path: string, init: any) => {
    if (path.endsWith('/capabilities')) return { ok: true, json: async () => ({ download_handoff_version: 1, entry_server_id: 'mini' }) };
    assert.equal(path, '/__access/paseo/downloads');
    assert.deepEqual(JSON.parse(init.body), { server_id: 'studio', token, filename: '中文.zip', transport: 'native' });
    return { ok: true, json: async () => ({ download_url: '/__access/paseo/downloads/' + 'a'.repeat(64) + '/start' }) };
  };
  const store = new FileTransferStore('access-save-api-regression');
  const unbind = store.bind(async input => {
    calls.push(input.action);
    if (input.action === 'tasks') return { tasks: task ? [task] : [], temporaryBytes: 0 };
    if (input.action === 'download') return task = { id: input.id, direction: 'download', workspaceId: 'w', instance: 'one', workspaceName: 'W', path: '', name: '中文.zip', size: 42, offset: 0, state: 'active', createdAt: 1, updatedAt: 1 };
    if (input.action === 'delegate') return { url: '/api/files/download?token=' + token, serverId: 'studio' };
    if (input.action === 'control') { assert.equal(input.command, 'delegated'); return task = { ...task!, state: 'delegated', updatedAt: 2 }; }
    throw Error('Unexpected byte/staging request: ' + input.action);
  });
  try {
    assert.equal(canSave(), false);
    await store.download('w', 'one', ['中文.zip'], '中文.zip');
    for (let n = 0; n < 100 && task?.state !== 'delegated'; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(task?.state, 'delegated');
    assert.equal(browserPickers, 0);
    assert.equal(clicks.length, 1);
    assert.ok(clicks[0].endsWith('/start'));
    assert.ok(!calls.includes('read'), 'Access must not stage or buffer the file in the web renderer');
    web.WorkbenchFileSave = { open() {} };
    assert.equal(canSave(), true, 'The independent legacy Pocket writer retains its own save path');
    web.WorkbenchFileSave = undefined;
    Object.defineProperty(web, 'navigator', { configurable: true, value: { userAgent: 'Chrome', storage: {} } });
    assert.equal(canSave(), true, 'Desktop browser saving remains available');
  } finally {
    unbind();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(web, name, descriptor); else delete web[name]; }
  }
});
