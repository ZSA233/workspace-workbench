import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { realpath } from 'node:fs/promises';
import { AsyncLocalStorage } from "node:async_hooks";

const canonicalSnapshot = new AsyncLocalStorage<Map<string, string>>();
/** Scoped to one read-only metadata operation; never reused for a mutation. */
export function withCanonicalSnapshot<T>(work: () => T): T {
  return canonicalSnapshot.run(new Map(), work);
}

export type Json = Record<string, any>;
export class WorkbenchError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export const issue = (error: unknown): Json =>
  error instanceof WorkbenchError
    ? {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    : {
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      };
export const now = () => new Date().toISOString();
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(path: string): string {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : resolve(path);
  const snapshot = canonicalSnapshot.getStore();
  const cached = snapshot?.get(expanded);
  if (cached !== undefined) return cached;
  if (existsSync(expanded)) {
    const value = realpathSync(expanded); snapshot?.set(expanded, value); return value;
  }
  const parent = dirname(expanded);
  const value = parent === expanded
    ? expanded
    : join(canonical(parent), relative(parent, expanded));
  snapshot?.set(expanded, value); return value;
}
export function inside(path: string, root: string, allowRoot = false): boolean {
  const part = relative(canonical(root), canonical(path));
  return (
    (allowRoot || part !== "") &&
    part !== ".." &&
    !part.startsWith("../") &&
    !isAbsolute(part)
  );
}
export async function canonicalAsync(path: string): Promise<string> {
  const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
  try { return await realpath(expanded); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    const parent = dirname(expanded);
    return parent === expanded ? expanded : join(await canonicalAsync(parent), relative(parent, expanded));
  }
}
export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8"));
}
export function optionalJson(path: string): Json {
  return existsSync(path) ? readJson(path) : {};
}
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    const fd = openSync(temporary, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
/** Single owner per project (transport lease); serialize all durable mutations. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }
  async drain() {
    await this.tail;
  }
}
export const stable = (value: any): string =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const slug = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80) || "workspace";
