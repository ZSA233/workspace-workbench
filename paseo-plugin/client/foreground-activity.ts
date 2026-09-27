import { useCallback, useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { observeWebForeground, webForeground, type WebForegroundTarget } from "./web-foreground";
import { reportNativeDiagnostic } from "./native-diagnostics.ts";

function currentForeground(): boolean {
  if (Platform.OS === "web") return webForeground(globalThis as WebForegroundTarget);
  const appState = AppState as unknown as { currentState?: string } | undefined;
  return !appState?.currentState || appState.currentState === "active";
}

export function useForegroundActivity(): boolean {
  const [active, setActive] = useState(currentForeground);
  useEffect(() => {
    reportNativeDiagnostic("hook-effect-start", { hook: "foreground-activity" });
    if (Platform.OS === "web") return observeWebForeground(globalThis as WebForegroundTarget, setActive);
    setActive(currentForeground());
    const appState = AppState as unknown as { addEventListener?: (event: string, listener: (state: string) => void) => { remove?: () => void } | undefined } | undefined;
    if (!appState?.addEventListener) {
      reportNativeDiagnostic("hook-effect-complete", { hook: "foreground-activity", result: "no-app-state" });
      return;
    }
    try {
      const subscription = appState.addEventListener("change", (state) => setActive(state === "active"));
      reportNativeDiagnostic("hook-effect-complete", { hook: "foreground-activity", result: "subscribed" });
      return () => { try { subscription?.remove?.(); } catch { /* optional native API */ } };
    } catch {
      reportNativeDiagnostic("hook-effect-complete", { hook: "foreground-activity", result: "subscribe-failed" });
      return;
    }
  }, []);
  return active;
}

/** Host tabs can remain mounted with display:none; window focus alone is insufficient. */
export function usePanelForeground() {
  const windowActive = useForegroundActivity();
  const [target, setTarget] = useState<unknown>(null);
  const [visible, setVisible] = useState(Platform.OS !== 'web');
  const ref = useCallback((value: unknown) => setTarget(value), []);
  useEffect(() => {
    if (Platform.OS !== 'web') { setVisible(true); return; }
    if (!target) return;
    type Observer = { observe(element: unknown): void; disconnect(): void };
    const constructor = (globalThis as unknown as { IntersectionObserver?: new (callback: (entries: { isIntersecting: boolean }[]) => void) => Observer }).IntersectionObserver;
    if (!constructor) { setVisible(true); return; }
    const observer = new constructor(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    try { observer.observe(target); } catch { setVisible(true); }
    return () => observer.disconnect();
  }, [target]);
  return { foreground: windowActive && visible, ref };
}
