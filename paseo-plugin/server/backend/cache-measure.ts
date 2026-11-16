import { lstat, opendir } from 'node:fs/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { join, relative, isAbsolute } from 'node:path';
import { WorkbenchError } from './storage.ts';
import type { AccountedUsage } from './cache-accounting.ts';

/** Allocated-byte estimates, bounded async I/O, hardlink de-duplication, no symlink walks. */
export async function measureCachePaths(paths: string[], options: {
  signal: AbortSignal; union?: Set<string>; deadline?: number; yieldToForeground?: () => Promise<void>;
  exclude?: string[];
}): Promise<AccountedUsage> {
  const seen = new Set<string>(), union = options.union || new Set<string>();
  const deadline = options.deadline ?? Date.now() + 120_000;
  let bytes = 0, uniqueBytes = 0, unlinkedBytes = 0, count = 0, missing = 0;
  const links: Record<string, number> = Object.create(null);
  const errors: string[] = [];
  const check = () => {
    if (options.signal.aborted) throw new WorkbenchError('cache_scan_cancelled', 'Cache scan cancelled');
    if (Date.now() >= deadline) throw new WorkbenchError('cache_scan_timeout', 'Directory scan timed out');
  };
  const visit = async (path: string, root = false): Promise<void> => {
    check();
    if (!root && options.exclude?.some(excluded => { const part = relative(excluded, path); return !part || part !== '..' && !part.startsWith('../') && !isAbsolute(part); })) return;
    if (++count % 64 === 0) { await yieldTurn(); await options.yieldToForeground?.(); check(); }
    let info;
    try { info = await lstat(path); }
    catch (error) { if (root && (error as NodeJS.ErrnoException).code === 'ENOENT') { missing++; return; } errors.push(String(error)); return; }
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) return;
    seen.add(key);
    const allocated = Number.isFinite(info.blocks) ? info.blocks * 512 : info.size;
    bytes += allocated;
    const linked = info.isFile() && info.nlink > 1;
    if (linked) links[key] = allocated;
    if (!union.has(key)) { union.add(key); uniqueBytes += allocated; if (!linked) unlinkedBytes += allocated; }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    try {
      const directory = await opendir(path);
      for await (const item of directory) await visit(join(path, item.name));
    } catch (error) {
      if (options.signal.aborted || Date.now() >= deadline) throw error;
      errors.push(String(error));
    }
  };
  try { for (const path of [...new Set(paths)]) await visit(path, true); }
  catch (error) {
    if (options.signal.aborted) throw error;
    errors.push(String(error));
  }
  return { bytes: errors.length && !bytes ? null : bytes, uniqueBytes, accounting: { unlinkedBytes, links }, state: errors.length ? (bytes ? 'partial' : 'failed') : missing === paths.length ? 'missing' : 'ready', observedAt: Date.now(), ...(errors.length ? { error: errors.slice(0, 3).join('; ').slice(0, 600) } : {}) };
}
