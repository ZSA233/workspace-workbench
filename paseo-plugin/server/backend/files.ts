import { DirectoryOrder, type DirectoryName } from './directory-order.ts';
import { watch, type FSWatcher } from 'node:fs';
import { opendir, lstat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileRequest, type DirectoryPage, type FileEntry } from '../../shared/files.ts';
import { FileRoots, fileVersion, fileStat } from './file-roots.ts';
import { FileTasks } from './file-tasks.ts';
import { terminal } from './file-journal.ts';
import { hash, stable, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';
import type { ObservationCache } from './cache.ts';
import { FileDecorationsService } from './file-decorations.ts';
import { RepositoryStatus } from './repository-status.ts';
import { ObservationScheduler } from './observation-scheduler.ts';
import { Documents } from './documents.ts';
import { SyntaxService } from './syntax-service.ts';

export class WorkspaceFiles {
  readonly roots: FileRoots;
  readonly order: DirectoryOrder;
  readonly tasks: FileTasks;
  readonly decorations: FileDecorationsService;
  readonly documents:Documents;
  private ownSyntax?:SyntaxService;
  private ownScheduler?: ObservationScheduler;
  private directories = new Map<string, { watcher?: FSWatcher; revision: number; used: number; owners: Set<string>; timer?: ReturnType<typeof setTimeout> }>();
  private generation = randomUUID();
  private changes = new Map<string, { paths: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  readonly workspaces: Workspaces;
  readonly cache: ObservationCache;
  readonly onChanged: (id: string, paths: string[]) => void;
  constructor(workspaces: Workspaces, cache: ObservationCache, onChanged: (id: string, paths: string[]) => void, status?: RepositoryStatus, syntax?:SyntaxService) {
    this.workspaces = workspaces; this.cache = cache; this.onChanged = onChanged;
    this.roots = new FileRoots(workspaces);this.order=new DirectoryOrder(cache);
    this.documents=new Documents(this.roots,syntax||(this.ownSyntax=new SyntaxService()));
    if (!status) { this.ownScheduler = new ObservationScheduler({ internalPaths: [workspaces.config.stateRoot, workspaces.config.workspaceRoot, workspaces.config.recordsRoot, workspaces.config.treesRoot] }); status = new RepositoryStatus(cache, this.ownScheduler, workspaces.config.gitTimeout); }
    this.decorations = new FileDecorationsService(this.roots, status);
    this.tasks = new FileTasks(this.roots, (id, paths) => this.changed(id, paths));
    void this.tasks.maintain().catch(() => {});
    this.timer = setInterval(() => { void this.tasks.maintain().catch(() => {}); for (const [path, entry] of this.directories) if (Date.now() - entry.used > 30_000) { entry.watcher?.close(); clearTimeout(entry.timer); this.directories.delete(path); } }, 10_000); this.timer.unref();
  }
  private changed(id: string, paths: string[]) {
    if (this.closed) return;
    let workspace: Json; try { workspace = this.workspaces.get(id); } catch { return; }
    const root = workspace.treePath || workspace.sourceRoot;
    const fullPaths = paths.map(path => join(root, path));
    for (const [full, directory] of this.directories) if (directory.owners.has(id) && fullPaths.some(path => full === dirname(path) || full === path)) directory.revision++;
    let batch = this.changes.get(id);
    if (!batch) { batch = { paths: new Set(), timer: setTimeout(() => { const pending = this.changes.get(id); this.changes.delete(id); if (!this.closed && pending) { this.cache.invalidateWorkspace(id); this.onChanged(id, [...pending.paths]); } }, 300) }; this.changes.set(id, batch); }
    fullPaths.forEach(path => batch!.paths.add(path));
  }
  retire(id: string) {
    this.order.retire(id);
    this.documents.syntax.retire(id);
    this.ownScheduler?.retireWorkspace(id);
    const batch = this.changes.get(id); if (batch) { clearTimeout(batch.timer); this.changes.delete(id); }
    for (const [path, entry] of this.directories) { entry.owners.delete(id); if (!entry.owners.size) { entry.watcher?.close(); clearTimeout(entry.timer); this.directories.delete(path); } }
  }
  reconcile(workspaces: Json[]) { if (workspaces.some(w => w.state === 'record_invalid')) return; const active = new Set(workspaces.filter(w => w.state !== 'removed').map(w => w.id)); for (const entry of this.directories.values()) for (const id of entry.owners) if (!active.has(id)) this.retire(id); }
  private touch(path: string, workspaceId: string) {
    let entry = this.directories.get(path);
    if (!entry) {
      entry = { revision: 0, used: Date.now(), owners: new Set() }; this.directories.set(path, entry);
      if (this.directories.size <= 256) {
        const value = entry;
        try { entry.watcher = watch(path, { persistent: false }, () => { if (!value.timer) value.timer = setTimeout(() => { value.revision++; value.timer = undefined; }, 300); }); entry.watcher.on('error', () => { value.watcher?.close(); value.watcher = undefined; }); } catch { /* reads remain authoritative */ }
      }
    }
    entry.used = Date.now(); entry.owners.add(workspaceId); return entry;
  }
  async request(raw: Json,signal?:AbortSignal): Promise<Json> {
    const parsed = fileRequest.safeParse(raw);
    if (!parsed.success) throw new WorkbenchError('file_request_invalid', 'Invalid file request', parsed.error.issues.map(i => ({ path: i.path, message: i.message })));
    const input = parsed.data;
    if (input.action === 'upload') return this.workspaces.mutations.run(() => this.tasks.upload(input));
    if (input.action === 'chunk') return this.tasks.chunk(input);
    if (input.action === 'finish') { await this.tasks.finish(input.id); return this.tasks.settled(input.id); }
    if (input.action === 'verify') return this.tasks.verify(input);
    if (input.action === 'download') return this.workspaces.mutations.run(() => this.tasks.download(input));
    if (input.action === 'download-selection') return this.workspaces.mutations.run(() => this.tasks.appendDownloadSelection(input));
    if (input.action === 'read') return this.tasks.read(input);
    if (input.action === 'ack') return this.tasks.ack(input);
    if (input.action === 'control') return this.tasks.control(input);
    if (input.action === 'task') return this.tasks.journal.view(this.tasks.journal.require(input.id));
    if (input.action === 'delegate') return this.tasks.delegation(input.id);
    if (input.action === 'activity') return { tasks: this.tasks.active(input.workspaceId).map(t => this.tasks.journal.view(t)) };
    if (input.action === 'tasks') return this.tasks.list(input.before, input.limit, input.activeOnly);
    if (input.action === 'mutate') { const result = await this.workspaces.mutations.run(() => this.tasks.operation(input)); return 'noop' in result ? result : this.tasks.settled(input.id); }
    const context = await this.roots.context(input.workspaceId, input.instance, input.action === 'mkdir');
    if(input.action==='document')return this.documents.page(context,input.path,input.offset,input.version);
    if(input.action==='document-stat')return this.documents.stat(context,input.path,input.version);
    if(input.action==='document-syntax')return this.documents.highlight(context,input.path,input.version,input.lineStart,input.count,input.markdown,signal,input.requestId);
    if(input.action==='document-cancel')return this.documents.cancel(context,input.requestId);
    if(input.action==='document-asset')return this.documents.asset(context,input.path,input.offset,input.version);
    if (input.action === 'decorations') return this.decorations.query(context, input.paths, input.force);
    if (input.action === 'versions') {
      const versions: Record<string, string> = Object.create(null), orders:Record<string,string>=Object.create(null);
      for (const path of input.paths) {
        try { const full = await this.roots.path(context, path); const s = await lstat(full); const w = this.touch(full, input.workspaceId); const content=`${this.generation}:${fileVersion(s)}:${w.revision}`;versions[path] = `${content}:${Math.floor(Date.now()/30_000)}`;if(input.listingProtocol===2)orders[path]=this.order.state(this.order.key(context.instance,path),content)?'ready':'preparing'; }
        catch { versions[path] = 'missing'; }
      }
      return { versions, instance: context.instance, ...(input.listingProtocol===2?{orders}:{}) };
    }
    if (input.action === 'preview') {
      const handle = await this.roots.read(context, input.path);
      try { const before = await handle.stat(), data = Buffer.alloc(Math.max(0, Math.min(64 * 1024, before.size - input.offset))); await handle.read(data, 0, data.length, input.offset); if (fileVersion(before) !== fileVersion(await handle.stat())) throw new WorkbenchError('file_source_changed', 'File changed while previewing'); return { data: data.toString('base64'), offset: input.offset, size: before.size, sha256: hash(data), version: fileVersion(before) }; }
      finally { await handle.close(); }
    }
    if (input.action === 'mkdir') {
      return this.workspaces.mutations.run(async () => {
        const fresh = await this.roots.context(input.workspaceId, context.instance, true);
        const name = this.roots.name(input.name), value = input.path ? input.path + '/' + name : name;
        const path = await this.roots.path(fresh, value, { mutate: !input.existOk });
        const existing = await fileStat(path);
        if (!(input.existOk && existing?.isDirectory() && !existing.isSymbolicLink())) await this.roots.path(fresh, value, { mutate: true });
        const task = this.tasks.journal.create({ id: input.id, identity: hash(stable(input)), private: { request: input }, direction: 'operation', operation: 'mkdir', workspaceId: input.workspaceId, instance: context.instance, workspaceName: context.workspace.displayName, path: input.path, name, size: null, offset: 0, state: 'queued', createdAt: Date.now(), updatedAt: Date.now() });
        if (terminal(task)) return this.tasks.journal.view(task);
        try { await mkdir(path).catch(async (e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST' || !input.existOk || !(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw e; }); task.state = 'complete'; if (!existing) { this.cache.invalidateWorkspace(input.workspaceId); this.changed(input.workspaceId, [value]); } }
        catch (e) { task.state = 'failed'; task.error = e instanceof Error ? e.message : String(e); }
        this.tasks.journal.save(task); return this.tasks.journal.view(task);
      });
    }
    const full = await this.roots.path(context, input.path), stat = await lstat(full);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkbenchError('file_not_directory', 'Expected a real directory');
    const observed = this.touch(full, input.workspaceId);
    const contentVersion = `${this.generation}:${fileVersion(stat)}:${observed.revision}`;
    const version = `${contentVersion}:${Math.floor(Date.now()/30_000)}`;
    const orderKey=this.order.key(context.instance,input.path);
    let offset = 0, after:DirectoryName|undefined;
    let ordering:'native'|'sorted'=input.listingProtocol===2 && input.order!=='native' && (input.order==='sorted' || this.order.state(orderKey,contentVersion))?'sorted':'native';
    if (input.cursor) {
      try { const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); if (cursor.version !== contentVersion || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error(); offset = cursor.offset;
        if(input.listingProtocol===2){ordering=cursor.order||'native';if(!['native','sorted'].includes(ordering))throw new Error();if(ordering==='sorted'){after=cursor.after;if(!after||typeof after.name!=='string'||typeof after.directory!=='boolean')throw new Error();}}
      }
      catch { throw new WorkbenchError('file_listing_changed', 'Directory changed; refresh its first page'); }
    }
    const snapshotId=hash(contentVersion+':'+ordering);
    const cursorFor=(offset:number,after?:DirectoryName)=>Buffer.from(JSON.stringify({version:contentVersion,offset,...(input.listingProtocol===2?{order:ordering,...(after?{after}:{})}:{})})).toString('base64url');
    if(input.listingProtocol===2 && ordering==='sorted'){
      const key=`files:sorted:${hash(context.instance)}:${input.path}:${offset}:${input.limit}`;
      const page=await this.cache.read(key,version,async()=>{
        const names=await this.order.page(orderKey,contentVersion,full,input.limit,after),more=names.length>input.limit,entries:FileEntry[]=[];
        for(const item of names.slice(0,input.limit)){const info=await fileStat(join(full,item.name));if(!info)throw new WorkbenchError('file_listing_changed','Directory changed during listing');const path=input.path?input.path+'/'+item.name:item.name;entries.push({name:item.name,path,kind:info.isDirectory()?'directory':info.isFile()?'file':info.isSymbolicLink()?'link':'other',size:info.size,modifiedAt:info.mtimeMs,version:fileVersion(info),protected:this.roots.protected(context,path),repository:context.repositories.has(join(full,item.name))});}
        if(fileVersion(await lstat(full))!==fileVersion(stat))throw new WorkbenchError('file_listing_changed','Directory changed during listing');
        return {workspaceId:input.workspaceId,instance:context.instance,path:input.path,version,entries,order:ordering,sortState:'ready',snapshotId,...(more?{cursor:cursorFor(offset+entries.length,names[input.limit-1])}:{})};
      },true,input.fresh,{workspaceId:input.workspaceId,repoPath:context.root});this.order.prepare(orderKey,full,contentVersion,input.workspaceId);return page;
    }
    const key = `files:v1:${hash(context.instance)}:${input.path}:${offset}:${input.limit}`;
    const result=await this.cache.read(key, version, async () => {
      const entries: FileEntry[] = [];
      const directory = await opendir(full); let index = 0, more = false;
      for await (const item of directory) {
        if (item.name.toLowerCase().startsWith('.workbench-transfer-')) continue;
        if (index++ < offset) continue;
        if (entries.length >= input.limit) { more = true; break; }
        const path = input.path ? input.path + '/' + item.name : item.name;
        const info = await fileStat(join(full, item.name)); if (!info) continue;
        entries.push({ name: item.name, path, kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : 'other', size: info.size, modifiedAt: info.mtimeMs, version: fileVersion(info), protected: this.roots.protected(context, path), repository: context.repositories.has(join(full, item.name)) });
      }
      if (fileVersion(await lstat(full)) !== fileVersion(stat)) throw new WorkbenchError('file_listing_changed', 'Directory changed during listing');
      entries.sort((a,b) => Number(b.kind === 'directory')-Number(a.kind === 'directory') || a.name.localeCompare(b.name));
      const page: DirectoryPage = { workspaceId: input.workspaceId, instance: context.instance, path: input.path, version, entries, ...(more ? { cursor: cursorFor(index-1) } : {}) };
      return page;
    }, true, input.fresh, { workspaceId: input.workspaceId, repoPath: context.root });
    if(input.listingProtocol===2){this.order.prepare(orderKey,full,contentVersion,input.workspaceId);return {...result,order:'native',sortState:this.order.state(orderKey,contentVersion)?'ready':'preparing',snapshotId};}
    return result;
  }
  assertIdle(id: string) { this.tasks.assertIdle(id); }
  async close() { this.closed = true; for (const entry of this.changes.values()) clearTimeout(entry.timer); this.changes.clear(); clearInterval(this.timer); for (const value of this.directories.values()) { value.watcher?.close(); clearTimeout(value.timer); } this.directories.clear(); await this.order.close(); await this.tasks.close(); if (this.ownScheduler) this.decorations.status.close(); await this.ownScheduler?.close(); await this.ownSyntax?.close(); }
}
