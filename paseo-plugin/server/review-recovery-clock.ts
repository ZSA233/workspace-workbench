/** Active review recovery is event-driven; this clock only fills missing events. */
export class ReviewRecoveryClock {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private fired = new Map<string, number>();
  private due = new Map<string, number | null>();
  private tick: () => Promise<void>;
  private fallbackMs: number;
  constructor(tick: () => Promise<void>, fallbackMs = 60_000) { this.tick = tick; this.fallbackMs = fallbackMs; }
  update(key: string, active: boolean, deadline?: number) {
    if (active) this.due.set(key, deadline && Number.isFinite(deadline) && this.fired.get(key) !== deadline ? deadline : null);
    else this.due.delete(key);
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.stopped || this.running || !this.due.size) return;
    const future = [...this.due.values()].filter((n): n is number => n !== null);
    const delay = Math.max(20, Math.min(this.fallbackMs, ...future.map(n => n - Date.now())));
    this.timer = setTimeout(() => {
      this.running = true;
      for (const [key, deadline] of this.due) if (deadline !== null && deadline <= Date.now()) { this.fired.set(key, deadline); this.due.set(key, null); }
      void this.tick().catch(() => {}).finally(() => { this.running = false; this.schedule(); });
    }, delay);
    this.timer.unref();
  }
  close() { this.stopped = true; clearTimeout(this.timer); this.due.clear(); this.fired.clear(); }
}
