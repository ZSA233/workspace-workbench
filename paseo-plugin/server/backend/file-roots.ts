import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { hash, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';

export const fileVersion = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => hash(`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`);
export const fileStat = async (path: string) => lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
export type FileRoot = { workspace: Json; root: string; instance: string; repositories: Set<string> };
const reserved = new Set(['.git', '.workspace', '.workspace-workbench']);
const within = (path: string, root: string) => { const p = relative(root, path); return !isAbsolute(p) && p !== '..' && !p.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
export class FileRoots {
  readonly workspaces: Workspaces;
  constructor(workspaces: Workspaces) { this.workspaces = workspaces; }
  async context(workspaceId: string, instance?: string, write = false): Promise<FileRoot> {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace.state !== 'active') throw new WorkbenchError('workspace_state_invalid', 'Workspace is not active');
    if (write && workspace.kind === 'linked-live') throw new WorkbenchError('files_read_only', 'This aggregate Workspace is read-only');
    const root = await realpath(String(workspace.treePath || workspace.sourceRoot));
    const identity = workspaceInstanceKey(workspace as Json & { id: string }) + ':' + hash(root);
    if (instance && instance !== identity) throw new WorkbenchError('workspace_instance_changed', 'Workspace instance changed; select it again');
    return { workspace, root, instance: identity, repositories: new Set((workspace.repositories || []).map((r: Json) => resolve(r.worktreePath || r.sourcePath))) };
  }
  parts(value: string): string[] {
    if (value.includes('\\') || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw new WorkbenchError('path_invalid', 'Expected a relative path');
    const parts = value ? value.split('/') : [];
    if (parts.some(p => !p || p === '.' || p === '..')) throw new WorkbenchError('path_invalid', 'Invalid path component');
    return parts;
  }
  name(value: string) { if (this.parts(value).length !== 1 || reserved.has(value.toLowerCase()) || value.toLowerCase().startsWith('.workbench-transfer-')) throw new WorkbenchError('path_protected', 'Invalid or protected name'); return value; }
  metadata(context: FileRoot, value: string): boolean {
    const parts = this.parts(value), full = join(context.root, ...parts), config = this.workspaces.config;
    return parts.some(p => reserved.has(p.toLowerCase()) || p.toLowerCase().startsWith('.workbench-transfer-'))
      || [config.configPath, config.socketPath, config.socketPath + '.owner.json'].map(p => resolve(p)).includes(full)
      || [config.stateRoot, config.recordsRoot, config.treesRoot, config.workspaceRoot].some(p => { const internal = resolve(p); return internal !== context.root && within(internal, context.root) && within(full, internal); });
  }
  protected(context: FileRoot, value: string): boolean { return !value || context.repositories.has(join(context.root, ...this.parts(value))) || this.metadata(context, value); }
  async path(context: FileRoot, value: string, options: { mutate?: boolean; parents?: boolean } = {}): Promise<string> {
    const parts = this.parts(value);
    if (options.mutate && this.protected(context, value)) throw new WorkbenchError('path_protected', 'Workspace roots, repositories and internal metadata are protected');
    if (this.metadata(context, value)) throw new WorkbenchError('path_protected', 'Internal metadata is protected');
    let current = context.root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      let stat = await fileStat(current);
      if (!stat && options.parents && i < parts.length - 1) { await mkdir(current).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; }); stat = await lstat(current); }
      if (stat && options.mutate && i === parts.length-1) {
        const actual = await realpath(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
        const config = this.workspaces.config;
        if (context.repositories.has(actual) || [config.configPath, config.socketPath, config.stateRoot, config.recordsRoot, config.treesRoot, config.workspaceRoot].map(path => resolve(path)).includes(actual)) throw new WorkbenchError('path_protected', 'Registered roots and metadata aliases are protected');
      }
      if (stat?.isSymbolicLink() && i < parts.length - 1) throw new WorkbenchError('path_symlink', 'Cannot traverse a symbolic-link directory');
      if (stat && i < parts.length - 1 && !stat.isDirectory()) throw new WorkbenchError('path_invalid', 'Parent is not a directory');
      if (stat && i === parts.length - 1 && stat.isSymbolicLink() && !options.mutate) return current;
    }
    const parent = await realpath(parts.length ? dirname(current) : current);
    if (!within(parent, context.root) || await realpath(context.root) !== context.root) throw new WorkbenchError('path_outside_root', 'Path is outside the Workspace');
    return current;
  }
  async read(context: FileRoot, value: string) {
    const path = await this.path(context, value);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) { await handle.close(); throw new WorkbenchError('file_not_regular', 'Expected a regular file'); }
    return handle;
  }
}
