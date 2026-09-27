import { Worker } from 'node:worker_threads';
import type { Config } from './config.ts';
import { stable, WorkbenchError, type Json } from './storage.ts';

type Pending = { id: number; key: string; operation: string; input: Json; config: Config; resolve(value: any): void; reject(error: unknown): void; promise: Promise<any> };
/** One bounded read-only worker per project. Durable mutations stay with their owner. */
export class ObservationRecords {
  private worker?: Worker;
  private active?: Pending;
  private queue: Pending[] = [];
  private flights = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;
  private completed = 0;
  private merged = 0;
  private config: () => Config;
  private changed: () => void;
  constructor(config: () => Config, changed = () => {}) { this.config = config; this.changed = changed; }
  request(operation: 'list' | 'get' | 'context' | 'roster' | 'identify', input: Json = {}, background = false): Promise<any> {
    if (this.closed) return Promise.reject(new WorkbenchError('observer_closed', 'Metadata reader closed'));
    const config = this.config(), key = stable({ operation, input, config });
    const existing = this.flights.get(key);
    if (existing) {
      this.merged++;
      if (!background && operation !== 'list' && operation !== 'roster') {
        const index = this.queue.indexOf(existing);
        if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(existing); }
      }
      return existing.promise;
    }
    if (this.flights.size >= 32) return Promise.reject(new WorkbenchError('observer_busy', 'Metadata read queue is full'));
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { id: ++this.sequence, key, operation, input, config, resolve, reject, promise };
    this.flights.set(key, item);
    if (background || operation === 'list' || operation === 'roster') this.queue.push(item); else this.queue.unshift(item);
    this.dispatch(); return promise;
  }
  private dispatch() {
    if (this.closed || this.active || !this.queue.length) return;
    if (!this.worker) {
      let worker: Worker;
      try { worker = new Worker(new URL('./observation-records-worker.ts', import.meta.url), { execArgv: ['--experimental-strip-types'] }); }
      catch (error) { this.fail(error); return; }
      this.worker = worker;
      worker.on('message', message => {
        if (this.worker === worker && message.event === 'roster-changed') { this.changed(); return; }
        if (this.worker !== worker || message.id !== this.active?.id) return;
        const item = this.active!; this.active = undefined; this.flights.delete(item.key); this.completed++;
        if (message.error) item.reject(new WorkbenchError(message.error.code, message.error.message, message.error.details));
        else item.resolve(message.value);
        this.dispatch(); if (!this.active) worker.unref();
      });
      worker.on('error', error => { if (this.worker === worker) { this.worker = undefined; this.fail(error); void worker.terminate(); } });
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.fail(new Error('Metadata worker exited')); } });
    }
    this.active = this.queue.shift(); this.worker.ref();
    const { id, operation, input, config } = this.active!;
    try { this.worker.postMessage({ id, operation, input, config }); }
    catch (error) { const worker = this.worker; this.worker = undefined; this.fail(error); void worker.terminate(); }
  }
  private fail(error: unknown) {
    for (const item of this.flights.values()) item.reject(new WorkbenchError('observer_unavailable', error instanceof Error ? error.message : 'Metadata reader unavailable'));
    this.flights.clear(); this.queue = []; this.active = undefined;
  }
  health() { return { active: !!this.active, queued: this.queue.length, completed: this.completed, merged: this.merged }; }
  invalidate() { this.worker?.postMessage({ event: 'invalidate' }); }
  async close() {
    this.closed = true; this.fail(new Error('Metadata reader closed'));
    const worker = this.worker; this.worker = undefined; await worker?.terminate();
  }
}
