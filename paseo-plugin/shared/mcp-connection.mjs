// One disposable connection per request. An uncertain RPC is never replayed.
export async function withMcpConnection(client, invoke, options = {}) {
  const { signal, deadline = Date.now() + 55_000, connectMs = 8_000,
    closeMs = 1_000, forceClose = () => {}, diagnose = () => {} } = options;
  let dispatched = false;
  const failure = (reason) => Object.assign(new Error(dispatched
    ? `workbench_request_uncertain_retry_same_identity:${reason}`
    : `workbench_not_dispatched:${reason}`), { workbenchDispatched: dispatched });
  async function bounded(operation, ms, reason, cancellation = signal) {
    let timer, abort;
    try {
      if (cancellation?.aborted) throw failure('cancelled');
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(failure(reason)), Math.max(0, ms));
          abort = () => reject(failure('cancelled'));
          cancellation?.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) cancellation?.removeEventListener('abort', abort);
    }
  }
  try {
    if (Date.now() >= deadline - closeMs) throw failure('deadline');
    diagnose({ phase: 'connecting' });
    await bounded(() => client.connect(), Math.min(connectMs, deadline - Date.now() - closeMs), 'connect_timeout');
    if (signal?.aborted) throw failure('cancelled');
    if (Date.now() >= deadline - closeMs) throw failure('deadline');
    diagnose({ phase: 'rpc' });
    // Set before invoking: a synchronous transport failure cannot prove that
    // nothing reached the peer. The server's durable identity resolves this.
    dispatched = true;
    return await bounded(() => invoke(client), deadline - Date.now() - closeMs, 'rpc_timeout');
  } catch (error) {
    diagnose({ phase: 'failed', dispatched, code: String(error?.message || '').includes('timeout') ? 'timeout' : 'request_failed' });
    if (dispatched && /Transport not connected|connection.*closed|socket|timed out/i.test(String(error?.message || '')) && !String(error?.message).includes('code=handler_error')) throw failure('transport_lost');
    if (error && typeof error === 'object') {
      try { error.workbenchDispatched = dispatched; } catch {}
    }
    throw error;
  } finally {
    diagnose({ phase: 'closing' });
    try { await bounded(() => client.close(), Math.min(closeMs, Math.max(0, deadline - Date.now())), 'close_timeout', null); }
    catch { diagnose({ phase: 'closing', code: 'cleanup_failed' }); }
    // SDK close may itself throw before releasing its WebSocket. Ownership is
    // local to this request; terminate it even after a failed/late handshake.
    forceClose();
    diagnose({ phase: 'closed' });
  }
}
