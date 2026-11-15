import { lstat, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from './storage.ts';

/** Cheap validation for both ordinary repositories and linked worktrees. No Git process. */
export async function activityHeadToken(root: string): Promise<string> {
  const small = async (path: string) => {
    try { if ((await stat(path)).size > 16_384) return ''; return await readFile(path, 'utf8'); }
    catch { return ''; }
  };
  let directory = join(root, '.git');
  if ((await lstat(directory)).isFile()) {
    const file = await small(directory);
    if (!file.startsWith('gitdir:')) throw new Error('Invalid Git directory');
    directory = resolve(root, file.slice(7).trim());
  }
  const common = (await small(join(directory, 'commondir'))).trim();
  const commonDirectory = common ? resolve(directory, common) : directory;
  const head = (await small(join(directory, 'HEAD'))).trim();
  if (!head) throw new Error('Git HEAD unavailable');
  const ref = head.startsWith('ref: ') ? head.slice(5) : '';
  if (ref && (!ref.startsWith('refs/') || ref.split('/').includes('..'))) throw new Error('Invalid Git reference');
  const packed = await stat(join(commonDirectory, 'packed-refs')).catch(() => null);
  return hash(JSON.stringify([directory, head, ref ? await small(join(directory, ref)) : '',
    ref ? await small(join(commonDirectory, ref)) : '', packed && [packed.ino, packed.size, packed.mtimeMs, packed.ctimeMs],
    await small(join(commonDirectory, 'reftable', 'tables.list'))]));
}
