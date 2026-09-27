import { createInterface } from 'node:readline';
import { requestBudget } from './mcp-policy.mjs';
import { createRequestScheduler } from './request-scheduler.mjs';
export function serveMcp(handle, { input = process.stdin, output = process.stdout, concurrency = 4, queueLimit = 16, budgetMs = 55_000 } = {}) {
  const scheduler = createRequestScheduler({ concurrency, queueLimit });
  const write = message => { if (!output.destroyed) output.write(JSON.stringify(message) + '\n'); };
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try {
      if (Buffer.byteLength(line) > 12 * 1_048_576) throw Error('request_too_large');
      message = JSON.parse(line);
      if (message.method === 'notifications/cancelled') { scheduler.cancel(message.params?.requestId); return; }
      if (message.id === undefined) return;
      scheduler.submit({ id: message.id, deadline: Date.now() + requestBudget(message, budgetMs),
        control: ['ping', 'initialize', 'tools/list'].includes(message.method),
        run: lifecycle => handle(message, lifecycle),
        respond: (error, result) => write({ jsonrpc: '2.0', id: message.id, ...(error ? { error: { code: -32603, message: error.message } } : { result }) }),
      });
    } catch (error) { write({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: error.message } }); }
  });
  const close = () => { scheduler.close(); lines.close(); };
  lines.once('close', () => scheduler.close());
  return { close, health: scheduler.health };
}
