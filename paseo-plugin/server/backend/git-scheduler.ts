import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkbenchError } from './storage.ts';

export type GitIntent = 'interactive' | 'observation' | 'background' | 'mutation';
export type GitPhase = 'queued' | 'git';
type Context = { intent: GitIntent; priority?: () => GitIntent; progress?: (phase: GitPhase, queueMs: number) => void };
const context = new AsyncLocalStorage<Context>();
export const withScheduledGit = <T>(work: () => Promise<T>, priority: () => GitIntent, progress?: Context['progress']) => context.run({ intent: priority(), priority, progress }, work);
export const withBackgroundGit = <T>(work: () => Promise<T>, progress?: Context['progress']) => context.run({ intent: 'background', progress }, work);
export const withObservationGit = <T>(work: () => Promise<T>, progress?: Context['progress']) => context.run({ intent: 'observation', progress }, work);
export const withInteractiveGit = <T>(work: () => Promise<T>, progress?: Context['progress']) => context.run({ intent: 'interactive', progress }, work);
export const withMutationGit = <T>(work: () => Promise<T>) => context.run({ intent: 'mutation' }, work);
const reads = new Set(['rev-parse', 'rev-list', 'status', 'diff', 'diff-tree', 'ls-files', 'ls-tree', 'show', 'log', 'for-each-ref', 'show-ref', 'merge-base', 'cat-file', 'symbolic-ref']);
export function gitIntent(args: string[]): Context {
  const inherited = context.getStore();
  // Explicit write transactions retain their original scheduling and lifetime.
  const read = reads.has(args[0]) || args[0] === 'worktree' && args[1] === 'list' || args[0] === 'config' && ['--get', '--get-all', '--get-regexp', '--list'].includes(args[1]);
  if (inherited?.intent === 'mutation' || !read) return { intent: 'mutation' };
  return inherited ? { ...inherited, intent: inherited.priority?.() || inherited.intent } : { intent: 'observation' };
}
type Waiter = { kind: GitIntent; at: number; signal?: AbortSignal; start(kind: GitIntent): void; fail(error: Error): void; cleanup(): void };
export class GitQueue {
  private active = 0;
  private ordinary = 0;
  private waiters: Waiter[] = [];
  private counts: Record<GitIntent, number> = { interactive: 0, observation: 0, background: 0, mutation: 0 };
  health() { return { running: this.active, queued: this.waiters.length, byIntent: { ...this.counts } }; }
  promote(signal: AbortSignal, kind: GitIntent) {
    for (const waiter of this.waiters) if (waiter.signal === signal && waiter.kind !== 'mutation') waiter.kind = kind;
    this.pump();
  }
  private eligible(kind: GitIntent) { return this.active < 4 && (kind !== 'background' || this.counts.background < 2) && (kind === 'interactive' || kind === 'mutation' || this.ordinary < 3); }
  private pump() {
    const rank = (w: Waiter) => Date.now() - w.at >= 5000 ? -1 : ({ interactive: 0, mutation: 1, observation: 2, background: 3 })[w.kind];
    this.waiters.sort((a, b) => rank(a) - rank(b) || a.at - b.at);
    while (this.active < 4) {
      const index = this.waiters.findIndex(w => this.eligible(w.kind));
      if (index < 0) break;
      const [w] = this.waiters.splice(index, 1);
      w.cleanup(); this.active++; this.counts[w.kind]++;
      if (w.kind === 'observation' || w.kind === 'background') this.ordinary++;
      w.start(w.kind);
    }
  }
  async run<T>(work: () => Promise<T>, kind: GitIntent, deadline?: number, signal?: AbortSignal, progress?: Context['progress']): Promise<T> {
    const at = Date.now();
    let executionKind = kind;
    const cancelled = () => new WorkbenchError('observer_cancelled', 'Git read cancelled', { stage: 'queued' });
    if (signal?.aborted) throw cancelled();
    if (deadline !== undefined && deadline <= at) throw new WorkbenchError('observation_timeout', 'Git queue deadline exceeded', { stage: 'queued' });
    if (this.waiters.length >= 256) throw new WorkbenchError('observer_busy', 'Git queue is full', { stage: 'queued' });
    progress?.('queued', 0);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remove = (error: Error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1); waiter.cleanup(); reject(error); this.pump();
      };
      const abort = () => remove(cancelled());
      const waiter: Waiter = { kind, at, signal, start: selected => { executionKind = selected; resolve(); }, fail: reject, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      this.waiters.push(waiter);
      if (deadline !== undefined) timer = setTimeout(() => remove(new WorkbenchError('observation_timeout', 'Git queue deadline exceeded', { stage: 'queued', queueMs: Date.now() - at })), Math.max(0, deadline - at));
      signal?.addEventListener('abort', abort, { once: true });
      this.pump();
    });
    try {
      if (signal?.aborted) throw cancelled();
      if (deadline !== undefined && Date.now() >= deadline) throw new WorkbenchError('observation_timeout', 'Git queue deadline exceeded', { stage: 'queued' });
      progress?.('git', Date.now() - at);
      return await work();
    } finally {
      // A timed-out child still owns the slot until command() observes close.
      this.active--; this.counts[executionKind]--;
      if (executionKind === 'observation' || executionKind === 'background') this.ordinary--;
      this.pump();
    }
  }
}
export const gitQueue = new GitQueue();
