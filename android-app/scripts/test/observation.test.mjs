import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../app/src/main/assets/pocket-observer.js', import.meta.url), 'utf8');
function fixture({ version = '0.12.0', withStore = true, supportedTasks = true } = {}) {
  let time = 0, next = 0;
  const timers = new Map(), messages = [], all = new Set(), lists = new Set(), observers = new Set();
  const hosts = [{ serverId: 'private-host', password: 'private-password', endpoint: 'secret.example' }];
  const snapshots = new Map([['private-host', { connectionStatus: 'online', agentDirectoryStatus: 'ready', activeConnection: { type: 'relay' } }]]);
  const client = { connectionVerification: null, getConnectionState: () => ({ status: 'connected' }), getLastLivenessRttMs: () => 42 };
  let checks = 0;
  const schedule = (fn, delay = 0) => { const id = ++next; timers.set(id, { at: time + delay, fn }); return id; };
  const store = {
    getHosts: () => hosts, getSnapshot: id => snapshots.get(id), getClient: () => client,
    subscribeAll: fn => { all.add(fn); return () => all.delete(fn); },
    subscribeHostList: fn => { lists.add(fn); return () => lists.delete(fn); },
    ensureConnectedAll: options => {
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { verify: true }); checks++;
      client.connectionVerification = {};
      schedule(() => { client.connectionVerification = null; }, 1000);
    }
  };
  const window = { WebSocket: class OriginalSocket {}, PocketObservationChannel: { postMessage: value => messages.push(JSON.parse(value)) } };
  window.top = window;
  if (withStore) window.__paseoHostRuntimeStore = store;
  class Observer {
    static supportedEntryTypes = supportedTasks ? ['longtask'] : [];
    constructor(fn) { this.fn = fn; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const context = vm.createContext({ window, location: { origin: 'https://appassets.androidplatform.net', pathname: '/h/private-host' },
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789012' }, performance: { now: () => time },
    setTimeout: schedule, clearTimeout: id => timers.delete(id), PerformanceObserver: Observer,
    document: new Proxy({}, { get() { throw Error('The observer must not access the DOM'); } }) });
  const socket = window.WebSocket;
  const api = vm.runInContext(`(${source})(${JSON.stringify({ token: 'test-token', webVersion: version })})`, context);
  const hello = messages[0];
  api.activate(hello.doc, 'native-generation');
  const advance = delta => {
    const end = time + delta; let loops = 0;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
      if (!entry) break;
      assert(++loops < 10000, 'Unexpected persistent timer'); timers.delete(entry[0]); time = entry[1].at; entry[1].fn();
    }
    time = end;
  };
  const emit = () => [...all, ...lists].forEach(fn => fn());
  return { api, window, socket, hosts, snapshots, client, messages, timers, all, lists, observers, advance, emit,
    checks: () => checks, activate: () => api.foreground(true), latest: type => messages.filter(m => m.type === type).at(-1) };
}

