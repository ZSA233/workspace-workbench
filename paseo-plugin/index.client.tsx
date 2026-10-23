import {configureDocumentOpener,clearDocuments,openDocument} from "./client/document-store";
import type { PluginAgentPanelProps, PluginClientContext, PluginSurfaceProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Platform, Text, View } from "react-native";
import { useEffect, useSyncExternalStore } from "react";
import { contextSurfacePrefix, createOpenGuard, workbenchDestination } from "./client/open-workbench";

import { clearFileReviews, configureFileReviewOpener, openFileReview } from "./client/file-review-store";
import { copy, getWorkbenchCopy } from "./shared/copy";
import { DocumentPanel, FileReviewPanel, WorkbenchPanel, WorkbenchSurfacePanel } from "./client/entry-panels";
import { atInitializationStage, createRegistrationScope, INITIALIZATION_REVISION, type RegistrationScope } from "./client/initialization";
import { localeFromHostProps } from "./client/i18n";
import { configureNativeDiagnosticReporter, installNativeRenderErrorHook, reportNativeDiagnostic } from "./client/native-diagnostics";
import { clearWorkbenchWorkspaceSnapshots, markWorkbenchWorkspaceSnapshotsReady, removeWorkbenchWorkspaceSnapshot, setWorkbenchWorkspaceSnapshot } from "./client/surface-context";
import { createRegistrationQueue } from "./client/registration-queue";
import { createDiagnosticSender } from "./client/diagnostic-sender";
import { createAndroidWorkspaceContext } from "./client/android-workspace-context";
import { connectPocket } from "./client/pocket-sdk/index";

const observerSurfaceId = "workbench";

// Paseo 0.8 exposes workspace actions on the injected API. Older desktop
// shells can still evaluate a plugin bundle before they enforce the manifest
// requirement, so keep the optional integration isolated and let Explorer
// panels continue to work when that API is absent.
type WorkspaceApiCompatibility = {
  open?: (directory: string) => Promise<{ id: string }>;
  subscribe?: (handler: (update: { kind: string; id: string; workspace?: { id: string; directory?: string | null; name?: string | null } }) => void) => () => void;
  list?: (options?: { subscribe?: Record<string, never>; page?: { limit: number; cursor?: string } }) => Promise<{
    entries: Array<{ id: string; directory?: string | null; workspaceDirectory?: string | null; name?: string | null }>;
    pageInfo?: { hasMore: boolean; nextCursor?: string | null };
    subscription?: { release(): Promise<void> };
  }>;
};

export default function contribute(client: PluginClientContext) {
  const scope = createRegistrationScope(reportNativeDiagnostic);
  const platform = Platform.OS || "unknown";
  const diagnosticSender = createDiagnosticSender(client);
  configureNativeDiagnosticReporter({ platform, report: diagnosticSender.report, errorsOnly: platform === "android" });
  scope.own("diagnostics", () => { configureNativeDiagnosticReporter(null); diagnosticSender.close(); });
  try {
    return atInitializationStage("registration", () => {
      if (platform !== "web" && platform !== "android") {
        scope.optional("native-render-error-hook", installNativeRenderErrorHook);
      }
      contributeClient(client, scope, platform);
      if (platform !== "android") {
        let retired = false;
        scope.own("recovery:module", () => { retired = true; });
        void import("./client/session-recovery").then(module => {
          if (!retired) scope.optional("recovery", () => module.registerRecoveryClient(client));
        }).catch(error => { if (!retired) scope.failure("recovery:module", error); });
      } else {
        reportNativeDiagnostic("android-client-policy", { recoveryUi: "disabled", workspaceObservation: "on-demand", globalErrorHook: "disabled" });
      }
      console.info(`[workbench/${INITIALIZATION_REVISION}] registered`, platform);
      return scope.close;
    });
  } catch (error) { scope.close(); throw error; }
}

