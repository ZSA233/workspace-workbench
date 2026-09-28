import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkbenchError, type Json } from './storage.ts';
type Version = {
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    isFile?: () => boolean;
};
type Io = {
    names(path: string): Promise<string[]>;
    version(path: string): Promise<Version>;
    read(path: string): Promise<string>;
};
const disk: Io = { names: readdir, version: stat, read: path => readFile(path, 'utf8') };
const fingerprint = (v: Version) => [v.dev, v.ino, v.size, v.mtimeMs, v.ctimeMs].join(':');
/** Read-only record content cache. Workspaces still validates every returned record. */
export class RecordCatalog {
    private cache = new Map<string, {
        version: string;
        value: Json | null;
        bytes: number;
    }>();
    private bytes = 0;
    private io: Io;
    private counters = { reads: 0, hits: 0, bytes: 0, active: 0, peak: 0, directoryMs: 0, versionMs: 0, readMs: 0, maxReadMs: 0 };
    constructor(io: Io = disk) { this.io = io; }
    private remove(path: string) {
        const old = this.cache.get(path);
        if (old) {
            this.bytes -= old.bytes;
            this.cache.delete(path);
        }
    }
    private async version(path: string) {
        const start = performance.now();
        try { return await this.io.version(path); }
        finally { this.counters.versionMs += performance.now() - start; }
    }
    async read(directory: string): Promise<Array<{
        path: string;
        value: Json | null;
    }>> {
        const start = performance.now();
        const names = await this.io.names(directory);
        this.counters.directoryMs += performance.now() - start;
        const paths = names.filter(name => name.endsWith('.json')).sort().map(name => join(directory, name));
        const present = new Set(paths);
        for (const path of this.cache.keys())
            if (!present.has(path))
                this.remove(path);
        const results: Array<{
            path: string;
            value: Json | null;
        } | undefined> = new Array(paths.length);
        let next = 0;
        const completed = await Promise.allSettled(Array.from({ length: Math.min(4, paths.length) }, async () => {
            while (next < paths.length) {
                const index = next++, path = paths[index];
                this.counters.active++;
                this.counters.peak = Math.max(this.counters.peak, this.counters.active);
                try {
                    const before = await this.version(path), key = fingerprint(before), cached = this.cache.get(path);
                    if (before.isFile && !before.isFile()) {
                        this.remove(path);
                        results[index] = {path, value: null};
                        continue;
                    }
                    if (cached?.version === key) {
                        this.counters.hits++;
                        results[index] = { path, value: cached.value };
                        continue;
                    }
                    this.counters.reads++;
                    const readStart = performance.now();
                    let text: string;
                    try {
                        text = await this.io.read(path);
                    }
                    finally {
                        const duration = performance.now() - readStart;
                        this.counters.readMs += duration;
                        this.counters.maxReadMs = Math.max(this.counters.maxReadMs, duration);
                    }
                    const bytes = Buffer.byteLength(text);
                    this.counters.bytes += bytes;
                    const after = await this.version(path);
                    // Never label a concurrent write with the newer file's identity.
                    if (key !== fingerprint(after))
                        throw new WorkbenchError('observer_records_changed', 'Workspace records changed during reading; retry');
                    let value: Json | null = null;
                    try {
                        const parsed = JSON.parse(text);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                            value = parsed;
                    }
                    catch { /* Invalid JSON remains an explicit invalid record. */ }
                    results[index] = { path, value };
                    this.remove(path);
                    if (bytes <= 16 * 1024 * 1024) {
                        this.cache.set(path, { version: key, value, bytes });
                        this.bytes += bytes;
                        while (this.cache.size > 500 || this.bytes > 16 * 1024 * 1024)
                            this.remove(this.cache.keys().next().value!);
                    }
                }
                catch (error) {
                    this.remove(path);
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                finally {
                    this.counters.active--;
                }
            }
        }));
        const failure = completed.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected')
            throw failure.reason;
        return results.filter((value): value is {
            path: string;
            value: Json | null;
        } => !!value);
    }
    health() { return { ...this.counters, entries: this.cache.size, retainedBytes: this.bytes }; }
}
