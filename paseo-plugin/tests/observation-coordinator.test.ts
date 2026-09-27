import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationCoordinator, validation, type Clock, type QueryView } from '../client/observation-coordinator.ts';
import { OBSERVATION_POLICY as policy } from '../shared/observation-policy.ts';
import type { ObserverResponse } from '../shared/observer.ts';

class FakeClock implements Clock {
  at = 1_000_000; serial = 0; tasks = new Map<number, { at: number; fn(): void }>();
  now = () => this.at;
  set = (fn: () => void, ms: number) => { const id = ++this.serial; this.tasks.set(id, { at: this.at + ms, fn }); return id; };
  clear = (id: unknown) => { this.tasks.delete(Number(id)); };
  async advance(ms: number) {
    const end = this.at + ms;
    for (let i = 0; i < 2000; i++) {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      const next = [...this.tasks].sort((a,b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) { this.at = end; return; }
      this.at = next[1].at; this.tasks.delete(next[0]); next[1].fn();
    }
    throw Error('timer loop');
  }
}
function setup() {
  const time = new FakeClock();
  const tokens: Record<string, string> = { '/a#working': '1', '/b#working': '1', roster: '1' };
  let reads = 0, fail = false;
  const issues: (string | null)[] = [], queries: QueryView[] = [], counts: Record<string, number> = {};
  const coordinator = new ObservationCoordinator('p', {
    queries: () => queries,
    read: async () => { reads++; if (fail) throw Error('offline'); return { ok: true, result: { instanceId: 'one', revision: 1, tokens } }; },
    issue: v => issues.push(v),
  }, time);
  const add = (id: string) => {
    const response = (): ObserverResponse => ({ ok: true, result: { observation: { state: 'ready', validationKey: `/${id}#working`, validationToken: tokens[`/${id}#working`] } } });
    const q: QueryView = { id, key: ['workspace-workbench','p','repository-changes','w',id], active: true, fetching: false, updatedAt: time.now(), data: response(),
      fetch: async () => { counts[id] = (counts[id] || 0) + 1; q.data = response(); q.updatedAt = time.now(); coordinator.changed(); },
      validate: () => {},
    };
    queries.push(q); return q;
  };
  return { time, tokens, issues, queries, counts, coordinator, add, reads: () => reads, fail: () => { fail = true; }, recover: () => { fail = false; } };
}

test('A B A reuses cached data; 15s version polls do not read unchanged repositories', async () => {
  const s = setup(), a = s.add('a'), b = s.add('b'); b.active = false;
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  for (let n = 0; n < 20; n++) { a.active = !a.active; b.active = !b.active; s.coordinator.changed(); await s.time.advance(100); }
  assert.deepEqual(s.counts, {});
  await s.time.advance(58_000);
  assert.equal(s.reads(), 5); // initial + four checks per minute
  assert.deepEqual(s.counts, {});
  s.coordinator.close();
});

test('inactive changes are read only on activation, and only once', async () => {
  const s = setup(), a = s.add('a'), b = s.add('b'); b.active = false;
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  s.tokens['/b#working'] = '2'; await s.time.advance(15_000);
  assert.deepEqual(s.counts, {});
  a.active = false; b.active = true; s.coordinator.changed(); await s.time.advance(0);
  assert.equal(s.counts.b, 1); await s.time.advance(30_000); assert.equal(s.counts.b, 1);
});

test('multiple subscribers share polling; unsubscribe stops queued reads and polling', async () => {
  const s = setup(); s.add('a');
  const one = s.coordinator.subscribe(['w']), two = s.coordinator.subscribe(['w']); await s.time.advance(0);
  assert.equal(s.reads(), 1); one(); s.coordinator.refresh(); two(); await s.time.advance(60_000);
  assert.equal(s.reads(), 1); assert.deepEqual(s.counts, {});
  s.coordinator.subscribe(['w']); await s.time.advance(0); assert.equal(s.reads(), 2);
});

test('fixed commit cache ignores working-tree tokens', () => {
  assert.equal(validation({ ok: true, result: { observation: { immutableIdentity: '/a:sha:path', validationKey: '/a#working', validationToken: '1' } } }, { instanceId: 'two', revision: 0, tokens: { '/a#working': '2' } }), 'same');
});

test('failures back off, warn only after the verification window, recover automatically', async () => {
  const s = setup(); s.add('a'); s.coordinator.subscribe(['w']); await s.time.advance(0); s.fail();
  await s.time.advance(60_000); assert.ok(!s.issues.includes('offline'));
  await s.time.advance(65_000); assert.ok(s.issues.includes('offline'));
  s.recover(); await s.time.advance(30_000); assert.equal(s.issues.at(-1), null);
});

test('legacy/native activation uses a 30s read floor without a version poll', async () => {
  const s = setup(), a = s.add('a'); a.data = { ok: true, result: {} };
  s.coordinator.subscribe(['w'], false); await s.time.advance(0); assert.equal(s.reads(), 0);
  a.active = false; s.coordinator.changed(); await s.time.advance(5_000); a.active = true; s.coordinator.changed(); await s.time.advance(0);
  assert.deepEqual(s.counts, {});
  a.active = false; s.coordinator.changed(); await s.time.advance(30_000); a.active = true; s.coordinator.changed(); await s.time.advance(0);
  assert.equal(s.counts.a, 1);
});

test('pending manual refresh waits for running cleanup and coalesces repeats', async () => {
  const s = setup(), a = s.add('a'); let release!: () => void, calls = 0;
  a.fetch = () => { calls++; return new Promise<void>(resolve => { release = resolve; }); };
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  s.coordinator.refresh(); await s.time.advance(0); assert.equal(calls, 1);
  s.coordinator.refresh(); s.coordinator.refresh(); await s.time.advance(100); assert.equal(calls, 1);
  release(); await s.time.advance(0); assert.equal(calls, 2);
  s.coordinator.close(); release();
});

test('lease includes substantial jitter and retries beyond the normal poll interval', () => {
  assert.ok(policy.leaseMs >= 4 * policy.pollMs);
});

test('bounded refresh attempts survive selection changes and stop until the next poll', async () => {
  const s = setup(), a = s.add('a');
  a.data = { ok: true, result: { observation: { state: 'ready', refreshing: true, validationKey: '/a#working', validationToken: '1' }, cache: { updatedAt: 'generation-one' } } };
  let calls = 0;
  a.fetch = async () => { calls++; a.data = structuredClone(a.data); s.coordinator.changed(); };
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  // The initial version poll may check completion once; subsequent attempts are bounded.
  const first = calls;
  await s.time.advance(5000);
  assert.equal(calls - first, 3);
  for (let i = 0; i < 5; i++) { a.active = false; s.coordinator.changed(); a.active = true; s.coordinator.changed(); }
  await s.time.advance(5000); assert.equal(calls - first, 3);
  await s.time.advance(5000); assert.equal(calls - first, 4);
});

test('business transport errors use bounded backoff rather than an immediate retry loop', async () => {
  const s = setup(), a = s.add('a'); let calls = 0;
  a.fetch = async () => { calls++; a.error = Error('transport'); s.coordinator.changed(); throw a.error; };
  s.coordinator.subscribe(['w'], false); s.coordinator.refresh(); await s.time.advance(0);
  assert.equal(calls, 1); await s.time.advance(1999); assert.equal(calls, 1);
  await s.time.advance(1); assert.equal(calls, 2);
  await s.time.advance(5000); assert.equal(calls, 3);
  await s.time.advance(10_000); assert.equal(calls, 4);
  s.coordinator.close();
});

test('late old-subscription version responses cannot update the current view', async () => {
  const time = new FakeClock(); let resolve!: (r: ObserverResponse) => void; const issues: (string | null)[] = [];
  const c = new ObservationCoordinator('p', { queries: () => [], read: () => new Promise(r => { resolve = r; }), issue: v => issues.push(v) }, time);
  const unsubscribe = c.subscribe(['old']); await time.advance(0); unsubscribe(); c.subscribe(['new']);
  resolve({ ok: false, error: { code: 'old', message: 'old' } }); await time.advance(0);
  assert.ok(!issues.includes('old')); assert.equal(c.counters.versionReads, 2); c.close();
});

test('panel-to-diff subscription handoff within freshness window resumes periodic validation', async () => {
  const s = setup(); s.add('a');
  const closePanel = s.coordinator.subscribe(['w']); await s.time.advance(0);
  await s.time.advance(500); closePanel();
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  assert.equal(s.reads(), 2);
  s.tokens['/a#working'] = '2'; await s.time.advance(15_000);
  assert.equal(s.reads(), 3); assert.equal(s.counts.a, 1);
});

test('manual refresh is not dropped when it overlaps an automatic refresh decision', async () => {
  const s = setup(), a = s.add('a');
  s.coordinator.subscribe(['w']); await s.time.advance(0);
  a.active = false; s.coordinator.changed();
  s.tokens['/a#working'] = '2'; await s.time.advance(15_000);
  a.active = true; s.coordinator.changed();
  const done = s.coordinator.refresh();
  // An external observer finished a read between activation and queue dispatch.
  a.data = { ok: true, result: { observation: { state: 'ready', validationKey: '/a#working', validationToken: '2' } } };
  await s.time.advance(0); await done;
  assert.equal(s.counts.a, 1);
});

test('backend generation change refreshes roster even when its numeric token is unchanged', async () => {
  const time = new FakeClock(); let instanceId = 'old', calls = 0;
  const q: QueryView = { id: 'list', key: ['workspace-workbench','p','workspace-list'], active: true, fetching: false, updatedAt: time.now(),
    data: { ok: true, result: { observation: { state: 'ready', validationKey: 'roster', validationToken: '1' } } },
    fetch: async () => { calls++; }, validate: () => {},
  };
  const c = new ObservationCoordinator('p', { queries: () => [q], read: async () => ({ ok: true, result: { instanceId, revision: 0, tokens: { roster: '1' } } }), issue: () => {} }, time);
  c.subscribe(['w']); await time.advance(0); assert.equal(calls, 0);
  instanceId = 'new'; await time.advance(15_000); assert.equal(calls, 1); c.close();
});

test('native foreground re-entry resumes a failed read whose retry was paused', async () => {
  const s = setup(), a = s.add('a');
  a.data = { ok: false, error: { code: 'observer_timeout', message: 'temporary' } };
  const leave = s.coordinator.subscribe(['w'], false);
  leave(); await s.time.advance(30_000);
  s.coordinator.subscribe(['w'], false); await s.time.advance(2000);
  assert.equal(s.counts.a, 1);
});

test('partial cached responses participate in failure backoff rather than rapid follow-up loops', async () => {
  const s = setup(), a = s.add('a'); let calls = 0;
  a.fetch = async () => {
    calls++; a.data = { ok: true, result: { observation: { state: 'partial', refreshing: true, validationKey: '/a#working', validationToken: '1', observedAt: String(calls) } } };
    s.coordinator.changed();
  };
  s.coordinator.subscribe(['w']); await s.time.advance(0); s.coordinator.refresh(); await s.time.advance(0);
  assert.equal(calls, 1); await s.time.advance(1999); assert.equal(calls, 1);
  await s.time.advance(1); assert.equal(calls, 2);
  await s.time.advance(5000); assert.equal(calls, 3); s.coordinator.close();
});

test('read tasks use the shared coordinator polling cadence and stop on background departure', async () => {
  const s = setup(), a = s.add('a'); let calls = 0;
  const pending = (ms: number) => ({ ok: true, result: { observation: { state: 'ready', refreshing: true, readTask: { state: 'queued', deadline: s.time.now() + 30000, nextPollMs: ms } } } });
  a.data = pending(250);
  a.fetch = async () => { calls++; a.data = pending(calls === 1 ? 500 : 1000); s.coordinator.changed(); };
  const leave = s.coordinator.subscribe(['w']); await s.time.advance(249); assert.equal(calls, 0);
  await s.time.advance(1); assert.equal(calls, 1);
  await s.time.advance(500); assert.equal(calls, 2);
  leave(); await s.time.advance(10000); assert.equal(calls, 2); s.coordinator.close();
});

test('terminal file errors are not replayed by version polling or retry timers', async () => {
  const s = setup(), a = s.add('a');
  a.data = { ok: false, error: { code: 'git_timeout', message: 'failed', details: { terminal: true, readTask: true } } };
  s.coordinator.subscribe(['w']); await s.time.advance(120000);
  assert.deepEqual(s.counts, {}); s.coordinator.close();
});

test('React Query initial fetch completing with a pending task does not lose the first status poll', async () => {
  const s = setup(), a = s.add('a');
  a.data = undefined;
  s.coordinator.subscribe(['w'], false); // activation queues the initial read
  a.fetching = true; s.coordinator.changed(); // QueryObserver starts its own read
  a.data = { ok: true, result: { observation: { state: 'ready', refreshing: true, readTask: { state: 'running', deadline: s.time.now() + 30000, nextPollMs: 250 } } } };
  a.fetching = false; s.coordinator.changed();
  await s.time.advance(250);
  assert.equal(s.counts.a, 1);
  s.coordinator.close();
});

test('a hidden panel does not poll its pending file while another panel keeps the project active', async () => {
  const s = setup(), hidden = s.add('hidden'), visible = s.add('visible');
  hidden.data = { ok: true, result: { observation: { state: 'ready', refreshing: true, readTask: { state: 'running', deadline: s.time.now() + 30000, nextPollMs: 250 } } } };
  hidden.active = false;
  s.coordinator.subscribe(['w']);
  await s.time.advance(1000);
  assert.equal(s.counts.hidden, undefined);
  hidden.active = true; visible.active = false; s.coordinator.changed();
  await s.time.advance(250);
  assert.equal(s.counts.hidden, 1);
  s.coordinator.close();
});
