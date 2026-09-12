import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";

import {
  observerSettings,
  observerSettingsRpc,
  type ObserverSettingsValues,
} from "../shared/settings";
import {
  defaultObserverSectionLayout,
  normalizeObserverSectionLayout,
  type ObserverSectionId,
  type ObserverSectionLayout,
  type SectionLayoutPreference,
} from "./model";

type PreferenceEvent =
  | { scope: string; kind: "selection"; id: string }
  | { scope: string; kind: "section"; id: ObserverSectionId; patch: Partial<SectionLayoutPreference> }
  | { scope: string; kind: "collapse"; collapsed: boolean }
  | { scope: string; kind: "reset" }
  | { scope: string; kind: "resize"; layout: ObserverSectionLayout };
const preferenceListeners = new Set<(event: PreferenceEvent) => void>();
function publishPreference(event: PreferenceEvent): void {
  for (const listener of preferenceListeners) listener(event);
}

function emptySettingsValues(): ObserverSettingsValues {
  return {
    selectedWorkspaceByPaseoWorkspace: {},
    sectionLayoutByPaseoWorkspace: {},
    lastProjectByHost: {},
  };
}

function storedLayout(layout: ObserverSectionLayout): ObserverSettingsValues["sectionLayoutByPaseoWorkspace"][string] {
  return {
    repositories: { ...layout.repositories },
    graph: { ...layout.graph },
    changes: { ...layout.changes },
  };
}

type SettingsSnapshot =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; revision: string; error: string; values: ObserverSettingsValues }
  | { status: "ready"; revision: string; values: ObserverSettingsValues };

function settingsError(error: unknown): string {
  return error instanceof Error ? error.message : copy.text_3f2e139043;
}

function parsedSettings(values: unknown): ObserverSettingsValues | null {
  const result = observerSettings.schema.safeParse(values);
  return result.success ? result.data : null;
}

export type ObserverPreferences = {
  ready: boolean;
  hydrated: boolean;
  selectedWorkspaceId: string;
  savedWorkspaceId: string;
  sectionLayout: ObserverSectionLayout;
  selectWorkspace(id: string): void;
  updateSection(id: ObserverSectionId, patch: Partial<SectionLayoutPreference>): void;
  commitResize(sizes: Record<ObserverSectionId, number>): void;
  setAllSectionsCollapsed(collapsed: boolean): void;
  resetLayout(): void;
};

/**
 * Host-scoped Paseo settings for the observer's navigation and presentation
 * preferences. Git data remains owned by Observer; only small UI choices are
 * persisted here.
 */
