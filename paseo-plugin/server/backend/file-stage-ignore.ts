import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { Git, withBackgroundGit } from './git.ts';
import { canonicalAsync, WorkbenchError } from './storage.ts';
import { type FileRoot, type FileRoots } from './file-roots.ts';
import type { StoredTask } from './file-journal.ts';
import { syncDirectory } from './file-io.ts';

/** Staging is private metadata, including while paused. Keep it out of Git's index. */
export class FileStageIgnore {
  private prepared = new Map<string, Promise<void>>();
  async prepare(roots: FileRoots, context: FileRoot, target: string, task: StoredTask, persist: () => void) {
    const repository = [...context.repositories].filter(path => { const value = relative(path, target); return value && value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); }).sort((a,b)=>b.length-a.length)[0];
    if (!repository) return;
    const root = await lstat(repository);
    const key = repository + ':' + root.dev + ':' + root.ino + ':' + context.instance;
    let flight = this.prepared.get(key);
    if (!flight) {
      flight = withBackgroundGit(async () => {
        const git = new Git(repository, Math.min(3000, roots.workspaces.config.gitTimeout));
        const common = await canonicalAsync(resolve(repository, await git.text(['rev-parse', '--git-common-dir']))), info = join(common, 'info');
        await mkdir(info, { recursive: true });
        if ((await lstat(info)).isSymbolicLink()) throw new WorkbenchError('path_symlink', 'Git ignore metadata is a symbolic link');
        const path = join(info, 'exclude'), pattern = '.workbench-transfer-*';
        task.private.stageIgnore = { path, pattern }; persist();
        const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        try {
          const buffer = Buffer.alloc(64*1024); let offset = 0, tail = '\n', present = false;
          for (;;) { const read = await file.read(buffer, 0, buffer.length, offset); if (!read.bytesRead) break; const text = tail + buffer.subarray(0,read.bytesRead).toString('utf8'); if (text.includes('\n'+pattern+'\n') || text.includes('\n'+pattern+'\r\n')) { present = true; break; } tail = text.slice(-128); offset += read.bytesRead; }
          if (!present) { await file.appendFile(`\n# Workspace Workbench transfer staging\n${pattern}\n`); await file.sync(); await syncDirectory(dirname(path)); }
        } finally { await file.close(); }
      }).catch(error => { this.prepared.delete(key); throw error; });
      this.prepared.set(key, flight);
      if (this.prepared.size > 256) this.prepared.delete(this.prepared.keys().next().value!);
    }
    await flight;
  }
}
