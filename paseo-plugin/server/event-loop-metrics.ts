import { monitorEventLoopDelay } from 'node:perf_hooks';
/** Small, resettable 30-second window; timers never keep a worker alive. */
export class EventLoopMetrics {
  private histogram = monitorEventLoopDelay({ resolution: 20 });
  private since = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private previous: Record<string, unknown> | null = null;
  constructor() {
    this.histogram.enable();
    this.timer = setInterval(() => { this.previous = this.sample(); this.histogram.reset(); this.since = Date.now(); }, 30_000);
    this.timer.unref();
  }
  private sample() { return { since: new Date(this.since).toISOString(), p95Ms: this.histogram.percentile(95) / 1e6, maxMs: this.histogram.max / 1e6, meanMs: Number.isFinite(this.histogram.mean) ? this.histogram.mean / 1e6 : 0 }; }
  snapshot() { return { current: this.sample(), previous: this.previous }; }
  close() { clearInterval(this.timer); this.histogram.disable(); }
}
