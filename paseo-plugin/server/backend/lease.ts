import { existsSync, lstatSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkbenchError } from "./storage.ts";

/** Kernel-backed project lease. SQLite releases it on process death, without
 * PID guessing, stale-file deletion races, a native addon, or Python. */
export function acquireProjectLease(recordsRoot: string): () => void {
  const path = join(recordsRoot, ".backend-lock.sqlite3");
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw new WorkbenchError(
      "observer_busy",
      "unverified project lease path; retained",
    );
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    throw new WorkbenchError(
      "observer_busy",
      "another process owns this project's records, or the lease is unavailable",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  };
}
