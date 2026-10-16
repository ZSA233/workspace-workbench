import type { PluginClientContext } from "@getpaseo/plugin/client";
import { recoveryPolicySchema, recoverySettingsRpc, sessionRecoveryRpc, type RecoveryPolicy, type RecoverySession } from "../shared/session-recovery.ts";

export type RecoveryClientSnapshot = { sessions: RecoverySession[]; policy: RecoveryPolicy; available: boolean; nativeAvailable: boolean; loaded: boolean; error: string | null };
/** One observation per client installation, shared by the screen and every pill. */
export function createRecoveryClientStore(client: PluginClientContext) {
  // The native host evaluates large source strings lazily. Constructing an
  // esbuild class in that path can fail before its constructor body runs.
  let snapshot: RecoveryClientSnapshot = { sessions: [], policy: recoveryPolicySchema.parse({}), available: false, nativeAvailable: false, loaded: false, error: null };
  const listeners = new Set<() => void>();
  let flight: Promise<void> | null = null;
  let stopped = false, started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => { if (stopped) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; };
  function publish(next: RecoveryClientSnapshot) {
    if (stopped) return;
    snapshot = next; listeners.forEach(listener => listener());
  }
  function start() {
    if (started || stopped) return;
    started = true;
    timer = setInterval(() => { void refresh(); }, 5000);
    void refresh();
  }
  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (flight) return flight;
    const request = Promise.resolve().then(() => stopped ? null : client.rpc(sessionRecoveryRpc, { action: "list" })).then(result => {
      if (result) publish({ sessions: result.sessions, policy: result.policy, available: result.available, nativeAvailable: result.nativeAvailable, loaded: true, error: result.error || null });
    }, error => {
      publish({ ...snapshot, available: false, loaded: true, error: error instanceof Error ? error.message : String(error),
        sessions: snapshot.sessions.map(session => ({ ...session, status: "unavailable", enabled: false })) });
    }).finally(() => { if (flight === request) flight = null; });
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
  function close() { stopped = true; clearInterval(timer); timer = undefined; listeners.clear(); }
  return { getSnapshot, subscribe, start, refresh, action, savePolicy, close };
}
export type RecoveryClientStore = ReturnType<typeof createRecoveryClientStore>;
