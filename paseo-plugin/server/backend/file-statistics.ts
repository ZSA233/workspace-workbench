import { gitQueue } from './git-scheduler.ts';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setImmediate as yieldTurn, setTimeout as pause } from 'node:timers/promises';
import { inside, WorkbenchError } from './storage.ts';
export type FileStatisticsResult = { additions: number | null; binary: boolean | null; statisticsState: 'ready' | 'deferred' | 'unavailable'; bytes: number };
const deferred = (): FileStatisticsResult => ({ additions: null, binary: null, statisticsState: 'deferred', bytes: 0 });
let active = 0;
const waiting: { start(): void; cancel(): void }[] = [];
async function fileSlot<T>(work: () => Promise<T>, signal?: AbortSignal, deadline = Date.now() + 30_000): Promise<T> {
  if (signal?.aborted) throw new WorkbenchError('observer_cancelled', 'File statistics cancelled');
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    if (waiting.length >= 128) { reject(new WorkbenchError('observer_busy', 'File statistics queue is full')); return; }
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', item.cancel); };
    const item = { start: () => { cleanup(); resolve(); }, cancel: () => {
      const index = waiting.indexOf(item); if (index < 0) return;
      waiting.splice(index, 1); cleanup(); reject(new WorkbenchError('observer_cancelled', 'File statistics cancelled'));
    } };
    const timer = setTimeout(item.cancel, Math.max(0, deadline - Date.now()));
    waiting.push(item); signal?.addEventListener('abort', item.cancel, { once: true });
  });
  else active++;
  try { return await work(); } finally { const next = waiting.shift(); if (next) next.start(); else active--; }
}
export async function countFile(path: string, root: string, maxBytes = 1048576, signal?: AbortSignal, deadline = Date.now() + 30_000): Promise<FileStatisticsResult> {
  return fileSlot(async () => {
    const check = () => {
      if (signal?.aborted) throw new WorkbenchError('observer_cancelled', 'File statistics cancelled', { stage: 'statistics' });
      if (Date.now() >= deadline) throw new WorkbenchError('observation_timeout', 'File statistics deadline exceeded', { stage: 'statistics' });
    };
    check();
    if (!inside(dirname(path), root, true)) return { ...deferred(), statisticsState: 'unavailable' };
    const stat = await lstat(path).catch(() => null);
    if (!stat) return { ...deferred(), statisticsState: 'unavailable' };
    if (stat.isSymbolicLink()) {
      const value = await readlink(path);
      return { additions: value ? value.split('\n').length - (value.endsWith('\n') ? 1 : 0) : 0, binary: false, statisticsState: 'ready', bytes: Buffer.byteLength(value) };
    }
    if (!stat.isFile()) return { ...deferred(), statisticsState: 'unavailable' };
    if (stat.size > maxBytes) return deferred();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes = 0, lines = 0, last = -1;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        check();
        // Statistics yield their I/O window while an interactive Git read runs.
        while (gitQueue.health().byIntent.interactive > 0) { await pause(10); check(); }
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1));
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > maxBytes) return { ...deferred(), bytes };
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) return { additions: null, binary: true, statisticsState: 'ready', bytes };
        try { decoder.decode(chunk, { stream: true }); } catch { return { additions: null, binary: true, statisticsState: 'ready', bytes }; }
        for (const char of chunk) if (char === 10) lines++;
        last = chunk[chunk.length - 1];
        await yieldTurn();
      }
      try { decoder.decode(); } catch { return { additions: null, binary: true, statisticsState: 'ready', bytes }; }
      const end = await file.stat();
      if (end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ino !== stat.ino) return { ...deferred(), bytes };
      return { additions: lines + (last >= 0 && last !== 10 ? 1 : 0), binary: false, statisticsState: 'ready', bytes };
    } finally { await file.close(); }
  }, signal, deadline);
}

/** Bounded per-project continuations. Content is never retained here. */
export class FileStatistics {
  private cache = new Map<string, FileStatisticsResult>();
  private tasks = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private closed = false;
  bytes = 0;
  async read(path: string, root: string, budget: number, signal?: AbortSignal, complete?: () => void, deadline?: number): Promise<FileStatisticsResult> {
    const stat = await lstat(path).catch(() => null);
    if (!stat) return { ...deferred(), statisticsState: 'unavailable' };
    const key = `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.cache.get(key);
    if (cached) return { ...cached, bytes: 0 };
    if (!budget) { this.schedule(key, path, root, complete); return deferred(); }
    const result = await countFile(path, root, Math.min(1048576, budget), signal, deadline);
    this.bytes += result.bytes;
    if (result.statisticsState === 'ready') this.save(key, result);
    else if (result.statisticsState === 'deferred') this.schedule(key, path, root, complete);
    return result;
  }
  private save(key: string, result: FileStatisticsResult) {
    this.cache.set(key, result);
    while (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
  }
  private schedule(key: string, path: string, root: string, complete?: () => void) {
    if (this.closed || this.tasks.has(key) || this.tasks.size >= 32) return;
    const abort = new AbortController();
    const promise = (async () => {
      await yieldTurn();
      try {
        const result = await countFile(path, root, Number.MAX_SAFE_INTEGER, abort.signal, Date.now() + 30_000);
        this.bytes += result.bytes;
        if (!this.closed && result.statisticsState === 'ready') { this.save(key, result); complete?.(); }
      } catch { /* observation can retry a deferred statistic later */ }
    })().finally(() => this.tasks.delete(key));
    this.tasks.set(key, { abort, promise });
  }
  health() { return { bytes: this.bytes, active: this.tasks.size, entries: this.cache.size }; }
  async close() { this.closed = true; for (const task of this.tasks.values()) task.abort.abort(); await Promise.allSettled([...this.tasks.values()].map(t => t.promise)); this.cache.clear(); }
}
