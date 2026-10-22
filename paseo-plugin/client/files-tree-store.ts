import type { DirectoryPage, FileEntry } from '../shared/files.ts';
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
  clear() { this.epoch++; this.decorations.clear(); this.pages.clear(); this.expanded = new Set(['']); this.selected.clear(); this.scroll = 0; this.instance = ''; removePreference(this.key); this.emit(); }
  toggle(path: string, rpc: FilesCall) { if (this.expanded.has(path)) this.expanded.delete(path); else { this.expanded.add(path); void this.load(path, rpc); } this.save(); this.emit(); }
  async load(path: string, rpc: FilesCall, more = false) {
    if (this.flights.has(path)) return this.flights.get(path);
    const epoch = this.epoch;
    this.refreshing.add(path); this.emit();
    const flight = (async () => {
      try {
        const old = this.pages.get(path), request = { action: 'list', workspaceId: this.workspaceId, ...(this.instance ? { instance: this.instance } : {}), path, limit: 200 };
        let page = await rpc({ ...request, ...(more && old?.cursor ? { cursor: old.cursor } : {}) }) as DirectoryPage;
        if (!more && old && old.entries.length > 200) {
          let collected = page.entries;
          while (page.cursor && collected.length < old.entries.length) { page = await rpc({ ...request, cursor: page.cursor }) as DirectoryPage; collected = [...collected, ...page.entries]; }
          page = { ...page, entries: collected };
        }
        if (epoch !== this.epoch) return;
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
      } finally { this.refreshing.delete(path); this.emit(); }
    })().finally(() => this.flights.delete(path));
    this.flights.set(path, flight); return flight;
  }
  async validate(rpc: FilesCall) {
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
