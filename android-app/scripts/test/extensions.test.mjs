import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const asset = name => readFileSync(new URL(`../../app/src/main/assets/${name}`, import.meta.url), 'utf8');
const createCore = vm.runInNewContext(asset('pocket-extensions-core.js'), { queueMicrotask });
const definition = (id = 'inspector') => ({ id, title: 'Inspector', icon: 'GitBranch', location: 'right-sidebar',
  content: { workspacePanelId: 'inspector-workspace', agentPanelId: 'inspector-agent' } });
const flush = () => new Promise(resolve => queueMicrotask(resolve));
function fixture() {
  let installed = []; const listeners = new Set(), codes = [];
  const registry = { getSnapshot: () => installed, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const core = createCore({ report: code => codes.push(code) });
  const owner = (serverId = 'host-a', id = 'example-plugin') => ({ id, serverId, paseo: {}, lifetime: new AbortController(),
    workspacePanels: [{ id: 'inspector-workspace', context: 'workspace' }, { id: 'inspector-agent', context: 'agent' }] });
  return { core, registry, codes, listeners, owner,
    publish(values) { installed = values; for (const listener of listeners) listener(); } };
}

test('setup registration waits for the actual installation, without trusting a claimed plugin or host ID', async () => {
  const f = fixture(), owner = f.owner();
  f.core.attachRegistry(f.registry);
  const plugin = f.core.api.connect({ paseo: owner.paseo, pluginId: 'another-plugin', hostId: 'host-b' });
  assert.equal(f.core.api.connect({ paseo: owner.paseo }), plugin);
  plugin.ui.registerPanel(definition());
  assert.equal(f.core.panels('host-a').length, 0);
  f.publish([owner]); await flush();
  assert.equal(f.core.panels('host-a').length, 1); assert.equal(f.core.panels('host-b').length, 0);
  assert.equal(f.core.panels('host-a')[0].owner, owner);
  assert.equal(plugin.supports('ui.panel.right-sidebar'), true); assert.equal(plugin.supports('future.capability'), false);
  f.core.dispose(); assert.equal(f.listeners.size, 0);
});

test('the same plugin on two hosts has independent ownership, context and cleanup', async () => {
  const f = fixture(), a = f.owner(), b = f.owner('host-b');
  f.publish([a, b]); f.core.attachRegistry(f.registry);
  const first = f.core.api.connect({ paseo: a.paseo }), second = f.core.api.connect({ paseo: b.paseo });
  first.ui.registerPanel(definition()); second.ui.registerPanel(definition()); await flush();
  let notifications = 0; const off = first.context.subscribe(() => notifications++);
  f.core.setContext({ hostId: 'host-a', workspaceId: 'workspace-one', agentId: 'agent-one' });
  const snapshot = first.context.getSnapshot();
  assert.equal(snapshot.workspaceId, 'workspace-one'); assert.equal(second.context.getSnapshot(), null);
  for (let i = 0; i < 8; i++) f.core.setContext({ hostId: 'host-a', workspaceId: 'workspace-one', agentId: 'agent-one' });
  assert.equal(first.context.getSnapshot(), snapshot); assert.equal(notifications, 1);
  f.core.setContext({ hostId: 'host-b', workspaceId: 'workspace-two' }); assert.equal(first.context.getSnapshot(), null);
  a.lifetime.abort(); assert.equal(f.core.panels('host-a').length, 0); assert.equal(f.core.panels('host-b').length, 1);
  assert.equal(first.supports('ui.panel.right-sidebar'), false); assert.equal(second.supports('ui.panel.right-sidebar'), true);
  off(); f.core.dispose();
});

test('only an owned registered workspace panel can be displayed, with optional agent rendering', async () => {
  const f = fixture(), owner = f.owner(); f.publish([owner]); f.core.attachRegistry(f.registry);
  const plugin = f.core.api.connect({ paseo: owner.paseo });
  plugin.ui.registerPanel({ ...definition(), content: { workspacePanelId: 'other-plugin-panel' } }); await flush();
  assert.equal(f.core.panels('host-a').length, 0); f.core.dispose();
});

test('updates are in place, duplicate IDs do not duplicate UI, and disposal is idempotent', async () => {
  const f = fixture(), owner = f.owner(); f.publish([owner]); f.core.attachRegistry(f.registry);
  const plugin = f.core.api.connect({ paseo: owner.paseo });
  const panel = plugin.ui.registerPanel(definition()); plugin.ui.registerPanel(definition()); await flush();
  assert.equal(f.core.panels('host-a').length, 1); assert.deepEqual(f.codes, ['extension_registration_invalid']);
  const key = f.core.panels('host-a')[0].key;
  panel.update({ title: 'Updated', icon: 'File', id: 'new-id', content: { workspacePanelId: 'wrong' } });
  assert.equal(f.core.panels('host-a')[0].key, key); assert.equal(f.core.panels('host-a')[0].title, 'Updated');
  panel.update({ enabled: false }); assert.equal(f.core.panels('host-a').length, 0);
  panel.update({ enabled: true }); assert.equal(f.core.panels('host-a').length, 1);
  panel.dispose(); panel.dispose(); panel.update({ enabled: true }); assert.equal(f.core.panels('host-a').length, 0);
  plugin.dispose(); plugin.dispose(); f.core.dispose();
});

test('reload keeps a stable preference identity while retiring the old generation and its subscriptions', async () => {
  const f = fixture(), old = f.owner(), next = f.owner(); f.publish([old]); f.core.attachRegistry(f.registry);
  const first = f.core.api.connect({ paseo: old.paseo }); first.ui.registerPanel(definition()); await flush();
  const before = f.core.panels('host-a')[0]; old.lifetime.abort();
  const second = f.core.api.connect({ paseo: next.paseo }); second.ui.registerPanel(definition());
  f.publish([next]); await flush(); const after = f.core.panels('host-a')[0];
  assert.notEqual(before.key, after.key); assert.equal(before.preferenceKey, after.preferenceKey);
  f.core.setContext({ hostId: 'host-a', workspaceId: 'new-instance' });
  assert.equal(first.context.getSnapshot(), null); assert.equal(second.context.getSnapshot().workspaceId, 'new-instance');
  f.core.catalog('host-a', [{ id: old.id }]); assert.equal(f.core.hasPlugin('host-a', old.id), true);
  f.core.catalog('host-a', []); assert.equal(f.core.hasPlugin('host-a', old.id), false);
  f.core.dispose(); assert.equal(f.core.debug().sessions, 0); assert.equal(f.core.debug().listeners, 0);
});

test('setup failures and late publication cannot resurrect disposed registrations', async () => {
  const f = fixture(), owner = f.owner(); f.core.attachRegistry(f.registry);
  const plugin = f.core.api.connect({ paseo: owner.paseo }); plugin.ui.registerPanel(definition());
  await flush(); f.publish([owner]); await flush();
  assert.equal(f.core.panels('host-a').length, 0); assert.equal(plugin.supports('ui.panel.right-sidebar'), false);
  f.core.disable(); assert.equal(f.core.api.connect({ paseo: owner.paseo }), null); f.core.dispose();
});

function adapterFixture({ version = '0.12.0', fingerprint = '0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381', badRegistry = false } = {}) {
  const window = {}, definitions = new Map(), codes = [], style = { remove() {} };
  let calls = 0, attached = 0, disabled = 0;
  const core = { attachRegistry() { if (badRegistry) throw Error('injected adapter failure'); attached++; }, catalog() {}, disable() { disabled++; } };
  const events = new Map();
  const document = { documentElement: { append() {} }, createElement: () => style, addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); } };
  const install = vm.runInNewContext(asset('pocket-extensions-paseo-0.12.js'), { window, document, Object, Set, Map, JSON });
  const adapter = install({ webVersion: version, bundleSha256: fingerprint }, core, { report: code => codes.push(code) });
  const original = (factory, id) => definitions.set(id, factory);
  function define(id) { window.__d((global, require, a, b, module) => { calls++;
    if (id === 3680) module.exports.pluginRegistry = { getSnapshot() {}, subscribe() {}, installCatalog() {} };
    else module.exports.CompactExplorerSidebar = function Original() {};
  }, id, []); }
  function run(id) { const module = { exports: {} }; definitions.get(id)(window, moduleId => moduleId === 3907 ? { createPluginNavigation: () => ({}) } : ({ createElement() {}, Component: class {} }), null, null, module); return module.exports; }
  return { window, adapter, codes, original, define, run, events, stats: () => ({ calls, attached, disabled }) };
}

