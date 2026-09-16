import { mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentProject } from "./projects.ts";
import { digest } from "./orchestration-state.ts";
const reviewTransitionQueues = new Map<string, Promise<void>>();
async function acquireReviewDiskLock(path: string): Promise<() => void> {
  const deadline = Date.now() + 15_000;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      mkdirSync(path, { mode: 0o700 });
      const heartbeat = setInterval(() => {
        try { utimesSync(path, new Date(), new Date()); } catch { /* release will report no state change */ }
      }, 30_000);
      heartbeat.unref();
      return () => { clearInterval(heartbeat); rmSync(path, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 10 * 60_000) rmSync(path, { recursive: true, force: true });
      }
      catch { /* another owner may be replacing the lock */ }
      if (Date.now() >= deadline) throw new Error("review_orchestrator_busy");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    }
  }
}

export async function withReviewTransitionLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const project = currentProject();
  if (!project) throw new Error("project_context_required");
  const key = `${project.configPath}:${workspaceId}`;
  const previous = reviewTransitionQueues.get(key) || Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolveQueue) => { releaseQueue = resolveQueue; });
  const chain = previous.then(() => queued);
  reviewTransitionQueues.set(key, chain);
  await previous;
  let releaseDisk: (() => void) | null = null;
  try {
    releaseDisk = await acquireReviewDiskLock(join(project.stateRoot, "reviews", `.transition-${digest(workspaceId)}`));
    return await operation();
  } finally {
    releaseDisk?.();
    releaseQueue();
    if (reviewTransitionQueues.get(key) === chain) reviewTransitionQueues.delete(key);
  }
}
