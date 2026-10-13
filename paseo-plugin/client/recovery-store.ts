import type { PluginClientContext } from "@getpaseo/plugin/client";
import { recoveryPolicySchema, recoverySettingsRpc, sessionRecoveryRpc, type RecoveryPolicy, type RecoverySession } from "../shared/session-recovery";

export type RecoveryClientSnapshot = { sessions: RecoverySession[]; policy: RecoveryPolicy; available: boolean; nativeAvailable: boolean; loaded: boolean; error: string | null };
/** One observation per client installation, shared by the screen and every pill. */
export class RecoveryClientStore {
  private snapshot: RecoveryClientSnapshot = { sessions: [], policy: recoveryPolicySchema.parse({}), available: false, nativeAvailable: false, loaded: false, error: null };
  private listeners = new Set<() => void>();
  private flight: Promise<void> | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private client: PluginClientContext;
  constructor(client: PluginClientContext) { this.client = client; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: RecoveryClientSnapshot) {
    if (this.stopped) return;
    this.snapshot = snapshot; this.listeners.forEach(listener => listener());
  }
  start() {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 5000);
  }
  refresh = (): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    this.flight = this.client.rpc(sessionRecoveryRpc, { action: "list" }).then(result => {
      this.publish({ sessions: result.sessions, policy: result.policy, available: result.available, nativeAvailable: result.nativeAvailable, loaded: true, error: result.error || null });
    }, error => {
      this.publish({ ...this.snapshot, available: false, loaded: true, error: error instanceof Error ? error.message : String(error),
        sessions: this.snapshot.sessions.map(session => ({ ...session, status: "unavailable", enabled: false })) });
    }).finally(() => { this.flight = null; });
    return this.flight;
  };
  async action(input: typeof sessionRecoveryRpc.input._input) {
    await this.client.rpc(sessionRecoveryRpc, input);
    // Do not let a stale in-flight read hide a successful mutation.
    await this.flight; await this.refresh();
  }
  async savePolicy(patch: Pick<RecoveryPolicy, "enabled" | "intervalSeconds" | "maxDurationMinutes" | "method" | "continueMessage">) {
    const current = await this.client.rpc(recoverySettingsRpc.read, {});
    if (current.status !== "ready") throw new Error(current.error);
    const values = recoveryPolicySchema.parse({ ...recoveryPolicySchema.parse(current.values), ...patch });
    const result = await this.client.rpc(recoverySettingsRpc.write, { revision: current.revision, values });
    if (result.status !== "saved") throw new Error(result.error);
    await this.flight; await this.refresh();
  }
  close() { this.stopped = true; clearInterval(this.timer); this.listeners.clear(); }
}