export function useObserverPreferences(scopeKey: string): ObserverPreferences {
  const readSettings = useRpc(observerSettingsRpc.read);
  const writeSettings = useRpc(observerSettingsRpc.write);
  const settingsRef = useRef<SettingsSnapshot>({ status: "loading" });
  const [settings, setSettings] = useState<SettingsSnapshot>({ status: "loading" });
  const readGeneration = useRef(0);
  const [hydratedKey, setHydratedKey] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [savedWorkspaceId, setSavedWorkspaceId] = useState("");
  const [sectionLayout, setSectionLayout] = useState(defaultObserverSectionLayout);
  const writeQueue = useRef(Promise.resolve());

  useEffect(() => {
    const receive = (event: PreferenceEvent) => {
      if (event.scope !== scopeKey) return;
      if (event.kind === "selection") {
        setSelectedWorkspaceId(event.id);
        setSavedWorkspaceId(event.id);
      } else if (event.kind === "section") {
        setSectionLayout((current) => ({ ...current, [event.id]: { ...current[event.id], ...event.patch } }));
      } else if (event.kind === "resize") {
        setSectionLayout(event.layout);
      } else if (event.kind === "reset") {
        setSectionLayout(defaultObserverSectionLayout());
      } else {
        setSectionLayout((current) => ({ repositories: { ...current.repositories, collapsed: event.collapsed }, graph: { ...current.graph, collapsed: event.collapsed }, changes: { ...current.changes, collapsed: event.collapsed } }));
      }
    };
    preferenceListeners.add(receive);
    return () => { preferenceListeners.delete(receive); };
  }, [scopeKey]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const reload = useCallback(async (): Promise<void> => {
    const generation = readGeneration.current + 1;
    readGeneration.current = generation;
    const loading: SettingsSnapshot = { status: "loading" };
    settingsRef.current = loading;
    setSettings(loading);
    try {
      const result = await readSettings({});
      if (readGeneration.current !== generation) return;
      if (result.status === "ready") {
        const values = parsedSettings(result.values);
        const next: SettingsSnapshot = values
          ? { status: "ready", revision: result.revision, values }
          : { status: "invalid", revision: result.revision, error: copy.text_c075ee72ab, values: emptySettingsValues() };
        settingsRef.current = next;
        setSettings(next);
        return;
      }
      const next: SettingsSnapshot = {
        status: "invalid",
        revision: result.revision,
        error: result.error,
        values: emptySettingsValues(),
      };
      settingsRef.current = next;
      setSettings(next);
    } catch (error) {
      if (readGeneration.current !== generation) return;
      const next: SettingsSnapshot = { status: "error", error: settingsError(error) };
      settingsRef.current = next;
      setSettings(next);
    }
  }, [readSettings]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const ready = settings.status !== "loading";
  const revision = settings.status === "ready" || settings.status === "invalid"
    ? settings.revision
    : settings.status;
  const currentHydrationKey = scopeKey;

  useEffect(() => {
    if (!ready) return;
    if (hydratedKey === currentHydrationKey) return;
    const values = settings.status === "ready" ? settings.values : emptySettingsValues();
    const saved = values.selectedWorkspaceByPaseoWorkspace[scopeKey] || "";
    setSavedWorkspaceId(saved);
    setSelectedWorkspaceId(saved);
    setSectionLayout(
      normalizeObserverSectionLayout(values.sectionLayoutByPaseoWorkspace[scopeKey]),
    );
    setHydratedKey(currentHydrationKey);
  }, [currentHydrationKey, ready, scopeKey, settings.status]);

  const persist = useCallback((update: (values: ObserverSettingsValues) => ObserverSettingsValues): void => {
    writeQueue.current = writeQueue.current.then(async () => {
      const current = settingsRef.current;
      if (current.status !== "ready") return;
      let revision = current.revision;
      let values = update(current.values);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await writeSettings({ revision, values });
        if (result.status === "saved") {
          const parsed = parsedSettings(result.values);
          if (parsed) {
            const saved: SettingsSnapshot = { status: "ready", revision: result.revision, values: parsed };
            settingsRef.current = saved;
            setSettings(saved);
          }
          return;
        }
        if (attempt === 1) return;
        const fresh = await readSettings({});
        if (fresh.status !== "ready") return;
        const parsed = parsedSettings(fresh.values);
        if (!parsed) return;
        revision = fresh.revision;
        values = update(parsed);
      }
    }).catch(() => { /* Local selection stays usable when persistence fails. */ });
  }, [readSettings, writeSettings]);

  const selectWorkspace = useCallback((id: string): void => {
    publishPreference({ scope: scopeKey, kind: "selection", id });
    setSelectedWorkspaceId(id);
    setSavedWorkspaceId(id);
    persist((values) => ({
      ...values,
      selectedWorkspaceByPaseoWorkspace: {
        ...values.selectedWorkspaceByPaseoWorkspace,
        [scopeKey]: id,
      },
    }));
  }, [persist, scopeKey]);

  const updateSection = useCallback((id: ObserverSectionId, patch: Partial<SectionLayoutPreference>): void => {
    publishPreference({ scope: scopeKey, kind: "section", id, patch });
    setSectionLayout((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
    persist((values) => {
      const current = normalizeObserverSectionLayout(values.sectionLayoutByPaseoWorkspace[scopeKey]);
      const next = { ...current, [id]: { ...current[id], ...patch } };
      return {
        ...values,
        sectionLayoutByPaseoWorkspace: {
          ...values.sectionLayoutByPaseoWorkspace,
          [scopeKey]: storedLayout(next),
        },
      };
    });
  }, [persist, scopeKey]);

  const commitResize = useCallback((sizes: Record<ObserverSectionId, number>) => {
    const apply = (current: ObserverSectionLayout): ObserverSectionLayout => ({
      ...current,
      repositories: { ...current.repositories, height: current.repositories.collapsed ? current.repositories.height : Math.round(Math.min(600, Math.max(72, sizes.repositories))) },
      graph: { ...current.graph, height: current.graph.collapsed ? current.graph.height : Math.round(Math.min(600, Math.max(72, sizes.graph))) },
    });
    const next = apply(sectionLayout);
    setSectionLayout(next);
    publishPreference({ scope: scopeKey, kind: "resize", layout: next });
    persist((values) => ({ ...values, sectionLayoutByPaseoWorkspace: { ...values.sectionLayoutByPaseoWorkspace, [scopeKey]: storedLayout(apply(normalizeObserverSectionLayout(values.sectionLayoutByPaseoWorkspace[scopeKey]))) } }));
  }, [sectionLayout, scopeKey, persist]);

  const setAllSectionsCollapsed = useCallback((collapsed: boolean): void => {
    publishPreference({ scope: scopeKey, kind: "collapse", collapsed });
    setSectionLayout((current) => ({
      repositories: { ...current.repositories, collapsed },
      graph: { ...current.graph, collapsed },
      changes: { ...current.changes, collapsed },
    }));
    persist((values) => {
      const current = normalizeObserverSectionLayout(values.sectionLayoutByPaseoWorkspace[scopeKey]);
      const next: ObserverSectionLayout = {
        repositories: { ...current.repositories, collapsed },
        graph: { ...current.graph, collapsed },
        changes: { ...current.changes, collapsed },
      };
      return {
        ...values,
        sectionLayoutByPaseoWorkspace: {
          ...values.sectionLayoutByPaseoWorkspace,
          [scopeKey]: storedLayout(next),
        },
      };
    });
  }, [persist, scopeKey]);

  const resetLayout = useCallback((): void => {
    publishPreference({ scope: scopeKey, kind: "reset" });
    const next = defaultObserverSectionLayout();
    setSectionLayout(next);
    persist((values) => ({
      ...values,
      sectionLayoutByPaseoWorkspace: {
        ...values.sectionLayoutByPaseoWorkspace,
        [scopeKey]: storedLayout(next),
      },
    }));
  }, [persist, scopeKey]);

  return {
    ready,
    hydrated: ready && hydratedKey === currentHydrationKey,
    selectedWorkspaceId,
    savedWorkspaceId,
    sectionLayout,
    selectWorkspace,
    updateSection,
    commitResize,
    setAllSectionsCollapsed,
    resetLayout,
  };
}
import { copy } from "../shared/copy";
