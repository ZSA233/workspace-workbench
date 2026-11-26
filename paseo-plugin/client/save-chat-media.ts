import type { ChatMediaFile } from '../shared/chat-media.ts';
import { CHAT_MEDIA_BLOB_LIMIT, CHAT_MEDIA_CHUNK_BYTES, type ChatMediaChunk, type ChatMediaDownload } from '../shared/chat-media-limits.ts';
import { canSave, checksum, decode, pickSaveDestination, type SaveDestination, type SaveWriter } from './files-platform.ts';
import { tryAccessDownload } from './access-download.ts';

/** Start the native/browser picker inside the click, before any RPC loses activation. */
export async function saveChatMediaFile(file: ChatMediaFile, metadata: () => Promise<ChatMediaDownload>, read: (offset: number, revision: string) => Promise<ChatMediaChunk>) {
  const web = globalThis as any;
  let destination: SaveDestination | undefined, writer: SaveWriter | undefined;
  try {
    if (canSave()) destination = await pickSaveDestination(file.name);
    const selected = await metadata();
    if (!file.available || selected.name !== file.name || selected.size !== file.size || !Number.isSafeInteger(selected.size)
      || selected.size < 0 || !/^[a-f0-9]{64}$/.test(selected.revision)) throw Error('附件已改变，请重新打开后保存');

    // Access owns its fixed same-origin HTTP handoff. A failed/uncertain handoff
    // must not fall through to another downloader and create a second save.
    if (!destination) {
      if (await tryAccessDownload(selected.url, selected.serverId, file.name)) return;
      if (/\bAccessPocket\//.test(web.navigator?.userAgent || '')) throw Error('请从工作台入口重新打开后保存附件');
      if (!web.document || selected.size > CHAT_MEDIA_BLOB_LIMIT) throw Error('请使用支持文件保存的浏览器或 Pocket 保存此附件');
    }
    writer = destination ? await destination.open() : undefined;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < selected.size; offset += CHAT_MEDIA_CHUNK_BYTES) {
      const chunk = await read(offset, selected.revision), bytes = decode(chunk.base64);
      if (chunk.offset !== offset || chunk.size !== selected.size || chunk.revision !== selected.revision
        || bytes.length !== Math.min(CHAT_MEDIA_CHUNK_BYTES, selected.size - offset) || checksum(bytes) !== chunk.sha256) throw Error('附件校验失败，请重试');
      if (writer) await writer.write(bytes); else parts.push(new Uint8Array(bytes));
    }
    if (writer) { await writer.close(); writer = undefined; destination = undefined; return; }
    // Authenticated RPC reads also work when a client is connected to a remote
    // host whose HTTP origin differs from this page. Never navigate its token.
    const url = web.URL.createObjectURL(new web.Blob(parts, { type: file.mimeType || 'application/octet-stream' }));
    try {
      const link = web.document.createElement('a'); link.href = url; link.download = file.name; link.rel = 'noopener';
      web.document.body.appendChild(link); link.click(); link.remove();
    } finally { web.setTimeout(() => web.URL.revokeObjectURL(url), 1000); }
  } catch (error) {
    await writer?.abort().catch(() => {});
    await destination?.discard().catch(() => {});
    if ((error as Error).name !== 'AbortError') throw error;
  }
}
