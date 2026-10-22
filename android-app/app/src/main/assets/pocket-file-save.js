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
    if (pending.size) { reject(new Error('Wait for the previous file save request')); return; }
    const id = 'save_' + Date.now() + '_' + (++counter);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('File save request timed out')); }, wait);
    pending.set(id, { resolve, reject, timer });
    PocketFileSaveChannel.postMessage(JSON.stringify({ token, id, action, ...data }));
  });
  Object.defineProperty(window, 'WorkbenchFileSave', { configurable: false, writable: false, value: Object.freeze({
    async open(name) {
      const opened = await call('open', { name }, 10 * 60 * 1000); const saveId = opened.id; let offset = 0, closed = false;
      return {
        async write(bytes) {
          if (closed) throw new Error('Save output is closed');
          for (let i = 0; i < bytes.length; i += 512 * 1024) {
            const part = bytes.subarray(i, i + 512 * 1024); let binary = '';
            for (let j = 0; j < part.length; j += 8192) binary += String.fromCharCode(...part.subarray(j, j + 8192));
            const result = await call('write', { saveId, offset, data: btoa(binary) });
            if (result.offset !== offset + part.length) throw new Error('File save confirmation mismatch');
            offset = result.offset;
          }
        },
        async close() { if (!closed) { await call('close', { saveId }); closed = true; } },
        async abort() { if (!closed) { await call('abort', { saveId }); closed = true; } }
      };
    }
  }) });
})
