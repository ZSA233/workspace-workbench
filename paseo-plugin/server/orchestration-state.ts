import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { currentProject } from "./projects.ts";

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function readState<T>(key: string): T | null {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const path = join(project.stateRoot, "orchestration", `${digest(key)}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
}
export function writeState(key: string, value: unknown): void {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const root = join(project.stateRoot, "orchestration");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${digest(key)}.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
