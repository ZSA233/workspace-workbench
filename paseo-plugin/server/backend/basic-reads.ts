import { Git } from './git.ts';
import { gitIntent, gitQueue } from './git-scheduler.ts';
import { stable, WorkbenchError } from './storage.ts';
type Flight = {
    abort: AbortController;
    consumers: number;
    promise: ReturnType<Git['run']>;
};
/** Share only in-flight basic reads of the same source version, with independent consumers. */
export class BasicReads {
    private closed = false;
    private flights = new Map<string, Flight>();
    async read(path: string, version: string, args: string[], check: boolean, timeout: number, signal?: AbortSignal) {
        if (this.closed)
            throw new WorkbenchError('observer_closed', 'Basic reader closed');
        if (signal?.aborted)
            throw new WorkbenchError('observer_cancelled', 'Basic observation cancelled');
        const key = stable({ path, version, args, check });
        let flight = this.flights.get(key);
        if (!flight) {
            if (this.flights.size >= 64)
                throw new WorkbenchError('observer_busy', 'Basic read capacity reached');
            const abort = new AbortController();
            const promise = new Git(path, timeout, Date.now() + Math.min(timeout, 30000), abort.signal, true).run(args, check);
            flight = { abort, consumers: 0, promise };
            this.flights.set(key, flight);
            void promise.finally(() => { if (this.flights.get(key) === flight)
                this.flights.delete(key); }).catch(() => { });
        }
        else {
            const intent = gitIntent(args).intent;
            if (intent === 'interactive' || intent === 'observation')
                gitQueue.promote(flight.abort.signal, intent);
        }
        flight.consumers++;
        let abort: () => void = () => { };
        try {
            return await Promise.race([flight.promise, new Promise<never>((_, reject) => {
                    abort = () => reject(new WorkbenchError('observer_cancelled', 'Basic observation subscriber cancelled'));
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted)
                        abort();
                })]);
        }
        finally {
            signal?.removeEventListener('abort', abort);
            if (--flight.consumers === 0)
                flight.abort.abort();
        }
    }
    async close() { this.closed = true; for (const flight of this.flights.values())
        flight.abort.abort(); await Promise.allSettled([...this.flights.values()].map(f => f.promise)); }
}
