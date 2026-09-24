import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { observerSettings, observerSettingsRpc } from "../shared/settings.ts";

export function chooseProject<T extends { configPath: string }>(projects: T[], contextual: T | undefined, chosen: string, saved: string, hasContext: boolean, requireContext = false) {
  // A workspace directory is authoritative. If it has no matching project,
  // keep the caller in setup instead of silently showing a project remembered
  // from another directory.
  if (hasContext) return contextual;
  // A host workspace can be known before Paseo provides its directory. Keep a
  // manual choice and the host's remembered project usable in that window;
  // waiting for a second picker here made agent/workspace surfaces ask for a
  // project on every open. The explicit context above still wins whenever a
  // directory is available.
  if (requireContext) {
    return projects.find((project) => project.configPath === chosen)
      || projects.find((project) => project.configPath === saved)
      || [...projects].sort((a, b) => a.configPath.localeCompare(b.configPath))[0];
  }
  return projects.find((project) => project.configPath === chosen)
    || projects.find((project) => project.configPath === saved)
    // A global/sidebar surface has no directory to identify a project. Pick a
    // stable default and expose the three-dot project switcher for an
    // explicit change; this removes the startup chooser after a fresh install
    // while keeping the choice deterministic when no memory exists yet.
    || [...projects].sort((a, b) => a.configPath.localeCompare(b.configPath))[0];
}

export function useProjectMemory(hostId: string) {
  const read = useRpc(observerSettingsRpc.read);
  const write = useRpc(observerSettingsRpc.write);
  const [saved, setSaved] = useState("");
  const [ready, setReady] = useState(false);
  const latest = useRef("");
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    let disposed = false;
    void read({}).then((result) => {
      if (disposed || result.status !== "ready") return;
      const parsed = observerSettings.schema.safeParse(result.values);
      if (parsed.success) { const value = parsed.data.lastProjectByHost[hostId] || ""; latest.current = value; setSaved(value); }
    }).catch(() => {}).finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [hostId, read]);
  const remember = useCallback((configPath: string) => {
    if (!ready || latest.current === configPath) return;
    latest.current = configPath; setSaved(configPath);
    queue.current = queue.current.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await read({});
        if (current.status !== "ready") return;
        const values = observerSettings.schema.parse(current.values);
        const lastProjectByHost = { ...values.lastProjectByHost, [hostId]: configPath };
        // A global surface has no active Paseo Workspace context. Keep a
        // stable last-used project so opening that surface does not require a
        // project choice after every conversation switch.
        if (hostId !== "global") lastProjectByHost.global = configPath;
        const result = await write({ revision: current.revision, values: { ...values, lastProjectByHost } });
        if (result.status === "saved") return;
      }
    }).catch(() => {});
  }, [hostId, ready, read, write]);
  return { ready, saved, remember };
}
