import { constants } from 'node:fs';
import { open, realpath, rm, lstat, opendir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { FILE_CHUNK_BYTES } from '../../shared/files.ts';
import { fileVersion, fileStat } from './file-roots.ts';
import { WorkbenchError } from './storage.ts';

export async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. File data and SQLite
  // receipts are still flushed; replacement ownership is reconciled on restart.
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function verifyTemporaryParent(path: string, expected?: string) {
  const actual = await realpath(dirname(path));
  if (actual !== (expected || dirname(path))) throw new WorkbenchError('file_recovery_required', 'Temporary directory ownership changed; recovery files were preserved');
}
export async function removeTemporary(path: string, parent?: string, inode?: string) {
  const stat = await fileStat(path); if (!stat) return;
  await verifyTemporaryParent(path, parent);
  if (inode && `${stat.dev}:${stat.ino}` !== inode) throw new WorkbenchError('file_recovery_required', 'Unverified recovery content was preserved');
  await rm(path, { recursive: stat.isDirectory(), force: false });
}
/** Metadata-only recursive version; renaming the root does not change its contents. */
export async function directoryVersion(path: string, check: () => void) {
  const digest = createHash('sha256');
  async function visit(full: string, name: string) {
    check(); const stat = await lstat(full);
    digest.update(name + ':' + (name ? fileVersion(stat) : `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}`) + '\n');
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      if (await realpath(full) !== full) throw new WorkbenchError('file_directory_changed', 'Directory ownership changed during verification');
      const directory = await opendir(full);
      for await (const entry of directory) await visit(join(full, entry.name), name ? name+'/'+entry.name : entry.name);
    }
  }
  await visit(path, ''); return digest.digest('hex');
}

/** Cancellable, bounded file I/O, including cross-device copies and browser snapshots. */
export async function copyFileChunks(source: string, target: string, check: () => void) {
  check();
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile()) throw new WorkbenchError('file_not_regular', 'Only regular files can be copied');
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o777);
    try {
      const buffer = Buffer.alloc(FILE_CHUNK_BYTES);
      for (let offset = 0; offset < before.size;) {
        check(); const read = await input.read(buffer, 0, Math.min(buffer.length, before.size-offset), offset);
        if (!read.bytesRead) throw new WorkbenchError('file_source_changed', 'Source ended while copying');
        let written = 0;
        while (written < read.bytesRead) { check(); const result = await output.write(buffer, written, read.bytesRead-written, offset+written); if (!result.bytesWritten) throw new Error('No copy write progress'); written += result.bytesWritten; }
        offset += read.bytesRead;
      }
      check();
      if (fileVersion(before) !== fileVersion(await input.stat())) throw new WorkbenchError('file_source_changed', 'Source changed while copying');
      await output.sync(); await syncDirectory(dirname(target));
    } finally { await output.close(); }
  } finally { await input.close(); }
}
