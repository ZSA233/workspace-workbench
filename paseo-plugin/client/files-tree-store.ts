import type { DirectoryPage, FileEntry, FileChange } from '../shared/files.ts';
import { readPreference, writePreference, removePreference } from './files-platform.ts';
import type { FilesCall } from './files-store.ts';
import { FilesDecorationsState } from './files-decorations-store.ts';

export type TreeRow = { key: string; path: string; depth: number; entry?: FileEntry; more?: boolean; loading?: boolean };
export class FilesTreeState {
  pages = new Map<string, DirectoryPage>();
  expanded = new Set<string>(['']);
  selected = new Set<string>();
  scroll = 0;
  instance = '';
  error = '';
  refreshing = new Set<string>();
  private flights = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private epoch = 0;
  private directoryEpochs = new Map<string, number>();
  private dirty = new Set<string>();
  private changesFlight?: Promise<void>;
  readonly key: string;
  readonly workspaceId: string;
  readonly decorations: FilesDecorationsState;
  constructor(key: string, workspaceId: string) {
    this.key = key; this.workspaceId = workspaceId;
    this.decorations = new FilesDecorationsState(workspaceId, () => this.instance, () => this.emit());
    const saved = readPreference(key); if (saved) { this.expanded = new Set(['', ...(saved.expanded || [])]); this.selected = new Set(saved.selected || []); this.scroll = saved.scroll || 0; this.instance = saved.instance || ''; }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  emit() { this.revision++; this.listeners.forEach(fn => fn()); }
  save() { writePreference(this.key, { instance: this.instance, expanded: [...this.expanded], selected: [...this.selected], scroll: this.scroll }); }
  clear() { this.epoch++; this.directoryEpochs.clear(); this.dirty.clear(); this.flights.clear(); this.refreshing.clear(); this.changesFlight = undefined; this.decorations.clear(); this.pages.clear(); this.expanded = new Set(['']); this.selected.clear(); this.scroll = 0; this.instance = ''; removePreference(this.key); this.emit(); }
  toggle(path: string, rpc: FilesCall) { if (this.expanded.has(path)) this.expanded.delete(path); else { this.expanded.add(path); void this.load(path, rpc); } this.save(); this.emit(); }
  async load(path: string, rpc: FilesCall, more = false, fresh = false): Promise<void> {
    const epoch = this.epoch;
    if (this.flights.has(path)) {
      const pending = this.flights.get(path)!;
      if (!fresh) return pending;
      await pending;
      if (epoch !== this.epoch) return;
      return this.load(path, rpc, more, fresh);
    }
    const directoryEpoch = this.directoryEpochs.get(path) || 0;
    this.refreshing.add(path); this.emit();
    const flight = (async () => {
      try {
        const old = this.pages.get(path), request = { action: 'list', workspaceId: this.workspaceId, ...(this.instance ? { instance: this.instance } : {}), path, limit: 200, ...(fresh ? { fresh: true } : {}) };
        let page = await rpc({ ...request, ...(more && old?.cursor ? { cursor: old.cursor } : {}) }) as DirectoryPage;
        if (!more && old && old.entries.length > 200) {
          let collected = page.entries;
          while (page.cursor && collected.length < old.entries.length) { page = await rpc({ ...request, cursor: page.cursor }) as DirectoryPage; collected = [...collected, ...page.entries]; }
          page = { ...page, entries: collected };
        }
        if (epoch !== this.epoch || directoryEpoch !== (this.directoryEpochs.get(path) || 0)) return;
        if (this.instance && this.instance !== page.instance) { this.clear(); return; }
        this.instance = page.instance;
        // Replace only when a complete page arrived. A failed refresh retains every visible row.
        const entries = more && old ? [...old.entries, ...page.entries.filter(e => !old.entries.some(x => x.path === e.path))] : page.entries;
        this.pages.set(path, { ...page, entries }); this.error = ''; this.save();
      } catch (e) {
        if (epoch !== this.epoch) return;
        const code = (e as any)?.code;
        if (code === 'workspace_instance_changed') this.clear();
        this.error = e instanceof Error ? e.message : String(e);
      }
    })().finally(() => { if (this.flights.get(path) === flight) { this.flights.delete(path); this.refreshing.delete(path); this.emit(); } });
    this.flights.set(path, flight); return flight;
  }
  changed(change: FileChange, rpc: FilesCall) {
    if (change.workspaceId !== this.workspaceId || change.instance !== this.instance) return;
    const removed = (path: string) => change.removed?.some(value => path === value || path.startsWith(value + '/'));
    if (change.removed?.length) {
      for (const path of new Set([...this.pages.keys(), ...this.flights.keys(), ...this.expanded])) if (removed(path)) {
        this.pages.delete(path); this.expanded.delete(path); this.dirty.delete(path);
        this.directoryEpochs.set(path, (this.directoryEpochs.get(path) || 0) + 1);
      }
      for (const page of this.pages.values()) page.entries = page.entries.filter(entry => !removed(entry.path));
      for (const path of this.selected) if (removed(path)) this.selected.delete(path);
      for (const path of this.decorations.entries.keys()) if (removed(path)) this.decorations.entries.delete(path);
    }
    for (const path of change.paths) {
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      for (const directory of [parent, path]) if (this.pages.has(directory)) {
        this.directoryEpochs.set(directory, (this.directoryEpochs.get(directory) || 0) + 1);
        this.dirty.add(directory);
      }
    }
    this.save(); this.emit();
    if (this.listeners.size) void this.refreshChanges(rpc);
  }
  private refreshChanges(rpc: FilesCall): Promise<void> {
    if (this.changesFlight) return this.changesFlight;
    const epoch = this.epoch;
    const flight = (async () => {
      // Merge completions from a batch; progress updates never reach this path.
      await new Promise(resolve => setTimeout(resolve, 40));
      while (epoch === this.epoch && this.dirty.size) {
        const paths = [...this.dirty]; this.dirty.clear();
        for (const path of paths) await this.load(path, rpc, false, true);
      }
      if (epoch === this.epoch) await this.decorations.refresh([...this.decorations.entries.keys()], rpc, true);
    })().finally(() => { if (this.changesFlight === flight) this.changesFlight = undefined; });
    this.changesFlight = flight; return flight;
  }
  async validate(rpc: FilesCall) {
    if (this.dirty.size) await this.refreshChanges(rpc);
    if (!this.instance) return this.load('', rpc);
    const paths = [...this.expanded].filter(p => this.pages.has(p)).slice(0, 200);
    try {
      const result = await rpc({ action: 'versions', workspaceId: this.workspaceId, instance: this.instance, paths });
      // Limit concurrent refreshes; large directory expansions must not flood the authenticated bridge.
      for (const path of paths) if (result.versions[path] !== this.pages.get(path)?.version) await this.load(path, rpc);
    } catch (e) { if ((e as any)?.code === 'workspace_instance_changed') this.clear(); this.error = e instanceof Error ? e.message : String(e); this.emit(); }
  }
  rows(filter = '') {
    const result: TreeRow[] = [{ key: 'root', path: '', depth: 0 }];
    const visit = (path: string, depth: number) => {
      const page = this.pages.get(path);
      for (const entry of page?.entries || []) {
        if (!filter || entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()) || entry.kind === 'directory') result.push({ key: entry.path, path: entry.path, depth, entry });
        if (entry.kind === 'directory' && this.expanded.has(entry.path)) visit(entry.path, depth + 1);
      }
      if (page?.cursor) result.push({ key: path + '/:more', path, depth, more: true });
    };
    if (this.expanded.has('')) visit('', 1); return result;
  }
}
const states = new Map<string, FilesTreeState>();
export function filesTreesChanged(scope: string, changes: FileChange[], rpc: FilesCall) {
  for (const [key, state] of states) if (key.startsWith(scope + ':files-tree:')) for (const change of changes) state.changed(change, rpc);
}
export function filesTreeState(scope: string, workspaceId: string) {
  const key = scope + ':files-tree:' + workspaceId;
  const keys: string[] = readPreference(scope + ':files-tree-keys') || [];
  if (!keys.includes(workspaceId)) writePreference(scope + ':files-tree-keys', [...keys, workspaceId]);
  let state = states.get(key); if (!state) { state = new FilesTreeState(key, workspaceId); states.set(key, state); }
  states.delete(key); states.set(key, state);
  if (states.size > 128) states.delete(states.keys().next().value!);
  return state;
}
export function reconcileFilesTrees(scope: string, workspaces: { id: string; state?: string }[]) {
  if (workspaces.some(w => w.state === 'record_invalid')) return;
  const active = new Set(workspaces.filter(w => w.state !== 'removed').map(w => w.id));
  const keys: string[] = readPreference(scope + ':files-tree-keys') || [];
  for (const id of keys) if (!active.has(id)) removePreference(scope + ':files-tree:' + id);
  writePreference(scope + ':files-tree-keys', keys.filter(id => active.has(id)));
  for (const [key, state] of states) if (key.startsWith(scope + ':files-tree:') && !active.has(state.workspaceId)) { state.clear(); states.delete(key); }
}
