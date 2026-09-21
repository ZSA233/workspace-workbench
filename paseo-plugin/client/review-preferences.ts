import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";

import { observerSettings, observerSettingsRpc } from "../shared/settings";
import { effectiveReviewMode, type ReviewMode } from "./review-mode";
import { reportNativeDiagnostic } from "./native-diagnostics.ts";

function parseMode(value: unknown): ReviewMode | null {
  return value === "split" || value === "unified" ? value : null;
}

/**
 * Persists only the user's wide-panel preference. A compact panel is always
 * unified, but it must not erase the preference that will be restored on a
 * wide panel later.
 */
export function useReviewModePreference(scopeKey: string, compact: boolean) {
  const native = Platform.OS !== "web";
  const read = useRpc(observerSettingsRpc.read);
  const write = useRpc(observerSettingsRpc.write);
  const [savedMode, setSavedMode] = useState<ReviewMode | null>(null);
  const [ready, setReady] = useState(false);
  const pendingRef = useRef<ReviewMode | null>(null);
  const readyRef = useRef(false);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    reportNativeDiagnostic("hook-effect-start", { hook: "review-preferences-read" });
    if (native) {
      reportNativeDiagnostic("hook-effect-complete", { hook: "review-preferences-read", result: "native-local" });
      return;
    }
    let disposed = false;
    void read({}).then((result) => {
      if (disposed || result.status !== "ready") return;
      const parsed = observerSettings.schema.safeParse(result.values);
      if (!parsed.success) return;
      const mode = parseMode(parsed.data.reviewModeByPaseoWorkspace[scopeKey]);
      setSavedMode(mode);
    }).catch(() => {}).finally(() => {
      reportNativeDiagnostic("hook-effect-complete", { hook: "review-preferences-read", result: "settled" });
      if (!disposed) setReady(true);
    });
    return () => { disposed = true; };
  }, [native, read, scopeKey]);

  const persist = useCallback((mode: ReviewMode) => {
    if (native) return;
    queue.current = queue.current.then(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await read({});
        if (current.status !== "ready") return;
        const parsed = observerSettings.schema.safeParse(current.values);
        if (!parsed.success) return;
        const result = await write({
          revision: current.revision,
          values: {
            ...parsed.data,
            reviewModeByPaseoWorkspace: {
              ...parsed.data.reviewModeByPaseoWorkspace,
              [scopeKey]: mode,
            },
          },
        });
        if (result.status === "saved") return;
      }
    }).catch(() => {
      // The local mode remains usable if settings are unavailable.
    });
  }, [native, read, scopeKey, write]);

  useEffect(() => {
    // Native panels keep this preference local. Do not touch the readiness
    // refs or enqueue persistence work on Android; the extra effect/update
    // path is unnecessary there and can run while the native diff surface is
    // still mounting.
    if (native) return;
    reportNativeDiagnostic("hook-effect-start", { hook: "review-preferences-ready" });
    readyRef.current = ready;
    const pending = ready ? pendingRef.current : null;
    if (pending) {
      pendingRef.current = null;
      persist(pending);
    }
  }, [native, persist, ready]);

  const setMode = useCallback((mode: ReviewMode) => {
    setSavedMode(mode);
    pendingRef.current = mode;
    if (readyRef.current) {
      pendingRef.current = null;
      persist(mode);
    }
  }, [persist]);

  const mode = effectiveReviewMode(compact, savedMode);
  return { mode, setMode };
}
