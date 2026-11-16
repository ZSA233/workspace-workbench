import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { WorkbenchError } from './storage.ts';

export function cacheHostRoot() {
  return join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'workspace-workbench', 'cache-management');
}
/** One measurement cohort per host; cleanup cannot race a scan/cleanup.
 * The database transaction is released by the OS even after a worker crashes. */
export async function withCacheLease<T>(root: string, signal: AbortSignal, work: () => Promise<T>, beforeAcquire?: () => void): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(root, 'operations.sqlite'));
  let locked = false;
  try {
    while (!locked) {
      if (signal.aborted) throw new WorkbenchError('cache_task_cancelled', 'Cache task cancelled while queued');
      beforeAcquire?.();
      try { db.exec('BEGIN IMMEDIATE'); locked = true; }
      catch (error) { if (!String(error).includes('locked')) throw error; await pause(100); }
    }
    if (signal.aborted) throw new WorkbenchError('cache_task_cancelled', 'Cache task cancelled');
    return await work();
  } finally { if (locked) db.exec('ROLLBACK'); db.close(); }
}
