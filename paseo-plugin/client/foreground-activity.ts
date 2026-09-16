import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import { observeWebForeground, webForeground, type WebForegroundTarget } from "./web-foreground";

function currentForeground(): boolean {
  if (Platform.OS === "web") return webForeground(globalThis as WebForegroundTarget);
  return !AppState.currentState || AppState.currentState === "active";
}

export function useForegroundActivity(): boolean {
  const [active, setActive] = useState(currentForeground);
  useEffect(() => {
    if (Platform.OS === "web") return observeWebForeground(globalThis as WebForegroundTarget, setActive);
    setActive(currentForeground());
    const subscription = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => subscription.remove();
  }, []);
  return active;
}
