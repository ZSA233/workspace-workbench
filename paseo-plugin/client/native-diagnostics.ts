import { CLIENT_GENERATION } from "./initialization";

export type NativeDiagnostic = {
  phase: string;
  platform: string;
  details: Record<string, string>;
};

type Reporter = (event: NativeDiagnostic) => void | Promise<void>;

let platform = "unknown";
let reporter: Reporter | null = null;
const emitted = new Set<string>();

export function configureNativeDiagnosticReporter(next: { platform: string; report: Reporter } | null): void {
  platform = next?.platform || "unknown";
  reporter = next?.report || null;
  if (!next) emitted.clear();
}

export function reportNativeDiagnostic(phase: string, details: Record<string, string> = {}): void {
  const normalized = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, String(value).slice(0, 4000)]));
  const event: NativeDiagnostic = { phase, platform, details: { pluginGeneration: CLIENT_GENERATION, ...normalized } };
  const key = `${phase}:${JSON.stringify(normalized)}`;
  if (emitted.has(key)) return;
  emitted.add(key);
  console.error("workbench_client_diagnostic", JSON.stringify(event));
  try {
    const pending = reporter?.(event);
    if (pending && typeof (pending as Promise<void>).catch === "function") void (pending as Promise<void>).catch(() => {});
  } catch {
    // Client diagnostics must never affect plugin rendering.
  }
}

/**
 * React Native can surface render failures through the host console instead of
 * the plugin callback. Capture only the two known shape errors while retaining
 * the original console behavior. This is deliberately installed per plugin
 * generation and removed on unload, so it cannot accumulate across reloads.
 */
export function installNativeRenderErrorHook(): () => void {
  if (platform === "web") return () => {};
  const original = console.error;
  let reporting = false;
  const capture = (message: string) => {
    if (reporting || !/Element type is invalid|prototype of undefined|Cannot read .*prototype|got: undefined/i.test(message)) return;
    reporting = true;
    try {
      const event: NativeDiagnostic = {
        phase: "android-render-error",
        platform,
        details: {
          pluginGeneration: CLIENT_GENERATION,
          message: message.slice(0, 4000),
        },
      };
      const pending = reporter?.(event);
      if (pending && typeof (pending as Promise<void>).catch === "function") void (pending as Promise<void>).catch(() => {});
    } finally {
      reporting = false;
    }
  };
  const hooked = (...args: unknown[]) => {
    original(...args);
    const message = args.map((value) => value instanceof Error ? `${value.message}\n${value.stack || ""}` : typeof value === "string" ? value : safeDiagnosticValue(value)).join(" ");
    capture(message);
  };
  console.error = hooked;
  const errorUtils = (globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
      setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
    };
  }).ErrorUtils;
  const previousGlobalHandler = errorUtils?.getGlobalHandler?.();
  const globalHandler = (error: unknown, isFatal?: boolean) => {
    capture(`${error instanceof Error ? error.message : String(error)}${isFatal ? "\n[fatal]" : ""}${error instanceof Error && error.stack ? `\n${error.stack}` : ""}`);
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

function safeDiagnosticValue(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return String(value);
  }
}
