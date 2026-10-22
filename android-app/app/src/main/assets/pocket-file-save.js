(function installFileSave(token) {
  'use strict';
  if (window !== window.top || location.origin !== 'https://appassets.androidplatform.net' || !window.PocketFileSaveChannel) return;
  const pending = new Map(); let counter = 0;
  PocketFileSaveChannel.onmessage = event => {
    let result; try { result = JSON.parse(event.data); } catch { return; }
    const entry = pending.get(result.id); if (!entry) return;
    pending.delete(result.id); clearTimeout(entry.timer);
    if (result.error) { const error = new Error(result.error); if (result.error === 'Save cancelled') error.name = 'AbortError'; entry.reject(error); } else entry.resolve(result);
  };
  const call = (action, data, wait = 60000) => new Promise((resolve, reject) => {
    const id = 'save_' + Date.now() + '_' + (++counter);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('File save request timed out')); }, wait);
    pending.set(id, { resolve, reject, timer });
    PocketFileSaveChannel.postMessage(JSON.stringify({ token, id, action, ...data }));
  });
  Object.defineProperty(window, 'WorkbenchFileSave', { configurable: false, writable: false, value: Object.freeze({
    capabilities: Object.freeze({ protocol: 2, multipleDestinations: true }),
    async open(name) {
      const opened = await call('open', { name }, 10 * 60 * 1000); const saveId = opened.id; let offset = 0, closed = false;
      let lane = Promise.resolve();
      const serial = work => { const next = lane.then(work); lane = next.catch(() => {}); return next; };
      return {
        write(bytes) { return serial(async () => {
          if (closed) throw new Error('Save output is closed');
          for (let i = 0; i < bytes.length; i += 512 * 1024) {
            const part = bytes.subarray(i, i + 512 * 1024); let binary = '';
            for (let j = 0; j < part.length; j += 8192) binary += String.fromCharCode(...part.subarray(j, j + 8192));
            const result = await call('write', { saveId, offset, data: btoa(binary) });
            if (result.offset !== offset + part.length) throw new Error('File save confirmation mismatch');
            offset = result.offset;
          }
        }); },
        close() { return serial(async () => { if (!closed) { await call('close', { saveId }); closed = true; } }); },
        abort() { return serial(async () => { if (!closed) { await call('abort', { saveId }); closed = true; } }); }
      };
    }
  }) });
})
