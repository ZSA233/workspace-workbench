import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Platform, Text, View } from "react-native";
import { useEffect, useSyncExternalStore } from "react";
import { contextSurfacePrefix, createOpenGuard, workbenchDestination } from "./client/open-workbench";

import { clearFileReviews, configureFileReviewOpener, openFileReview } from "./client/file-review-store";
import { copy } from "./shared/copy";
import { FileReviewPanel, WorkbenchPanel, WorkbenchSurfacePanel } from "./client/entry-panels";
import { atInitializationStage, INITIALIZATION_REVISION } from "./client/initialization";

const observerSurfaceId = "workbench";

export default function contribute(client: PluginClientContext) {
  return atInitializationStage("registration", () => contributeClient(client));
}

function contributeClient(client: PluginClientContext) {
  function registerPanel(panel: Parameters<PluginClientContext["addWorkspacePanel"]>[0]) {
    return atInitializationStage(`panel:${panel.id}`, () => client.addWorkspacePanel(panel));
  }
  function registerCommand(command: Parameters<PluginClientContext["addCommandCenterItem"]>[0]) {
    return atInitializationStage(`command:${command.id}`, () => client.addCommandCenterItem(command));
  }
  const platform: string = atInitializationStage("platform", () => Platform.OS);
  const openGuard = createOpenGuard();
  const contextSurfaces = new Map<string, () => void>();
  let surfaceContext: { workspaceId: string; agentId?: string; key: string } | null = null;
  const surfaceListeners = new Set<() => void>();
  let surfaceMounts = 0;
  function ContextualSurface(props: PluginSurfaceProps) {
    const context = useSyncExternalStore((listener) => { surfaceListeners.add(listener); return () => { surfaceListeners.delete(listener); }; }, () => surfaceContext, () => surfaceContext);
    useEffect(() => {
      surfaceMounts++;
      return () => {
        surfaceMounts--;
        void Promise.resolve().then(() => { if (surfaceMounts === 0) surfaceContext = null; });
      };
    }, []);
    if (!context) return <WorkbenchSurfacePanel {...props} />;
    return <WorkbenchSurfacePanel key={context.key} {...props} target={{ workspaceId: context.workspaceId, agentId: context.agentId }} />;
  }
  function openWorkbench(workspaceId: string, agentId?: string) {
    const destination = workbenchDestination(platform, workspaceId, agentId);
    if (!openGuard.allow(`${destination.kind}:${destination.id}:${workspaceId}`)) return;
    try {
      if (destination.kind === "panel") client.openPanel(destination.id, destination.options);
      else {
        if (surfaceContext?.key !== destination.id) {
          surfaceContext = { workspaceId, agentId, key: destination.id };
          surfaceListeners.forEach((listener) => listener());
        }
        // The host obtains the sheet title from the sidebar registration.
        // Reuse its named surface while keeping selection in a separate store.
        client.openSurface(observerSurfaceId);
      }
    } catch (error) {
      console.error("workbench_open_failed", error);
      // The global surface remains an explicit recovery entry.
      client.openSurface("workspace-workbench-open-failed");
    }
  }
  function FailureSurface(props: PluginSurfaceProps) {
    return <View style={{ flex: 1 }}><Text style={{ padding: 12, color: props.theme.colors.statusWarning }}>{copy.openFailed}</Text><WorkbenchSurfacePanel {...props} /></View>;
  }
  const surfaceCleanup = atInitializationStage("surface", () => client.addSurface(observerSurfaceId, ContextualSurface));
  const failureCleanup = atInitializationStage("failure-surface", () => client.addSurface("workspace-workbench-open-failed", FailureSurface));
  const sidebarCleanup = atInitializationStage("sidebar", () => client.addSidebarItem({
    id: "workspace-workbench-sidebar",
    title: "Workspace Workbench",
    icon: "GitBranch",
    surface: observerSurfaceId,
  }));
  const panelCleanups = [
    surfaceCleanup,
    failureCleanup,
    sidebarCleanup,
    registerPanel({
      id: "workspace-workbench-workspace",
      title: "Workspace Workbench",
      icon: "GitBranch",
      context: "workspace",
      locations: ["explorer"],
      Component: WorkbenchPanel,
    }),
    registerPanel({
      id: "workspace-workbench-agent",
      title: "Workspace Workbench",
      icon: "GitBranch",
      context: "agent",
      locations: ["explorer"],
      Component: WorkbenchPanel,
    }),
    registerPanel({
      id: "workspace-workbench-file",
      title: "Workspace Changes",
      icon: "FileDiff",
      context: "workspace",
      locations: ["workspace"],
      Component: FileReviewPanel,
    }),
    registerPanel({
      id: "workspace-workbench-file-agent",
      title: "Workspace Changes",
      icon: "FileDiff",
      context: "agent",
      locations: ["workspace"],
      Component: FileReviewPanel,
    }),
  ];

  const removeFileReviewOpener = configureFileReviewOpener((request) => {
    if (!request.hostWorkspaceId && request.directory && request.selection) {
      const selection = request.selection;
      void client.paseo.workspaces.open(request.directory).then((workspace) => {
        if (disposed) return;
        openFileReview(selection, { ...request, hostWorkspaceId: workspace.id });
      }).catch((error) => console.error("file_panel_open_failed", error));
      return;
    }
    const options = {
      workspaceId: request.hostWorkspaceId,
      location: "workspace" as const,
      ...(request.agentId ? { agentId: request.agentId } : {}),
    };
    client.openPanel(request.panelId, options);
  });

  // Workspace panels are discoverable from Paseo's Explorer tab menu, but the
  // host does not pin third-party panels beside its built-in Files/Changes
  // tabs. Add a small workspace-header entry so the panel remains one click
  // away without registering a full-screen surface.
  const headerButtons = new Map<string, { remove(): void }>();
  let disposed = false;

  const removeHeaderButton = (workspaceId: string) => {
    if (surfaceContext?.workspaceId === workspaceId) { surfaceContext = null; surfaceListeners.forEach((listener) => listener()); }
    for (const [id, cleanup] of contextSurfaces) {
      if (id.startsWith(contextSurfacePrefix(workspaceId))) { cleanup(); contextSurfaces.delete(id); }
    }
    const registration = headerButtons.get(workspaceId);
    if (!registration) return;
    registration.remove();
    headerButtons.delete(workspaceId);
  };

  const addHeaderButton = (workspaceId: string) => {
    if (disposed || headerButtons.has(workspaceId)) return;
    headerButtons.set(
      workspaceId,
      atInitializationStage("header", () => client.addHeaderButton({
        id: "workspace-workbench",
        workspaceId,
        button: {
          title: "Open Workspace Workbench",
          icon: "GitBranch",
          label: copy.headerLabel,
          behavior: {
            kind: "action",
            onPress() {
              openWorkbench(workspaceId);
            },
          },
        },
      })),
    );
  };

  const unsubscribeWorkspaces = atInitializationStage("workspace-subscription", () => client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") {
      addHeaderButton(update.workspace.id);
    } else {
      removeHeaderButton(update.id);
      clearFileReviews(update.id);
    }
  }));

  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ entries }) => {
      for (const workspace of entries) addHeaderButton(workspace.id);
    })
    .catch(() => {
      // The Command Center and Explorer tab menu remain available if the
      // workspace directory is temporarily unavailable during app startup.
    });

  const commandCleanups = [
    registerCommand({
      id: "open-workspace-workbench",
      title: "Open Workspace Workbench",
      icon: "GitBranch",
      keywords: ["workspace", "git", "branch", "review", "changes"],
      context: "workspace",
      onSelect({ workspace }) {
        openWorkbench(workspace.id);
      },
    }),
    registerCommand({
      id: "open-workspace-workbench-agent",
      title: "Open Workspace Workbench",
      icon: "GitBranch",
      keywords: ["workspace", "git", "branch", "review", "changes"],
      context: "agent",
      onSelect({ workspace, agent }) {
        openWorkbench(workspace.id, agent.id);
      },
    }),
  ];

  console.info(`[workbench/${INITIALIZATION_REVISION}] registered`, platform);
  return () => {
    disposed = true;
    surfaceContext = null;
    surfaceListeners.clear();
    for (const cleanup of contextSurfaces.values()) cleanup();
    contextSurfaces.clear();
    removeFileReviewOpener();
    for (const cleanup of panelCleanups) cleanup();
    for (const cleanup of commandCleanups) cleanup();
    unsubscribeWorkspaces();
    for (const workspaceId of headerButtons.keys()) {
      removeHeaderButton(workspaceId);
    }
  };
}
