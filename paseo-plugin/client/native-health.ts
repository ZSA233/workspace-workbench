type Activity = {
  currentState?: string | null;
  addEventListener?(type: "change", listener: (state: string) => void): { remove(): void };
};
/** JS responsiveness only: Android native crashes/ANRs still require logcat. */
export function installNativeHealthMonitor(options: {
  activity?: Activity;
  report(phase: string, details: Record<string, string>): void;
  now?: () => number;
  set?: (run: () => void, ms: number) => ReturnType<typeof setInterval>;
  clear?: (timer: ReturnType<typeof setInterval>) => void;
}) {
  const now = options.now || Date.now, set = options.set || setInterval, clear = options.clear || clearInterval;
  let timer: ReturnType<typeof setInterval> | undefined, previous = 0, lastReport = 0, maxLag = 0, samples = 0, sequence = 0, closed = false;
  function report(phase: string, details: Record<string, string>) { try { options.report(phase, { ...details, sequence: String(++sequence) }); } catch { /* telemetry must not break the app */ } }
  function sample() {
    const at = now(), lag = Math.max(0, at - previous - 2000); previous = at;
    maxLag = Math.max(maxLag, lag); samples++;
    if (at - lastReport >= 30000 || (lag >= 1000 && at - lastReport >= 10000)) {
      report(lag >= 1000 ? "native-js-stall" : "native-health", { maxLagMs: String(maxLag), samples: String(samples) });
      lastReport = at; maxLag = 0; samples = 0;
    }
  }
  function activity(state: string) {
    if (closed) return;
    if (timer !== undefined) clear(timer); timer = undefined;
    report("native-app-state", { state });
    if (state === "active") { previous = now(); lastReport = previous; samples = 0; maxLag = 0; timer = set(sample, 2000); }
  }
  activity(options.activity?.currentState || "active");
  let subscription: { remove(): void } | undefined;
  try { subscription = options.activity?.addEventListener?.("change", activity); } catch { /* native compatibility */ }
  return () => { closed = true; if (timer !== undefined) clear(timer); timer = undefined; subscription?.remove(); };
}
