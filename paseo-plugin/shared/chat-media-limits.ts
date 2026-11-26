export const CHAT_MEDIA_CHUNK_BYTES = 128 * 1024;
export const CHAT_MEDIA_BLOB_LIMIT = 24 * 1024 * 1024;
export type ChatMediaChunk = { offset: number; size: number; revision: string; base64: string; sha256: string };
export type ChatMediaDownload = { url: string; serverId: string; name: string; size: number; revision: string };
