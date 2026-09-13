import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  getWorkbenchCopy,
  resolveWorkbenchLocale,
  type WorkbenchCopy,
  type WorkbenchLocale,
} from "../shared/copy";

const LocaleContext = createContext<WorkbenchLocale | null>(null);

export function localeFromHostProps(props: unknown): WorkbenchLocale {
  if (!props || typeof props !== "object") return resolveWorkbenchLocale();
  const value = props as Record<string, unknown>;
  const host = value.host && typeof value.host === "object" ? value.host as Record<string, unknown> : null;
  return resolveWorkbenchLocale(value.locale || value.language || host?.locale || host?.language);
}

export function WorkbenchLocaleProvider({ locale, children }: { locale: WorkbenchLocale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useWorkbenchLocale(): WorkbenchLocale {
  return useContext(LocaleContext) || resolveWorkbenchLocale();
}

export function useWorkbenchCopy(): WorkbenchCopy {
  const locale = useWorkbenchLocale();
  return useMemo(() => getWorkbenchCopy(locale), [locale]);
}
