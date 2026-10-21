import { CLIENT_GENERATION } from "./initialization.ts";

export type NativeDiagnostic = {
  phase: string;
  platform: string;
  details: Record<string, string>;
};

type Reporter = (event: NativeDiagnostic) => void | Promise<void>;

let platform = "unknown";
let reporter: Reporter | null = null;
const emitted = new Set<string>();
let clientInstance = "", configuredAt = 0;
let errorsOnly = false;

export function configureNativeDiagnosticReporter(next: { platform: string; report: Reporter; errorsOnly?: boolean } | null): void {
  platform = next?.platform || "unknown";
  reporter = next?.report || null;
  errorsOnly = Boolean(next?.errorsOnly);
  configuredAt = Date.now(); clientInstance = `${configuredAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (!next) emitted.clear();
}

export function reportNativeDiagnostic(phase: string, details: Record<string, string> = {}): void {
  // Android ordinary chat must not format, retain or send routine render and
  // registration telemetry. Keep one installation marker and explicit failures.
  if (errorsOnly && phase !== "android-client-policy" && !/fatal|failed|error/.test(phase)) return;
  const normalized = Object.fromEntries(Object.entries(details).slice(0, 32).map(([key, value]) => [key.slice(0, 120), String(value).slice(0, 4000)]));
  const event: NativeDiagnostic = { phase, platform, details: { ...normalized, pluginGeneration: CLIENT_GENERATION, clientInstance, uptimeMs: String(Date.now() - configuredAt) } };
  const key = `${phase}:${JSON.stringify(normalized)}`;
  if (emitted.has(key)) return;
  emitted.add(key);
  if (emitted.size > 256) emitted.delete(emitted.values().next().value!);
  // Routine registration is not a React Native exception. Avoid LogBox/error
  // stack handling for every successful stage on the app's global console.
  const log = /fatal|failed|error/.test(phase) ? console.error : console.info;
  log("workbench_client_diagnostic", JSON.stringify(event));
  try {
    const pending = reporter?.(event);
    if (pending && typeof (pending as Promise<void>).catch === "function") void (pending as Promise<void>).catch(() => {});
  } catch {
    // Client diagnostics must never affect plugin rendering.
  }
}

/**
 * React Native can surface render failures through the host console instead of
 * the plugin callback. Capture render failures and fatal errors while retaining
 * the original console behavior. This is deliberately installed per plugin
 * generation and removed on unload, so it cannot accumulate across reloads.
 */
export function installNativeRenderErrorHook(): () => void {
  if (platform === "web") return () => {};
  const original = console.error;
  let reporting = false;
  let lastCaptureAt = -Infinity;
  const capture = (message: string, fatal = false) => {
    if (reporting || (!fatal && !/Element type is invalid|prototype of undefined|Cannot read .*prototype|got: undefined|out of memory|heap limit|Maximum (update depth|call stack)|Invariant Violation/i.test(message)) || Date.now() - lastCaptureAt < 1000) return;
    reporting = true;
    lastCaptureAt = Date.now();
    try {
      reportNativeDiagnostic(fatal ? "native-js-fatal" : "android-render-error", { message: message.slice(0, 4000) });
    } catch {
      // The host RPC can throw synchronously while a client is disconnecting.
    } finally {
      reporting = false;
    }
  };
  const hooked = (...args: unknown[]) => {
    original(...args);
    // Never serialize arbitrary React/fiber objects on the error path.
    const message = args.slice(0, 4).map((value) => value instanceof Error ? `${value.message}\n${value.stack || ""}`.slice(0, 4000) : typeof value === "string" ? value.slice(0, 4000) : "[non-string diagnostic argument]").join(" ");
    capture(message);
  };
  console.error = hooked;
  const errorUtils = (globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  }).ErrorUtils;
  let previousGlobalHandler: ((error: unknown, isFatal?: boolean) => void) | undefined;
  try { previousGlobalHandler = errorUtils?.getGlobalHandler?.(); } catch { /* optional native hook */ }
  const globalHandler = (error: unknown, isFatal?: boolean) => {
    try {
      const value = error as { message?: unknown; stack?: unknown } | null;
      const message = typeof value?.message === "string" ? value.message.slice(0, 4000) : String(error).slice(0, 4000);
      const stack = typeof value?.stack === "string" ? value.stack.slice(0, 4000) : "";
      capture(`${message}${isFatal ? "\n[fatal]" : ""}${stack ? `\n${stack}` : ""}`, Boolean(isFatal));
    } catch { /* Even an unprintable native exception must reach the host handler. */ }
    previousGlobalHandler?.(error, isFatal);
  };
  try { errorUtils?.setGlobalHandler?.(globalHandler); } catch { /* optional native hook */ }
  return () => {
    if (console.error === hooked) console.error = original;
    try {
      if (errorUtils?.getGlobalHandler?.() === globalHandler) errorUtils?.setGlobalHandler?.(previousGlobalHandler || (() => {}));
    } catch { /* optional native hook */ }
  };
}
