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
  structureRevision = 0;
  foreground = true;
  sortedListing = false;
  interacting = false;
  private sortReady = new Set<string>();
  canReorder() { return this.scroll <= 1 && !this.selected.size && !this.interacting; }
  async applySorted(rpc:FilesCall){if(!this.foreground||!this.canReorder())return;for(const path of [...this.sortReady]){if(!this.canReorder())break;this.sortReady.delete(path);await this.load(path,rpc);}}
  private epoch = 0;
  private directoryEpochs = new Map<string, number>();
  private dirty = new Set<string>();
  private changesFlight?: Promise<void>;
  readonly key: string;
  readonly workspaceId: string;
  readonly decorations: FilesDecorationsState;
  constructor(key: string, workspaceId: string) {
    this.key = key; this.workspaceId = workspaceId;
    this.decorations = new FilesDecorationsState(workspaceId, () => this.instance, () => this.emit('view'));
    const saved = readPreference(key); if (saved) { this.expanded = new Set(['', ...(saved.expanded || [])]); this.selected = new Set(saved.selected || []); this.scroll = saved.scroll || 0; this.instance = saved.instance || ''; }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.revision;
  emit(kind: 'structure' | 'view' = 'structure') { if(kind==='structure')this.structureRevision++; this.revision++; this.listeners.forEach(fn => fn()); }
  save() { writePreference(this.key, { instance: this.instance, expanded: [...this.expanded], selected: [...this.selected], scroll: this.scroll }); }
  clear() { this.epoch++; this.sortReady.clear(); this.directoryEpochs.clear(); this.dirty.clear(); this.flights.clear(); this.refreshing.clear(); this.changesFlight = undefined; this.decorations.clear(); this.pages.clear(); this.expanded = new Set(['']); this.selected.clear(); this.scroll = 0; this.instance = ''; removePreference(this.key); this.emit(); }
  toggle(path: string, rpc: FilesCall) { if (this.expanded.has(path)) this.expanded.delete(path); else { this.expanded.add(path); void this.load(path, rpc, false, false, true); } this.save(); this.emit(); }
  async load(path: string, rpc: FilesCall, more = false, fresh = false, reopened = false): Promise<void> {
    const epoch = this.epoch;
    if (this.flights.has(path)) {
      const pending = this.flights.get(path)!;
      if (!fresh) return pending;
      await pending;
      if (epoch !== this.epoch) return;
      return this.load(path, rpc, more, fresh, reopened);
    }
    const directoryEpoch = this.directoryEpochs.get(path) || 0;
    const first = !this.pages.has(path);
    this.refreshing.add(path); if (first) this.emit('view');
    let changed = first;
    const flight = (async () => {
      try {
        const old = this.pages.get(path), request = { action: 'list', workspaceId: this.workspaceId, ...(this.instance ? { instance: this.instance } : {}), path, limit: 200, ...(this.sortedListing ? {listingProtocol:2, ...(!reopened && !this.canReorder() && old?.order?{order:old.order}:{})}:{}), ...(fresh ? { fresh: true } : {}) };
        let page = await rpc({ ...request, ...(more && old?.cursor ? { cursor: old.cursor } : {}) }) as DirectoryPage;
        if(more && old?.snapshotId && page.snapshotId!==old.snapshotId)throw Object.assign(new Error('Directory changed'),{code:'file_listing_changed'});
        if (!more && old && old.entries.length > 200) {
          let collected = page.entries;
          while (page.cursor && collected.length < old.entries.length) { page = await rpc({ ...request, cursor: page.cursor }) as DirectoryPage; collected = [...collected, ...page.entries]; }
          page = { ...page, entries: collected };
        }
        if (epoch !== this.epoch || directoryEpoch !== (this.directoryEpochs.get(path) || 0)) return;
        if (this.instance && this.instance !== page.instance) { this.clear(); return; }
        this.instance = page.instance;
        if(old?.order==='native' && page.order==='sorted' && !reopened && !this.canReorder()){this.sortReady.add(path);return;}
        if(page.order==='native' && page.sortState==='ready')this.sortReady.add(path);else this.sortReady.delete(path);

        // Replace only when a complete page arrived. A failed refresh retains every visible row.
        const known = new Set(old?.entries.map(e=>e.path));
        let entries = more && old ? [...old.entries, ...page.entries.filter(e => !known.has(e.path))] : page.entries;
        const same = !!old && JSON.stringify(old.entries)===JSON.stringify(entries);
        if(same)entries=old.entries;
        changed ||= !same || Boolean(old?.cursor)!==Boolean(page.cursor) || !!this.error;
        this.pages.set(path, { ...page, entries }); this.error = ''; if(changed)this.save();
      } catch (e) {
        if (epoch !== this.epoch) return;
        const code = (e as any)?.code;
        if(code==='file_listing_changed'){this.dirty.add(path);return;}
        if (code === 'workspace_instance_changed') this.clear();
        const message = e instanceof Error ? e.message : String(e);changed ||= this.error!==message;this.error=message;
      }
    })().finally(() => { if (this.flights.get(path) === flight) { this.flights.delete(path); this.refreshing.delete(path); if(changed)this.emit(); if(more && this.dirty.has(path) && this.foreground)void this.refreshChanges(rpc); } });
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
    if (this.foreground && this.listeners.size) void this.refreshChanges(rpc);
  }
  private refreshChanges(rpc: FilesCall): Promise<void> {
    if (this.changesFlight) return this.changesFlight;
    const epoch = this.epoch;
    const flight = (async () => {
      // Merge completions from a batch; progress updates never reach this path.
      await new Promise(resolve => setTimeout(resolve, 40));
      let passes=0;
      while (epoch === this.epoch && this.dirty.size && passes++<2) {
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
      const result = await rpc({ action: 'versions', workspaceId: this.workspaceId, instance: this.instance, paths, ...(this.sortedListing?{listingProtocol:2}:{}) });
      // Limit concurrent refreshes; large directory expansions must not flood the authenticated bridge.
      for (const path of paths) { if(result.orders?.[path]==='ready' && this.pages.get(path)?.order==='native')this.sortReady.add(path);if(result.versions[path]!==this.pages.get(path)?.version || this.sortReady.has(path) && this.canReorder())await this.load(path,rpc); }
    } catch (e) { if ((e as any)?.code === 'workspace_instance_changed') this.clear(); this.error = e instanceof Error ? e.message : String(e); this.emit(); }
  }
  rows(filter = '') {
    filter = filter.toLocaleLowerCase();
    const result: TreeRow[] = [{ key: 'root', path: '', depth: 0 }];
    const visit = (path: string, depth: number) => {
      const page = this.pages.get(path);
      for (const entry of page?.entries || []) {
        if (!filter || entry.name.toLocaleLowerCase().includes(filter) || entry.kind === 'directory') result.push({ key: entry.path, path: entry.path, depth, entry });
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
