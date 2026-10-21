import type { PluginClientContext } from "@getpaseo/plugin/client";
import { recoveryPolicySchema, recoverySettingsRpc, sessionRecoveryRpc, type RecoveryPolicy, type RecoverySession } from "../shared/session-recovery.ts";

export type RecoveryClientSnapshot = { sessions: RecoverySession[]; policy: RecoveryPolicy; available: boolean; nativeAvailable: boolean; loaded: boolean; error: string | null };
/** One observation per client installation, shared by the screen and every pill. */
export function createRecoveryClientStore(client: PluginClientContext, options: { demandOnly?: boolean; idleIntervalMs?: number; diagnostic?: (phase: string, details: Record<string, string>) => void } = {}) {
  // The native host evaluates large source strings lazily. Constructing an
  // esbuild class in that path can fail before its constructor body runs.
  let snapshot: RecoveryClientSnapshot = { sessions: [], policy: recoveryPolicySchema.parse({}), available: false, nativeAvailable: false, loaded: false, error: null };
  const listeners = new Set<() => void>();
  let flight: Promise<void> | null = null;
  let stopped = false, started = false;
  let foreground = true, observers = 0, signature = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => { if (stopped) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; };
  function publish(next: RecoveryClientSnapshot) {
    if (stopped) return;
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    snapshot = next; listeners.forEach(listener => listener());
  }
  function schedule() {
    if (timer !== undefined) clearInterval(timer); timer = undefined;
    if (started && !stopped && foreground && (!options.demandOnly || observers > 0)) timer = setInterval(() => { void refresh(); }, observers ? 5000 : options.idleIntervalMs ?? 5000);
  }
  function setForeground(active: boolean) {
    if (stopped || foreground === active) return;
    foreground = active; schedule();
    if (active && started && (!options.demandOnly || observers > 0)) void refresh();
  }
  function observe() {
    if (stopped) return () => {};
    observers++; schedule();
    if (foreground) void refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true; observers--; schedule();
      if (options.demandOnly && observers === 0) publish({ ...snapshot, sessions: [], loaded: false, error: null });
    };
  }
  function start() {
    if (started || stopped) return;
    started = true;
    schedule();
    if (foreground && (!options.demandOnly || observers > 0)) void refresh();
  }
  function refresh(): Promise<void> {
    if (stopped || (options.demandOnly && observers === 0)) return Promise.resolve();
    if (flight) return flight;
    const startedAt = Date.now();
    const request = Promise.resolve().then(() => stopped || !foreground || (options.demandOnly && observers === 0) ? null : client.rpc(sessionRecoveryRpc, { action: "list" })).then(result => {
      if (result && (!options.demandOnly || observers > 0)) publish({ sessions: result.sessions, policy: result.policy, available: result.available, nativeAvailable: result.nativeAvailable, loaded: true, error: result.error || null });
    }, error => {
      if (options.demandOnly && observers === 0) return;
      publish({ ...snapshot, available: false, loaded: true, error: error instanceof Error ? error.message : String(error),
        sessions: snapshot.sessions.map(session => ({ ...session, status: "unavailable", enabled: false })) });
    }).finally(() => {
      if (flight === request) flight = null;
      const elapsedMs = Date.now() - startedAt;
      if (!stopped && (!options.demandOnly || observers > 0) && elapsedMs >= 500) {
        try { options.diagnostic?.("recovery-observation-slow", { elapsedMs: String(elapsedMs), sessions: String(snapshot.sessions.length), observers: String(observers) }); } catch { /* optional telemetry */ }
      }
    });
    flight = request;
    return request;
  }
  function assertActive() { if (stopped) throw new Error("recovery_client_closed"); }
  async function action(input: typeof sessionRecoveryRpc.input._input) {
    assertActive();
    await client.rpc(sessionRecoveryRpc, input);
    // Do not let a stale in-flight read hide a successful mutation.
    await flight; await refresh();
  }
  async function savePolicy(patch: Pick<RecoveryPolicy, "enabled" | "intervalSeconds" | "maxDurationMinutes" | "method" | "continueMessage">) {
    assertActive();
    const current = await client.rpc(recoverySettingsRpc.read, {});
    assertActive();
    if (current.status !== "ready") throw new Error(current.error);
    const values = recoveryPolicySchema.parse({ ...recoveryPolicySchema.parse(current.values), ...patch });
    const result = await client.rpc(recoverySettingsRpc.write, { revision: current.revision, values });
    if (result.status !== "saved") throw new Error(result.error);
    await flight; await refresh();
  }
  function close() { stopped = true; if (timer !== undefined) clearInterval(timer); timer = undefined; listeners.clear(); snapshot = { ...snapshot, sessions: [] }; signature = ""; }
  return { getSnapshot, subscribe, start, refresh, action, savePolicy, close, observe, setForeground };
}
export type RecoveryClientStore = ReturnType<typeof createRecoveryClientStore>;
