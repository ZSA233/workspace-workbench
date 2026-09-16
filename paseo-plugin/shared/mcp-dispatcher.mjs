import { createInterface } from 'node:readline';
export function serveMcp(handle, { input = process.stdin, output = process.stdout, concurrency = 4, queueLimit = 16, budgetMs = 55_000 } = {}) {
  const requests = new Map(), queue = [];
  let active = 0, closed = false;
  const metrics = { completed: 0, timedOut: 0, cleanupFailures: 0 };
  const write = (message) => { if (!output.destroyed) output.write(JSON.stringify(message) + '\n'); };
  const error = (id, message) => write({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  const diagnose = (record, event) => {
    record.phase = event.phase;
    if (event.code === 'timeout') metrics.timedOut++;
    if (event.code === 'cleanup_failed') {
      metrics.cleanupFailures++;
      process.stderr.write(JSON.stringify({ component: 'workbench-mcp', code: 'cleanup_failed' }) + '\n');
    }
  };
  const drain = () => {
    while (!closed && active < concurrency && queue.length) {
      const record = queue.shift();
      if (!requests.has(record.message.id)) continue;
      active++; record.phase = 'dispatching';
      void Promise.resolve().then(() => handle(record.message, {
        signal: record.controller.signal, deadline: record.deadline,
        diagnose: event => diagnose(record, event),
      })).then(result => write({ jsonrpc: '2.0', id: record.message.id, result }), e => error(record.message.id, e instanceof Error ? e.message : 'workbench_failed'))
        .finally(() => { clearTimeout(record.timer); requests.delete(record.message.id); active--; metrics.completed++; drain(); });
    }
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try {
      if (Buffer.byteLength(line) > 12 * 1_048_576) throw Error('request_too_large');
      message = JSON.parse(line);
      if (message.method === 'notifications/cancelled') {
        const record = requests.get(message.params?.requestId);
        if (record) cancel(record, 'cancelled');
        return;
      }
      if (message.id === undefined) return;
      if (requests.has(message.id)) { error(message.id, 'duplicate_request_id'); return; }
      if (['ping', 'initialize', 'tools/list'].includes(message.method)) {
        void Promise.resolve().then(() => handle(message, {})).then(result => write({ jsonrpc: '2.0', id: message.id, result }), e => error(message.id, e.message));
        return;
      }
      if (closed || (active >= concurrency && queue.length >= queueLimit)) { error(message.id, 'workbench_busy_not_dispatched'); return; }
      const record = { message, controller: new AbortController(), receivedAt: Date.now(), deadline: Date.now() + budgetMs, phase: 'queued', timer: undefined };
      requests.set(message.id, record);
      record.timer = setTimeout(() => { metrics.timedOut++; cancel(record, 'deadline'); }, budgetMs);
      queue.push(record); drain();
    } catch (e) { error(message?.id ?? null, e instanceof Error ? e.message : 'workbench_failed'); }
  });
  function cancel(record, reason) {
    record.controller.abort(reason);
    if (record.phase === 'queued') {
      queue.splice(queue.indexOf(record), 1); clearTimeout(record.timer); requests.delete(record.message.id);
      error(record.message.id, `workbench_not_dispatched:${reason}`);
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const record of requests.values()) cancel(record, 'stdin_closed');
    lines.close();
  }
  lines.once('close', close);
  return { close, health: () => ({ ...metrics, active, queued: queue.length,
    oldestRequestAgeMs: Math.max(0, ...[...requests.values()].map(r => Date.now() - r.receivedAt)),
    phases: [...requests.values()].map(r => r.phase) }) };
}
