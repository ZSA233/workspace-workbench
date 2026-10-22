import { z } from 'zod';

export const FILE_CHUNK_BYTES = 512 * 1024;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const path = z.string().max(32768).default('');
const scope = { workspaceId: z.string().min(1), instance: z.string().optional() };
const entry = z.object({ ...scope, path, version: z.string().optional() });
const batchId = z.string().max(128).optional();
const policy = z.enum(['ask', 'replace', 'keep']).default('ask');
export const fileRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), ...scope, path, cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(200) }),
  z.object({ action: z.literal('versions'), ...scope, paths: z.array(z.string()).max(200).default([]) }),
  z.object({ action: z.literal('decorations'), ...scope, paths: z.array(z.string().max(32768)).max(200), force: z.boolean().default(false) }),
  z.object({ action: z.literal('preview'), ...scope, path, offset: z.number().int().nonnegative().default(0) }),
  z.object({ action: z.literal('mkdir'), ...scope, path, name: z.string().min(1), id, existOk: z.boolean().default(false) }),
  z.object({ action: z.literal('mutate'), id, batchId, operation: z.enum(['copy', 'move', 'rename', 'delete']), entries: z.array(entry).min(1).max(200), destination: entry.optional(), name: z.string().optional(), policy, confirm: z.boolean().default(false) }),
  z.object({ action: z.literal('upload'), id, batchId, ...scope, path, name: z.string().min(1), size: z.number().int().nonnegative(), modifiedAt: z.number().nonnegative(), policy }),
  z.object({ action: z.literal('chunk'), id, offset: z.number().int().nonnegative(), data: z.string().max(Math.ceil(FILE_CHUNK_BYTES / 3) * 4), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal('finish'), id }),
  z.object({ action: z.literal('download'), id, batchId, ...scope, paths: z.array(z.string()).min(1).max(200) }),
  z.object({ action: z.literal('read'), id, offset: z.number().int().nonnegative() }),
  z.object({ action: z.literal('verify'), id, offset: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal('ack'), id, offset: z.number().int().nonnegative() }),
  z.object({ action: z.literal('control'), id, command: z.enum(['pause', 'resume', 'cancel', 'skip', 'keep', 'replace', 'retry', 'complete', 'delegated']) }),
  z.object({ action: z.literal('task'), id }),
  z.object({ action: z.literal('delegate'), id }),
  z.object({ action: z.literal('activity'), workspaceId: z.string().min(1) }),
  z.object({ action: z.literal('tasks'), activeOnly: z.boolean().default(false), before: z.number().optional(), limit: z.number().int().min(1).max(200).default(100) }),
]);
export type FileRequest = z.infer<typeof fileRequest>;
export type FileEntry = { name: string; path: string; kind: 'directory' | 'file' | 'link' | 'other'; size: number; modifiedAt: number; version: string; protected: boolean; repository: boolean };
export type DirectoryPage = { workspaceId: string; instance: string; path: string; version: string; entries: FileEntry[]; cursor?: string; refreshing?: boolean };
export type FileTaskState = 'queued' | 'preparing' | 'active' | 'paused' | 'interrupted' | 'conflict' | 'ready_to_save' | 'complete' | 'cancelled' | 'failed' | 'delegated';
export type FileTask = { id: string; batchId?: string; cleanupPending?: boolean; canReplace?: boolean; conflict?: 'exists' | 'changed'; direction: 'upload' | 'download' | 'operation'; operation?: string; workspaceId: string; instance: string; workspaceName: string; path: string; name: string; size: number | null; offset: number; state: FileTaskState; createdAt: number; updatedAt: number; error?: string; sha256?: string; files?: number; processed?: number; excluded?: number; modifiedAt?: number; sourceName?: string; nextOffset?: number };
export type FileResult = import('./file-decorations.ts').FileDecorations | DirectoryPage | FileTask | { tasks: FileTask[]; next?: number; temporaryBytes: number } | { versions: Record<string, string>; instance: string } | { data: string; offset: number; size: number; sha256: string; version?: string };
