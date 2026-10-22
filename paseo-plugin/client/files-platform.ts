import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { FILE_CHUNK_BYTES } from '../shared/files.ts';

// Browser capabilities stay in this adapter; the Workbench also runs in native renderers.
const web = globalThis as any;
export type LocalFile = { name: string; size: number; lastModified: number; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }; webkitRelativePath?: string };
export const checksum = (data: Uint8Array) => bytesToHex(sha256(data));
export function encode(data: Uint8Array): string {
  let binary = ''; for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return web.btoa(binary);
}
export function decode(value: string): Uint8Array { const s = web.atob(value); return Uint8Array.from(s, (c: string) => c.charCodeAt(0)); }
export const newFileId = () => web.crypto?.randomUUID?.() || `f_${Date.now()}_${Math.random().toString(36).slice(2)}`;
export function readPreference(key: string): any { try { return JSON.parse(web.localStorage?.getItem(key) || 'null'); } catch { return null; } }
export function writePreference(key: string, value: unknown) { try { web.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* preferences are disposable */ } }
export function removePreference(key: string) { try { web.localStorage?.removeItem(key); } catch {} }

export function droppedFiles(transfer: any): AsyncGenerator<{ file?: LocalFile; path: string; directory?: boolean }> {
  async function* visit(entry: any, prefix: string): AsyncGenerator<{ file?: LocalFile; path: string; directory?: boolean }> {
    const path = prefix + entry.name;
    if (['.git', '.workspace', '.workspace-workbench'].includes(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.workbench-transfer-')) { yield { path }; return; }
    if (entry.isFile) yield { path, file: await new Promise<LocalFile>((resolve, reject) => entry.file(resolve, reject)) };
    else if (entry.isDirectory) {
      yield { path, directory: true }; const reader = entry.createReader();
      for (;;) { const entries: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!entries.length) break; for (const child of entries) yield* visit(child, path + '/'); }
    }
  }
  // Capture entries synchronously, before the drop event's protected data store closes.
  const entries = Array.from(transfer.items || []).map((item: any) => item.webkitGetAsEntry?.()).filter(Boolean);
  const files = Array.from(transfer.files || []) as LocalFile[];
  return (async function* () {
    if (entries.length) for (const entry of entries) yield* visit(entry, '');
    else for (const file of files) yield { file, path: file.webkitRelativePath || file.name };
  })();
}
export function pickFiles(directory: boolean, onFiles: (files: LocalFile[]) => void) {
  if (!web.document) throw new Error('File selection requires the browser or Pocket');
  const input = web.document.createElement('input'); input.type = 'file'; input.multiple = true;
  if (directory) input.setAttribute('webkitdirectory', '');
  input.style.display = 'none'; web.document.body.appendChild(input);
  input.onchange = () => { onFiles(Array.from(input.files || [])); input.remove(); };
  input.oncancel = () => input.remove(); input.click();
}

/** Each durable chunk is a separate atomic OPFS write. No growing in-memory Blob. */
export class DownloadStaging {
  private directory: any;
  private parent: any;
  private directoryName: string;
  readonly id: string; readonly size: number;
  private constructor(id: string, size: number, directory: any, parent: any, directoryName: string) { this.id = id; this.size = size; this.directory = directory; this.parent = parent; this.directoryName = directoryName; }
  static supported() { return Boolean(web.navigator?.storage?.getDirectory); }
  static async open(scope: string, id: string, size: number) {
    if (!this.supported()) throw new Error('Persistent download storage is unavailable');
    const root = await web.navigator.storage.getDirectory();
    const owner = checksum(new TextEncoder().encode(scope)).slice(0, 24);
    const parent = await root.getDirectoryHandle('workbench-files', { create: true }), directoryName = owner + '-' + id;
    const directory = await parent.getDirectoryHandle(directoryName, { create: true });
    return new DownloadStaging(id, size, directory, parent, directoryName);
  }
  async offset() {
    try {
      const record = JSON.parse(await (await (await this.directory.getFileHandle('progress')).getFile()).text());
      if (record.format !== 1 || record.size !== this.size || !Number.isSafeInteger(record.offset) || record.offset < 0 || record.offset > this.size) return 0;
      // A manifest can only reference closed writes; still verify the final chunk exists.
      if (record.offset) { const i = Math.floor((record.offset - 1) / FILE_CHUNK_BYTES); const chunk = await (await this.directory.getFileHandle(String(i))).getFile(); if (chunk.size !== record.offset - i * FILE_CHUNK_BYTES + 65) return 0; }
      return record.offset as number;
    } catch { return 0; }
  }
  async write(offset: number, bytes: Uint8Array, digest = checksum(bytes)) {
    if (offset % FILE_CHUNK_BYTES || bytes.length !== Math.min(FILE_CHUNK_BYTES, this.size - offset)) throw new Error('Invalid download chunk');
    const output = await (await this.directory.getFileHandle(String(offset / FILE_CHUNK_BYTES), { create: true })).createWritable();
    try { await output.write(new TextEncoder().encode(digest + '\n')); await output.write(bytes); await output.close(); } catch (e) { await output.abort().catch(() => {}); throw e; }
    const progress = await (await this.directory.getFileHandle('progress', { create: true })).createWritable();
    try { await progress.write(JSON.stringify({ format: 1, size: this.size, offset: offset + bytes.length })); await progress.close(); } catch (e) { await progress.abort().catch(() => {}); throw e; }
  }
  async exportTo(output: { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }, check: () => void) {
    try {
      if (await this.offset() !== this.size) throw new Error('Download has not been staged completely');
      for (let offset = 0; offset < this.size; offset += FILE_CHUNK_BYTES) {
        check(); const file = await (await this.directory.getFileHandle(String(offset / FILE_CHUNK_BYTES))).getFile();
        if (file.size !== Math.min(FILE_CHUNK_BYTES, this.size - offset) + 65) throw new Error('A saved download chunk is missing');
        const digest = await file.slice(0, 64).text(), bytes = new Uint8Array(await file.slice(65).arrayBuffer());
        if (!/^[a-f0-9]{64}$/.test(digest) || checksum(bytes) !== digest) { const progress = await (await this.directory.getFileHandle('progress', { create: true })).createWritable(); await progress.write(JSON.stringify({ format: 1, size: this.size, offset: 0 })); await progress.close(); throw new Error('Local staging verification failed; resume the download'); }
        await output.write(bytes);
      }
      check(); await output.close();
    } catch (e) { await output.abort().catch(() => {}); throw e; }
  }
  async clear() { await this.parent.removeEntry(this.directoryName, { recursive: true }).catch((error: any) => { if (error.name !== 'NotFoundError') throw error; }); }
  static async remove(scope: string, id: string) {
    if (!this.supported()) return;
    try { const root = await web.navigator.storage.getDirectory(), parent = await root.getDirectoryHandle('workbench-files'); await parent.removeEntry(checksum(new TextEncoder().encode(scope)).slice(0,24) + '-' + id, { recursive: true }); }
    catch (error: any) { if (error.name !== 'NotFoundError') throw error; }
  }
}

export type SaveWriter = { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> };
export type SaveDestination = { open(): Promise<SaveWriter>; discard(): Promise<void> };
const legacySaveLanes = new WeakMap<object, Promise<void>>();
export function pickSaveDestination(name: string): Promise<SaveDestination> {
  // Called directly by a user gesture; waiting for an RPC first loses activation.
  if (web.WorkbenchFileSave?.open) {
    const bridge=web.WorkbenchFileSave;let release=()=>{};
    let opening:Promise<SaveWriter>;
    if(bridge.capabilities?.multipleDestinations)opening=bridge.open(name);
    else {
      const previous=legacySaveLanes.get(bridge)||Promise.resolve();
      const reservation=new Promise<void>(resolve=>{release=resolve;});
      legacySaveLanes.set(bridge,previous.then(()=>reservation));
      opening=previous.then(()=>bridge.open(name));
    }
    return opening.catch((error:Error)=>{release();if(error.message==='Save cancelled')error.name='AbortError';throw error;}).then((writer:SaveWriter)=>{
      let closed=false;
      const abort=async()=>{if(!closed){try{await writer.abort();}finally{closed=true;release();}}};
      return {open:async()=>({write:(bytes:Uint8Array)=>writer.write(bytes),close:async()=>{await writer.close();closed=true;release();},abort}),discard:abort};
    });
  }
  // Choose the path now, but open its transactional writer only when bytes are ready.
  if (web.showSaveFilePicker) return web.showSaveFilePicker({ suggestedName: name }).then((handle: any) => ({ open: () => handle.createWritable(), discard: async () => {} }));
  return Promise.reject(new Error('Choose a browser with file saving support, or use Pocket'));
}
export function canSave() { return Boolean(web.showSaveFilePicker || web.WorkbenchFileSave?.open); }
export async function delegateDownload(url: string, serverId: string) {
  const parsed = new web.URL(url, web.location?.href);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== web.location?.origin || !parsed.pathname.startsWith('/api/')) throw new Error('Host download URL must use this page’s trusted origin');
  const status = await web.fetch(new web.URL('/api/status', parsed.origin).href, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!status.ok || (await status.json()).serverId !== serverId) throw new Error('This page does not have a verified download connection to the remote host; use Windows file saving or Pocket');
  const link = web.document.createElement('a'); link.href = parsed.href; link.download = ''; link.rel = 'noopener'; web.document.body.appendChild(link); link.click(); link.remove();
}
