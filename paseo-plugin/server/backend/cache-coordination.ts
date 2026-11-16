import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Short control transactions live separately from the filesystem-operation
 * lease, so a cleanup can advertise priority while another worker is scanning. */
export class CacheCoordination {
  private db: DatabaseSync;
  static async open(root: string) { await mkdir(root, { recursive: true, mode: 0o700 }); return new CacheCoordination(root); }
  private constructor(root: string) {
    this.db = new DatabaseSync(join(root, 'coordination.sqlite'));
    try { this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS cleanup_intents (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invalidations (revision INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, paths TEXT NOT NULL);`); }
    catch (error) { this.db.close(); throw error; }
  }
  intent(id: string) { this.db.prepare('INSERT OR REPLACE INTO cleanup_intents VALUES (?,?)').run(id, Date.now() + 30_000); }
  release(id: string) { this.db.prepare('DELETE FROM cleanup_intents WHERE id=?').run(id); }
  cleanupPending() { return !!this.db.prepare('SELECT 1 FROM cleanup_intents WHERE expires>? LIMIT 1').get(Date.now()); }
  invalidate(paths: string[]) { this.db.prepare('INSERT INTO invalidations(at,paths) VALUES (?,?)').run(Date.now(), JSON.stringify(paths)); }
  changes(revision: number): { revision: number; at: number; paths: string[] }[] {
    return this.db.prepare('SELECT revision,at,paths FROM invalidations WHERE revision>? ORDER BY revision').all(revision)
      .map(row => ({ revision: Number(row.revision), at: Number(row.at), paths: JSON.parse(String(row.paths)) }));
  }
  close() { this.db.close(); }
}
