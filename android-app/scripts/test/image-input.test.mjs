import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const adapter = readFileSync(new URL('../../app/src/main/assets/pocket-image-input.js', import.meta.url), 'utf8');
const bundleDir = new URL('../../app/src/main/assets/paseo/', import.meta.url);
const hasBundle = existsSync(new URL('_workbench.json', bundleDir));
function upstreamModule(marker) {
  const manifest = JSON.parse(readFileSync(new URL('_workbench.json', bundleDir), 'utf8'));
  assert.equal(manifest.metadata.version, '0.12.0');
  const code = readFileSync(new URL(manifest.files.find(file => /\/index-[\w]+\.js$/.test(file.path)).path, bundleDir), 'utf8');
  const at = code.indexOf(marker); assert(at >= 0, `Upstream contract missing: ${marker}`);
  return code.slice(code.lastIndexOf('\n__d(', at), code.indexOf('\n__d(', at));
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ enabled = true, composer = true, setter = true, trusted = true, version = '0.12.0' } = {}) {
  let now = 0, sequence = 0;
  const timers = new Map(), nodes = [], changes = [], errors = [], reports = [], observers = new Set(), windowListeners = new Map();
  const consoleErrors = [], alerts = [];
  const schedule = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; };
  class Event {
    constructor(type, options = {}) { this.type = type; this.bubbles = !!options.bubbles; this.stopped = false; }
    stopImmediatePropagation() { this.stopped = true; }
  }
  class Element {
    constructor(tag) { this.tag = tag; this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.isConnected = false; }
    setAttribute(name, value) { this.attributes.set(name, value); if (['type', 'accept'].includes(name)) this[name] = value; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    dispatchEvent(event) {
      event.target = this;
      if (event.type === 'change') for (const fn of changes) { fn(event); if (event.stopped) return true; }
      for (const fn of this.listeners.get(event.type) || []) {
        try { const value = fn(event); if (value?.then) value.catch(error => errors.push(error)); }
        catch (error) { errors.push(error); }
      }
      return true;
    }
    remove() { this.isConnected = false; nodes.splice(nodes.indexOf(this), 1); }
    querySelectorAll(selector) { return nodes.filter(node => node.parentElement === this && matches(node, selector)); }
    appendChild(node) { node.parentElement = this; return body.appendChild(node); }
  }
  class Input extends Element {
    constructor() { super('input'); this.type = ''; this.accept = ''; this._files = []; }
    get files() { return this._files; }
    set files(value) { if (!setter) throw new Error('FileList setter unavailable'); this._files = value; }
    set value(value) { if (value === '') this._files = []; }
  }
  const body = { appendChild(node) { node.isConnected = true; nodes.push(node); for (const observer of observers) observer.fn(); return node; },
    removeChild(node) { node.remove(); } };
  const matches = (node, selector) => selector.startsWith('[data-testid="') &&
    node.getAttribute('data-testid') === selector.slice('[data-testid="'.length, -2);
  const document = { body, createElement: tag => tag === 'input' ? new Input() : new Element(tag),
    addEventListener(type, fn) { if (type === 'change') changes.push(fn); },
    removeEventListener(type, fn) { if (type === 'change') changes.splice(changes.indexOf(fn), 1); },
    querySelectorAll: selector => nodes.filter(node => matches(node, selector)),
    querySelector: selector => nodes.find(node => matches(node, selector)) ?? null };
  const composerRoot = composer ? new Element('div') : null;
  if (composerRoot) { composerRoot.setAttribute('data-testid', 'message-input-root'); body.appendChild(composerRoot); }
  const window = { PocketImageInputChannel: { postMessage: code => reports.push(code) },
    addEventListener(type, fn) { windowListeners.set(type, fn); }, removeEventListener(type) { windowListeners.delete(type); } };
  window.top = window;
  class Observer { constructor(fn) { this.fn = fn; } observe() { observers.add(this); } disconnect() { observers.delete(this); } }
  class DataTransfer { files = []; items = { add: file => this.files.push(file) }; }
  class Image { naturalWidth = 20; naturalHeight = 12; set src(_) { queueMicrotask(() => this.onload()); } }
  const context = vm.createContext({ window, document, HTMLInputElement: Input, DataTransfer, File, Blob, Uint8Array,
    location: { origin: trusted ? 'https://appassets.androidplatform.net' : 'https://outside.invalid' },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), MutationObserver: Observer, Event, MouseEvent: Event,
    URL: { createObjectURL: () => 'blob:proof' }, Image, console: { ...console, error: (...args) => consoleErrors.push(args) } });
  const api = enabled ? vm.runInContext(`(${adapter})(${JSON.stringify({ webVersion: version })})`, context) : null;
  function loadModule(source, dependencies) {
    let exports;
    context.__d = (factory, _id, deps) => { const module = { exports: {} };
      factory(window, id => dependencies[deps.indexOf(id)] ?? {}, null, null, module, module.exports, deps); exports = module.exports; };
    vm.runInContext(source, context); return exports;
  }
  const picker = () => loadModule(upstreamModule('const o={images:\'image/*\''),
    [{ Platform: { isDOMAvailable: true }, PermissionStatus: { GRANTED: 'granted' } }, {}, { parseMediaTypes: value => value }]).default;
  const pick = () => picker().launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true });
  const pickWithHook = () => {
    const raster = loadModule(upstreamModule('e.resolveRasterImageMimeType='), []);
    const normalizer = loadModule(upstreamModule('e.normalizePickedImageAssets='), [raster, {}, {}, {}]);
    const hook = loadModule(upstreamModule('_e.useImageAttachmentPicker='), [
      { useRef: value => ({ current: value }), useCallback: callback => callback },
      { default: { alert: (...args) => alerts.push(args) }, __esModule: true },
      { ...picker(), useMediaLibraryPermissions: () => [{ status: 'granted', granted: true }, async () => ({ status: 'granted', granted: true })],
        PermissionStatus: { UNDETERMINED: 'undetermined' }, getPendingResultAsync: async () => null },
      { useTranslation: () => ({ t: key => key }) }, { isElectronRuntime: () => false }, normalizer, { isWeb: true }
    ]);
    return hook.useImageAttachmentPicker().pickImages();
  };
  return { pick, pickWithHook, api, nodes, reports, errors, consoleErrors, alerts, observers, timers, document,
    input: () => nodes.find(node => node instanceof Input),
    select(files) { const input = nodes.find(node => node instanceof Input); input._files = files; input.dispatchEvent(new Event('change', { bubbles: true })); },
    status: () => nodes.find(node => node.attributes.has('data-pocket-image-status'))?.textContent ?? '',
    pill() { const node = new Element('div'); node.setAttribute('data-testid', 'composer-image-attachment-pill'); (composerRoot || body).appendChild(node); },
    reject(reason) { windowListeners.get('unhandledrejection')?.({ reason }); },
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    persist: () => loadModule(upstreamModule('e.pickAndPersistImages='), []).pickAndPersistImages };
}
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const withBundle = { skip: !hasBundle && !process.env.POCKET_VERIFY_BUNDLED_ADAPTER };

