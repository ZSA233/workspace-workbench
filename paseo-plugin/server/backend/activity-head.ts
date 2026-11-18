import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from './storage.ts';

export const activityObjectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const metadataLimit = 16_384;

export type ActivityHead = {
  token: string;
  head: string | null;
  unborn: boolean;
  commonDir: string;
  batchable: boolean;
  files: string[];
};

function missing(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '');
}
async function optionalStat(path: string) {
  try { return await stat(path); }
  catch (error) { if (missing(error)) return null; throw error; }
}
async function smallFile(path: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Git HEAD check cancelled');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > metadataLimit) throw new Error('Invalid Git metadata file');
    const bytes = Buffer.allocUnsafe(metadataLimit + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (signal?.aborted) throw new Error('Git HEAD check cancelled');
    if (bytesRead > metadataLimit) throw new Error('Git metadata file is too large');
    return bytes.toString('utf8', 0, bytesRead).trim();
  } finally { await file.close(); }
}
const fingerprint = (value: Awaited<ReturnType<typeof optionalStat>>) =>
  value && [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs];

/** Probe the exact worktree. Loose refs and detached HEADs need no Git process. */
export async function readActivityHead(root: string, signal?: AbortSignal): Promise<ActivityHead> {
  const dotGit = join(root, '.git');
  const directoryEntry = await lstat(dotGit);
  let directory = dotGit;
  if (directoryEntry.isFile()) {
    const pointer = await smallFile(dotGit, signal);
    if (!pointer?.startsWith('gitdir: ') || !pointer.slice(8).trim()) throw new Error('Invalid Git directory');
    directory = resolve(root, pointer.slice(8).trim());
  } else if (!directoryEntry.isDirectory() && !directoryEntry.isSymbolicLink()) {
    throw new Error('Invalid Git directory');
  }
  directory = await realpath(directory);
  const headPath = join(directory, 'HEAD'), commonPath = join(directory, 'commondir');
  const [head, common] = await Promise.all([smallFile(headPath, signal), smallFile(commonPath, signal)]);
  if (!head) throw new Error('Git HEAD unavailable');
  const commonDir = common ? await realpath(resolve(directory, common)) : directory;
  const files = [dotGit, headPath, commonPath];
  const ref = head.startsWith('ref: ') ? head.slice(5) : '';
  if (ref && (!ref.startsWith('refs/') || ref.split('/').some(part => !part || part === '.' || part === '..') || ref.includes('\\') || ref.includes('\0'))) {
    throw new Error('Invalid Git reference');
  }
  const worktreeRef = /^refs\/(bisect|worktree|rewritten)\//.test(ref);
  const refPath = ref ? join(worktreeRef ? directory : commonDir, ref) : '';
  const value = refPath ? await smallFile(refPath, signal) : head;
  if (refPath) files.push(refPath);
  // Reftable can make even a loose ref an incomplete view of the reference.
  const tablePath = join(commonDir, 'reftable', 'tables.list');
  const table = await optionalStat(tablePath);
  const packedPath = join(commonDir, 'packed-refs');
  const packed = ref && !value ? await optionalStat(packedPath) : null;
  if (ref && !value) files.push(packedPath);
  if (ref) files.push(tablePath);
  const resolved = !table && value && activityObjectId.test(value) ? value : null;
  const worktreeConfig = directory !== commonDir ? await optionalStat(join(directory, 'config.worktree')) : null;
  // Common object storage is shareable for conventional worktrees. Unusual
  // object/ref overrides keep their own Git context.
  const externalView = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_REPLACE_REF_BASE']
    .some(key => Boolean(process.env[key]));
  return {
    token: hash(JSON.stringify([directory, commonDir, directoryEntry.ino, head, value, fingerprint(packed), fingerprint(table)])),
    head: externalView ? null : resolved,
    unborn: !externalView && Boolean(ref && value === null && !packed && !table),
    commonDir,
    batchable: Boolean(resolved && !table && !worktreeRef && !worktreeConfig && !externalView),
    files,
  };
}

export async function activityHeadToken(root: string): Promise<string> {
  return (await readActivityHead(root)).token;
}
