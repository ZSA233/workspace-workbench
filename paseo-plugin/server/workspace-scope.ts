import { AsyncLocalStorage } from "node:async_hooks";
import { currentProject } from "./projects.ts";

const owners = new AsyncLocalStorage<ReadonlySet<string>>();
const flights = new Map<string, Promise<void>>();
/** Serialize scope changes with task startup within the plugin, including nested calls. */
export async function withWorkspaceScope<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${currentProject()?.configPath || "standalone"}:${workspaceId}`;
  const held = owners.getStore();
  if (held?.has(key)) return operation();
  const previous = flights.get(key) || Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => done);
  flights.set(key, tail);
  await previous;
  try { return await owners.run(new Set([...(held || []), key]), operation); }
  finally { release(); if (flights.get(key) === tail) flights.delete(key); }
}