test('the real supported bundle retains the DOM input and composer selectors used by the adapter', withBundle, () => {
  const picker = upstreamModule('const o={images:\'image/*\'');
  assert(picker.includes("setAttribute('data-testid','file-input')"));
  assert(upstreamModule('testID:"message-input-root"').includes('testID:"message-input-root"'));
  assert(upstreamModule('testID:"composer-image-attachment-pill"').includes('testID:"composer-image-attachment-pill"'));
});
test('real Expo picker leaves an empty-MIME image Promise pending after its change handler rejects', withBundle, async () => {
  const f = fixture({ enabled: false }); let settled = false;
  f.pick().then(() => { settled = true; });
  f.select([new File([png], 'photo.png')]); await tick();
  assert.equal(settled, false);
  assert.match(f.errors[0].message, /Unsupported file type/);
});
test('real image attachment hook rejects an unadapted image/x-png File after the Expo picker succeeds', withBundle, async () => {
  const f = fixture({ enabled: false }), result = f.pickWithHook();
  await tick(); f.select([new File([png], 'photo.png', { type: 'image/x-png' })]);
  assert.equal(await result, null);
  assert.match(f.consoleErrors[0][1].message, /Unsupported image type/);
  assert.equal(f.alerts.length, 1); assert.equal(f.errors.length, 0);
});
test('aliases use actual image headers and pass the real picker, normalizer and attachment hook', withBundle, async t => {
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const bmp = Uint8Array.from([66, 77, ...Array(52).fill(0)]);
  for (const [supplied, bytes, expected] of [
    ['image/x-png', png, 'image/png'], ['image/pjpeg', jpeg, 'image/jpeg'], ['image/x-jpeg', jpeg, 'image/jpeg'],
    ['image/x-ms-bmp', bmp, 'image/bmp'], ['image/x-bmp', bmp, 'image/bmp'],
    ['image/x-png', jpeg, 'image/jpeg'], ['image/vnd.provider-photo', png, 'image/png']
  ]) await t.test(`${supplied} → ${expected}`, async () => {
    const f = fixture(), original = new File([bytes], 'provider-photo.bin', { type: supplied, lastModified: 1234 });
    const result = f.pickWithHook(); await tick(); f.select([original]); const images = await result;
    assert.equal(images.length, 1); assert.equal(images[0].mimeType, expected);
    assert.equal(images[0].source.kind, 'blob');
    const file = images[0].source.blob;
    assert.equal(file.type, expected); assert.equal(file.name, original.name); assert.equal(file.lastModified, 1234);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    let saved;
    const metadata = await f.persist()({ pickImages: async () => images,
      persister: { persistFromBlob: async value => { saved = value; return { id: 'original-draft-storage' }; } } });
    assert.equal(saved.blob, file); assert.equal(saved.mimeType, expected); assert.equal(metadata.length, 1);
    assert.equal(f.consoleErrors.length, 0); assert.equal(f.alerts.length, 0); assert.equal(f.errors.length, 0);
    f.pill(); assert(f.reports.includes('image_attachment_ready')); f.api.dispose();
  });
});
test('an alias image label and filename cannot promote non-image bytes or a truncated PNG signature', withBundle, async t => {
  for (const bytes of [new TextEncoder().encode('%PDF-proof'), Uint8Array.from([137, 80, 78, 71])])
    await t.test(`reject ${bytes.length}-byte payload`, async () => {
      const f = fixture(), result = f.pickWithHook(); await tick();
      f.select([new File([bytes], 'renamed.png', { type: 'image/x-png' })]);
      assert.equal(await result, null); assert.match(f.status(), /无法识别/);
      assert(f.reports.includes('image_input_unsupported'));
      assert.equal(f.consoleErrors.length, 0); assert.equal(f.alerts.length, 0); assert.equal(f.errors.length, 0); f.api.dispose();
    });
});
test('image/jpg remains the original File and the real normalizer returns image/jpeg metadata', withBundle, async () => {
  const f = fixture(), original = new File([Uint8Array.from([255, 216, 255, 224])], 'compatible.jpg', { type: 'image/jpg', lastModified: 4321 });
  const result = f.pickWithHook(); await tick(); f.select([original]); const images = await result;
  assert.equal(images[0].source.blob, original); assert.equal(images[0].mimeType, 'image/jpeg');
  assert.equal(f.consoleErrors.length, 0); assert.equal(f.alerts.length, 0); f.api.dispose();
});
test('normalized replay resolves the actual Expo picker, preserves bytes/name/time and follows original persistence', withBundle, async () => {
  const f = fixture(), file = new File([png], 'camera-original.bin', { type: 'application/octet-stream', lastModified: 1234 });
  const result = f.pick(); f.select([file]); assert.equal(f.status(), ''); const picked = await result;
  assert.equal(f.status(), '');
  assert.equal(picked.canceled, false); assert.equal(picked.assets.length, 1);
  const normalized = picked.assets[0].file;
  assert.equal(normalized.type, 'image/png'); assert.equal(normalized.name, file.name); assert.equal(normalized.lastModified, 1234);
  assert.deepEqual(new Uint8Array(await normalized.arrayBuffer()), png);
  let saved;
  const persisted = await f.persist()({ pickImages: async () => [{ source: { kind: 'blob', blob: normalized }, mimeType: normalized.type, fileName: normalized.name }],
    persister: { persistFromBlob: async input => { saved = input; return { id: 'original-draft-storage' }; } } });
  assert.equal(saved.blob, normalized); assert.equal(persisted[0].id, 'original-draft-storage');
  f.pill(); assert.equal(f.status(), ''); assert(f.reports.includes('image_attachment_ready')); f.api.dispose();
});
test('normal image Files remain unchanged even when DataTransfer FileList assignment is unavailable', withBundle, async () => {
  const f = fixture({ setter: false }), file = new File([png], 'known.png', { type: 'image/png', lastModified: 4321 });
  const result = f.pick(); f.select([file]); const picked = await result;
  assert.equal(picked.assets[0].file, file); assert.equal(f.errors.length, 0); f.api.dispose();
});
test('local files getter preserves good files alongside normalized files when the FileList setter is unavailable', withBundle, async () => {
  const f = fixture({ setter: false }), good = new File([png], 'known.png', { type: 'image/png' });
  const result = f.pick(); f.select([good, new File([png], 'unknown')]); const picked = await result;
  assert.equal(picked.assets[0].file, good); assert.equal(picked.assets[1].file.type, 'image/png'); f.api.dispose();
});
test('a provider non-image MIME is repaired only when the actual bytes identify an image', withBundle, async () => {
  const f = fixture(), result = f.pick(); f.select([new File([png], 'camera.bin', { type: 'text/plain' })]);
  assert.equal((await result).assets[0].file.type, 'image/png'); f.api.dispose();
});
test('non-image bytes with a non-image MIME resolve actual Expo cancellation instead of hanging', withBundle, async () => {
  const f = fixture(), result = f.pick(); f.select([new File(['%PDF-proof'], 'renamed.png', { type: 'application/pdf' })]);
  assert.equal((await result).canceled, true); assert.match(f.status(), /无法识别/);
  assert(f.reports.includes('image_input_unsupported')); assert.equal(f.errors.length, 0); f.api.dispose();
});
test('unreadable selection resolves actual Expo cancellation, displays retry feedback and permits another selection', withBundle, async () => {
  const f = fixture(), file = new File([png], 'blocked.png');
  file.slice = () => ({ arrayBuffer: async () => { throw new Error('private content URI'); } });
  const result = f.pick(); f.select([file]); assert.equal((await result).canceled, true);
  assert.match(f.status(), /无法读取/); assert(f.reports.includes('image_input_unreadable'));
  const retry = f.pick(); f.select([new File([png], 'retry.png', { type: 'image/png' })]); assert.equal(f.status(), '');
  assert.equal((await retry).canceled, false); assert.equal(f.status(), '');
  assert(!JSON.stringify(f.reports).includes('private')); f.api.dispose();
});
test('selection and slow processing stay unobstructed while bounded diagnostics still finish', withBundle, async () => {
  const f = fixture(), result = f.pick(); f.select([new File([png], 'slow.png', { type: 'image/png' })]); await result;
  assert.equal(f.status(), ''); f.advance(15000); assert.equal(f.status(), '');
  assert.equal(f.observers.size, 0); assert(f.reports.includes('image_attachment_unconfirmed')); f.api.dispose(); assert.equal(f.timers.size, 0);
});
test('a stalled provider read is cancelled with retry feedback and no lingering timers', withBundle, async () => {
  const f = fixture(), file = new File([png], 'stalled.png'); file.slice = () => ({ arrayBuffer: () => new Promise(() => {}) });
  const result = f.pick(); f.select([file]); f.advance(15000); assert.equal((await result).canceled, true); await tick();
  assert(f.reports.includes('image_input_unreadable')); f.api.dispose(); assert.equal(f.timers.size, 0);
});
test('actual composer persistence failure still rejects and is diagnosed with visible feedback while preserving the original error', withBundle, async () => {
  const f = fixture(), result = f.pick(); f.select([new File([png], 'draft.png', { type: 'image/png' })]); const picked = await result;
  const error = Object.assign(new Error('private storage context'), { name: 'QuotaExceededError' });
  await assert.rejects(f.persist()({ pickImages: async () => [{ source: { kind: 'blob', blob: picked.assets[0].file }, mimeType: 'image/png' }],
    persister: { persistFromBlob: async () => { throw error; } } }), value => value === error);
  f.reject(error); assert.match(f.status(), /未能保存到草稿/); assert(f.reports.includes('image_attachment_failed')); f.api.dispose();
});
test('adapter only attaches to the trusted main page and supported bundle version', () => {
  assert.equal(fixture({ trusted: false }).api, null); assert.equal(fixture({ version: '0.13.0' }).api, null);
});
test('generic Workbench file input is untouched', () => {
  const f = fixture(), input = f.document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  f.document.body.appendChild(input); f.select([new File([png], 'workbench.png')]);
  assert.equal(f.reports.length, 0); assert.equal(f.status(), ''); f.api.dispose();
});
