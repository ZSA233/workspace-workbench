import { FILE_CHUNK_BYTES, type FileTask, type FileChange } from '../shared/files.ts';
import { unchangedFileMove } from '../shared/file-operations.ts';
import { checksum, decode, encode, newFileId, DownloadStaging, readPreference, writePreference, canSave, pickSaveDestination, delegateDownload, type LocalFile, type SaveDestination } from './files-platform.ts';

export type FilesCall = (request: Record<string, any>) => Promise<any>;
function batches<T>(entries: T[]) { const result: T[][] = []; let current: T[] = [], bytes = 0; for (const entry of entries) { const size = JSON.stringify(entry).length*3; if (current.length && (current.length >= 200 || bytes+size > FILE_CHUNK_BYTES)) { result.push(current); current = []; bytes = 0; } current.push(entry); bytes += size; } if (current.length) result.push(current); return result; }
const done = (t: FileTask) => ['complete', 'cancelled', 'delegated'].includes(t.state) && !t.cleanupPending;
export type TransferView = FileTask & { localError?: string; speed?: number; needsSource?: boolean; stagedBytes?: number; saving?: boolean; destinationSelected?: boolean };
type Snapshot = { tasks: TransferView[]; error?: string; temporaryBytes: number; localBytes: number };
export class FileTransferStore {
  private rpc?: FilesCall;
  private listeners = new Set<() => void>();
  private changeListeners = new Set<(changes: FileChange[]) => void>();
  private tasks = new Map<string, FileTask>();
  private files = new Map<string, LocalFile>();
  private errors = new Map<string, string>();
  private speeds = new Map<string, number>();
  private localOffsets = new Map<string, number>();
  private saveOffsets = new Map<string, number>();
  private running = new Map<string, Promise<void>>();
  private queued = new Set<string>();
  private stopped = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private owners = 0;
  private downloadSelection = false;
  private saved: Record<string, number>;
  private verified = new Set<string>();
  private batchPolicies = new Map<string, string>();
  private cleaned = new Set<string>();
  private saving = new Set<string>();
  private destinations = new Map<string, SaveDestination>();
  private cleaning = new Map<string, Promise<void>>();
  applyBatchPolicy(batchId: string, command: string) { this.batchPolicies.set(batchId, command); if (this.batchPolicies.size > 1000) this.batchPolicies.delete(this.batchPolicies.keys().next().value!); }
  private snapshot: Snapshot = { tasks: [], temporaryBytes: 0, localBytes: 0 };
  readonly scope: string;
  constructor(scope: string) { this.scope = scope; this.saved = readPreference(scope + ':files-saved') || {}; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeChanges = (listener: (changes: FileChange[]) => void) => { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit(error?: string) {
    const priority = (task: FileTask) => ['active', 'preparing'].includes(task.state) ? 0 : task.cleanupPending || ['conflict', 'ready_to_save', 'failed', 'interrupted'].includes(task.state) ? 1 : done(task) ? 3 : 2;
    const tasks = [...this.tasks.values()].sort((a, b) => priority(a) - priority(b) || b.createdAt - a.createdAt).map(t => ({ ...t,
      ...(['active', 'ready_to_save'].includes(t.state) && (this.saveOffsets.has(t.id) || this.localOffsets.has(t.id)) ? { offset: (this.saveOffsets.get(t.id) ?? this.localOffsets.get(t.id))!, state: (this.saveOffsets.get(t.id) ?? this.localOffsets.get(t.id)) === t.size ? 'ready_to_save' as const : 'active' as const } : {}),
      saving: this.saving.has(t.id), destinationSelected: this.destinations.has(t.id), stagedBytes: this.localOffsets.get(t.id), localError: this.errors.get(t.id), speed: this.speeds.get(t.id), needsSource: t.direction === 'upload' && !done(t) && !this.files.has(t.id) && t.offset < (t.size ?? 0),
    }));
    this.snapshot = { ...this.snapshot, tasks, error, localBytes: [...this.localOffsets.values()].reduce((a, b) => a + b, 0) };
    this.listeners.forEach(fn => fn());
  }
  bind(rpc: FilesCall, capabilities: { downloadSelection?: boolean } = {}) {
    this.rpc = rpc; this.downloadSelection = Boolean(capabilities.downloadSelection); this.owners++; void this.poll();
    return () => { this.owners--; if (!this.owners && !this.running.size) clearTimeout(this.timer); };
  }
  async call(input: Record<string, any>) { if (!this.rpc) throw new Error('File connection is unavailable'); return this.rpc(input); }
  private record(task: FileTask, notify = true) {
    const old = this.tasks.get(task.id);
    if (old && old.updatedAt > task.updatedAt) return old;
    this.tasks.set(task.id, task);
    if (notify && task.changes?.length && JSON.stringify(old?.changes) !== JSON.stringify(task.changes)) this.changeListeners.forEach(listener => listener(task.changes!));
    return task;
  }
  private discardDestination(id: string) { const destination = this.destinations.get(id); this.destinations.delete(id); if (destination) void destination.discard().catch(() => {}); }
  private accept(task: FileTask) { task = this.record(task); if (done(task)) { this.discardDestination(task.id); this.files.delete(task.id); this.errors.delete(task.id); this.speeds.delete(task.id); if (task.direction === 'download') void this.cleanup(task.id); else this.localOffsets.delete(task.id); this.verified.delete(task.id); } this.emit(); return task; }
  async poll() {
    if (this.polling) return this.polling;
    clearTimeout(this.timer);
    this.polling = (async () => {
      try {
        const result = await this.call({ action: 'tasks', limit: 200 });
        const all = new Map<string, FileTask>((result.tasks as FileTask[]).map(t => [t.id, t]));
        if (result.incompleteTasks > (result.tasks as FileTask[]).filter(t => !done(t)).length) {
          let before: number | undefined;
          for (;;) { const page = await this.call({ action: 'tasks', activeOnly: true, limit: 200, ...(before ? { before } : {}) }); for (const task of page.tasks as FileTask[]) all.set(task.id, task); if (page.tasks.length < 200 || !page.next) break; before = page.next; }
        }
        result.tasks = [...all.values()];
        const seen = new Set<string>();
        for (const incoming of result.tasks as FileTask[]) { seen.add(incoming.id); const task = this.record(incoming, this.tasks.has(incoming.id)); if (done(task)) { this.discardDestination(task.id); this.files.delete(task.id); if (task.direction === 'download' && !this.cleaned.has(task.id)) void this.cleanup(task.id); else if (task.direction !== 'download') this.localOffsets.delete(task.id); } }
        // Tasks outside the recent page retain their stable identities and are queried individually.
        for (const [id, old] of this.tasks) if (!seen.has(id) && !done(old)) { try { this.record(await this.call({ action: 'task', id })); } catch { /* keep the recovery entry */ } }
        for (const [id, old] of this.tasks) if (done(old) && !seen.has(id)) { this.tasks.delete(id); this.cleaned.delete(id); }
        for (const [id, message] of this.errors) if (/connection|socket|transport|network|timed out|observer_unavailable/i.test(message)) this.errors.delete(id);
        this.snapshot.temporaryBytes = result.temporaryBytes;
        this.emit();
        for (const task of this.tasks.values()) {
          const policy = task.batchId && this.batchPolicies.get(task.batchId);
          if (task.state === 'conflict' && task.conflict !== 'changed' && policy && !(policy === 'replace' && task.canReplace === false)) { await this.control(task.id, policy); continue; }
          if (this.saved[task.id] === task.size && !done(task)) { try { if (task.offset !== task.size) await this.call({ action: 'ack', id: task.id, offset: task.size }); this.accept(await this.call({ action: 'control', id: task.id, command: 'complete' })); delete this.saved[task.id]; writePreference(this.scope + ':files-saved', this.saved); } catch { /* saved locally; retry confirmation only */ } }
          if (['active', 'ready_to_save'].includes(task.state) && !this.errors.has(task.id) && !this.stopped.has(task.id) && !this.saving.has(task.id) && (task.direction === 'upload' && (this.files.has(task.id) || task.offset === task.size) || task.direction === 'download' && (this.destinations.has(task.id) || DownloadStaging.supported() && canSave()))) this.enqueue(task.id);
        }
      } catch (e) { this.emit(String(e instanceof Error ? e.message : e)); }
    })().finally(() => { this.polling = undefined; if (this.owners || this.running.size) this.timer = setTimeout(() => void this.poll(), this.running.size || this.snapshot.tasks.some(t => !done(t)) ? 1200 : 5000); });
    return this.polling;
  }
  async upload(file: LocalFile, workspaceId: string, instance: string, path: string, policy = 'ask', batchId?: string) {
    const id = newFileId(); this.files.set(id, file);
    const task = await this.call({ action: 'upload', id, batchId, workspaceId, instance, path, name: file.name, size: file.size, modifiedAt: file.lastModified, policy });
    if (task.state === 'conflict' && task.conflict !== 'changed' && batchId && this.batchPolicies.has(batchId)) { this.accept(task); await this.control(id, this.batchPolicies.get(batchId)!); return task as FileTask; }
    this.accept(task); if (task.state === 'active') this.enqueue(id); return task as FileTask;
  }
  async attach(id: string, file: LocalFile) {
    const task = this.tasks.get(id); if (!task || file.size !== task.size || file.name !== task.name && file.name !== (task as any).sourceName || task.modifiedAt !== undefined && file.lastModified !== task.modifiedAt) throw new Error('Select the original file with the same name, size and modification time');
    this.files.set(id, file); this.verified.delete(id); await this.control(id, 'resume');
  }
  async download(workspaceId: string, instance: string, paths: string[], suggestedName: string) {
    const groups = batches(paths); if (!groups.length) return;
    if (groups.length > 1 && !this.downloadSelection) throw new Error('Update the plugin backend to download this selection as one archive');
    // Keep the initial click's activation: choose the destination before the first RPC.
    let destination: SaveDestination | undefined;
    if (canSave()) {
      try { destination = await pickSaveDestination(suggestedName); }
      catch (error) { if ((error as any)?.name === 'AbortError') return; throw error; }
    }
    const id = newFileId();
    if (destination) this.destinations.set(id, destination);
    try {
      let task: FileTask;
      try { task = await this.call({ action: 'download', id, workspaceId, instance, paths: groups[0], ...(groups.length > 1 ? { defer: true } : {}) }); }
      catch (error) { try { task = await this.call({ action: 'task', id }); } catch { throw error; } }
      this.accept(task);
      let offset = groups[0].length;
      for (let index = 1; index < groups.length; index++) {
        const request = { action: 'download-selection', id, offset, paths: groups[index], final: index === groups.length - 1 };
        try { task = await this.call(request); }
        catch (error) { task = await this.call({ action: 'task', id }); if ((task.selectionCount || 0) < offset + groups[index].length || request.final && task.selectionPending) task = await this.call(request); }
        this.accept(task); offset += groups[index].length;
      }
      if (!canSave()) void this.delegate(id).catch(error => { this.errors.set(id, error instanceof Error ? error.message : String(error)); this.emit(); });
    } catch (error) { this.discardDestination(id); throw error; }
    void this.poll();
  }
  async operation(input: Record<string, any>) {
    const entries = input.operation === 'move' && input.destination ? input.entries.filter((entry: any) => !unchangedFileMove(entry, input.destination)) : input.entries;
    if (!entries.length) return;
    const batchId = newFileId(); let task: FileTask | undefined;
    for (const group of batches(entries)) { const result = await this.call({ ...input, batchId, entries: group, action: 'mutate', id: newFileId() }); if (!result.noop) task = this.accept(result); }
    void this.poll(); return task;
  }
  async control(id: string, command: string) {
    if (['pause', 'cancel', 'skip'].includes(command)) this.stopped.add(id); else this.stopped.delete(id);
    this.errors.delete(id);
    const task = this.accept(await this.call({ action: 'control', id, command }));
    if (['cancel', 'skip'].includes(command)) { await this.running.get(id)?.catch(() => {}); if (task.direction === 'download') await this.cleanup(id); this.localOffsets.delete(id); }
    if (!done(task) && task.state === 'active') this.enqueue(id); this.emit(); void this.poll();
  }
  async cleanup(id: string) {
    if (this.cleaning.has(id)) return this.cleaning.get(id);
    const flight = (async () => { await this.running.get(id)?.catch(() => {}); try { await DownloadStaging.remove(this.scope, id); this.localOffsets.delete(id); this.cleaned.add(id); this.errors.delete(id); } catch (e) { this.errors.set(id, 'Local staging cleanup failed: ' + String(e)); } finally { this.emit(); } })().finally(() => this.cleaning.delete(id));
    this.cleaning.set(id, flight); return flight;
  }
  private enqueue(id: string) { if (!this.running.has(id)) this.queued.add(id); this.dispatch(); }
  private dispatch() {
    while (this.running.size < 2 && this.queued.size) {
      const id = this.queued.values().next().value!; this.queued.delete(id);
      if (this.stopped.has(id) || this.saving.has(id)) continue;
      const task = this.tasks.get(id); if (!task || !['active', 'ready_to_save'].includes(task.state)) continue;
      const flight = (task.direction === 'upload' ? this.send(task) : this.receive(task)).catch(e => { if (!this.stopped.has(id)) this.errors.set(id, e instanceof Error ? e.message : String(e)); }).finally(() => { this.running.delete(id); this.speeds.delete(id); this.emit(); this.dispatch(); });
      this.running.set(id, flight);
    }
  }
  private check(id: string) { if (this.stopped.has(id)) throw new Error('Transfer paused'); }
  private async send(initial: FileTask) {
    const file = this.files.get(initial.id); if (!file) { if (initial.offset === initial.size) this.accept(await this.call({ action: 'finish', id: initial.id })); return; }
    let task = await this.call({ action: 'task', id: initial.id }) as FileTask;
    if (!this.verified.has(task.id)) {
      for (let offset = 0; offset < task.offset;) { this.check(task.id); const bytes = new Uint8Array(await file.slice(offset, Math.min(offset + FILE_CHUNK_BYTES, file.size)).arrayBuffer()); const result = await this.call({ action: 'verify', id: task.id, offset, sha256: checksum(bytes) }); offset = result.nextOffset; }
      this.verified.add(task.id);
    }
    while (task.offset < file.size) {
      this.check(task.id); if (task.state !== 'active') { this.accept(task); return; }
      const started = Date.now(), offset = task.offset, bytes = new Uint8Array(await file.slice(offset, Math.min(offset + FILE_CHUNK_BYTES, file.size)).arrayBuffer());
      try { task = await this.call({ action: 'chunk', id: task.id, offset, data: encode(bytes), sha256: checksum(bytes) }); }
      catch (e) { const status = await this.call({ action: 'task', id: task.id }); if (status.offset === offset + bytes.length) task = status; else throw e; }
      this.speeds.set(task.id, bytes.length * 1000 / Math.max(1, Date.now() - started)); this.accept(task);
    }
    this.check(task.id);
    try { this.accept(await this.call({ action: 'finish', id: task.id })); }
    catch (e) { const status = await this.call({ action: 'task', id: task.id }); this.accept(status); if (status.state === 'active') throw e; }
  }
  private async receive(task: FileTask) {
    if (task.size === null) return;
    if (!DownloadStaging.supported()) { if (this.destinations.has(task.id)) await this.saveChosen(task, true); return; }
    if (!canSave() && !this.destinations.has(task.id)) return;
    const staging = await DownloadStaging.open(this.scope, task.id, task.size); let offset = await staging.offset();
    this.localOffsets.set(task.id, offset); this.emit();
    while (offset < task.size) {
      this.check(task.id); const started = Date.now(), chunk = await this.call({ action: 'read', id: task.id, offset });
      const bytes = decode(chunk.data); if (chunk.offset !== offset || chunk.size !== task.size || checksum(bytes) !== chunk.sha256) throw new Error('Download chunk verification failed');
      await staging.write(offset, bytes, chunk.sha256); offset += bytes.length;
      this.localOffsets.set(task.id, offset); this.speeds.set(task.id, bytes.length * 1000 / Math.max(1, Date.now() - started)); this.emit();
      this.accept(await this.call({ action: 'ack', id: task.id, offset: Math.max(task.offset, offset) }));
    }
    if (task.size === 0) this.accept(await this.call({ action: 'ack', id: task.id, offset: 0 }));
    if (this.destinations.has(task.id) && !this.saving.has(task.id)) await this.saveChosen(task);
  }
  private async saveChosen(task: FileTask, direct = false) {
    const id = task.id, destination = this.destinations.get(id); if (!destination || task.size === null) return;
    this.saving.add(id); this.emit();
    try {
      this.check(id);
      const output = await destination.open();
      if (!direct && DownloadStaging.supported()) await (await DownloadStaging.open(this.scope, id, task.size)).exportTo(output, () => this.check(id));
      else {
        try {
          for (let offset = 0; offset < task.size;) { this.check(id); const started = Date.now(), chunk = await this.call({ action: 'read', id, offset }); const bytes = decode(chunk.data); if (checksum(bytes) !== chunk.sha256 || chunk.offset !== offset || chunk.size !== task.size || !bytes.length || offset + bytes.length > task.size) throw new Error('Download checksum mismatch'); await output.write(bytes); offset += bytes.length; this.saveOffsets.set(id, offset); this.speeds.set(id, bytes.length * 1000 / Math.max(1, Date.now() - started)); this.emit(); }
          this.check(id); await output.close();
        } catch (e) { await output.abort().catch(() => {}); throw e; }
      }
      this.saved[id] = task.size; writePreference(this.scope + ':files-saved', this.saved);
      if (this.tasks.get(id)?.offset !== task.size) await this.call({ action: 'ack', id, offset: task.size });
      this.accept(await this.call({ action: 'control', id, command: 'complete' }));
      delete this.saved[id]; writePreference(this.scope + ':files-saved', this.saved);
    } finally { this.discardDestination(id); this.saveOffsets.delete(id); this.saving.delete(id); this.emit(); }
  }
  async save(id: string, direct = false) {
    if (this.saving.has(id) || !direct && this.destinations.has(id)) return;
    const task = this.tasks.get(id); if (!task || task.size === null) return;
    const pending = direct && this.destinations.has(id) ? Promise.resolve(this.destinations.get(id)!) : pickSaveDestination(task.name); this.saving.add(id); this.stopped.delete(id); this.errors.delete(id); this.emit();
    try {
      const destination = await pending;
      const current = this.tasks.get(id);
      if (this.stopped.has(id) || !current || done(current)) { await destination.discard(); return; }
      this.destinations.set(id, destination);
      await this.running.get(id);
      while (this.running.size >= 2) { this.check(id); await new Promise(resolve => setTimeout(resolve, 100)); }
      const flight = this.saveChosen(task, direct || !DownloadStaging.supported()); this.running.set(id, flight);
      try { await flight; } finally { this.running.delete(id); this.dispatch(); }
    } catch (error) { if (!this.stopped.has(id) && (error as any)?.name !== 'AbortError') this.errors.set(id, error instanceof Error ? error.message : String(error)); }
    finally { this.discardDestination(id); this.saving.delete(id); this.emit(); }
  }
  async delegate(id: string) { let result; this.stopped.delete(id); do { this.check(id); result = await this.call({ action: 'delegate', id }); if (result.pending) await new Promise(r => setTimeout(r, 1000)); } while (result.pending); this.check(id); await delegateDownload(result.url, result.serverId); this.accept(await this.call({ action: 'control', id, command: 'delegated' })); }
}
const stores = new Map<string, FileTransferStore>();
export function fileTransferStore(scope: string) { let store = stores.get(scope); if (!store) { store = new FileTransferStore(scope); stores.set(scope, store); } return store; }
