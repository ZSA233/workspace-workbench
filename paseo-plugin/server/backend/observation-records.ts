import { Worker } from 'node:worker_threads';
import type { Config } from './config.ts';
import { stable, WorkbenchError, type Json } from './storage.ts';

type Pending = { id: number; key: string; operation: string; input: Json; config: Config; acceptedAt: number; startedAt?: number; resolve(value: any): void; reject(error: unknown): void; promise: Promise<any> };
const emptySupplement = () => ({ orphanScan: {state:'scanning',candidates:[],scannedDirectories:0}, discovered: {state:'scanning',repositories:[],incomplete:true,scannedDirectories:0} });
/** Bounded metadata reader; optional directory scans use a separate worker. */
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
  private supplement?: ObservationRecords;
  private supplementValue: Json = emptySupplement();
  private supplementConfig = '';
  private supplementRevision = 0;
  private recent: Json[] = [];
  private workerFactory: () => Worker;
  constructor(config: () => Config, changed = () => {}, workerFactory = () => new Worker(new URL('./observation-records-worker.ts', import.meta.url), { execArgv: ['--experimental-strip-types'] })) { this.config = config; this.changed = changed; this.workerFactory = workerFactory; }
  private updateSupplements(input: Json) {
    const identity = stable(this.config());
    const revision = this.supplementRevision;
    if (identity !== this.supplementConfig) { this.supplementConfig = identity; this.supplementValue = emptySupplement(); }
    // Completion notifications retrieve the published snapshot only. Starting
    // a new scan here would loop forever when discovery consistently fails.
    this.supplement ||= new ObservationRecords(this.config, () => this.updateSupplements({snapshotOnly:true}), this.workerFactory);
    void this.supplement.request('supplements', input, true).then(value => {
      if (this.closed || identity !== this.supplementConfig) return;
      if (revision !== this.supplementRevision) { this.updateSupplements({}); return; }
      if (stable(value) !== stable(this.supplementValue)) { this.supplementValue = value; this.changed(); }
    }).catch(error => {
      if (this.closed || identity !== this.supplementConfig) return;
      if (revision !== this.supplementRevision) { this.updateSupplements({}); return; }
      const value = {orphanScan:{...this.supplementValue.orphanScan,state:'failed',reason:error.code || 'observer_unavailable'},discovered:{...this.supplementValue.discovered,state:'failed',reason:error.code || 'observer_unavailable'}};
      if (stable(value) !== stable(this.supplementValue)) { this.supplementValue = value; this.changed(); }
    });
  }
  request(operation: 'list' | 'get' | 'context' | 'roster' | 'identify' | 'supplements', input: Json = {}, background = false): Promise<any> {
    if (this.closed) return Promise.reject(new WorkbenchError('observer_closed', 'Metadata reader closed'));
    const config = this.config(), key = stable({ operation, input, config });
    const existing = this.flights.get(key);
    if (existing) {
      this.merged++;
      if (!background && operation !== 'list') {
        const index = this.queue.indexOf(existing);
        if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(existing); }
      }
      return existing.promise;
    }
    if (this.flights.size >= 32) return Promise.reject(new WorkbenchError('observer_busy', 'Metadata read queue is full'));
    let resolve!: Pending['resolve'], reject!: Pending['reject'];
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const item = { id: ++this.sequence, key, operation, input, config, acceptedAt: Date.now(), resolve, reject, promise };
    this.flights.set(key, item);
    if (background || operation === 'list') this.queue.push(item); else this.queue.unshift(item);
    this.dispatch(); return promise;
  }
  private dispatch() {
    if (this.closed || this.active || !this.queue.length) return;
    if (!this.worker) {
      let worker: Worker;
      try { worker = this.workerFactory(); }
      catch (error) { this.fail(error); return; }
      this.worker = worker;
      worker.on('message', message => {
        if (this.worker === worker && message.event === 'roster-changed') { this.changed(); return; }
        if (this.worker !== worker || message.id !== this.active?.id) return;
        const item = this.active!; this.active = undefined; this.flights.delete(item.key); this.completed++;
        this.recent.push({operation:item.operation,queueMs:(item.startedAt || item.acceptedAt)-item.acceptedAt,executionMs:Date.now()-(item.startedAt || item.acceptedAt),failed:!!message.error});
        if (this.recent.length > 16) this.recent.shift();
        if (message.error) item.reject(new WorkbenchError(message.error.code, message.error.message, message.error.details));
        else if (item.operation === 'roster') {
          // Directory discovery has its own read-only worker. Even a blocking
          // filesystem call there cannot hold the authoritative roster hostage.
          this.updateSupplements(item.input);
          item.resolve({...message.value,...this.supplementValue});
        } else item.resolve(message.value);
        this.dispatch(); if (!this.active) worker.unref();
      });
      worker.on('error', error => { if (this.worker === worker) { this.worker = undefined; this.fail(error); void worker.terminate(); } });
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.fail(new Error('Metadata worker exited')); } });
    }
    this.active = this.queue.shift(); this.worker.ref();
    this.active!.startedAt = Date.now();
    const { id, operation, input, config } = this.active!;
    try { this.worker.postMessage({ id, operation, input, config }); }
    catch (error) { const worker = this.worker; this.worker = undefined; this.fail(error); void worker.terminate(); }
  }
  private fail(error: unknown) {
    for (const item of this.flights.values()) item.reject(new WorkbenchError('observer_unavailable', error instanceof Error ? error.message : 'Metadata reader unavailable'));
    this.flights.clear(); this.queue = []; this.active = undefined;
  }
  health(): Json { return { active: !!this.active, ...(this.active ? {operation:this.active.operation,elapsedMs:Date.now()-(this.active.startedAt || this.active.acceptedAt)} : {}), queued: this.queue.length, completed: this.completed, merged: this.merged, recent:[...this.recent], ...(this.supplement ? {supplements:this.supplement.health()} : {}) }; }
  invalidate() {
    this.supplementRevision++;
    this.supplementValue = {orphanScan:{...this.supplementValue.orphanScan,state:'stale'},discovered:{...this.supplementValue.discovered,state:'stale'}};
    this.worker?.postMessage({ event: 'invalidate' }); this.supplement?.invalidate();
  }
  async close() {
    this.closed = true; this.fail(new Error('Metadata reader closed'));
    const worker = this.worker; this.worker = undefined; await Promise.all([worker?.terminate(),this.supplement?.close()]);
  }
}
