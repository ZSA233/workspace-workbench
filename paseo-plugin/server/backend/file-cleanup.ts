import { rm } from 'node:fs/promises';
import { fileStat } from './file-roots.ts';
import type { FileJournal, StoredTask } from './file-journal.ts';
import { removeTemporary } from './file-io.ts';

/** Terminal data only. An interrupted/failed transfer is never an evictable cache. */
export async function cleanFileTasks(journal: FileJournal, part: (id: string) => string, busy: (id: string) => boolean, cleanPublished: (task: StoredTask) => Promise<void>) {
  for (const row of journal.db.prepare("SELECT data FROM tasks WHERE terminal=1 OR json_extract(data,'$.cleanupPending')=1").iterate()) {
    const task = JSON.parse(row.data as string) as StoredTask;
    if (busy(task.id)) continue;
    // A delegated HTTP download has a short-lived token and may still have the file open.
    if (task.state === 'delegated' && Date.now() - (task.private.delegatedAt || task.updatedAt) < 3600000) continue;
    try {
      if (task.private.publish) await cleanPublished(task);
      await rm(part(task.id), { force: false }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
      if (task.private.stage && !task.private.publish) {
        await removeTemporary(task.private.stage, task.private.stageParent, task.private.stageInode);
        delete task.private.stage;
      }
      if (journal.get(task.id)?.updatedAt !== task.updatedAt) continue;
      task.cleanupPending = task.state !== 'delegated' && Boolean(task.private.stage || task.private.publish);
      journal.db.prepare('UPDATE tasks SET data=?,terminal=? WHERE id=?').run(JSON.stringify(task), task.cleanupPending ? 0 : 1, task.id);
    } catch { /* Locked files and failed removals retain their ownership records for retry. */ }
  }
  journal.prune();
  journal.db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(256)');
}
