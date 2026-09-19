import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";

type EventTargetLike = {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
};

type DocumentLike = EventTargetLike & { visibilityState?: string };

const FOREGROUND_REFRESH_DEBOUNCE_MS = 1_500;

export function useRefreshOnForeground(enabled: boolean, refresh: () => void): void {
  const refreshRef = useRef(refresh);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const trigger = () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < FOREGROUND_REFRESH_DEBOUNCE_MS) return;
      lastRefreshAt.current = now;
      refreshRef.current();
    };

    if (Platform.OS === "web") {
      const web = globalThis as unknown as EventTargetLike & { document?: DocumentLike };
      const documentTarget = web.document;
      const visible = () => documentTarget?.visibilityState !== "hidden";
      let wasHidden = documentTarget?.visibilityState === "hidden";
      let wasBlurred = false;
      const onVisibilityChange = () => {
        const hidden = documentTarget?.visibilityState === "hidden";
        if (!hidden && wasHidden) trigger();
        wasHidden = hidden;
      };
      const onBlur = () => { wasBlurred = true; };
      const onFocus = () => {
        if (wasBlurred && visible()) trigger();
        wasBlurred = false;
      };
      documentTarget?.addEventListener?.("visibilitychange", onVisibilityChange);
      web.addEventListener?.("blur", onBlur);
      web.addEventListener?.("focus", onFocus);
      return () => {
        documentTarget?.removeEventListener?.("visibilitychange", onVisibilityChange);
        web.removeEventListener?.("blur", onBlur);
        web.removeEventListener?.("focus", onFocus);
      };
    }

    const appState = AppState as unknown as { currentState?: string; addEventListener?: (event: string, listener: (state: string) => void) => { remove?: () => void } | undefined } | undefined;
    if (!appState?.addEventListener) return;
    let previousState = appState.currentState;
    const subscription = appState.addEventListener("change", (nextState) => {
      if (nextState === "active" && previousState !== "active") trigger();
      previousState = nextState;
    });
    return () => { try { subscription?.remove?.(); } catch { /* optional native API */ } };
  }, [enabled]);
}
