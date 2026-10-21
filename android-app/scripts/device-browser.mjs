// Android WebView CDP helper. Uses Node 22 built-ins; no browser binaries or hooks in the APK.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
const execute = promisify(execFile);
export async function adb(serial, args, options = {}) {
  return (await execute('adb', ['-s', serial, ...args], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
}
export async function connectDevice(serial, { chrome = false, packageName = 'dev.paseo.pocket', select = page => page.type === 'page' &&
    page.url.startsWith('https://appassets.androidplatform.net/') } = {}) {
  let pid = null;
  if (!chrome) {
    for (let n = 0; n < 40; n++) {
      try { pid = (await adb(serial, ['shell', 'pidof', packageName])).trim(); } catch { /* activity launch */ }
      if (pid) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (!pid) throw new Error('Paseo Pocket did not start');
  }
  const socket = chrome ? 'chrome_devtools_remote' : `webview_devtools_remote_${pid}`;
  const port = (await adb(serial, ['forward', 'tcp:0', `localabstract:${socket}`])).trim();
  const endpoint = `http://127.0.0.1:${port}`;
  let page;
  for (let n = 0; n < 40; n++) {
    try { page = (await (await fetch(endpoint + '/json', { signal: AbortSignal.timeout(1000) })).json()).find(select); } catch { /* startup */ }
    if (page) break;
    await new Promise(r => setTimeout(r, 250));
  }
  if (!page) { await adb(serial, ['forward', '--remove', `tcp:${port}`]); throw new Error('No matching test page'); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(); const events = new EventEmitter();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
    } else events.emit(message.method, message.params);
  });
  ws.addEventListener('close', () => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP closed')); } pending.clear(); });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { send, events, async evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression: `Promise.resolve((${expression}))`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('Test JavaScript failed: ' + result.exceptionDetails.text);
    return result.result.value;
  }, async close() { ws.close(); await adb(serial, ['forward', '--remove', `tcp:${port}`]); } };
}
