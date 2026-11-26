import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { CHAT_MEDIA_CHUNK_BYTES } from '../../shared/chat-media-limits.ts';

export type PromptMedia = { type: string; data?: string; mimeType?: string; id?: string; fileName?: string; path?: string; size?: number };
type Image = { assetId: string; name: string; mimeType: string; size: number };
type File = Image & { uploadId?: string; uploadName?: string; modifiedAt?: number };
export type ChatMediaReceipt = { schemaVersion: 1; id: string; agentId: string; messageId: string; createdAt: number; images: Image[]; files: File[] };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const IMAGE_LIMIT = 8 * 1024 * 1024, TOTAL_LIMIT = 24 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
export const chatMediaReceiptId = (agentId: string, messageId: string) => hash(JSON.stringify([agentId, messageId]));
const home = () => resolve(process.env.PASEO_HOME || join(homedir(), '.paseo'));
export const chatMediaRoot = () => join(home(), 'workspace-workbench', 'chat-media');
const receiptFile = (id: string) => { if (!validHash(id)) throw Error('chat_media_invalid_id'); return join(chatMediaRoot(), 'receipts', id + '.json'); };
const ownerFile = (id: string) => join(chatMediaRoot(), 'owners', id + '.json');
const imageFile = (id: string) => { if (!validHash(id)) throw Error('chat_media_invalid_id'); return join(chatMediaRoot(), 'images', id); };
const safeName = (name: string) => name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || '附件';

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const base = await realpath(home()), actual = await realpath(path);
  if (actual !== join(base, 'workspace-workbench', 'chat-media') && !actual.startsWith(join(base, 'workspace-workbench', 'chat-media') + sep)) throw Error('chat_media_invalid_storage');
  if ((await lstat(path)).isSymbolicLink()) throw Error('chat_media_invalid_storage');
}
async function privateRead(path: string, limit: number) {
  const parent = await realpath(dirname(path)), base = join(await realpath(home()), 'workspace-workbench', 'chat-media');
  if (parent !== base && !parent.startsWith(base + sep)) throw Error('chat_media_invalid_storage');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw Error('chat_media_invalid_storage');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export async function nativeChatMediaDisplayed(id: string) {
  if (!validHash(id)) throw Error('chat_media_invalid_id');
  try { return (await privateRead(join(chatMediaRoot(), 'displayed', id), 128)).toString() === id; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function markNativeChatMediaDisplayed(id: string) {
  if (!validHash(id)) throw Error('chat_media_invalid_id');
  await install(join(chatMediaRoot(), 'displayed', id), id);
}
export async function recordNativeChatMediaRuntime(version: string, sourceHash: string) {
  const id = process.pid + '-' + randomUUID();
  await install(join(chatMediaRoot(), 'runtime', id + '.json'), JSON.stringify({ version: 1, pid: process.pid, createdAt: Date.now(), hostVersion: version, sourceHash }));
}
async function install(path: string, bytes: string | Uint8Array) {
  await directory(dirname(path));
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try { await link(temporary, path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; return false; }
  finally { await unlink(temporary); }
}

/** Reserve Workbench's existing frozen-media owner before native dispatch. */
export async function reserveTopicChatMedia(agentId: string, messageId: string) {
  const value = JSON.stringify({ kind: 'topic', agentId, messageId });
  const file = ownerFile(chatMediaReceiptId(agentId, messageId));
  if (!await install(file, value) && (await privateRead(file, 4096)).toString() !== value) throw Error('chat_media_owner_changed');
}
async function topicOwned(agentId: string, messageId: string) {
  try {
    const value = JSON.parse((await privateRead(ownerFile(chatMediaReceiptId(agentId, messageId)), 4096)).toString());
    return value.kind === 'topic' && value.agentId === agentId && value.messageId === messageId;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Called only after the native host records an accepted prompt. Never sends. */
export async function captureChatMedia(agentId: string, messageId: string, prompt: readonly PromptMedia[]): Promise<ChatMediaReceipt | undefined> {
  if (await topicOwned(agentId, messageId)) return;
  const media = prompt.filter(item => item.type === 'image' || item.type === 'uploaded_file');
  if (!media.length) return;
  if (media.length > 20) throw Error('chat_media_limit');
  const receipt: ChatMediaReceipt = { schemaVersion: 1, id: chatMediaReceiptId(agentId, messageId), agentId, messageId, createdAt: Date.now(), images: [], files: [] };
  let size = 0;
  const seen = new Set<string>();
  for (const item of media) {
    const mimeType = (item.mimeType || 'application/octet-stream').toLowerCase();
    if (item.type === 'image') {
      if (!imageTypes.has(mimeType) || !item.data || item.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data) || item.data.length % 4) throw Error('chat_media_invalid_image');
      const bytes = Buffer.from(item.data, 'base64'); size += bytes.length;
      if (!bytes.length || bytes.length > IMAGE_LIMIT || size > TOTAL_LIMIT) throw Error('chat_media_limit');
      const assetId = hash(bytes);
      if (seen.has(assetId)) continue; seen.add(assetId);
      await install(imageFile(assetId), bytes);
      receipt.images.push({ assetId, name: '图片 ' + (receipt.images.length + 1), mimeType, size: bytes.length });
    } else {
      const name = safeName(item.fileName || '附件'), assetId = hash(JSON.stringify([item.id, item.path, item.size]));
      if (seen.has(assetId)) continue; seen.add(assetId);
      const file: File = { assetId, name, mimeType, size: Number.isSafeInteger(item.size) && item.size! >= 0 ? item.size! : 0 };
      // Native uploads are durable. Never dereference an arbitrary prompt path.
      if (item.id && /^upload_[a-f0-9-]{36}$/.test(item.id) && item.path && item.fileName === name) {
        const path = join(home(), 'uploads', item.id, name);
        try {
          const stat = await lstat(path);
          if (resolve(item.path) === path && await realpath(path) === join(await realpath(home()), 'uploads', item.id, name)
            && stat.isFile() && !stat.isSymbolicLink() && stat.size === file.size) Object.assign(file, { uploadId: item.id, uploadName: name, modifiedAt: stat.mtimeMs });
        } catch {}
      }
      receipt.files.push(file);
    }
  }
  await install(receiptFile(receipt.id), JSON.stringify(receipt));
  const saved = await readChatMediaReceipt(agentId, messageId, receipt.id);
  if (JSON.stringify(saved.images) !== JSON.stringify(receipt.images) || JSON.stringify(saved.files) !== JSON.stringify(receipt.files)) throw Error('chat_media_receipt_changed');
  return saved;
}

export async function readChatMediaReceipt(agentId: string, messageId: string, id: string): Promise<ChatMediaReceipt> {
  if (id !== chatMediaReceiptId(agentId, messageId)) throw Error('chat_media_outside_session');
  const value = JSON.parse((await privateRead(receiptFile(id), 128 * 1024)).toString()) as ChatMediaReceipt;
  if (value.schemaVersion !== 1 || value.id !== id || value.agentId !== agentId || value.messageId !== messageId
    || !Array.isArray(value.images) || !Array.isArray(value.files) || value.images.length + value.files.length > 20) throw Error('chat_media_outside_session');
  return value;
}
export async function readChatMediaImage(receipt: ChatMediaReceipt, assetId: string) {
  const image = receipt.images.find(item => item.assetId === assetId);
  if (!image) throw Error('chat_media_outside_selection');
  const bytes = await privateRead(imageFile(assetId), IMAGE_LIMIT);
  if (hash(bytes) !== assetId || bytes.length !== image.size) throw Error('chat_media_image_changed');
  return { mimeType: image.mimeType, base64: bytes.toString('base64') };
}
export async function chatMediaDownloadPath(receipt: ChatMediaReceipt, assetId: string) {
  const file = receipt.files.find(item => item.assetId === assetId);
  if (!file?.uploadId || !file.uploadName || !/^upload_[a-f0-9-]{36}$/.test(file.uploadId) || safeName(file.uploadName) !== file.uploadName) throw Error('chat_media_file_unavailable');
  const path = join(home(), 'uploads', file.uploadId, file.uploadName), stat = await lstat(path);
  if (await realpath(path) !== join(await realpath(home()), 'uploads', file.uploadId, file.uploadName)
    || !stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size || stat.mtimeMs !== file.modifiedAt) throw Error('chat_media_file_changed');
  return { path, file };
}

const fileRevision = (stat: {dev:number;ino:number;size:number;mtimeMs:number}) => hash(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs]));
export async function describeChatMediaFile(path: string, size: number) {
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==size)throw Error('chat_media_file_changed');
  return {path,size,revision:fileRevision(stat)};
}
/** Only fixed, selected native-upload or registered-artifact paths reach here. */
export async function readChatMediaFileChunk(file: {path:string;size:number;revision:string}, offset:number, revision?:string) {
  if(revision!==file.revision||!Number.isSafeInteger(offset)||offset<0||offset>file.size||offset%CHAT_MEDIA_CHUNK_BYTES)throw Error('chat_media_file_changed');
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    if(fileRevision(await handle.stat())!==revision)throw Error('chat_media_file_changed');
    const bytes=Buffer.alloc(Math.min(CHAT_MEDIA_CHUNK_BYTES,file.size-offset));
    let read=0;
    while(read<bytes.length){const value=await handle.read(bytes,read,bytes.length-read,offset+read);if(!value.bytesRead)throw Error('chat_media_file_changed');read+=value.bytesRead;}
    if(fileRevision(await handle.stat())!==revision)throw Error('chat_media_file_changed');
    return {offset,size:file.size,revision,base64:bytes.toString('base64'),sha256:hash(bytes)};
  }finally{await handle.close();}
}