test('observer subscribes without touching DOM, transports, secrets or host data', () => {
  const f = fixture(); f.activate();
  assert.equal(f.latest('state').hosts[0].phase, 'ready');
  assert.equal(f.latest('state').hosts[0].transport, 'relay');
  assert.equal(f.latest('state').hosts[0].selected, true);
  assert.equal(f.window.WebSocket, f.socket);
  assert.equal(f.all.size, 1); assert.equal(f.lists.size, 1);
  const exported = JSON.stringify(f.messages);
  for (const secret of ['private-host', 'private-password', 'secret.example']) assert(!exported.includes(secret));
  assert.equal(f.checks(), 0);
});
test('host updates are coalesced and directory readiness is distinct from transport readiness', () => {
  const f = fixture(); f.activate();
  const snap = f.snapshots.get('private-host');
  snap.agentDirectoryStatus = 'revalidating';
  for (let n=0;n<100;n++) f.emit();
  assert.equal(f.timers.size, 1); f.advance(80);
  assert.equal(f.latest('state').hosts[0].phase, 'syncing');
  snap.agentDirectoryStatus = 'error_after_ready'; f.emit(); f.advance(80);
  assert.equal(f.latest('state').hosts[0].phase, 'error');
});
test('multiple hosts retain anonymous identities and removed hosts disappear', () => {
  const f = fixture(); f.activate();
  f.hosts.push({ serverId: 'another-secret' });
  f.snapshots.set('another-secret', { connectionStatus: 'offline' }); f.emit(); f.advance(80);
  assert.deepEqual(f.latest('state').hosts.map(h => h.host), [1,2]);
  f.hosts.shift(); f.emit(); f.advance(80);
  assert.deepEqual(f.latest('state').hosts.map(h => h.host), [2]);
  assert(!JSON.stringify(f.messages).includes('another-secret'));
});
test('connection verification reuses the existing client and merges repeated clicks', () => {
  const f = fixture(); f.activate();
  assert.equal(f.api.verify(), true); assert.equal(f.api.verify(), false);
  assert.equal(f.checks(), 1); assert.equal(f.latest('state').hosts[0].phase, 'connecting');
  f.advance(1100); assert.equal(f.latest('verification').busy, false);
  assert.equal(f.latest('state').hosts[0].phase, 'ready');
  f.api.foreground(false); assert.equal(f.api.verify(), false); assert.equal(f.timers.size, 0);
});
test('verification has a bounded observation deadline', () => {
  const f = fixture(); f.activate(); f.api.verify(); f.client.getConnectionState = () => ({ status: 'connecting' });
  f.advance(6100); assert.equal(f.latest('verification').busy, false); assert.equal(f.timers.size, 0);
});
test('missing runtime times out without permanent polling', () => {
  const f = fixture({ withStore: false }); f.activate(); f.advance(15100);
  assert.equal(f.latest('unavailable').reason, 'timeout'); assert.equal(f.timers.size, 0);
});
test('unknown web version does not inspect or operate the runtime', () => {
  const f = fixture({ version: '0.12.1' }); f.activate();
  assert.equal(f.latest('unavailable').reason, 'version'); assert.equal(f.all.size, 0);
  assert.equal(f.api.verify(), false); assert.equal(f.timers.size, 0);
});
test('incompatible or throwing runtime safely unsubscribes', () => {
  const f = fixture(); f.activate(); f.snapshots.get = () => { throw Error('sensitive upstream error'); };
  f.emit(); f.advance(80);
  assert.equal(f.latest('unavailable').reason, 'incompatible'); assert.equal(f.all.size, 0); assert.equal(f.lists.size, 0);
  assert(!JSON.stringify(f.messages).includes('sensitive'));
});
test('no continuous polling after attachment; refresh only reads existing RTT', () => {
  const f = fixture(); f.activate(); f.advance(30000);
  assert.equal(f.timers.size, 0); assert.equal(f.checks(), 0);
  f.api.refresh(); assert.equal(f.latest('state').hosts[0].rttAgeMs, 30000);
});
test('long tasks are observed only while requested in the foreground', () => {
  const f = fixture(); f.activate(); assert.equal(f.observers.size, 0);
  f.api.inspect(true, true); assert.equal(f.observers.size, 1);
  f.advance(100); [...f.observers][0].fn({ getEntries: () => [{ startTime: 1, duration: 70 }] });
  assert.equal(f.latest('tasks').count, 1);
  f.api.foreground(false); assert.equal(f.observers.size, 0);
  f.advance(30000); f.api.foreground(true);
  [...f.observers][0].fn({ getEntries: () => [{ startTime: 10, duration: 30000 }] });
  assert.equal(f.latest('tasks').count, 1, 'A background gap must not become a long task');
  f.api.inspect(false); assert.equal(f.observers.size, 0);
});
test('unsupported performance observers are explicit and do not install a timer fallback', () => {
  const f = fixture({ supportedTasks: false }); f.activate(); f.api.inspect(true);
  assert.equal(f.latest('tasks').supported, false); assert.equal(f.observers.size, 0); assert.equal(f.timers.size, 0);
});
test('dispose releases all timers, observers and subscriptions', () => {
  const f = fixture(); f.activate(); f.api.inspect(true); f.api.verify(); f.emit(); f.api.dispose();
  // Only the test transport's own artificial verification deadline remains.
  f.advance(7000);
  assert.equal(f.all.size, 0); assert.equal(f.lists.size, 0); assert.equal(f.observers.size, 0); assert.equal(f.timers.size, 0);
  const count = f.messages.length; f.emit(); f.api.refresh(); assert.equal(f.messages.length, count);
});
test('document activation rejects a different document and cannot replace an established generation', () => {
  const f = fixture(); f.api.activate('old-document', 'wrong'); f.api.activate(f.messages[0].doc, 'wrong'); f.activate();
  assert.equal(f.latest('state').generation, 'native-generation');
});

const bundleDir = new URL('../../app/src/main/assets/paseo/', import.meta.url);
const hasBundle = existsSync(new URL('_workbench.json', bundleDir));
test('locked real web bundle retains the exact adapter contract', { skip: !hasBundle && !process.env.POCKET_VERIFY_BUNDLED_ADAPTER }, () => {
  const manifest = JSON.parse(readFileSync(new URL('_workbench.json', bundleDir), 'utf8'));
  assert.equal(manifest.metadata.version, '0.12.0');
  const entry = manifest.files.find(f => /\/index-[\w]+\.js$/.test(f.path));
  assert(entry, 'Missing bundled web entry');
  const code = readFileSync(new URL(entry.path, bundleDir), 'utf8');
  for (const signature of ['__paseoHostRuntimeStore', 'getHosts(){', 'getSnapshot(e){', 'getClient(e){',
    'subscribeAll(e){', 'subscribeHostList(e){', 'ensureConnectedAll(e){', 'getLastLivenessRttMs(){', 'connectionVerification=null',
    'agentDirectoryStatus', 'activeConnection']) assert(code.includes(signature), `Adapter contract changed: ${signature}`);
});
