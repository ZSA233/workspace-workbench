import { createRequestScheduler } from '../../shared/request-scheduler.mjs';
import { WorkbenchError } from './storage.ts';

type Entry = { promise: Promise<any>; consumers: number; settled: boolean };
/** Bounded observation only. Preparation has its own durable execution owner. */
export class RuntimeReadQueue {
  private scheduler = createRequestScheduler({concurrency:2,queueLimit:32});
  private entries = new Map<string, Entry>();
  private running = new Set<Promise<unknown>>();
  read<T>(key: string, deadline: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted || Date.now() >= deadline) return Promise.reject(new WorkbenchError('observer_timeout','Environment observation expired'));
    let entry = this.entries.get(key);
    if (!entry) {
      let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;
      const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;});
      entry = {promise,consumers:0,settled:false}; this.entries.set(key,entry);
      const current = entry;
      this.scheduler.submit({id:key,deadline,run:({signal: owned}: {signal:AbortSignal}) => {
        const task = run(owned); this.running.add(task);
        void task.finally(() => this.running.delete(task)).catch(() => {});
        return task;
      },respond:(error:unknown,value:T) => {
        current.settled=true; if(this.entries.get(key) === current) this.entries.delete(key);
        if(error) reject(error); else resolve(value);
      }});
    }
    const current = entry; current.consumers++;
    return new Promise<T>((resolve,reject) => {
      let finished=false;
      const done=(error:unknown,value?:T) => {
        if(finished)return; finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        current.consumers--;
        if(!current.consumers && !current.settled) this.scheduler.cancel(key,'cancelled');
        if(error)reject(error);else resolve(value!);
      };
      const cancel=()=>done(new WorkbenchError('observer_timeout','Environment observation cancelled'));
      const timer=setTimeout(cancel,Math.max(0,deadline-Date.now()));
      signal?.addEventListener('abort',cancel,{once:true});
      current.promise.then(value=>done(null,value),error=>done(error));
      if(signal?.aborted)cancel();
    });
  }
  health(){return this.scheduler.health();}
  async close(){this.scheduler.close();await Promise.allSettled([...this.running]);}
}
