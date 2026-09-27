import { randomUUID } from 'node:crypto';
import { DIFF_READ_PROTOCOL, type DiffReadState } from '../../shared/diff-read.ts';
import { issue, WorkbenchError, type Json } from './storage.ts';
import { withScheduledGit, gitQueue, type GitIntent } from './git-scheduler.ts';

type Task = { intent: GitIntent; id: string; key: string; identity: string; started: number; deadline: number; state: DiffReadState; phase: string; queueMs: number; consumers: Map<string, number>; abort: AbortController; flight: Promise<void>; result?: Json; error?: Json; cleanupDone: boolean; releasedAt?: number };
export class DiffReadTasks {
  readonly generation = randomUUID();
  private tasks = new Map<string, Task>();
  private keys = new Map<string, string>();
  private requests = new Map<string, string>();
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  private counters = { started: 0, merged: 0, cancelled: 0, timedOut: 0, bytes: 0, cacheHits: 0 };
  private events: Json[] = [];
  constructor() { this.timer = setInterval(() => this.sweep(), 250); this.timer.unref(); }
  private event(task: Task, outcome: string) {
    this.events.push({ at: new Date().toISOString(), generation: this.generation, taskId: task.id, requestIds: [...task.consumers.keys()].slice(0, 8), phase: task.phase, outcome, durationMs: Date.now() - task.started, queueMs: task.queueMs });
    if (this.events.length > 64) this.events.shift();
  }
  private snapshot(task: Task, requestId: string): Json {
    return { protocol: DIFF_READ_PROTOCOL, generation: this.generation, requestId, taskId: task.id, state: task.state, phase: task.phase, acceptedAt: task.started, deadline: task.deadline, queueMs: task.queueMs, ...(task.result ? { result: task.result } : {}), ...(task.error ? { error: task.error } : {}) };
  }
  async start(key: string, requestId: string, work: (signal: AbortSignal, deadline: number, publish: (value: Json) => void) => Promise<Json>, budgetMs = 30_000, identity = key, intent: 'interactive' | 'observation' | 'background' = 'interactive'): Promise<Json> {
    if (this.closed) throw new WorkbenchError('observer_closed', 'Diff reader closed');
    if (!requestId || requestId.length > 200) throw new WorkbenchError('request_invalid', 'Diff request identity required');
    this.sweep();
    if (this.tasks.size >= 128) {
      const removable = [...this.tasks.values()].filter(task => task.cleanupDone).sort((a, b) => a.started - b.started);
      for (const task of removable) { this.forget(task); if (this.tasks.size < 128) break; }
    }
    const requestTask = this.tasks.get(this.requests.get(requestId) || '');
    if (requestTask && requestTask.identity !== identity) throw new WorkbenchError('request_identity_conflict', 'Diff request identity belongs to another file');
    if (!requestTask && this.requests.size >= 512) throw new WorkbenchError('observer_busy', 'Diff subscriber capacity reached');
    let task = requestTask || this.tasks.get(this.keys.get(key) || '');
    const priorCleanup = task && !task.cleanupDone ? task.flight : Promise.resolve();
    if (task && !requestTask && (['failed', 'cancelled'].includes(task.state) || intent !== 'interactive' && task.cleanupDone)) task = undefined;
    if (!task) {
      if ([...this.tasks.values()].filter(t => !t.cleanupDone).length >= 32) throw new WorkbenchError('observer_busy', 'Diff task capacity reached');
      const started = Date.now();
      task = { intent, id: randomUUID(), key, identity, started, deadline: started + Math.min(30_000, Math.max(1, budgetMs)), state: 'queued', phase: 'queued', queueMs: 0, consumers: new Map(), abort: new AbortController(), flight: Promise.resolve(), cleanupDone: false };
      this.tasks.set(task.id, task); this.keys.set(key, task.id); this.counters.started++;
      const current = task;
      current.flight = withScheduledGit(async () => {
        try {
          // A cancelled cache flight must finish cleanup before its replacement
          // can reuse that cache key; otherwise the new read inherits its abort.
          await priorCleanup;
          if (current.abort.signal.aborted) return;
          const result = await work(current.abort.signal, current.deadline, value => { if (!current.abort.signal.aborted) current.result = value; });
          if (current.abort.signal.aborted) return;
          if (Date.now() >= current.deadline) { this.cancel(current, 'diff_read_timeout'); return; }
          current.result = result; current.state = 'ready'; current.phase = 'complete';
          if (result.cacheHit) this.counters.cacheHits++;
          else this.counters.bytes += Number(result.readBytes || 0);
        } catch (error) {
          if (!current.abort.signal.aborted) { current.error = issue(error); current.state = 'failed'; }
        } finally { current.cleanupDone = true; this.event(current, current.state); }
      }, () => current.intent, (phase, queueMs) => {
        if (current.abort.signal.aborted) return;
        current.phase = phase; current.state = phase === 'queued' ? 'queued' : 'running'; current.queueMs += queueMs;
      });
    } else {
      this.counters.merged++;
      if ((intent === 'interactive' && task.intent !== 'interactive') || (intent === 'observation' && task.intent === 'background')) { task.intent = intent; gitQueue.promote(task.abort.signal, intent); }
    }
    if (!task.consumers.has(requestId) && task.consumers.size >= 32) throw new WorkbenchError('observer_busy', 'Diff subscriber capacity reached');
    task.consumers.set(requestId, Date.now() + 15_000); task.releasedAt = undefined;
    this.requests.set(requestId, task.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([task.flight, new Promise<void>(resolve => { timer = setTimeout(resolve, 100); })]);
    clearTimeout(timer);
    return this.snapshot(task, requestId);
  }
  status(taskId: string, requestId: string): Json {
    this.sweep();
    const task = this.tasks.get(taskId || this.requests.get(requestId) || '');
    if (!task || this.requests.get(requestId) !== task.id) throw new WorkbenchError('diff_task_missing', 'Diff task no longer exists', { generation: this.generation });
    task.consumers.set(requestId, Date.now() + 15_000); task.releasedAt = undefined;
    return this.snapshot(task, requestId);
  }
  async wait(taskId: string, requestId: string, deadline: number, signal?: AbortSignal): Promise<Json> {
    const task = this.tasks.get(taskId);
    if (!task || this.requests.get(requestId) !== task.id) throw new WorkbenchError('diff_task_missing', 'Diff task no longer exists');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([task.flight, new Promise<void>((_, reject) => {
        abort = () => reject(new WorkbenchError('observer_cancelled', 'Diff caller cancelled'));
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new WorkbenchError('observation_timeout', 'Diff caller deadline exceeded', { stage: task.phase })), Math.max(0, deadline - Date.now()));
      })]);
      return this.snapshot(task, requestId);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }
  release(taskId: string, requestId: string): Json {
    const task = this.tasks.get(taskId || this.requests.get(requestId) || '');
    if (task && this.requests.get(requestId) === task.id) { task.consumers.delete(requestId); if (!task.consumers.size) task.releasedAt = Date.now(); }
    this.sweep(); return { released: true, generation: this.generation };
  }
  private cancel(task: Task, code: string) {
    if (task.cleanupDone || task.abort.signal.aborted) return;
    const refresh = task.key.startsWith('refresh:');
    task.error = { code: refresh && code === 'diff_read_timeout' ? 'observer_refresh_timeout' : code, message: code === 'diff_read_timeout' ? refresh ? 'Repository refresh deadline exceeded' : 'File read deadline exceeded' : 'Read cancelled', details: { stage: task.phase, taskId: task.id, queueMs: task.queueMs } };
    task.state = code === 'diff_read_timeout' ? 'failed' : 'cancelled';
    if (code === 'diff_read_timeout') this.counters.timedOut++; else this.counters.cancelled++;
    task.abort.abort();
  }
  private sweep() {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      for (const [id, until] of task.consumers) if (until <= now) task.consumers.delete(id);
      if (!task.consumers.size) task.releasedAt ??= now;
      if (!task.cleanupDone && now >= task.deadline) this.cancel(task, 'diff_read_timeout');
      if (!task.consumers.size && (task.state === 'queued' || now - (task.releasedAt || now) >= 2000)) this.cancel(task, 'observer_cancelled');
      if (task.cleanupDone && (now - task.started >= 60_000 || !task.consumers.size && now - (task.releasedAt || now) >= 2000)) {
        this.forget(task);
      }
    }
  }
  private forget(task: Task) {
    this.tasks.delete(task.id);
    if (this.keys.get(task.key) === task.id) this.keys.delete(task.key);
    for (const [request, id] of this.requests) if (id === task.id) this.requests.delete(request);
  }
  health() {
    const cutoff = Date.now() - 30_000;
    const events = this.events.filter(event => Date.parse(event.at) >= cutoff);
    return { protocol: DIFF_READ_PROTOCOL, generation: this.generation, active: [...this.tasks.values()].filter(t => !t.cleanupDone).length,
      retained: this.tasks.size, ...this.counters, lifetime: { ...this.counters }, windowStartedAt: new Date(cutoff).toISOString(),
      recent: { completed: events.length, failures: events.filter(event => event.outcome === 'failed').length, maxMs: Math.max(0, ...events.map(event => event.durationMs)) },
      events, historicalEventCount: this.events.length - events.length };
  }
  async close() { this.closed = true; clearInterval(this.timer); for (const task of this.tasks.values()) this.cancel(task, 'observer_cancelled'); await Promise.allSettled([...this.tasks.values()].map(t => t.flight)); this.tasks.clear(); this.keys.clear(); this.requests.clear(); }
}
