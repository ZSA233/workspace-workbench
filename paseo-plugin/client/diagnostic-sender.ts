import type { PluginClientContext } from "@getpaseo/plugin/client";
import { clientDiagnostic, clientDiagnosticBatch } from "../shared/client-diagnostics.ts";
import type { NativeDiagnostic } from "./native-diagnostics.ts";

/** Bound telemetry memory and RPC concurrency; never retry failed telemetry. */
export function createDiagnosticSender(client: PluginClientContext) {
  const pending: NativeDiagnostic[] = [];
  let closed = false, running = false, urgent = 0;
  function flush() {
    if (closed || running || !pending.length) return;
    running = true;
    const events = pending.splice(0, 16);
    void Promise.resolve().then(() => closed ? null : client.rpc(clientDiagnosticBatch, { events })).catch(() => {}).finally(() => { running = false; flush(); });
  }
  function report(event: NativeDiagnostic) {
    if (closed) return;
    if (/fatal|failed|error/.test(event.phase)) {
      // Fatal registration can unload immediately. Dispatch its evidence before
      // cleanup instead of losing it in the ordinary startup batch.
      if (urgent >= 2) return;
      urgent++;
      try { void Promise.resolve(client.rpc(clientDiagnostic, event)).catch(() => {}).finally(() => { urgent--; }); }
      catch { urgent--; }
      return;
    }
    if (pending.length >= 64) pending.shift();
    pending.push(event);
    if (!running) { running = true; void Promise.resolve().then(() => { running = false; flush(); }); }
  }
  return { report, close: () => { closed = true; pending.length = 0; } };
}
