import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { observerSettings, observerSettingsRpc } from "../shared/settings.ts";

export function chooseProject<T extends { configPath: string }>(projects: T[], contextual: T | undefined, chosen: string, saved: string, hasContext: boolean) {
  // A workspace directory is authoritative. If it has no matching project,
  // keep the caller in setup instead of silently showing a project remembered
  // from another directory.
  if (hasContext) return contextual;
  return projects.find((project) => project.configPath === chosen)
    || projects.find((project) => project.configPath === saved)
    || (projects.length === 1 ? projects[0] : undefined);
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
        const result = await write({ revision: current.revision, values: { ...values, lastProjectByHost: { ...values.lastProjectByHost, [hostId]: configPath } } });
        if (result.status === "saved") return;
      }
    }).catch(() => {});
  }, [hostId, ready, read, write]);
  return { ready, saved, remember };
}
