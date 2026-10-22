import type { FileDecoration, FileDecorations } from '../shared/file-decorations.ts';
import type { FilesCall } from './files-store.ts';

export type DecorationRecord = { entry: FileDecoration; freshness: FileDecorations['freshness']; observedAt: string };
/** Color changes notify the tree without changing its filesystem pages or UI state. */
export class FilesDecorationsState {
  readonly entries = new Map<string, DecorationRecord>();
  private pending = new Set<string>();
  private force = false;
  private epoch = 0;
  private flight?: Promise<void>;
  readonly workspaceId: string;
  readonly instance: () => string;
  readonly changed: () => void;
  constructor(workspaceId: string, instance: () => string, changed: () => void) { this.workspaceId = workspaceId; this.instance = instance; this.changed = changed; }
  clear() { this.epoch++; this.entries.clear(); this.pending.clear(); this.force = false; this.flight = undefined; }
  refresh(paths: string[], rpc: FilesCall, force = false): Promise<void> {
    if (!this.instance()) return Promise.resolve();
    paths.forEach(path => this.pending.add(path)); this.force ||= force;
    if (this.flight) return this.flight;
    const epoch = this.epoch, instance = this.instance();
    const current = (async () => {
      while (this.pending.size && epoch === this.epoch) {
        const batch: string[] = []; let bytes = 0;
        for (const path of this.pending) {
          const size = new TextEncoder().encode(JSON.stringify(path)).byteLength + 1;
          if (batch.length && (batch.length >= 200 || bytes + size > 48 * 1024)) break;
          batch.push(path); bytes += size; this.pending.delete(path);
        }
        const manual = this.force; this.force = false;
        let changed = false;
        const put = (path: string, value: DecorationRecord) => { const old=this.entries.get(path); if (!old || old.freshness!==value.freshness || JSON.stringify(old.entry)!==JSON.stringify(value.entry)) changed=true; this.entries.delete(path);this.entries.set(path,old && old.freshness===value.freshness && JSON.stringify(old.entry)===JSON.stringify(value.entry)?Object.assign(old,{observedAt:value.observedAt}):value); };
        try {
          const result = await rpc({ action: 'decorations', workspaceId: this.workspaceId, instance, paths: batch, force: manual }) as FileDecorations;
          if (epoch !== this.epoch || instance !== this.instance() || result.instance !== instance || result.workspaceId !== this.workspaceId) return;
          const byPath = new Map(result.entries.map(entry => [entry.path, entry]));
          for (const path of batch) {
            const entry = byPath.get(path), old = this.entries.get(path);
            const fresh = entry?.state === 'ready';
            put(path, { entry: fresh ? entry : old?.entry || { path, state: 'unknown' }, freshness: fresh ? result.freshness : old ? 'stale' : 'unknown', observedAt: fresh ? result.observedAt : old?.observedAt || result.observedAt });
          }
        } catch {
          if (epoch !== this.epoch || instance !== this.instance()) return;
          for (const path of batch) { const old = this.entries.get(path); put(path, { entry: old?.entry || { path, state: 'unknown' }, freshness: old ? 'stale' : 'unknown', observedAt: old?.observedAt || '' }); }
        }
        while (this.entries.size > 4000) this.entries.delete(this.entries.keys().next().value!);
        if (changed) this.changed();
      }
    })().finally(() => { if (this.flight === current) this.flight = undefined; });
    this.flight = current; return current;
  }
}
