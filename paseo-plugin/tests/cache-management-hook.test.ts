import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import { cacheTaskActive } from '../shared/cache-management.ts';
import { uncertainControlFailure } from '../shared/task-state.ts';

function harness() {
  const slots: any[] = []; let cursor = 0, id = 0, refetches = 0;
  const effects: Array<() => void> = [], timers = new Map<number, () => void>(), calls: any[] = [];
  const data: any = { stale: false, nextScanAt: Date.now() + 60_000, resources: [], workspaces: [] };
  const react = {
    useRef(value: unknown) { const at = cursor++; return slots[at] ?? (slots[at] = { current: value }); },
    useState(value: unknown) { const at = cursor++; if (!slots[at]) slots[at] = { value, set: (next: any) => { slots[at].value = typeof next === 'function' ? next(slots[at].value) : next; } }; return [slots[at].value, slots[at].set]; },
    useCallback(fn: unknown, deps: unknown[]) { const at = cursor++, previous = slots[at]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) slots[at] = { value: fn, deps }; return slots[at].value; },
    useEffect(effect: () => unknown, deps: unknown[]) { const at = cursor++, previous = slots[at]; if (!previous || deps.some((value, index) => value !== previous.deps[index])) effects.push(() => { previous?.cleanup?.(); slots[at] = { deps, cleanup: effect() }; }); },
  };
  const source = readFileSync(new URL('../client/use-cache-management.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {}, refetch = async () => { refetches++; };
  vm.runInNewContext(code, { exports, setInterval: (fn: () => void) => { timers.set(++id, fn); return id; }, clearInterval: (value: number) => timers.delete(value), require: (name: string) => {
    if (name === 'react') return react;
    if (name === '@tanstack/react-query') return { useQuery: (options: any) => options.queryKey.includes('cache-inventory') ? { data, refetch } : { data: undefined, refetch } };
    if (name === '../shared/cache-management') return { cacheTaskActive };
    if (name === '../shared/task-state') return { uncertainControlFailure };
    throw Error(name);
  } });
  const rpc = (project: string) => async (request: any) => { calls.push({ project, ...request }); return { ok: true, result: { state: 'complete', phase: 'fresh' } }; };
  const firstRpc = rpc('a'), secondRpc = rpc('b');
  return {
    calls, data,
    render(options: { visible?: boolean; foreground?: boolean; watching?: boolean; project?: string; workspaceId?: string } = {}) {
      cursor = 0;
      const project = options.project || 'a';
      return exports.useCacheManagement({ enabled: true, foreground: true, visible: true, watching: false, workspaceId: 'main', ...options, project, rpc: project === 'a' ? firstRpc : secondRpc });
    },
    async commit() { while (effects.length) effects.shift()!(); await turn(); },
    async tick() { for (const tick of timers.values()) tick(); await turn(); },
    async unmount() { for (const slot of slots) slot?.cleanup?.(); await turn(); },
    refetches: () => refetches,
  };
}

test('cache polling does not record repeated use; hiding the page pauses its own demand', async () => {
  const h = harness(); h.render(); await h.commit();
  assert.equal(h.calls.filter(value => value.params.action === 'activity').length, 1);
  const first = h.calls.find(value => value.params.action === 'start'); assert.ok(first.params.automatic); assert.equal(first.params.force, false);
  await h.tick(); h.render(); await h.commit(); await h.tick();
  assert.equal(h.calls.filter(value => value.params.action === 'activity').length, 1);
  h.render({ visible: false, watching: true }); await h.commit();
  assert.ok(h.calls.some(value => value.params.action === 'pause' && value.params.viewId === first.params.viewId));
  const count = h.calls.length; await h.tick(); assert.equal(h.calls.length, count, 'opening the selector alone never starts a directory scan');
  h.render(); await h.commit();
  const reopened = h.calls.filter(value => value.params.action === 'start').at(-1); assert.notEqual(reopened.params.viewId, first.params.viewId);
  await h.unmount();
});

test('foreground/project transitions retire the captured project view and keep manual refresh selective by default', async () => {
  const h = harness(); let cache = h.render(); await h.commit();
  await cache.scan(); await cache.scan(true);
  const manual = h.calls.filter(value => value.params.action === 'start' && !value.params.automatic);
  assert.equal(manual[0].params.force, false); assert.equal(manual[1].params.force, true);
  h.render({ project: 'b', workspaceId: 'other' }); await h.commit();
  const pause = h.calls.find(value => value.params.action === 'pause'); assert.equal(pause.project, 'a');
  assert.ok(h.calls.some(value => value.project === 'b' && value.params.action === 'start' && value.params.workspaceId === 'other'));
  h.render({ project: 'b', workspaceId: 'other', foreground: false }); await h.commit();
  const count = h.calls.length; await h.tick(); assert.equal(h.calls.length, count);
  await h.unmount();
});