function contributeClient(client: PluginClientContext, scope: RegistrationScope, platform: string) {
  const workspaceApi = ((client as unknown as { paseo?: { workspaces?: WorkspaceApiCompatibility } }).paseo)?.workspaces;
  const androidContext = platform === "android" ? createAndroidWorkspaceContext(workspaceApi) : null;
  if (androidContext) scope.own("android-workspace-context", androidContext.close);
  function ContextualWorkbenchPanel(props: PluginWorkspacePanelProps | PluginAgentPanelProps) {
    useEffect(() => androidContext?.observe(), []);
    return <WorkbenchPanel {...props} />;
  }
  function registerPanel(panel: Parameters<PluginClientContext["addWorkspacePanel"]>[0]) {
    return scope.register(`panel:${panel.id}`, () => client.addWorkspacePanel(panel));
  }
  function registerOptionalPanel(panel: Parameters<PluginClientContext["addWorkspacePanel"]>[0]) {
    // Secondary panel locations need not be available on every host.
    return scope.optional(`panel:${panel.id}`, () => client.addWorkspacePanel(panel));
  }
  function registerCommand(command: Parameters<PluginClientContext["addCommandCenterItem"]>[0]) {
    return scope.register(`command:${command.id}`, () => client.addCommandCenterItem(command));
  }
  const openGuard = createOpenGuard();
  const contextSurfaces = new Map<string, () => void>();
  let surfaceContext: { workspaceId: string; agentId?: string; key: string } | null = null;
  const surfaceListeners = new Set<() => void>();
  let surfaceMounts = 0;
  let disposed = false;
  const headerButtons = new Map<string, { remove(): void }>();
  const headerQueue = createRegistrationQueue({ deferred: platform !== "web", report: reportNativeDiagnostic });
  scope.own("workspace-state", () => {
    disposed = true;
    headerQueue.close();
    clearWorkbenchWorkspaceSnapshots();
    surfaceContext = null;
    surfaceListeners.clear();
    for (const cleanup of contextSurfaces.values()) cleanup();
    contextSurfaces.clear();
    for (const workspaceId of headerButtons.keys()) {
      try { removeHeaderButton(workspaceId); } catch (error) { scope.failure("header:cleanup", error); }
    }
  });
  function ContextualSurface(props: PluginSurfaceProps) {
    reportNativeDiagnostic("contextual-surface-entry", { hostId: props.host.id });
    const context = useSyncExternalStore((listener) => { surfaceListeners.add(listener); return () => { surfaceListeners.delete(listener); }; }, () => surfaceContext, () => surfaceContext);
    useEffect(() => {
      const releaseContext = androidContext?.observe();
      surfaceMounts++;
      return () => {
        releaseContext?.();
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
    useEffect(() => androidContext?.observe(), []);
    const copy = getWorkbenchCopy(localeFromHostProps(props));
    return <View style={{ flex: 1 }}><Text style={{ padding: 12, color: props.theme.colors.statusWarning }}>{copy.openFailed}</Text><WorkbenchSurfacePanel {...props} /></View>;
  }
  scope.register("surface", () => client.addSurface(observerSurfaceId, ContextualSurface));
  scope.register("failure-surface", () => client.addSurface("workspace-workbench-open-failed", FailureSurface));
  scope.register("sidebar", () => client.addSidebarItem({
    id: "workspace-workbench-sidebar",
    title: "Workspace Workbench",
    icon: "GitBranch",
    surface: observerSurfaceId,
  }));
  registerPanel({
    id: "workspace-workbench-workspace",
    title: "Workspace Workbench",
    icon: "GitBranch",
    context: "workspace",
    locations: ["explorer"],
    Component: platform === "android" ? ContextualWorkbenchPanel : WorkbenchPanel,
  });
  registerPanel({
    id: "workspace-workbench-agent",
    title: "Workspace Workbench",
    icon: "GitBranch",
    context: "agent",
    locations: ["explorer"],
    Component: platform === "android" ? ContextualWorkbenchPanel : WorkbenchPanel,
  });
  if (platform === "web") {
    const pocket = connectPocket(client);
    if (pocket) {
      scope.own("pocket-extension", () => pocket.dispose());
      pocket.ui.registerPanel({
        id: "workbench", title: copy.headerLabel, icon: "GitBranch", location: "right-sidebar",
        content: { workspacePanelId: "workspace-workbench-workspace", agentPanelId: "workspace-workbench-agent" },
      });
    }
  }
  registerOptionalPanel({
    id: "workspace-workbench-file",
    title: "Workspace Changes",
    // GitBranch is available in the native icon registry. Keep the
    // registration icon conservative; the panel itself still renders the
    // detailed diff UI after it has opened.
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace"],
    Component: FileReviewPanel,
  });
  registerOptionalPanel({
    id: "workspace-workbench-file-agent",
    title: "Workspace Changes",
    icon: "GitBranch",
    context: "agent",
    locations: ["workspace"],
    Component: FileReviewPanel,
  });

  registerOptionalPanel({id:'workspace-workbench-document',title:'File Viewer',icon:'GitBranch',context:'workspace',locations:['workspace'],Component:DocumentPanel});
  registerOptionalPanel({id:'workspace-workbench-document-agent',title:'File Viewer',icon:'GitBranch',context:'agent',locations:['workspace'],Component:DocumentPanel});
  scope.register('document-opener',()=>configureDocumentOpener((selection,back)=>{
    if(!selection.hostWorkspaceId&&selection.directory&&workspaceApi?.open){void workspaceApi.open(selection.directory).then(workspace=>{if(!disposed)openDocument({...selection,hostWorkspaceId:workspace.id});}).catch(error=>console.error('document_open_failed',error));return;}
    client.openPanel(back?(selection.agentId?'workspace-workbench-agent':'workspace-workbench-workspace'):(selection.agentId?'workspace-workbench-document-agent':'workspace-workbench-document'),{workspaceId:selection.hostWorkspaceId,agentId:selection.agentId,location:back?'explorer':'workspace'});
  }));

  scope.register("file-review-opener", () => configureFileReviewOpener((request) => {
    if (!request.hostWorkspaceId && request.directory && request.selection) {
      const selection = request.selection;
      if (!workspaceApi?.open) {
        console.error("file_panel_open_failed", "workspace_api_unavailable");
        return;
      }
      void workspaceApi.open(request.directory).then((workspace) => {
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
  }));

  // Workspace panels are discoverable from Paseo's Explorer tab menu, but the
  // host does not pin third-party panels beside its built-in Files/Changes
  // tabs. Add a small workspace-header entry so the panel remains one click
  // away without registering a full-screen surface.
  const removeHeaderButton = (workspaceId: string) => {
    headerQueue.cancel(workspaceId);
    if (surfaceContext?.workspaceId === workspaceId) { surfaceContext = null; surfaceListeners.forEach((listener) => listener()); }
    for (const [id, cleanup] of contextSurfaces) {
      if (id.startsWith(contextSurfacePrefix(workspaceId))) { cleanup(); contextSurfaces.delete(id); }
    }
    const registration = headerButtons.get(workspaceId);
    if (!registration) return;
    headerButtons.delete(workspaceId);
    registration.remove();
  };

  const addHeaderButton = (workspaceId: string) => {
    if (disposed || headerButtons.has(workspaceId)) return;
    headerQueue.enqueue(workspaceId, () => registerHeaderButton(workspaceId));
  };
  const registerHeaderButton = (workspaceId: string) => {
    if (disposed || headerButtons.has(workspaceId)) return;
    headerButtons.set(
      workspaceId,
      scope.step("header", () => client.addHeaderButton({
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

  if (platform !== "android" && workspaceApi?.subscribe) {
    scope.register("workspace-subscription", () => workspaceApi.subscribe!((update) => {
      if (disposed) return;
      if (update.kind === "upsert" && update.workspace) {
        addHeaderButton(update.workspace.id);
        if (update.workspace.directory) setWorkbenchWorkspaceSnapshot({ id: update.workspace.id, directory: update.workspace.directory, name: update.workspace.name || update.workspace.id });
      } else {
        removeHeaderButton(update.id);
        removeWorkbenchWorkspaceSnapshot(update.id);
        clearFileReviews(update.id); clearDocuments(update.id);
      }
    }));
  }

  if (platform !== "android" && workspaceApi?.list) {
    void workspaceApi
      .list({ subscribe: {} })
      .then(({ entries, subscription }) => {
        if (subscription) scope.own("workspace-directory-stream", () => { void subscription.release().catch(() => {}); });
        if (disposed) return;
        for (const workspace of entries) {
          addHeaderButton(workspace.id);
          if (workspace.directory) setWorkbenchWorkspaceSnapshot({ id: workspace.id, directory: workspace.directory, name: workspace.name || workspace.id });
        }
        markWorkbenchWorkspaceSnapshotsReady(true);
      })
      .catch(() => {
        // The Command Center and Explorer tab menu remain available if the
        // workspace directory is temporarily unavailable during app startup.
        if (!disposed) markWorkbenchWorkspaceSnapshotsReady(false);
      });
  } else if (platform !== "android") markWorkbenchWorkspaceSnapshotsReady(false);

  registerCommand({
    id: "open-workspace-workbench",
    title: "Open Workspace Workbench",
    icon: "GitBranch",
    keywords: ["workspace", "git", "branch", "review", "changes"],
    context: "workspace",
    onSelect({ workspace }) {
      openWorkbench(workspace.id);
    },
  });

  scope.own("workspace-lifetime", () => { disposed = true; });
}
