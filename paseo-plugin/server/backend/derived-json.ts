import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Derived caches do not use the synchronous durable-mutation journal writer. */
export async function writeDerivedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** At most one disk write and one replacement snapshot; slow disks cannot grow a queue. */
export class DerivedJsonWriter {
  private next: unknown;
  private pending = false;
  private flight?: Promise<void>;
  private path: string;
  private write: typeof writeDerivedJson;
  constructor(path: string, write = writeDerivedJson) { this.path = path; this.write = write; }
  save(value: unknown): void {
    this.next = value; this.pending = true;
    if (this.flight) return;
    this.flight = this.drain().finally(() => { this.flight = undefined; if (this.pending) this.save(this.next); });
  }
  private async drain() {
    while (this.pending) {
      const value = this.next; this.next = undefined; this.pending = false;
      try { await this.write(this.path, value); } catch { /* Derived data can be recomputed. */ }
    }
  }
  async flush() { while (this.flight) await this.flight; }
}
