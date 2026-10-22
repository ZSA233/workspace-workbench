import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../app/src/main/assets/pocket-file-save.js', import.meta.url), 'utf8');
function fixture({ trusted = true, mainFrame = true } = {}) {
  const requests = [], channel = { postMessage: raw => requests.push(JSON.parse(raw)) };
  const window = { PocketFileSaveChannel: channel }; window.top = mainFrame ? window : {};
  vm.runInNewContext(`(${source})('proof-token')`, { window, PocketFileSaveChannel: channel, location: { origin: trusted ? 'https://appassets.androidplatform.net' : 'https://example.invalid' }, setTimeout, clearTimeout, btoa: value => Buffer.from(value, 'binary').toString('base64') });
  return { api: window.WorkbenchFileSave, requests, answer: value => channel.onmessage({ data: JSON.stringify(value) }) };
}
test('only the trusted main page exposes the file save bridge', () => {
  assert.equal(fixture({ trusted: false }).api, undefined); assert.equal(fixture({ mainFrame: false }).api, undefined); assert.ok(fixture().api);
});
test('cancelling the system picker rejects with AbortError before any write and permits another selection', async () => {
  const f = fixture(), first = f.api.open('file.txt'); assert.equal(f.requests.length, 1);
  f.answer({ id: f.requests[0].id, error: 'Save cancelled' });
  await assert.rejects(first, error => error.name === 'AbortError'); assert.deepEqual(f.requests.map(r => r.action), ['open']);
  const next = f.api.open('retry.txt'); f.answer({ id: f.requests[1].id }); const output = await next;
  const closing = output.abort(); f.answer({ id: f.requests[2].id }); await closing;
  assert.deepEqual(f.requests.map(r => r.action), ['open', 'open', 'abort']);
});
test('confirmed destinations write bounded chunks and close exactly once', async () => {
  const f = fixture(), pending = f.api.open('large.bin'); f.answer({ id: f.requests[0].id }); const output = await pending;
  const writing = output.write(new Uint8Array(512 * 1024 + 17));
  assert.equal(Buffer.from(f.requests[1].data, 'base64').length, 512 * 1024);
  f.answer({ id: f.requests[1].id, offset: 512 * 1024 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(Buffer.from(f.requests[2].data, 'base64').length, 17);
  f.answer({ id: f.requests[2].id, offset: 512 * 1024 + 17 }); await writing;
  const closing = output.close(); f.answer({ id: f.requests[3].id }); await closing; await output.close();
  assert.deepEqual(f.requests.map(r => r.action), ['open', 'write', 'write', 'close']);
});
