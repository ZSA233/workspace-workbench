import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-ignore JavaScript transport boundary
import { withMcpConnection } from '../shared/mcp-connection.mjs';
const never = () => new Promise(() => {});
const budgets = () => ({ connectMs: 20, deadline: Date.now() + 80, closeMs: 20 });
test('stalled handshake is bounded, closed and never dispatches an RPC', async () => {
  let closed = 0, dispatched = 0;
  await assert.rejects(withMcpConnection({ connect: never, close: async () => { closed++; } }, () => { dispatched++; }, budgets()), /not_dispatched:connect_timeout/);
  assert.equal(closed, 1); assert.equal(dispatched, 0);
});
test('failed connection is cleaned up without masking its error', async () => {
  let closed = 0;
  await assert.rejects(withMcpConnection({ connect: async () => { throw Error('offline'); }, close: async () => { closed++; throw Error('Transport not connected'); } }, never, budgets()), /offline/);
  assert.equal(closed, 1);
});
test('RPC timeout preserves uncertainty and never replays a mutation', async () => {
  let dispatched = 0;
  await assert.rejects(withMcpConnection({ connect: async () => {}, close: never }, () => { dispatched++; return never(); }, budgets()), /request_uncertain_retry_same_identity/);
  assert.equal(dispatched, 1);
});
test('cleanup failure cannot turn successful execution into transport failure', async () => {
  assert.deepEqual(await withMcpConnection({ connect: async () => {}, close: async () => { throw Error('Transport not connected'); } }, async () => ({ ok: true }), budgets()), { ok: true });
});
test('independent request can succeed after a stalled connection', async () => {
  await assert.rejects(withMcpConnection({ connect: never, close: never }, never, budgets()));
  assert.equal(await withMcpConnection({ connect: async () => {}, close: async () => {} }, async () => 'ready', budgets()), 'ready');
});

test('real SDK handshake cancellation releases 100 WebSocket connections', async () => {
  const { WebSocketServer, default: WebSocket } = await import('ws');
  const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
  type ClientSocket = ReturnType<NonNullable<ConstructorParameters<typeof DaemonClient>[0]['webSocketFactory']>>;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(r => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  let invoked = 0;
  try {
    for (let i = 0; i < 100; i++) {
      const sockets = new Set<InstanceType<typeof WebSocket>>();
      const client = new DaemonClient({ url: `ws://127.0.0.1:${port}`, clientId: `test-${i}`, clientType: 'mcp', reconnect: { enabled: false },
        webSocketFactory: (url: string, options: any) => { const socket = new WebSocket(url, options?.protocols, { headers: options?.headers }); socket.on('error', () => {}); sockets.add(socket); return socket as unknown as ClientSocket; } });
      await assert.rejects(withMcpConnection(client, () => { invoked++; }, { connectMs: 10, closeMs: 10, deadline: Date.now() + 100,
        forceClose: () => { for (const socket of sockets) socket.terminate(); sockets.clear(); } }), /not_dispatched/);
      assert.equal(sockets.size, 0);
    }
    await new Promise(r => setTimeout(r, 50));
    assert.equal(server.clients.size, 0); assert.equal(invoked, 0);
  } finally { for (const socket of server.clients) socket.terminate(); await new Promise<void>(r => server.close(() => r())); }
});
