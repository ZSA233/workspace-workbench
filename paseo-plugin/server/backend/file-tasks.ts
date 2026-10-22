import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { open, mkdir, rename, rm, readdir, lstat, readlink, symlink, statfs, realpath, link } from 'node:fs/promises';
import { dirname, join, basename, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import { FILE_CHUNK_BYTES, type FileRequest, type FileTask } from '../../shared/files.ts';
import { FileStageIgnore } from './file-stage-ignore.ts';
import { copyFileChunks, syncDirectory, verifyTemporaryParent, removeTemporary, directoryVersion } from './file-io.ts';
import { cleanFileTasks } from './file-cleanup.ts';
import { FileRoots, fileStat, fileVersion, type FileRoot } from './file-roots.ts';
import { FileJournal, terminal, type StoredTask } from './file-journal.ts';
import { hash, stable, WorkbenchError, SerialQueue, type Json } from './storage.ts';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sleep = () => new Promise<void>(r => setImmediate(r));
export class FileTasks {
  readonly journal: FileJournal;
  private stageIgnore = new FileStageIgnore();
  private controlFlags = new Map<string, 'paused' | 'cancelled'>();
  private publications = new Map<string, { queue: SerialQueue; users: number }>();
  private locks = new Map<string, { queue: SerialQueue; users: number }>();
  private running = new Map<string, Promise<void>>();
  private waiting: string[] = [];
  private closed = false;
  private closing?: Promise<void>;
  private lastCleanup = 0;
  private maintenance?: Promise<void>;
  readonly roots: FileRoots;
  readonly changed: (workspaceId: string, paths: string[]) => void;
  constructor(roots: FileRoots, changed: (workspaceId: string, paths: string[]) => void) {
    this.roots = roots; this.changed = changed;
    this.journal = new FileJournal(join(roots.workspaces.config.stateRoot, 'file-transfers'));
  }
  private part(id: string) { return join(this.journal.root, hash(id) + '.part'); }
  private async lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    let entry = this.locks.get(id); if (!entry) { entry = { queue: new SerialQueue(), users: 0 }; this.locks.set(id, entry); }
    entry.users++;
    try { return await entry.queue.run(work); } finally { if (--entry.users === 0) this.locks.delete(id); }
  }
  private base(input: Json, context: FileRoot, direction: FileTask['direction'], name: string, path: string): StoredTask {
    return { id: input.id, batchId: input.batchId, identity: hash(stable(input)), workspaceId: context.workspace.id, instance: context.instance, workspaceName: context.workspace.displayName || context.workspace.id, direction, name, path, size: null, offset: 0, state: 'queued', createdAt: Date.now(), updatedAt: Date.now(), private: { request: input } };
  }
  private async context(task: StoredTask, write = false) { return this.roots.context(task.workspaceId, task.instance, write); }
  private check(task: StoredTask) { if (this.closed || this.controlFlags.has(task.id)) throw new WorkbenchError('file_task_paused', 'Task paused'); }
  private save(task: StoredTask, overrideControl = false) { const current = this.journal.get(task.id); if (!overrideControl && current && ['paused', 'cancelled'].includes(current.state) && task.state !== 'complete') task.state = current.state; this.journal.save(task); return this.journal.view(task); }
  private recordChange(task: StoredTask, workspaceId: string, instance: string, path: string, removed = false) {
    const changes = task.changes ||= [];
    let change = changes.find(item => item.workspaceId === workspaceId && item.instance === instance);
    if (!change) { change = { workspaceId, instance, paths: [] }; changes.push(change); }
    if (!change.paths.includes(path)) change.paths.push(path);
    if (removed && !(change.removed ||= []).includes(path)) change.removed.push(path);
    this.changed(workspaceId, [path]);
  }
  /** Return small filesystem operations promptly, without holding a request for long jobs. */
  async settled(id: string) {
    const flight = this.running.get(id);
    if (flight) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([flight, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]); }
      finally { clearTimeout(timer); }
    }
    return this.journal.view(this.journal.require(id));
  }
  private async free(path: string, needed: number) { const s = await statfs(path); if (s.bavail * s.bsize < needed) throw new WorkbenchError('file_disk_full', 'Not enough disk space; confirmed progress is retained'); }
  async upload(input: Extract<FileRequest, { action: 'upload' }>) {
    return this.lock(input.id, async () => {
      const context = await this.roots.context(input.workspaceId, input.instance, true);
      const name = this.roots.name(input.name), path = input.path ? input.path + '/' + name : name;
      const candidate = this.base(input, context, 'upload', name, input.path);
      const previous = this.journal.get(input.id);
      if (previous) return this.journal.view(this.journal.create(candidate));
      const target = await this.roots.path(context, path, { parents: true });
      const existing = await fileStat(target);
      candidate.canReplace = !this.roots.protected(context, path) && !existing?.isDirectory() && !existing?.isSymbolicLink();
      candidate.size = input.size; candidate.modifiedAt = input.modifiedAt; candidate.sourceName = input.name;
      const parentInfo = await lstat(dirname(target)); candidate.private.parent = `${parentInfo.dev}:${parentInfo.ino}`;
      candidate.private.expected = existing ? fileVersion(existing) : null;
      candidate.state = (existing || !candidate.canReplace) && (input.policy === 'ask' || !candidate.canReplace && input.policy !== 'keep') ? 'conflict' : 'active'; if (candidate.state === 'conflict') candidate.conflict = 'exists';
      if ((existing || !candidate.canReplace) && input.policy === 'keep') { candidate.name = await this.available(context, input.path, name); candidate.private.expected = null; candidate.canReplace = true; }
      return this.journal.view(this.journal.create(candidate));
    });
  }
  async chunk(input: Extract<FileRequest, { action: 'chunk' }>) {
    return this.lock(input.id, async () => {
      const task = this.journal.require(input.id); const context = await this.context(task, true);
      await this.checkParent(task, context);
      if (task.direction !== 'upload' || task.state !== 'active') throw new WorkbenchError('file_task_not_active', 'Upload is not active');
      const bytes = Buffer.from(input.data, 'base64');
      if (!bytes.length || bytes.length > FILE_CHUNK_BYTES || bytes.toString('base64') !== input.data || digest(bytes) !== input.sha256) throw new WorkbenchError('file_chunk_invalid', 'Chunk checksum or encoding is invalid');
      const previous = this.journal.chunk(task.id, input.offset);
      if (previous) { if (previous.size !== bytes.length || previous.digest !== input.sha256) throw new WorkbenchError('file_chunk_conflict', 'Previously confirmed chunk differs'); return this.journal.view(task); }
      if (input.offset !== task.offset || task.offset + bytes.length > task.size!) throw new WorkbenchError('file_offset_conflict', 'Query the confirmed offset before continuing', { offset: task.offset });
      await this.free(this.journal.root, bytes.length);
      const existed = await fileStat(this.part(task.id));
      const file = await open(this.part(task.id), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if ((await file.stat()).size < task.offset) throw new WorkbenchError('file_partial_missing', 'Confirmed partial data is missing');
        let written = 0;
        while (written < bytes.length) { const r = await file.write(bytes, written, bytes.length - written, input.offset + written); if (!r.bytesWritten) throw new Error('No write progress'); written += r.bytesWritten; }
        await file.sync(); if (!existed) await syncDirectory(this.journal.root);
      } finally { await file.close(); }
      task.offset += bytes.length; const latest = this.journal.require(task.id); if (['paused', 'cancelled'].includes(latest.state)) task.state = latest.state; delete task.error;
      this.journal.commitChunk(task, input.offset, bytes.length, input.sha256);
      return this.journal.view(task);
    });
  }
  private async checkParent(task: StoredTask, context: FileRoot) { const target = await this.roots.path(context, task.path ? task.path + '/' + task.name : task.name, { mutate: true }); const s = await lstat(dirname(target)); if (task.private.parent && `${s.dev}:${s.ino}` !== task.private.parent) throw new WorkbenchError('file_directory_changed', 'Target directory was replaced; cancel and select the new directory'); }
  private async available(context: FileRoot, directory: string, name: string) {
    const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) { const next = `${base} (${i})${ext}`; if (!await fileStat(await this.roots.path(context, directory ? directory + '/' + next : next, { mutate: true }))) return next; }
  }
  /** Journal before publication; inode ownership reconciles a lost rename response. */
  private async publish(task: StoredTask, stage: string, target: string, expected: string | null) {
    let entry = this.publications.get(target); if (!entry) { entry = { queue: new SerialQueue(), users: 0 }; this.publications.set(target, entry); } entry.users++;
    try { return await entry.queue.run(() => this.publishLocked(task, stage, target, expected)); } finally { if (--entry.users === 0) this.publications.delete(target); }
  }
  private async publishLocked(task: StoredTask, stage: string, target: string, expected: string | null) {
    this.check(task);
    const phase = task.private.publish as Json | undefined;
    if (phase) {
      const found = await fileStat(phase.target);
      if (phase.published || found && `${found.dev}:${found.ino}` === phase.inode) return;
      if (await fileStat(phase.backup) && !found) { await verifyTemporaryParent(phase.backup, phase.parent); await rename(phase.backup, phase.target); }
    }
    const current = await fileStat(target);
    if ((current ? fileVersion(current) : null) !== expected) { task.state = 'conflict'; task.conflict = 'changed'; task.private.conflictTarget = target; task.private.expected = current ? fileVersion(current) : null; task.error = 'Target changed while the operation was running'; this.save(task); throw new WorkbenchError('file_target_changed', task.error); }
    if (current?.isDirectory() && task.private.targetTrees?.[target]) {
      const tree = await directoryVersion(target, () => this.check(task));
      if (tree !== task.private.targetTrees[target]) { task.private.targetTrees[target] = tree; task.private.conflictTarget = target; task.private.expected = fileVersion(current); task.state = 'conflict'; task.conflict = 'changed'; task.error = 'Destination directory contents changed; confirm replacement again'; this.save(task); throw new WorkbenchError('file_target_changed', task.error); }
    }
    const source = await lstat(stage), backup = join(dirname(target), `.workbench-transfer-${hash(task.id).slice(0, 24)}-backup`);
    if (await fileStat(backup)) throw new WorkbenchError('file_recovery_required', 'A previous replacement backup is retained');
    task.private.publish = { stage, target, backup, inode: `${source.dev}:${source.ino}`, parent: await realpath(dirname(target)), backupTree: task.private.targetTrees?.[target], backupSignature: current ? `${current.dev}:${current.ino}:${current.size}:${current.mtimeMs}` : null, expected }; this.save(task); this.check(task);
    if (task.private.stage === stage) task.private.stageInode = `${source.dev}:${source.ino}`; this.save(task); this.check(task);
    if (current) await rename(target, backup);
    try { if (!source.isDirectory() && task.private.stage === stage) { await link(stage, target); await rm(stage, { force: false }); } else await rename(stage, target); }
    catch (e) { if (current && !await fileStat(target)) await rename(backup, target); throw e; }
    await syncDirectory(dirname(target)); task.private.publish.published = true; this.save(task);
  }
  private async cleanupPublished(task: StoredTask) {
    const phase = task.private.publish;
    if (phase && await fileStat(phase.backup)) {
      const backup = await lstat(phase.backup), target = await fileStat(phase.target);
      if ((!phase.published && (!target || `${target.dev}:${target.ino}` !== phase.inode)) || phase.backupSignature && `${backup.dev}:${backup.ino}:${backup.size}:${backup.mtimeMs}` !== phase.backupSignature) { task.error = `Recovery backup preserved for inspection: ${phase.backup}`; return; }
      try { await verifyTemporaryParent(phase.backup, phase.parent); if (phase.backupTree && await directoryVersion(phase.backup, () => {}) !== phase.backupTree) { task.error = `Modified recovery backup preserved for inspection: ${phase.backup}`; return; } await rm(phase.backup, { recursive: true, force: false }); } catch { task.error = `Replacement succeeded; recovery cleanup is pending: ${phase.backup}`; }
    }
    if (phase && await fileStat(phase.backup)) return;
    if (phase && task.private.stage === phase.stage) { try { await removeTemporary(phase.stage, task.private.stageParent, phase.inode); } catch { task.error = `Committed file is safe; temporary recovery data was preserved: ${phase.stage}`; return; } }
    delete task.private.publish;
  }
  async finish(id: string) {
    const task = this.journal.require(id);
    if (task.state === 'complete' || this.running.has(id)) return this.journal.view(task);
    if (task.direction !== 'upload' || task.state !== 'active' || task.offset !== task.size) throw new WorkbenchError('file_upload_incomplete', 'Upload has not received all bytes');
    task.private.finalizing = true; task.state = 'queued'; this.save(task); this.enqueue(id); return this.journal.view(task);
  }
  private async finishUploadUnlocked(task: StoredTask) {
      const id = task.id, context = await this.context(task, true);
      await this.checkParent(task, context);
      if (task.state === 'complete') return this.journal.view(task);
      if (task.direction !== 'upload' || task.offset !== task.size) throw new WorkbenchError('file_upload_incomplete', 'Upload has not received all bytes');
      const target = await this.roots.path(context, task.path ? task.path + '/' + task.name : task.name, { mutate: true });
      const oldPhase = task.private.publish;
      if (oldPhase) {
        const current = await fileStat(target);
        if (oldPhase.published || current && `${current.dev}:${current.ino}` === oldPhase.inode) { task.state = 'complete'; this.save(task); await this.cleanupPublished(task); await rm(this.part(id), { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); if (task.private.stage && !await fileStat(task.private.stage)) delete task.private.stage; this.recordChange(task, task.workspaceId, task.instance, task.path ? task.path + '/' + task.name : task.name); return this.save(task); }
      }
      await this.stageIgnore.prepare(this.roots, context, target, task, () => { this.save(task); this.check(task); });
      const stage = join(dirname(target), `.workbench-transfer-${hash(task.id).slice(0, 24)}-upload`);
      if (!task.private.publish) {
        if (task.private.stage === stage) { await verifyTemporaryParent(stage, task.private.stageParent); await rm(stage, { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
        task.private.stage = stage; task.private.stageParent = await realpath(dirname(stage)); this.save(task);
        const source = await open(this.part(id), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try { if ((await source.stat()).size !== task.size) throw new WorkbenchError('file_upload_incomplete', 'Partial size differs from confirmed size'); task.sha256 = await this.hashFile(source, task); }
        finally { await source.close(); }
        await copyFileChunks(this.part(id), stage, () => this.check(task));
        const staged = await open(stage, constants.O_RDONLY | constants.O_NOFOLLOW); try { await staged.sync(); } finally { await staged.close(); }
      }
      this.check(task); await this.roots.path(context, task.path ? task.path + '/' + task.name : task.name, { mutate: true });
      await this.publish(task, stage, target, task.private.expected);
      task.state = 'complete'; this.save(task); await this.cleanupPublished(task); await rm(this.part(id), { force: false }).catch(() => {});
      if (task.private.stage && !await fileStat(task.private.stage)) delete task.private.stage; this.recordChange(task, task.workspaceId, task.instance, task.path ? task.path + '/' + task.name : task.name); return this.save(task);
  }
  private async hashFile(file: Awaited<ReturnType<typeof open>>, task: StoredTask) {
    const h = createHash('sha256'), buffer = Buffer.alloc(FILE_CHUNK_BYTES); let offset = 0;
    while (offset < task.size!) {
      this.check(task); const record = this.journal.chunk(task.id, offset);
      if (!record || record.size < 1 || record.size > buffer.length) throw new WorkbenchError('file_partial_corrupt', 'Confirmed chunk journal is incomplete');
      let read = 0;
      while (read < record.size) { const result = await file.read(buffer, read, record.size-read, offset+read); if (!result.bytesRead) throw new WorkbenchError('file_partial_corrupt', 'Confirmed upload data is missing'); read += result.bytesRead; }
      const bytes = buffer.subarray(0, record.size);
      if (digest(bytes) !== record.digest) throw new WorkbenchError('file_partial_corrupt', 'Confirmed upload data failed checksum verification; original target is preserved');
      h.update(bytes); offset += read; await sleep();
    }
    return h.digest('hex');
  }
  async verify(input: Extract<FileRequest, { action: 'verify' }>) {
    const task = this.journal.require(input.id); await this.context(task);
    const previous = this.journal.chunk(task.id, input.offset);
    if (!previous || previous.digest !== input.sha256) throw new WorkbenchError('file_source_changed', 'Selected local file differs from confirmed upload data');
    return { nextOffset: input.offset + previous.size };
  }
  async download(input: Extract<FileRequest, { action: 'download' }>) {
    const context = await this.roots.context(input.workspaceId, input.instance);
    const name = input.paths.length === 1 ? basename(input.paths[0]) : 'files';
    const { defer, ...legacyInput } = input;
    const candidate = this.base(defer ? input : legacyInput, context, 'download', name, dirname(input.paths[0]) === '.' ? '' : dirname(input.paths[0]));
    if (this.journal.get(input.id)) return this.journal.view(this.journal.create(candidate));
    candidate.private.selectionVersions = Object.create(null);
    for (const path of input.paths) {
      if (!path || this.roots.metadata(context, path)) throw new WorkbenchError('path_protected', 'Select files or ordinary directories');
      const info = await lstat(await this.roots.path(context, path)); if(input.versions?.[path]&&input.versions[path]!==fileVersion(info))throw new WorkbenchError('file_source_changed','The previewed file changed; refresh before downloading'); candidate.private.selectionVersions[path] = fileVersion(info);
      if (input.paths.length === 1 && info.isFile()) candidate.private.version = fileVersion(info);
    }
    if (input.defer) { candidate.selectionPending = true; candidate.selectionCount = input.paths.length; }
    const task = this.journal.create(candidate);
    if (!task.selectionPending && task.state === 'queued') this.enqueue(task.id);
    return this.journal.view(task);
  }
  async appendDownloadSelection(input: Extract<FileRequest, { action: 'download-selection' }>) {
    return this.lock(input.id, async () => {
      const task = this.journal.require(input.id), context = await this.context(task);
      if (task.direction !== 'download' || ['cancelled', 'failed', 'complete', 'delegated'].includes(task.state)) throw new WorkbenchError('file_task_not_active', 'Download selection is not active');
      const paths: string[] = task.private.request.paths;
      if (input.offset > paths.length) throw new WorkbenchError('file_offset_conflict', 'Query the confirmed download selection before continuing');
      if (input.offset < paths.length) {
        if (stable(paths.slice(input.offset, input.offset + input.paths.length)) !== stable(input.paths) || input.final && input.offset + input.paths.length !== paths.length) throw new WorkbenchError('file_request_conflict', 'Confirmed download selection differs');
        if (!input.final || !task.selectionPending) return this.journal.view(task);
      } else {
        if (!task.selectionPending) throw new WorkbenchError('file_request_conflict', 'Download selection is already complete');
        const versions: Json = Object.create(null);
        for (const path of input.paths) {
          if (!path || this.roots.metadata(context, path)) throw new WorkbenchError('path_protected', 'Select files or ordinary directories');
          const version = fileVersion(await lstat(await this.roots.path(context, path))), previous = task.private.selectionVersions[path] || versions[path];
          if (previous && previous !== version) throw new WorkbenchError('file_source_changed', 'Selected source changed after the download was queued');
          versions[path] = version;
        }
        paths.push(...input.paths); Object.assign(task.private.selectionVersions, versions);
      }
      task.name = 'files'; task.selectionCount = paths.length; delete task.private.version;
      if (input.final) { task.selectionPending = false; if (task.state !== 'paused') task.state = 'queued'; }
      this.save(task);
      if (!task.selectionPending && task.state === 'queued') this.enqueue(task.id);
      return this.journal.view(task);
    });
  }
  async operation(input: Extract<FileRequest, { action: 'mutate' }>) {
    const first = input.entries[0], context = await this.roots.context(first.workspaceId, first.instance, input.operation !== 'copy');
    if (input.operation === 'delete' && !input.confirm) throw new WorkbenchError('file_delete_confirmation_required', 'Confirm the exact selected paths before permanently deleting');
    const task = this.base(input, context, 'operation', input.entries.length === 1 ? basename(first.path) : `${input.entries.length} files`, first.path);
    const old = this.journal.get(task.id); if (old) return this.journal.view(this.journal.create(task));
    const entries = input.entries.filter(item => !input.entries.some(other => other !== item && other.workspaceId === item.workspaceId && item.path.startsWith(other.path + '/')));
    const pinned = [];
    const targets: Json = {};
    for (const item of entries) {
      const c = await this.roots.context(item.workspaceId, item.instance, input.operation !== 'copy');
      const source = await this.roots.path(c, item.path, { mutate: input.operation !== 'copy' }), info = await lstat(source);
      if (item.version && item.version !== fileVersion(info)) throw new WorkbenchError('file_source_changed', 'Selected source changed');
      if (input.operation !== 'delete') {
        const dest = input.destination || { workspaceId: item.workspaceId, instance: c.instance, path: dirname(item.path) === '.' ? '' : dirname(item.path) };
        const targetContext = await this.roots.context(dest.workspaceId, dest.instance, true);
        const name = input.operation === 'rename' ? this.roots.name(input.name || '') : basename(item.path);
        const target = await this.roots.path(targetContext, dest.path ? dest.path + '/' + name : name);
        // A move/rename back to the same path is not a transfer and has no journal row.
        if (source === target && input.operation !== 'copy') continue;
        const descendant = relative(source, target);
        if (info.isDirectory() && descendant && descendant !== '..' && !descendant.startsWith('..' + sep) && !isAbsolute(descendant)) throw new WorkbenchError('file_destination_invalid', 'Cannot move or copy a directory into itself');
        const exists = await fileStat(target), directory = await lstat(dirname(target));
        targets[target] = { expected: exists ? fileVersion(exists) : null, parent: `${directory.dev}:${directory.ino}` };
        if (input.destination) task.private.destination = { ...dest, instance: targetContext.instance };
      }
      pinned.push({ ...item, instance: c.instance, version: fileVersion(info) });
    }
    if (!pinned.length) return { noop: true as const };
    if (input.operation !== 'copy') for (const item of pinned) {
      const info = await lstat(await this.roots.path(await this.roots.context(item.workspaceId, item.instance), item.path));
      if (!info.isDirectory()) continue;
      for (const active of this.active(item.workspaceId)) {
        if (active.id === input.id) continue;
        const request = active.private.request || {}, paths: string[] = [];
        if (active.workspaceId === item.workspaceId) paths.push(...(request.paths || [request.path || active.path]));
        if (request.destination?.workspaceId === item.workspaceId) paths.push(request.destination.path);
        for (const source of request.entries || []) if (source.workspaceId === item.workspaceId) paths.push(source.path);
        if (paths.some(path => path === item.path || path.startsWith(item.path + '/'))) throw new WorkbenchError('file_path_busy', 'Finish or cancel file tasks in this directory before moving or deleting it');
      }
    }
    task.private.entries = pinned; task.private.targets = targets;
    task.operation = input.operation; task.files = pinned.length; task.processed = 0;
    const created = this.journal.create(task); if (created.state === 'queued') this.enqueue(created.id); return this.journal.view(created);
  }
  private enqueue(id: string) { if (!this.waiting.includes(id) && !this.running.has(id)) this.waiting.push(id); this.dispatch(); }
  private dispatch() {
    while (!this.closed && this.running.size < 2 && this.waiting.length) {
      const id = this.waiting.shift()!;
      const flight = this.lock(id, async () => {
        const task = this.journal.require(id); if (terminal(task) || task.state === 'paused') return;
        task.state = 'preparing'; delete task.error; this.save(task);
        try { if (task.direction === 'upload') await this.finishUploadUnlocked(task); else if (task.direction === 'download') await this.prepareDownload(task); else await this.mutate(task); }
        catch (e) { const current = this.journal.require(id); if (!['paused', 'cancelled', 'conflict'].includes(current.state)) { current.state = this.closed ? 'interrupted' : 'failed'; current.error = e instanceof Error ? e.message : String(e); if (e instanceof WorkbenchError && e.code === 'file_source_changed') current.private.sourceChanged = true; this.save(current); } }
      }).finally(() => { this.running.delete(id); this.dispatch(); });
      this.running.set(id, flight);
    }
  }
  private async *walk(context: FileRoot, value: string, readOnly = false, skipped?: () => void): AsyncGenerator<{ path: string; full: string; stat: Stats }> {
    if (readOnly && this.roots.metadata(context, value)) { skipped?.(); return; }
    const full = await this.roots.path(context, value);
    if (this.roots.protected(context, value) && !(readOnly && context.repositories.has(full))) throw new WorkbenchError('path_protected', `Protected entry: ${value}`);
    const stat = await lstat(full); yield { path: value, full, stat };
    if (stat.isDirectory()) { const directory = await import('node:fs/promises').then(fs => fs.opendir(full)); for await (const entry of directory) yield* this.walk(context, value + '/' + entry.name, readOnly, skipped); }
  }
  private async prepareDownload(task: StoredTask) {
    if (task.selectionPending) throw new WorkbenchError('file_selection_incomplete', 'The download selection is incomplete; finish selecting or cancel and select again');
    const context = await this.context(task), input = task.private.request as Extract<FileRequest, { action: 'download' }>;
    const unique = new Set(input.paths), selectedPaths = [...unique].filter(path => { const parts = this.roots.parts(path); for (let n = 1; n < parts.length; n++) if (unique.has(parts.slice(0, n).join('/'))) return false; return true; });
    const parents = selectedPaths.map(path => this.roots.parts(path).slice(0,-1));
    const common = [...parents[0]]; for (const parts of parents.slice(1)) while (common.length && common.some((part, i) => parts[i] !== part)) common.pop();
    for (const path of selectedPaths) if (task.private.selectionVersions?.[path] && fileVersion(await lstat(await this.roots.path(context, path))) !== task.private.selectionVersions[path]) throw new WorkbenchError('file_source_changed', 'Selected source changed after the download was queued; create a new download');
    const archiveRoot = join(context.root, ...common);
    const firstPath = await this.roots.path(context, input.paths[0]), first = await lstat(firstPath);
    if (input.paths.length === 1 && first.isFile()) {
      if (task.private.version && task.private.version !== fileVersion(first)) throw new WorkbenchError('file_source_changed', 'Source changed; create a new download');
      task.private.source = input.paths[0]; task.private.version = fileVersion(first); task.size = first.size;
      if (task.private.delegating && !task.private.snapshot) {
        await rm(this.part(task.id), { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        await copyFileChunks(firstPath, this.part(task.id), () => this.check(task));
        this.check(task); await this.roots.path(context, input.paths[0]);
        if (fileVersion(await lstat(firstPath)) !== task.private.version) throw new WorkbenchError('file_source_changed', 'Source changed while preparing browser download');
        const snapshot = await open(this.part(task.id), constants.O_RDONLY | constants.O_NOFOLLOW); try { await snapshot.sync(); } finally { await snapshot.close(); }
        task.private.snapshot = true;
      }
      task.state = task.offset === task.size ? 'ready_to_save' : 'active'; this.save(task); return;
    }
    task.name = task.name.replace(/\.zip$/i, '') + '.zip'; task.processed = 0; task.excluded = 0;
    const part = this.part(task.id); await rm(part, { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    const zip = new yazl.ZipFile();
    const destination = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const check = () => this.check(task);
    const output = new Writable({ highWaterMark: FILE_CHUNK_BYTES, write(bytes: Buffer, _encoding, callback) {
      void (async () => { check(); let offset = 0; while (offset < bytes.length) { const result = await destination.write(bytes, offset, bytes.length - offset); if (!result.bytesWritten) throw new Error('No archive write progress'); offset += result.bytesWritten; } })().then(() => callback(), callback);
    } });
    const flight = pipeline(zip.outputStream, output); void flight.catch(() => {});
    try {
      for (const selected of selectedPaths) {
        for await (const item of this.walk(context, selected, true, () => { task.excluded = (task.excluded || 0)+1; })) {
          this.check(task);
          const zipPath = relative(archiveRoot, item.full).replaceAll('\\', '/');
          if (zipPath.startsWith('../')) throw new WorkbenchError('download_scope_invalid', 'Download path escaped its common directory');
          if (item.stat.isSymbolicLink()) {
            const reference = Buffer.from(await readlink(item.full), 'utf8');
            if (fileVersion(await lstat(item.full)) !== fileVersion(item.stat)) throw new WorkbenchError('file_source_changed', 'Symbolic link changed while archiving');
            zip.addBuffer(reference, zipPath, { mode: 0o120777, mtime: item.stat.mtime, compress: false });
          } else if (item.stat.isDirectory()) zip.addEmptyDirectory(zipPath);
          else if (item.stat.isFile()) {
            const version = fileVersion(item.stat), roots = this.roots;
            zip.addReadStreamLazy(zipPath, { size: item.stat.size, mtime: item.stat.mtime, compress: !/\.(?:zip|gz|tgz|bz2|xz|7z|rar|png|jpe?g|webp|mp[34])$/i.test(item.path) }, callback => {
              void this.roots.read(context, item.path).then(async handle => {
                if (fileVersion(await handle.stat()) !== version) { await handle.close(); throw new WorkbenchError('file_source_changed', 'A source file changed while preparing the archive'); }
                const stream = Readable.from((async function* () {
                  try { let offset = 0; for (;;) { const buffer = Buffer.alloc(FILE_CHUNK_BYTES); const r = await handle.read(buffer, 0, buffer.length, offset); if (!r.bytesRead) break; offset += r.bytesRead; yield buffer.subarray(0, r.bytesRead); } if (fileVersion(await handle.stat()) !== version) throw new WorkbenchError('file_source_changed', 'Source changed while archiving'); }
                  finally { await handle.close(); }
                })());
                callback(null, stream);
              }).catch(e => callback(e, null as any));
            });
          }
          task.processed!++; this.save(task); await sleep();
        }
      }
      zip.end(); await flight; await destination.sync(); await syncDirectory(this.journal.root);
    } catch (e) { (zip.outputStream as Readable).destroy(e instanceof Error ? e : new Error(String(e))); await flight.catch(() => {}); throw e; }
    finally { await destination.close(); }
    task.private.archive = true; task.size = (await lstat(part)).size; task.state = 'active'; this.save(task);
  }
  async read(input: Extract<FileRequest, { action: 'read' }>) {
    const task = this.journal.require(input.id), context = await this.context(task);
    if (task.direction !== 'download' || !['active', 'ready_to_save'].includes(task.state)) throw new WorkbenchError('file_task_not_active', 'Download is not active');
    const file = task.private.archive || task.private.snapshot ? await open(this.part(task.id), constants.O_RDONLY | constants.O_NOFOLLOW) : await this.roots.read(context, task.private.source);
    try {
      if (!task.private.archive && !task.private.snapshot && fileVersion(await file.stat()) !== task.private.version) throw new WorkbenchError('file_source_changed', 'Source changed; restart the download');
      if (input.offset > task.size!) throw new WorkbenchError('file_offset_conflict', 'Offset exceeds file size');
      const buffer = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, task.size! - input.offset));
      let total = 0;
      while (total < buffer.length) { const r = await file.read(buffer, total, buffer.length - total, input.offset + total); if (!r.bytesRead) throw new WorkbenchError('file_source_changed', 'Source ended before the expected size'); total += r.bytesRead; }
      if (!task.private.archive && !task.private.snapshot && fileVersion(await file.stat()) !== task.private.version) throw new WorkbenchError('file_source_changed', 'Source changed during this read');
      return { data: buffer.toString('base64'), offset: input.offset, size: task.size!, sha256: digest(buffer) };
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === 'file_source_changed') { const latest = this.journal.require(task.id); if (!terminal(latest)) { latest.state = 'failed'; latest.error = error.message; latest.private.sourceChanged = true; this.save(latest); } }
      throw error;
    } finally { await file.close(); }
  }
  async ack(input: Extract<FileRequest, { action: 'ack' }>) {
    return this.lock(input.id, async () => {
      const task = this.journal.require(input.id);
      if (task.direction !== 'download' || !['active', 'ready_to_save'].includes(task.state) || input.offset < task.offset || input.offset > task.size!) throw new WorkbenchError('file_offset_conflict', 'Invalid confirmed download offset');
      task.offset = input.offset; task.state = task.offset === task.size ? 'ready_to_save' : 'active'; return this.save(task);
    });
  }
  private async mutate(task: StoredTask) {
    const raw = task.private.request as Extract<FileRequest, { action: 'mutate' }>;
    const input = { ...raw, entries: task.private.entries || raw.entries, destination: task.private.destination || raw.destination } as Extract<FileRequest, { action: 'mutate' }>;
    for (let i = task.processed || 0; i < input.entries.length; i++) {
      this.check(task);
      const item = input.entries[i], sourceContext = await this.roots.context(item.workspaceId, item.instance, input.operation !== 'copy');
      const source = await this.roots.path(sourceContext, item.path, { mutate: input.operation !== 'copy' });
      const phase = task.private.publish;
      if (phase && (phase.published || await fileStat(phase.target) && `${(await lstat(phase.target)).dev}:${(await lstat(phase.target)).ino}` === phase.inode)) {
        if (task.private.removeSource) await this.removeCopiedSource(task);
        const destination = input.destination || { workspaceId: item.workspaceId, instance: item.instance, path: dirname(item.path) === '.' ? '' : dirname(item.path) };
        const targetContext = await this.roots.context(destination.workspaceId, destination.instance, true);
        this.recordChange(task, destination.workspaceId, targetContext.instance, relative(targetContext.root, phase.target).split(sep).join('/'));
        this.recordChange(task, item.workspaceId, sourceContext.instance, item.path, input.operation !== 'copy');
        await this.cleanupPublished(task); task.processed = i + 1; delete task.private.policy; delete task.private.conflictTarget; delete task.private.expected; this.save(task); continue;
      }
      const info = await lstat(source);
      if (item.version && fileVersion(info) !== item.version) throw new WorkbenchError('file_source_changed', 'Selected source changed; select it again');
      if (info.isDirectory() && input.operation !== 'copy') for await (const _ of this.walk(sourceContext, item.path)) this.check(task);
      if (input.operation === 'delete') { for await (const _ of this.walk(sourceContext, item.path)) this.check(task); this.check(task); await this.roots.path(sourceContext, item.path, { mutate: true }); await rm(source, { recursive: info.isDirectory(), force: false }); }
      else {
        const dest = input.destination || { workspaceId: item.workspaceId, instance: item.instance, path: dirname(item.path) === '.' ? '' : dirname(item.path) };
        const targetContext = await this.roots.context(dest.workspaceId, dest.instance, true);
        let name = input.operation === 'rename' ? this.roots.name(input.name || '') : basename(item.path);
        let value = dest.path ? dest.path + '/' + name : name;
        let target = await this.roots.path(targetContext, value);
        const descendant = relative(source, target);
        if (target === source && input.operation !== 'copy' || descendant && descendant !== '..' && !descendant.startsWith('..' + sep) && !isAbsolute(descendant)) throw new WorkbenchError('file_destination_invalid', 'Cannot move a directory into itself');
        let exists = await fileStat(target);
        const pinned = task.private.targets?.[target], parentInfo = await lstat(dirname(target));
        if (pinned && pinned.parent !== `${parentInfo.dev}:${parentInfo.ino}`) throw new WorkbenchError('file_directory_changed', 'Destination directory was replaced');
        if (pinned && pinned.expected !== (exists ? fileVersion(exists) : null) && task.private.conflictTarget !== target) { task.state = 'conflict'; task.conflict = 'changed'; task.private.conflictTarget = target; task.private.expected = exists ? fileVersion(exists) : null; task.error = 'Destination changed after the operation was queued'; this.save(task); return; }
        const chosen = task.private.policy || input.policy;
        if (exists && chosen === 'keep') { name = await this.available(targetContext, dest.path, name); value = dest.path ? dest.path + '/' + name : name; target = await this.roots.path(targetContext, value, { mutate: true }); exists = null; }
        task.canReplace = !this.roots.protected(targetContext, value);
        if (exists?.isDirectory() && task.canReplace) {
          try { for await (const _ of this.walk(targetContext, value)) this.check(task); }
          catch (error) { if (error instanceof WorkbenchError && error.code === 'path_protected') task.canReplace = false; else throw error; }
          if (task.canReplace) {
            const tree = await directoryVersion(target, () => this.check(task)); task.private.targetTrees ||= {};
            if (task.private.targetTrees[target] && task.private.targetTrees[target] !== tree) { task.private.targetTrees[target] = tree; task.private.conflictTarget = target; task.private.expected = fileVersion(exists); task.state = 'conflict'; task.conflict = 'changed'; task.error = 'Destination directory contents changed; confirm again'; this.save(task); return; }
            task.private.targetTrees[target] = tree;
          }
        }
        if (exists && (chosen === 'ask' || !task.canReplace)) { task.state = 'conflict'; task.conflict = 'exists'; task.error = task.canReplace ? `${value} already exists` : 'Destination contains protected metadata; keep both or skip'; task.private.expected = fileVersion(exists); task.private.conflictTarget = target; this.save(task); return; }
        if (exists && task.private.conflictTarget === target && fileVersion(exists) !== task.private.expected) { task.private.policy = 'ask'; task.private.expected = fileVersion(exists); task.state = 'conflict'; task.conflict = 'changed'; task.error = 'Destination changed; confirm again'; this.save(task); return; }
        let stage = source;
        const crossDevice = input.operation !== 'copy' && info.dev !== parentInfo.dev;
        if (input.operation === 'copy' || crossDevice) {
          stage = join(dirname(target), `.workbench-transfer-${hash(task.id).slice(0,24)}-${i}`);
          if (await fileStat(stage)) { if (task.private.stage !== stage) throw new WorkbenchError('file_recovery_required', 'Unverified partial copy retained'); await verifyTemporaryParent(stage, task.private.stageParent); await rm(stage, { recursive: true, force: false }); }
          task.private.stage = stage; task.private.stageParent = await realpath(dirname(stage)); if (crossDevice) task.private.removeSource = { ...item, instance: sourceContext.instance }; this.save(task);
          const sourceDigest = createHash('sha256');
          for await (const entry of this.walk(sourceContext, item.path, input.operation === 'copy', () => { task.excluded = (task.excluded || 0)+1; })) {
            this.check(task); sourceDigest.update(entry.path + ':' + fileVersion(entry.stat) + '\n'); const output = join(stage, relative(source, entry.full));
            if (entry.stat.isDirectory()) await mkdir(output);
            else if (entry.stat.isSymbolicLink()) await symlink(await readlink(entry.full), output);
            else if (entry.stat.isFile()) { await copyFileChunks(entry.full, output, () => this.check(task)); if (fileVersion(await lstat(entry.full)) !== fileVersion(entry.stat)) throw new WorkbenchError('file_source_changed', 'Source changed during copying'); }
            else throw new WorkbenchError('file_not_regular', 'Special filesystem entries cannot be copied');
          }
          if (crossDevice) task.private.sourceDigest = sourceDigest.digest('hex');
          task.private.stage = stage; this.save(task);
        }
        this.check(task); await this.roots.path(sourceContext, item.path, { mutate: input.operation !== 'copy' });
        await this.roots.path(targetContext, value, { mutate: true });
        await this.publish(task, stage, target, exists ? fileVersion(exists) : null);
        if (crossDevice) await this.removeCopiedSource(task);
        await this.cleanupPublished(task); if (task.private.stage && !await fileStat(task.private.stage)) delete task.private.stage;
        this.recordChange(task, dest.workspaceId, targetContext.instance, value);
      }
      this.recordChange(task, item.workspaceId, sourceContext.instance, item.path, input.operation !== 'copy');
      task.processed = i + 1; delete task.private.policy; delete task.private.conflictTarget; delete task.private.expected; task.state = 'preparing'; this.save(task);
    }
    task.state = 'complete'; this.save(task);
  }
  private async removeCopiedSource(task: StoredTask) {
    const source = task.private.removeSource, context = await this.roots.context(source.workspaceId, source.instance, true);
    const full = await this.roots.path(context, source.path, { mutate: true }), current = await fileStat(full);
    if (!current) { delete task.private.removeSource; return; }
    const digest = createHash('sha256');
    for await (const item of this.walk(context, source.path)) { this.check(task); digest.update(item.path + ':' + fileVersion(item.stat) + '\n'); }
    if (digest.digest('hex') !== task.private.sourceDigest) throw new WorkbenchError('file_source_changed', 'Copy was committed, but the source changed and was preserved; inspect both paths');
    this.check(task); await this.roots.path(context, source.path, { mutate: true });
    await rm(full, { recursive: current.isDirectory(), force: false }); delete task.private.removeSource;
  }
  async control(input: Extract<FileRequest, { action: 'control' }>) {
    // Pause/cancel must be visible to a running directory operation before its lock drains.
    if (['pause', 'cancel', 'skip'].includes(input.command)) { const task = this.journal.require(input.id); if (input.command === 'skip' && task.direction === 'operation' && task.state === 'conflict' && !task.private.publish) { task.processed = (task.processed || 0) + 1; delete task.private.conflictTarget; delete task.private.expected; delete task.private.policy; task.state = 'queued'; this.save(task); this.enqueue(task.id); return this.journal.view(task); } if (!terminal(task)) { task.state = input.command === 'pause' ? 'paused' : 'cancelled'; this.controlFlags.set(task.id, task.state); this.save(task); } }
    return this.lock(input.id, async () => {
      const task = this.journal.require(input.id);
      if (task.state === 'complete') { if (input.command === 'cancel' && task.cleanupPending) { await this.cleanupPublished(task); if (task.private.stage) { await removeTemporary(task.private.stage, task.private.stageParent, task.private.stageInode); delete task.private.stage; } return this.save(task); } return this.journal.view(task); }
      if (['cancel', 'skip'].includes(input.command)) {
        await rm(this.part(task.id), { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
        if (task.private.publish) { const p = task.private.publish, s = await fileStat(p.target); if (p.published || s && `${s.dev}:${s.ino}` === p.inode) await this.cleanupPublished(task); else if (await fileStat(p.backup) && !s) { await verifyTemporaryParent(p.backup, p.parent); await rename(p.backup, p.target); } }
        if (task.private.stage) { await removeTemporary(task.private.stage, task.private.stageParent, task.private.stageInode); delete task.private.stage; }
        task.state = 'cancelled'; this.controlFlags.delete(task.id); return this.save(task);
      }
      if (input.command === 'pause') return this.journal.view(task);
      await this.context(task, task.direction !== 'download');
      if (task.selectionPending) throw new WorkbenchError('file_selection_incomplete', 'The download selection is incomplete; cancel and select the files again');
      if (task.private.sourceChanged && ['resume', 'retry'].includes(input.command)) throw new WorkbenchError('file_source_changed', 'Source changed; cancel this task and select the source again');
      if (input.command === 'complete') { if (task.direction !== 'download' || task.offset !== task.size) throw new WorkbenchError('file_download_incomplete', 'Download has not been saved completely'); task.state = 'complete'; if (task.private.archive || task.private.snapshot) await rm(this.part(task.id), { force: false }).catch(() => {}); return this.save(task); }
      if (input.command === 'delegated') { if (task.direction !== 'download') throw new WorkbenchError('file_task_invalid', 'Only downloads can be delegated'); task.state = 'delegated'; task.private.delegatedAt = Date.now(); return this.save(task); }
      if (task.state === 'delegated') throw new WorkbenchError('file_task_delegated', 'This download was handed to the browser; create a new task to download again');
      if (task.state === 'cancelled') throw new WorkbenchError('file_task_cancelled', 'Create a new task after cancellation');
      if (input.command === 'keep' || input.command === 'replace') {
        if (input.command === 'replace' && task.canReplace === false) throw new WorkbenchError('path_protected', 'Choose Keep both or Skip for this protected destination');
        if (task.state !== 'conflict') throw new WorkbenchError('file_task_invalid', 'No conflict is pending');
        if (task.direction === 'upload') {
          const c = await this.context(task, true);
          if (input.command === 'keep') { task.name = await this.available(c, task.path, task.name); task.private.expected = null; task.canReplace = true; }
          else {
            const target = await this.roots.path(c, task.path ? task.path + '/' + task.name : task.name, { mutate: true });
            const s = await fileStat(target); if (s?.isDirectory() || s?.isSymbolicLink()) throw new WorkbenchError('file_kind_conflict', 'Target is not a regular file');
            const version = s ? fileVersion(s) : null;
            if (task.private.expected !== version) { task.private.expected = version; task.conflict = 'changed'; task.error = 'Target changed while awaiting confirmation; review replacement again'; return this.save(task); }
          }
        } else task.private.policy = input.command;
      }
      delete task.error; delete task.conflict; this.controlFlags.delete(task.id); task.state = task.direction === 'upload' ? task.private.finalizing ? 'queued' : 'active' : task.direction === 'download' && task.size !== null ? (task.offset === task.size ? 'ready_to_save' : 'active') : 'queued';
      const result = this.save(task, true); if (task.state === 'queued') this.enqueue(task.id); return result;
    });
  }
  async list(before?: number, limit?: number, activeOnly = false) { await this.maintain(); const tasks = this.journal.list(before, limit, activeOnly); let temporaryBytes = 0; for (const entry of await readdir(this.journal.root, { withFileTypes: true })) if (entry.name.endsWith('.part') && entry.isFile()) temporaryBytes += (await lstat(join(this.journal.root, entry.name))).size; return { tasks, next: tasks.length ? tasks[tasks.length-1].updatedAt : undefined, temporaryBytes, incompleteTasks: Number(this.journal.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE terminal=0').get()?.n || 0) }; }
  maintain() {
    if (this.maintenance) return this.maintenance;
    if (this.closed || Date.now() - this.lastCleanup < 60000) return Promise.resolve();
    this.lastCleanup = Date.now();
    this.maintenance = cleanFileTasks(this.journal, id => this.part(id), id => this.running.has(id) || this.locks.has(id), task => this.cleanupPublished(task)).finally(() => { this.maintenance = undefined; });
    return this.maintenance;
  }
  active(id: string) { return [...new Map([...this.journal.db.prepare('SELECT data FROM tasks WHERE terminal=0').iterate()].map(r => { const task = JSON.parse(r.data as string) as StoredTask; return [task.id, task] as const; }).concat([...new Set([...this.running.keys(), ...this.locks.keys()])].map(key => [key, this.journal.get(key)] as const).filter((pair): pair is readonly [string, StoredTask] => Boolean(pair[1])))).values()].filter(t => t.workspaceId === id || t.private.request?.entries?.some((e: Json) => e.workspaceId === id) || t.private.request?.destination?.workspaceId === id); }
  async delegation(id: string) {
    const task = this.journal.require(id); await this.context(task);
    if (task.selectionPending) throw new WorkbenchError('file_selection_incomplete', 'The download selection is incomplete');
    if (task.direction !== 'download' || !['queued', 'preparing', 'active', 'ready_to_save', 'delegated'].includes(task.state)) throw new WorkbenchError('file_task_not_active', task.error || 'Download is not ready');
    if (!task.private.archive && !task.private.snapshot) {
      if (!this.running.has(id)) { task.private.delegating = true; task.state = 'queued'; this.save(task); this.enqueue(id); }
      return { pending: true };
    }
    return { cwd: this.journal.root, path: hash(task.id) + '.part' };
  }
  assertIdle(id: string) { if (this.active(id).length) throw new WorkbenchError('workspace_file_task_active', 'Finish or cancel Workspace file tasks before removing it'); }
  close() { return this.closing ||= this.shutdown(); }
  private async shutdown() { this.closed = true; await Promise.allSettled([...this.running.values()]); for (const q of this.locks.values()) await q.queue.drain(); await this.maintenance; this.journal.close(); }
}
