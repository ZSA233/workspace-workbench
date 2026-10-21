/** Bound native host contribution updates per frame. No class or async loop:
 * Hermes evaluates this module through the host's lazy source loader. */
export function createRegistrationQueue(options: {
  deferred: boolean;
  schedule?: (run: () => void) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  report?: (phase: string, details: Record<string, string>) => void;
}) {
  const pending = new Map<string, () => void>();
  const schedule = options.schedule || ((run: () => void) => setTimeout(run, 16));
  const cancelTimer = options.cancel || clearTimeout;
  const now = options.now || Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false, running = false, completed = 0;
  function run() {
    timer = undefined;
    if (closed) return;
    running = true;
    const start = now();
    let count = 0;
    while (pending.size && count < 4 && (count === 0 || now() - start < 4)) {
      const [key, task] = pending.entries().next().value!;
      pending.delete(key);
      try { task(); } catch { /* registration scopes retain the actual error */ }
      count++; completed++;
    }
    if (now() - start >= 32) { try { options.report?.("native-registration-slow", { elapsedMs: String(now() - start), processed: String(count), pending: String(pending.size) }); } catch { /* optional telemetry */ } }
    running = false;
    if (!closed && pending.size) timer = schedule(run);
  }
  function enqueue(key: string, task: () => void) {
    if (closed) return;
    if (!options.deferred) { task(); return; }
    pending.set(key, task);
    if (!running && timer === undefined) timer = schedule(run);
  }
  function close() { closed = true; if (timer !== undefined) cancelTimer(timer); timer = undefined; pending.clear(); }
  return { enqueue, cancel: (key: string) => pending.delete(key), close, debug: () => ({ pending: pending.size, completed, scheduled: timer !== undefined }) };
}
