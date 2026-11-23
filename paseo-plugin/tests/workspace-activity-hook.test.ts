import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { WORKSPACE_ACTIVITY_VISIBLE_LIMIT } from '../shared/workspace-activity.ts';

function harness() {
  let cursor = 0, nextTimer = 0, now = Date.now();
  const slots: any[] = [], effects: Array<() => void> = [], calls: any[] = [];
  const timers = new Map<number, { fn(): void; at: number }>();
  const react = {
    startTransition: (fn: () => void) => fn(),
    useRef(value: unknown) { const at = cursor++; return slots[at] ?? (slots[at] = { current: value }); },
    useState(value: unknown) {
      const at = cursor++;
      slots[at] ??= { value, set: (next: any) => { slots[at].value = typeof next === 'function' ? next(slots[at].value) : next; } };
      return [slots[at].value, slots[at].set];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) slots[at] = { value: fn, deps };
      return slots[at].value;
    },
    useEffect(effect: () => unknown, deps: unknown[]) {
      const at = cursor++, previous = slots[at];
      if (!previous || deps.some((value, index) => value !== previous.deps[index])) effects.push(() => {
        previous?.cleanup?.(); slots[at] = { deps, cleanup: effect() };
      });
    },
  };
  const source = readFileSync(new URL('../client/use-workspace-activity.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  vm.runInNewContext(code, {
    exports, Date: { now: () => now },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++nextTimer, { fn, at: now + ms }); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === '../shared/workspace-activity') return { WORKSPACE_ACTIVITY_VISIBLE_LIMIT };
      throw Error(name);
    },
  });
  const rpc = async (request: any) => {
    calls.push(request);
    return { ok: true, result: { generation: request.params.cursor?.generation, revision: 1, reset: false, updates: [], fullScan: null } };
  };
  return {
    calls,
    render(options: { open?: boolean; enabled?: boolean; project?: string } = {}) {
      cursor = 0;
      return exports.useWorkspaceActivity({ project: 'project', enabled: true, open: false, selectedWorkspaceId: 'main', snapshot: { generation: 'worker', revision: 0 }, rpc, reloadRoster: async () => {}, ...options });
    },
    async commit() { while (effects.length) effects.shift()!(); await turn(); },
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await turn();
    },
    async unmount() { for (const slot of slots) slot?.cleanup?.(); await turn(); },
  };
}

test('each selector opening reaches the backend even when a quick close is merged between polls', async () => {
  const h = harness();
  try {
    h.render(); await h.commit();
    assert.equal(h.calls[0].params.selectorOpen, false);
    h.render({ open: true }); await h.commit(); await h.advance(1_000);
    const first = h.calls.at(-1);
    assert.equal(first.params.selectorOpen, true);
    assert.equal(first.params.selectorSequence, 1);
    await h.advance(1_000);
    assert.equal(h.calls.at(-1).params.selectorSequence, 1, 'heartbeat retains its original opening');
    const before = h.calls.length;
    h.render(); await h.commit();
    h.render({ open: true }); await h.commit();
    assert.equal(h.calls.length, before, 'no closed request was sent between the two opening states');
    await h.advance(1_000);
    assert.equal(h.calls.at(-1).params.selectorOpen, true);
    assert.equal(h.calls.at(-1).params.selectorSequence, 2);
    assert.ok(h.calls.every(call => call.method === 'workspace.activity' && call.params.action === 'view'), 'opening does not request directory scans or forced activity scans');
  } finally { await h.unmount(); }
});

test('returning from the background creates a fresh view and preserves the open-selector catch-up request', async () => {
  const h = harness();
  try {
    h.render({ open: true }); await h.commit();
    const original = h.calls[0];
    assert.equal(original.params.selectorOpen, true);
    assert.equal(original.params.selectorSequence, 1);
    h.render({ enabled: false, open: true }); await h.commit();
    const afterPause = h.calls.length;
    await h.advance(2 * 24 * 60 * 60 * 1_000);
    assert.equal(h.calls.length, afterPause, 'background observation stays paused');
    h.render({ open: true }); await h.commit();
    const resumed = h.calls.at(-1);
    assert.notEqual(resumed.params.viewId, original.params.viewId);
    assert.equal(resumed.params.selectorOpen, true);
    assert.equal(resumed.params.selectorSequence, 1);
  } finally { await h.unmount(); }
});
