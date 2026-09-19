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
