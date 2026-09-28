import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hash, WorkbenchError } from './storage.ts';
/** SQLite releases ownership on process death; no stale PID file is trusted. */
export async function withRuntimeInstall<T>(identity: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const root = join(homedir(), '.cache', 'workspace-workbench', 'runtime-locks');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(join(root, `${hash(identity)}.sqlite`));
    const deadline = Date.now() + 300000;
    let locked = false;
    try {
        while (!locked) {
            if (signal?.aborted)
                throw new WorkbenchError('operation_interrupted', 'Preparation cancelled while waiting for installation');
            try {
                db.exec('BEGIN IMMEDIATE');
                locked = true;
            }
            catch (error) {
                if (!String(error).includes('locked') || Date.now() >= deadline)
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        return await work();
    }
    finally {
        if (locked)
            db.exec('ROLLBACK');
        db.close();
    }
}
