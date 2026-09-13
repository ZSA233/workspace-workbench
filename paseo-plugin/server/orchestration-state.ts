import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { currentProject } from "./projects.ts";

export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function statePath(key: string, bucket = "orchestration"): string {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  return join(project.stateRoot, bucket, `${digest(key)}.json`);
}
export function readState<T>(key: string): T | null {
  const path = statePath(key);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
}
export function writeState(key: string, value: unknown): void {
  const path = statePath(key);
  const root = join(currentProject()!.stateRoot, "orchestration");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
export function readReviewState<T>(key: string): T | null {
  const path = statePath(key, "reviews");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
}
export function writeReviewState(key: string, value: unknown): void {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const path = statePath(key, "reviews");
  const root = join(project.stateRoot, "reviews");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

export function removeReviewState(key: string): boolean {
  const path = statePath(key, "reviews");
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
