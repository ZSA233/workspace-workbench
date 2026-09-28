import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Durable records: errors propagate before callers dispatch a side effect. */
export async function writeOperation(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(value));
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dirname(path), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await unlink(temporary).catch(() => { });
    }
}
