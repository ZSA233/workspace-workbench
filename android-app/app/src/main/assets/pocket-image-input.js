(function pocketImageInput(config) {
  'use strict';
  // APK-owned boundary adapter. The verified Paseo bundle, storage and send path stay intact.
  if (window !== window.top || location.origin !== 'https://appassets.androidplatform.net' || config.webVersion !== '0.12.0') return null;
  let disposed = false, pending = null, notice = null, noticeTimer = null;
  const replay = new WeakSet(), operations = new Set();
  const channel = window.PocketImageInputChannel;
  const pill = '[data-testid="composer-image-attachment-pill"]';
  const report = code => { try { channel?.postMessage(code); } catch (_) {} };
  const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' };
  const acceptedTypes = new Set([...Object.values(extensions), 'image/jpg']);
  function imageType(bytes, file, extensionFallback) {
    const text = (offset, length) => String.fromCharCode(...bytes.slice(offset, offset + length));
    if (bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n') return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
    if (text(0, 2) === 'BM') return 'image/bmp';
    if (text(0, 4) === 'II*\0' || text(0, 4) === 'MM\0*') return 'image/tiff';
    if (text(4, 4) === 'ftyp') {
      const brands = text(8, bytes.length - 8);
      if (/avif|avis/.test(brands)) return 'image/avif';
      if (/heic|heix|hevc|hevx/.test(brands)) return 'image/heic';
      if (/mif1|msf1/.test(brands)) return 'image/heif';
    }
    return extensionFallback ? extensions[file.name.split('.').pop().toLowerCase()] || null : null;
  }
  function show(message, error = false, duration = error ? 8000 : 0) {
    clearTimeout(noticeTimer);
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('data-pocket-image-status', '');
      notice.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;padding:12px 16px;border-radius:12px;background:#202923;color:#fff;font:14px/1.5 system-ui,sans-serif;box-shadow:0 3px 18px #0004;pointer-events:none';
      document.body.appendChild(notice);
    }
    notice.setAttribute('role', error ? 'alert' : 'status');
    notice.textContent = message;
    if (duration) noticeTimer = setTimeout(hide, duration);
  }
  function hide() { clearTimeout(noticeTimer); noticeTimer = null; notice?.remove(); notice = null; }
  function finish(operation) {
    clearTimeout(operation.timer); operation.observer?.disconnect(); operations.delete(operation);
    if (pending === operation) pending = null;
  }
  function emit(input) {
    replay.add(input);
    try { input.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { replay.delete(input); }
  }
  function failure(operation, code, message) {
    finish(operation); report(code);
    if (!disposed) show(message, true);
  }
  async function prepare(file, operation) {
    const supplied = file.type.toLowerCase().split(';')[0].trim();
    // Known types remain the original File, including bytes, name and timestamps.
    // Expo's normalizer rejects aliases such as image/x-png and image/pjpeg.
    // Repair these from the actual header, without trusting an image/* label or
    // filename. image/jpg is already accepted by the upstream normalizer.
    if (acceptedTypes.has(supplied)) return file;
    // Read only a header here. No full-image copy or additional native URI permissions.
    const bytes = await Promise.race([file.slice(0, 64).arrayBuffer(), new Promise((_, reject) => {
      operation.readTimers.push(setTimeout(() => reject(new Error('read_timeout')), 15000));
    })]);
    if (disposed) return file;
    if (file.size > 0 && !bytes.byteLength) throw new Error('unreadable');
    const type = imageType(new Uint8Array(bytes), file,
      !supplied || supplied === 'application/octet-stream' || supplied === 'binary/octet-stream');
    if (!type) throw new Error('type');
    return type === file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
  }
  function matches(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.getAttribute('data-testid') !== 'file-input') return false;
    const accepts = input.accept.split(',').map(value => value.trim()).filter(Boolean);
    return accepts.length > 0 && accepts.every(value => /^image\//i.test(value));
  }
  function changed(event) {
    const input = event.target;
    if (disposed || replay.has(input) || !matches(input) || !input.files?.length) return;
    // Expo's async change listener cannot reject its enclosing picker Promise. Validate
    // before handing it the files, then replay exactly one normal change or cancellation.
    event.stopImmediatePropagation();
    const operation = { input, readTimers: [], observer: null, timer: null, delivered: false };
    operations.add(operation);
    pending = operation;
    // The composer thumbnail is the selection feedback; keep typing unobstructed.
    hide(); report('image_input_selected');
    const composer = document.querySelector('[data-testid="message-input-root"]');
    const before = new Set(composer?.querySelectorAll(pill) || []);
    Promise.all(Array.from(input.files, file => prepare(file, operation))).then(files => {
      if (disposed || !operations.has(operation)) return;
      if (!input.isConnected) { finish(operation); hide(); return; }
      if (files.some((file, index) => file !== input.files[index])) {
        try {
          const transfer = new DataTransfer();
          for (const file of files) transfer.items.add(file);
          input.files = transfer.files;
        } catch (_) {
          // Older providers may lack the FileList setter. Expo only reads/iterates
          // this input's files; a local getter preserves every selected File.
          Object.defineProperty(input, 'files', { configurable: true, get: () => files });
        }
      }
      report('image_input_ready');
      if (composer) {
        operation.observer = new MutationObserver(() => {
          if (Array.from(composer.querySelectorAll(pill)).some(node => !before.has(node))) {
            finish(operation); hide(); report('image_attachment_ready');
          }
        });
        operation.observer.observe(composer, { childList: true, subtree: true });
        operation.timer = setTimeout(() => {
          finish(operation); report('image_attachment_unconfirmed');
        }, 15000);
      } else { finish(operation); hide(); }
      operation.delivered = true;
      emit(input);
    }).catch(error => {
      if (disposed || !operations.has(operation)) return;
      // Emptying the input lets Expo resolve its picker and release its busy flag.
      input.value = '';
      emit(input);
      failure(operation, error?.message === 'type' ? 'image_input_unsupported' : 'image_input_unreadable',
        error?.message === 'type' ? '无法识别这张图片，请重新选择 PNG、JPEG 或其他受支持的图片。' : '无法读取所选图片，请重新选择，或先将图片保存到设备。');
    }).finally(() => { for (const timer of operation.readTimers) clearTimeout(timer); });
  }
  function rejected(event) {
    if (!pending?.delivered) return;
    // Keep the original error observable; show feedback only for storage/read failures
    // during this bounded selection, without logging filenames, URI or exception text.
    if (['QuotaExceededError', 'DataCloneError', 'InvalidStateError', 'UnknownError', 'NotReadableError'].includes(event.reason?.name))
      failure(pending, 'image_attachment_failed', '图片未能保存到草稿，请重试。');
  }
  document.addEventListener('change', changed, true);
  window.addEventListener('unhandledrejection', rejected);
  const api = Object.freeze({ dispose() {
    disposed = true; document.removeEventListener('change', changed, true); window.removeEventListener('unhandledrejection', rejected);
    for (const operation of operations) { for (const timer of operation.readTimers) clearTimeout(timer); finish(operation); }
    hide();
  } });
  window.addEventListener('pagehide', api.dispose, { once: true });
  return api;
})
