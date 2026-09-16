import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
// @ts-ignore JS runtime transport
import { serveMcp } from '../shared/mcp-dispatcher.mjs';
// @ts-ignore JS runtime transport
import { withMcpConnection } from '../shared/mcp-connection.mjs';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
function harness() {
  const input = new PassThrough(), output = new PassThrough(), results: any[] = [];
  let dispatched = 0, closed = 0;
  output.on('data', b => results.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const server = serveMcp(async (message: any, options: any) => {
    if (message.method === 'ping') return {};
    return withMcpConnection({ connect: async () => {}, close: async () => { closed++; } }, () => { dispatched++; return new Promise(() => {}); }, { ...options, closeMs: 5 });
  }, { input, output, budgetMs: 200 });
  const send = (id: number, method = 'tools/call', params = {}) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return { input, results, server, send, counts: () => ({ dispatched, closed }) };
}
test('slow RPCs do not block ping; queue is bounded and cancellation does not dispatch queued mutations', async () => {
  const h = harness();
  for (let id = 0; id < 21; id++) h.send(id);
  h.send(30, 'ping');
  await delay(10);
  assert.equal(h.counts().dispatched, 4);
  assert.match(h.results.find(r => r.id === 20).error.message, /busy_not_dispatched/);
  assert.deepEqual(h.results.find(r => r.id === 30).result, {});
  h.input.write(JSON.stringify({ method: 'notifications/cancelled', params: { requestId: 5 } }) + '\n');
  await delay(5);
  assert.match(h.results.find(r => r.id === 5).error.message, /not_dispatched:cancelled/);
  h.server.close(); await delay(30);
  assert.equal(h.counts().dispatched, 4);
  assert.equal(h.counts().closed, 4);
  assert.equal(h.server.health().active, 0);
  assert.equal(h.server.health().queued, 0);
});
test('stdin EOF cancels an active request and reclaims its connection', async () => {
  const h = harness(); h.send(1); await delay(5); h.input.end(); await delay(30);
  assert.equal(h.counts().closed, 1);
  assert.match(h.results[0].error.message, /uncertain/);
});
test('queued time counts against the original deadline', async () => {
  const h = harness(); for (let n = 0; n < 10; n++) h.send(n);
  await delay(270); h.server.close();
  assert.equal(h.server.health().active, 0);
  assert.equal(h.server.health().queued, 0);
  assert.equal(h.results.length, 10);
});
test('100 disposable lifecycles retain no pending SDK connections', async () => {
  let live = 0, destroyed = 0;
  for (let n = 0; n < 100; n++) {
    await withMcpConnection({ connect: async () => { live++; }, close: async () => {} }, async () => n,
      { forceClose: () => { live--; destroyed++; } });
  }
  assert.equal(live, 0); assert.equal(destroyed, 100);
});