test('an unknown bundle fingerprint leaves the host module loader untouched', () => {
  const f = adapterFixture({ fingerprint: 'unknown' }); assert.equal(f.adapter, null); assert.equal('__d' in f.window, false);
});
test('the temporary module hook restores after its two targets, runs host factories once, and cleans up', () => {
  const f = adapterFixture(); f.window.__d = f.original; f.define(3680); f.define(4604);
  assert.equal(f.window.__d, f.original); f.run(3680); f.run(4604);
  assert.deepEqual(f.stats(), { calls: 2, attached: 1, disabled: 0 });
  f.adapter.dispose(); f.adapter.dispose(); assert.equal(f.window.__d, f.original);
});
test('an adapter exception disables enhancements without retrying the original factory', () => {
  const f = adapterFixture({ badRegistry: true }); f.window.__d = f.original; f.define(3680); f.run(3680);
  assert.equal(f.window.__d, f.original); assert.deepEqual(f.stats(), { calls: 1, attached: 0, disabled: 1 });
  assert.deepEqual(f.codes, ['extension_adapter_unavailable']); f.adapter.dispose();
});


test('unknown page versions and missing target definitions preserve the host loader', () => {
  const unknown = adapterFixture({ version: '0.13.0' });
  assert.equal(unknown.adapter, null); assert.equal('__d' in unknown.window, false);
  const missing = adapterFixture(); missing.window.__d = missing.original; missing.define(3680);
  missing.events.get('DOMContentLoaded')();
  assert.equal(missing.window.__d, missing.original);
  assert.equal(missing.stats().disabled, 1);
  assert.deepEqual(missing.codes, ['extension_adapter_unavailable']);
  missing.adapter.dispose(); assert.equal(missing.events.size, 0);
});

