import { useSyncExternalStore } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export type WorkbenchWorkspaceSnapshot = {
  id: string;
  directory: string;
  name: string;
};

export type WorkbenchSurfaceProps = PluginSurfaceProps & {
  target?: { workspaceId: string; agentId?: string };
};

const snapshots = new Map<string, WorkbenchWorkspaceSnapshot>();
const listeners = new Set<() => void>();

export function setWorkbenchWorkspaceSnapshot(snapshot: WorkbenchWorkspaceSnapshot): void {
  if (!snapshot.id || !snapshot.directory) return;
  const previous = snapshots.get(snapshot.id);
  if (previous?.directory === snapshot.directory && previous.name === snapshot.name) return;
  snapshots.set(snapshot.id, snapshot);
  listeners.forEach((listener) => listener());
}

export function removeWorkbenchWorkspaceSnapshot(id: string): void {
  if (!snapshots.delete(id)) return;
  listeners.forEach((listener) => listener());
}

export function clearWorkbenchWorkspaceSnapshots(): void {
  if (!snapshots.size) return;
  snapshots.clear();
  listeners.forEach((listener) => listener());
}

export function useWorkbenchWorkspaceSnapshot(workspaceId: string): WorkbenchWorkspaceSnapshot | null {
  // Keep this store local to the plugin. It avoids depending on the optional
  // host state provider, which is not present in every native Surface host.
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => workspaceId ? snapshots.get(workspaceId) || null : null,
    () => workspaceId ? snapshots.get(workspaceId) || null : null,
  );
}
