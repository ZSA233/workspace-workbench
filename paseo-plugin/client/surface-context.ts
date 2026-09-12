import type { PaseoApi } from "@getpaseo/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export type WorkbenchSurfaceProps = PluginSurfaceProps & {
  target?: { workspaceId: string; agentId?: string };
};

/** Surface hosts do not supply the Workspace Panel's state-hook provider. */
export async function readSurfaceWorkspace(paseo: PaseoApi, workspaceId: string) {
  const handle = paseo.workspaces.ref(workspaceId);
  const workspace = await handle.refresh();
  if (!workspace || !handle.directory) throw new Error("host_workspace_unavailable");
  return { directory: handle.directory, name: handle.name || workspaceId };
}
