import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FileTask } from '../../shared/files.ts';
import { WorkbenchError, type Json, hash } from './storage.ts';
export type StoredTask = FileTask & { identity: string; private: Json };
export const terminal = (task: FileTask) => ['complete', 'cancelled', 'delegated'].includes(task.state);
export class FileJournal {
  readonly db: DatabaseSync;
  private lastUpdated = 0;
  readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, 'tasks.sqlite3');
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new WorkbenchError('file_journal_invalid', 'Unverified task journal retained');
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated INTEGER NOT NULL, terminal INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_updated ON tasks(updated); CREATE TABLE IF NOT EXISTS chunks(task TEXT NOT NULL, offset INTEGER NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(task,offset));');
    this.lastUpdated = Number(this.db.prepare('SELECT MAX(updated) AS value FROM tasks').get()?.value || 0);
    for (const row of this.db.prepare('SELECT data FROM tasks WHERE terminal=0').iterate()) {
      const t = JSON.parse(row.data as string) as StoredTask;
      if (['active', 'preparing', 'queued'].includes(t.state)) { t.state = 'interrupted'; t.error = 'Transfer interrupted; resume using the same task'; this.save(t); }
    }
    this.prune();
  }
  get(id: string): StoredTask | undefined { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.data as string) : undefined; }
  require(id: string) { const t = this.get(id); if (!t) throw new WorkbenchError('file_task_missing', 'Transfer task was not found'); return t; }
  save(task: StoredTask) { task.cleanupPending = terminal(task) && task.state !== 'delegated' && Boolean(task.private.stage || task.private.publish); task.updatedAt = this.lastUpdated = Math.max(Date.now(), this.lastUpdated + 1); this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,terminal=excluded.terminal,data=excluded.data').run(task.id, task.workspaceId, task.updatedAt, terminal(task) && !task.cleanupPending ? 1 : 0, JSON.stringify(task)); if (terminal(task)) this.db.prepare('DELETE FROM chunks WHERE task=?').run(task.id); }
  create(task: StoredTask) { const old = this.get(task.id); if (old) { if (old.identity !== task.identity) throw new WorkbenchError('file_request_conflict', 'Task ID was reused with different inputs'); return old; } this.save(task); return task; }
  chunk(id: string, offset: number) { return this.db.prepare('SELECT size,digest FROM chunks WHERE task=? AND offset=?').get(id, offset) as { size: number; digest: string } | undefined; }
  commitChunk(task: StoredTask, offset: number, size: number, digest: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('INSERT OR REPLACE INTO chunks VALUES(?,?,?,?)').run(task.id, offset, size, digest); this.save(task); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  view(task: StoredTask): FileTask { const { identity, private: _private, ...publicTask } = task; return publicTask; }
  list(before = Number.MAX_SAFE_INTEGER, limit = 100, activeOnly = false) { return [...this.db.prepare(`SELECT data FROM tasks WHERE updated<? ${activeOnly ? 'AND terminal=0' : ''} ORDER BY updated DESC,id DESC LIMIT ?`).iterate(before, limit)].map(r => this.view(JSON.parse(r.data as string))); }
  active(workspaceId: string) { return [...this.db.prepare('SELECT data FROM tasks WHERE workspace=? AND terminal=0').iterate(workspaceId)].map(r => JSON.parse(r.data as string) as StoredTask); }
  prune() {
    const ids = [...this.db.prepare('SELECT id FROM tasks WHERE terminal=1 AND (updated<? OR id NOT IN (SELECT id FROM tasks WHERE terminal=1 ORDER BY updated DESC LIMIT 1000))').iterate(Date.now() - 7 * 86400000)].map(r => String(r.id));
    for (const id of ids) { const task = this.require(id); if (existsSync(join(this.root, hash(id) + '.part')) || task.private.publish || task.private.stage) continue; this.db.prepare('DELETE FROM chunks WHERE task=?').run(id); this.db.prepare('DELETE FROM tasks WHERE id=?').run(id); }
  }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