function bootstrapFixture({ compatible = true, embedded = false, sameOrigin = true } = {}) {
  const events = new Map(), messages = [], calls = [];
  const window = { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); },
    PocketExtensionsChannel: { postMessage(raw) { messages.push(JSON.parse(raw)); } } };
  window.top = embedded ? {} : window;
  const install = vm.runInNewContext(asset('pocket-extensions.js'), { window, location: { origin: sameOrigin ? 'https://pocket.invalid' : 'https://external.invalid' }, crypto: { randomUUID: () => 'document-one' } });
  const core = { api: {}, dispose() { calls.push('core-dispose'); } };
  const adapter = { dispose() { calls.push('adapter-dispose'); }, foreground(value) { calls.push(['foreground', value]); }, handleBack() { return true; } };
  let state;
  const bridge = install({ origin: 'https://pocket.invalid', token: 'token' }, () => core, (config, core, callbacks) => {
    state = callbacks.state; return compatible ? adapter : null;
  });
  return { window, events, messages, calls, bridge, state };
}

test('document handshake ignores old documents and reports already-open sidebar after activation', () => {
  const f = bootstrapFixture(); assert(f.window.Pocket); assert.equal(f.messages[0].type, 'hello');
  f.state(true); assert.equal(f.messages.length, 1);
  f.bridge.activate('old-document', 'generation-old'); assert.equal(f.messages.length, 1);
  f.bridge.activate('document-one', 'generation-current');
  assert.equal(f.messages[1].type, 'activated'); assert.equal(f.messages[2].open, true);
  assert.equal(f.messages[2].generation, 'generation-current');
  f.bridge.activate('document-one', 'generation-duplicate'); assert.equal(f.messages.length, 3);
  assert.equal(f.bridge.handleBack(), true); f.bridge.foreground(false);
  f.events.get('pagehide')(); f.bridge.dispose(); f.bridge.dispose();
  assert.equal(f.window.Pocket, undefined);
  assert.deepEqual(f.calls, [['foreground', false], 'adapter-dispose', 'core-dispose']);
  assert.equal(f.events.size, 0);
});

test('unsupported, external and child documents do not expose a Pocket extension API', () => {
  for (const options of [{ compatible: false }, { embedded: true }, { sameOrigin: false }]) {
    const f = bootstrapFixture(options); assert.equal(f.bridge, null); assert.equal(f.window.Pocket, undefined);
    assert.equal(f.messages.length, 0); assert.equal(f.events.size, 0);
  }
});

if (process.env.POCKET_VERIFY_BUNDLED_ADAPTER === '1') test('the bundled official 0.12 page matches the pinned adapter entry and exports', () => {
  const base = new URL('../../app/src/main/assets/paseo/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('_workbench.json', base), 'utf8'));
  const entry = manifest.files.find(row => /^_expo\/static\/js\/web\/index-[a-f0-9]+\.js$/.test(row.path));
  assert(entry); const source = readFileSync(new URL(entry.path, base), 'utf8');
  const fingerprint = createHash('sha256').update(source).digest('hex');
  assert.equal(fingerprint, '0551012c13e098ebdd9ba96ef639952b84ba25a15e766d41b215c20841bd3381');
  assert.equal(entry.sha256, fingerprint);
  for (const [id, name] of [[3680, 'pluginRegistry'], [4604, 'CompactExplorerSidebar'], [3907, 'createPluginNavigation']]) {
    const module = source.split('\n').find(line => line.includes(`},${id},[`));
    assert(module?.includes(name), `Pinned module ${id} must export ${name}`);
  }
  const native = readFileSync(new URL('../../app/src/main/java/dev/paseo/pocket/PocketExtensionsBridge.kt', import.meta.url), 'utf8');
  assert(native.includes(fingerprint)); assert(native.includes(entry.path));
});
