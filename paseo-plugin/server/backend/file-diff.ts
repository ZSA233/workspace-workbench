import { isAbsolute, join, dirname } from 'node:path';
import { lstat, readlink } from 'node:fs/promises';
import { inside, WorkbenchError } from './storage.ts';
import type { Git } from './git.ts';

type Name = { status: string; path: string; oldPath?: string };
export function diffNames(raw: string): Name[] {
  const parts = raw.split('\0'), names: Name[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++]; if (!status) continue;
    const first = parts[i++];
    names.push(/^[RC]/.test(status) ? { status, oldPath: first, path: parts[i++] } : { status, path: first });
  }
  return names;
}
export function validateDiffPath(path: string) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split(/[\\/]/).includes('..'))
    throw new WorkbenchError('path_invalid', 'Diff path must be a relative repository path');
}
function utf8Prefix(data: Buffer) {
  let end = data.length;
  while (end > 0 && (data[end - 1] & 0xc0) === 0x80) end--;
  if (end < data.length || end > 0 && data[end - 1] >= 0xc0) {
    const start = end > 0 ? end - 1 : 0;
    const lead = data[start], width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (start + width > data.length) return data.subarray(0, start).toString('utf8');
  }
  return data.toString('utf8');
}

/** File content never depends on whole-repository numstat or untracked reads. */
export async function readSingleDiff(git: Git, scope: string, path: string, base?: string | null, commit?: string | null, options: { oldPath?: string | null; maxBytes?: number } = {}) {
  validateDiffPath(path);
  if (options.oldPath) validateDiffPath(options.oldPath);
  const target = join(git.path, path);
  // Validate the resolved parent, including deleted files; never follow a link target.
  if (!inside(dirname(target), git.path, true)) throw new WorkbenchError('path_invalid', 'Diff path escapes repository');
  const maxBytes = options.maxBytes || 262144;
  const head = scope === 'working' ? await git.head() : null;
  let untracked = false;
  if (scope === 'working') {
    const raw = await git.text(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path]);
    untracked = raw.split('\0').some(entry => entry.startsWith('?? ')) || !head && raw.length > 0;
  }
  const range = scope === 'working' && !head
    ? { args: ['diff'], left: null, right: null }
    : await git.range(scope, base, commit);
  // Freeze the comparison base once; a concurrent checkout must not relabel
  // a patch with a later HEAD while the commands are running.
  if (scope === 'working' && head) range.args = ['diff', head];
  let oldPath = options.oldPath || undefined;
  if (!untracked) {
    const names = diffNames(await git.text([...range.args, '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', '--', ...(oldPath ? [oldPath] : []), path]));
    let file = names.find(item => item.path === path);
    if (!file) throw new WorkbenchError('file_not_changed', 'File is not in the selected changes');
    // A path-filtered addition can be the destination of a rename. A names-only
    // fallback is allowed, but never statistics or content of other files.
    if (file.status.startsWith('A') && !oldPath) {
      file = diffNames(await git.text([...range.args, '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames'])).find(item => item.path === path) || file;
    }
    oldPath = file.oldPath;
    if (oldPath) validateDiffPath(oldPath);
  }
  if (untracked) {
    const stat = await lstat(target).catch(() => null);
    if (!stat || !stat.isFile() && !stat.isSymbolicLink()) throw new WorkbenchError('file_not_changed', 'File is no longer available');
    if (stat.isSymbolicLink()) {
      const value = await readlink(target);
      const quote = (name: string) => /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
      const lines = value.endsWith('\n') ? value.slice(0, -1).split('\n') : value.split('\n');
      const patch = `diff --git ${quote(`a/${path}`)} ${quote(`b/${path}`)}\nnew file mode 120000\n--- /dev/null\n+++ ${quote(`b/${path}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join('')}${value.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
      const bytes = Buffer.from(patch);
      return { patch: utf8Prefix(bytes.subarray(0, maxBytes)), left: null, right: null, head, truncated: bytes.length > maxBytes, bytes: bytes.length };
    }
  }
  const args = untracked
    ? ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--unified=80', '--', '/dev/null', path]
    : [...range.args, '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=80', '--', ...(oldPath ? [oldPath] : []), path];
  const result = await git.run(args, false, { maxBytes, truncate: true });
  if (result.code !== 0 && !(untracked && result.code === 1)) throw new WorkbenchError('git_diff_failed', result.stderr);
  return { patch: result.truncated ? utf8Prefix(Buffer.from(result.stdout)) : result.stdout, left: untracked ? null : range.left, right: range.right, head: scope === 'working' ? head : range.right, truncated: result.truncated, bytes: result.bytes };
}
