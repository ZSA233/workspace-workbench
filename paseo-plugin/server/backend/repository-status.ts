import { Git } from './git.ts';
import type { ObservationCache } from './cache.ts';
import type { ObservationScheduler } from './observation-scheduler.ts';
import { hash, now, WorkbenchError } from './storage.ts';

export type RawStatus = { rows: Array<[string, string]>; version: string; observedAt: string };
/** Original XY records shared by the Git view and file decorations, within the existing cache budget. */
export class RepositoryStatus {
  private producers = new Set<AbortController>();
  private closed = false;
  readonly cache: ObservationCache;
  readonly scheduler: ObservationScheduler;
  readonly timeout: number;
  readonly clock: () => number;
  constructor(cache: ObservationCache, scheduler: ObservationScheduler, timeout: number, clock = Date.now) { this.cache = cache; this.scheduler = scheduler; this.timeout = timeout; this.clock = clock; }
  version(workspaceId: string, path: string, instance = '') {
    return `${this.scheduler.statusToken(path)}:${this.cache.workspaceEpoch(workspaceId)}:${hash(instance)}:${Math.floor(this.clock() / 30_000)}`;
  }
  async read(workspaceId: string, path: string, gitlinkRoot = false, instance = ''): Promise<RawStatus> {
    const version = this.version(workspaceId, path, instance);
    const value = await this.cache.read(`raw-status:v1:${hash(path)}:${gitlinkRoot}:${hash(instance)}`, version, async () => {
      if (this.closed) throw new WorkbenchError('observer_closed', 'Git status reader is closed');
      const abort = new AbortController(); this.producers.add(abort);
      const timer = setTimeout(() => abort.abort(), Math.min(30_000, this.timeout)); timer.unref();
      try {
        const git = new Git(path, this.timeout, Date.now() + Math.min(30_000, this.timeout), abort.signal);
        if (await git.root() !== path) throw new WorkbenchError('repository_root_mismatch', 'Expected the registered Git worktree root');
        const rows = await git.status(gitlinkRoot);
        return { rows, version, observedAt: now(), observation: { state: 'ready' } };
      } finally { clearTimeout(timer); this.producers.delete(abort); }
    }, true, true, { workspaceId, repoPath: path });
    if (value.version !== version) throw new WorkbenchError('observation_superseded', 'An older Git status read finished after invalidation');
    return { rows: value.rows, version: value.version, observedAt: value.observedAt };
  }
  close() { this.closed = true; for (const abort of this.producers) abort.abort(); }
}
