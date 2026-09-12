import type { PluginClientContext } from "@getpaseo/plugin/client";

import { clearFileReviews, configureFileReviewOpener, openFileReview } from "./client/file-review-store";
import { copy } from "./shared/copy";
import { FileReviewPanel } from "./client/file-review";
import { WorkbenchPanel, WorkbenchSurfacePanel } from "./client/panel";

const observerSurfaceId = "workspace-workbench-surface";

export default function contribute(client: PluginClientContext) {
  const surfaceCleanup = client.addSurface(observerSurfaceId, WorkbenchSurfacePanel);
  const sidebarCleanup = client.addSidebarItem({
    id: "workspace-workbench-sidebar",
    title: "Workspace Workbench",
    icon: "GitBranch",
    surface: observerSurfaceId,
  });
  const panelCleanups = [
    surfaceCleanup,
    sidebarCleanup,
    client.addWorkspacePanel({
      id: "workspace-workbench-workspace",
      title: "Workspace Workbench",
      icon: "GitBranch",
      context: "workspace",
      locations: ["explorer"],
      Component: WorkbenchPanel,
    }),
    client.addWorkspacePanel({
      id: "workspace-workbench-agent",
      title: "Workspace Workbench",
      icon: "GitBranch",
      context: "agent",
      locations: ["explorer"],
      Component: WorkbenchPanel,
    }),
    client.addWorkspacePanel({
      id: "workspace-workbench-file",
      title: "Workspace Changes",
      icon: "FileDiff",
      context: "workspace",
      locations: ["workspace"],
      Component: FileReviewPanel,
    }),
    client.addWorkspacePanel({
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
    const registration = headerButtons.get(workspaceId);
    if (!registration) return;
    registration.remove();
    headerButtons.delete(workspaceId);
  };

  const addHeaderButton = (workspaceId: string) => {
    if (disposed || headerButtons.has(workspaceId)) return;
    headerButtons.set(
      workspaceId,
      client.addHeaderButton({
        id: "workspace-workbench",
        workspaceId,
        button: {
          title: "Open Workspace Workbench",
          icon: "GitBranch",
          label: copy.headerLabel,
          behavior: {
            kind: "action",
            onPress() {
              client.openPanel("workspace-workbench-workspace", {
                workspaceId,
                location: "explorer",
              });
            },
          },
        },
      }),
    );
  };

  const unsubscribeWorkspaces = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") {
      addHeaderButton(update.workspace.id);
    } else {
      removeHeaderButton(update.id);
      clearFileReviews(update.id);
    }
  });

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
    client.addCommandCenterItem({
      id: "open-workspace-workbench",
      title: "Open Workspace Workbench",
      icon: "GitBranch",
      keywords: ["workspace", "git", "branch", "review", "changes"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("workspace-workbench-workspace", { location: "explorer" });
      },
    }),
    client.addCommandCenterItem({
      id: "open-workspace-workbench-agent",
      title: "Open Workspace Workbench",
      icon: "GitBranch",
      keywords: ["workspace", "git", "branch", "review", "changes"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("workspace-workbench-agent", { location: "explorer" });
      },
    }),
  ];

  return () => {
    disposed = true;
    removeFileReviewOpener();
    for (const cleanup of panelCleanups) cleanup();
    for (const cleanup of commandCleanups) cleanup();
    unsubscribeWorkspaces();
    for (const workspaceId of headerButtons.keys()) {
      removeHeaderButton(workspaceId);
    }
  };
}
