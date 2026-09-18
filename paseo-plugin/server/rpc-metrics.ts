export class RpcMetrics {
  private since = Date.now();
  private calls = new Map<string, { count: number; failures: number; maxMs: number }>();
  private active = 0;
  private peak = 0;

  private rotate() {
    if (Date.now() - this.since < 30_000) return;
    this.since = Date.now();
    this.calls.clear();
    this.peak = this.active;
  }

  async track<T>(method: string, operation: () => T | Promise<T>): Promise<T> {
    this.rotate();
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    const started = Date.now();
    let failed = false;
    try { return await operation(); }
    catch (error) { failed = true; throw error; }
    finally {
      this.active--;
      this.rotate();
      if (!this.calls.has(method) && this.calls.size >= 64) method = "other";
      const item = this.calls.get(method) || { count: 0, failures: 0, maxMs: 0 };
      item.count++;
      if (failed) item.failures++;
      item.maxMs = Math.max(item.maxMs, Date.now() - started);
      this.calls.set(method, item);
    }
  }

  snapshot() {
    this.rotate();
    const memory = process.memoryUsage();
    return { windowStartedAt: new Date(this.since).toISOString(), active: this.active, peak: this.peak,
      methods: Object.fromEntries(this.calls), memory: { rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external } };
  }
}
