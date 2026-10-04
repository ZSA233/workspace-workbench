import {
useRpc,
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { AccessibilityInfo,LayoutAnimation,Platform,Pressable,Text,UIManager,View } from "react-native";
import { type WorkbenchCopy,type WorkbenchLocale } from "../shared/copy";
import { copyText,Modal,ScrollView,TextInput,useToast } from "./native-components";
import { observationQueryOptions } from './observation-content.ts';
import { observationMeta } from './observation-coordinator';
import { useFileView } from "./use-file-view";
import { useObservationRefresh } from "./use-observation-refresh";
import { refreshObservations,useObservationVersions } from "./use-observation-versions";
import { usePreparationTask } from "./use-preparation-task";
import { useRepositoryObservation } from "./use-repository-observation";
import { useReviewSession } from "./use-review-session";
import { useWorkbenchSettings } from "./use-workbench-settings";
import { useWorkspaceActions } from './use-workspace-actions';
import { useWorkspaceCatalog } from "./use-workspace-catalog";
import { appendAssetReference,useWorkspaceHandoff } from "./use-workspace-handoff";
import { useWorkspaceSelection } from "./use-workspace-selection";

import { type AgentPermissionMode,type AgentRelationship } from "../shared/agent-session";
import {
observationTimingFromWire
} from "../shared/observation-timing";
import { observerQuery } from "../shared/observer";
import { projectsQuery,type ProjectInfo } from "../shared/projects";
import { projectBackendStart,projectStorageQuery } from "../shared/setup";
import { isMainWorkspace,makeStyles,queryFailureForDisplay,resultOf,TabButton,workspaceIdFromProps } from "./components/ui";
import { usePanelForeground } from "./foreground-activity";
import { useRefreshOnForeground } from "./foreground-refresh";
import { localeFromHostProps,useWorkbenchCopy,useWorkbenchLocale,WorkbenchLocaleProvider } from "./i18n";
import {
defaultTreeMode,
formatObservedTime,
type ChangeScope,
type ReviewResult,
type WorkspaceTask
} from "./model";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { useLastSuccessfulResponse } from "./observation";
import { observationAreaDetail,type ObservationArea } from "./panel/observation-display";
import { projectPreferenceScopeKey } from "./panel/scope";
import { useObserverPreferences } from "./preferences";
import { useWorkbenchWorkspaceSnapshot,useWorkbenchWorkspaceSnapshotStatus,type WorkbenchSurfaceProps } from "./surface-context";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";


function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  // macOS may expose the same checkout through a symlink in the host surface
  // and as a real path after the server resolves it.
  return normalized.startsWith("/private/") ? normalized.slice("/private".length) : normalized;
}

function pathContains(root: string, directory: string): boolean {
  const base = comparablePath(root);
  const current = comparablePath(directory);
  return current === base || current.startsWith(`${base}/`);
}

function reportNativeRenderError(phase: string, error: unknown): void {
  reportNativeDiagnostic(phase, {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error && error.stack ? error.stack : "",
  });
}



import { CreateWorkspace } from "./components/create-workspace";
import { IconButton } from "./components/icon-button";
import { AnchoredMenu,LayoutMenu,WorkspaceSelector } from "./components/navigation";
import { ProjectRuntimeMenu } from "./components/project-runtime";
import { ProjectSetup } from "./components/project-setup";
import { ProjectStorageMenu } from "./components/project-storage";
import { SectionAllocationContext,stableScrollbarStyle } from "./components/ui";
import { WorkspaceDeletionPanel } from "./components/workspace-deletion";
import { chooseProject,useProjectMemory } from "./project-memory";
import { useSectionSizing } from "./use-section-sizing";

import { ExecutionBindingCard } from "./components/agent";

import { ToolchainNotice,WorkspaceView } from "./components/repositories";

import { AgentReviewView } from "./components/agent-review";
import { HandoffMaterialsCard } from "./components/handoff-materials";
import { ReviewView } from "./components/review";

export function WorkbenchPanel(props: PanelProps) {
  const hostWorkspaceId = workspaceIdFromProps(props);
  const paseoWorkspace = useWorkbenchWorkspaceSnapshot(hostWorkspaceId);
  reportNativeDiagnostic("panel-implementation-entry", { kind: props.context, workspaceId: hostWorkspaceId });
  return <WorkbenchLocaleProvider locale={localeFromHostProps(props)}><ObserverPanelContent {...props} hostWorkspaceId={hostWorkspaceId} paseoWorkspace={paseoWorkspace} /></WorkbenchLocaleProvider>;
}

export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  const locale = localeFromHostProps(props);
  const workspaceId = props.target?.workspaceId || "";
  const paseoWorkspace = useWorkbenchWorkspaceSnapshot(workspaceId);
  reportNativeDiagnostic("surface-implementation-entry", { workspaceId, snapshot: paseoWorkspace ? "ready" : "missing" });
  const context = props.target?.agentId
    ? { context: "agent" as const, workspaceId, agentId: props.target.agentId }
    : { context: "workspace" as const, workspaceId };
  return <WorkbenchLocaleProvider locale={locale}><ObserverPanelContent {...props} {...context} hostWorkspaceId={workspaceId} paseoWorkspace={paseoWorkspace} /></WorkbenchLocaleProvider>;
}

export function ObserverPanelContent(props: ObserverPanelContentProps) {
  const localizedCopy = useWorkbenchCopy();
  reportNativeDiagnostic("observer-content-entry", { context: props.context, workspaceId: props.hostWorkspaceId, directory: props.paseoWorkspace?.directory || "" });
  let getProjects: ReturnType<typeof useRpc<typeof projectsQuery["input"], typeof projectsQuery["output"]>>;
  try {
    getProjects = useRpc(projectsQuery);
    reportNativeDiagnostic("observer-rpc-hook-ready", { method: "projects-query" });
  } catch (error) {
    reportNativeRenderError("observer-rpc-hook-failed", error);
    throw error;
  }
  const directory = props.paseoWorkspace?.directory || "";
  const snapshotStatus = useWorkbenchWorkspaceSnapshotStatus();
  const hostContextPending = Boolean(props.hostWorkspaceId) && snapshotStatus === "pending";
  const hostContextRequired = Boolean(props.hostWorkspaceId) && snapshotStatus === "available";
  let projects;
  try {
    projects = useQuery({ queryKey: ["workbench-projects", props.host.id, directory], queryFn: () => getProjects({ directory: directory || undefined }), refetchOnWindowFocus: false, retry: false });
    reportNativeDiagnostic("observer-project-query-ready", { pending: String(projects.isPending) });
  } catch (error) {
    reportNativeRenderError("observer-project-query-failed", error);
    throw error;
  }
  let memory;
  try {
    // The global sidebar has no host Workspace ID. Its host instance ID can
    // change between surfaces, so using it here made the project picker forget
    // the last choice on every new conversation. Workspace panels still scope
    // memory to their concrete Paseo Workspace.
    memory = useProjectMemory(props.hostWorkspaceId || "global");
    reportNativeDiagnostic("observer-memory-hook-ready", { ready: String(memory.ready) });
  } catch (error) {
    reportNativeRenderError("observer-memory-hook-failed", error);
    throw error;
  }
  const [pickingProject, setPickingProject] = useState(false);
  const [chosen, setChosen] = useState("");
  const [setupProject, setSetupProject] = useState<ProjectInfo | null>(null);
  const detected = directory ? projects.data?.filter((p) => [p.sourceRoot, p.workspaceRoot].some((root) => pathContains(root, directory))).sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0] : undefined;
  const active = setupProject || (hostContextPending ? undefined : chooseProject(projects.data || [], detected, chosen, memory.saved, Boolean(directory), hostContextRequired));
  useEffect(() => {
    setSetupProject(null);
    setChosen("");
  }, [directory]);
  if (hostContextPending || (!directory && !memory.ready) || projects.isPending) {
    reportNativeDiagnostic("observer-first-branch", { branch: "memory-loading" });
    return <Text style={{ color: props.theme.colors.foregroundMuted }}>{localizedCopy.projectLoading}</Text>;
  }
  if (directory && !active) {
    reportNativeDiagnostic("observer-first-branch", { branch: "project-setup" });
    return <ProjectSetup
    directory={directory}
    theme={props.theme}
    onSaved={(project) => {
      setSetupProject(project);
      setChosen(project.configPath);
      void projects.refetch();
    }}
    />;
  }
  if (!active || pickingProject) {
    reportNativeDiagnostic("observer-first-branch", { branch: "project-picker" });
    return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{projects.isPending ? localizedCopy.projectLoading : projects.isError ? localizedCopy.projectLoadFailed : !projects.data?.length ? localizedCopy.noRegisteredProjects : localizedCopy.selectProject}</Text>
    {projects.data?.map((p) => <Pressable key={p.configPath} onPress={() => {
      setChosen(p.configPath);
      setSetupProject(null);
      setPickingProject(false);
      // Persist an explicit choice immediately. Waiting for the selected
      // project's first full observation meant closing the panel during a
      // cold start lost the choice and reopened the picker next time.
      memory.remember(p.configPath);
    }}><Text style={{ color: props.theme.colors.foreground }}>{p.displayName}</Text></Pressable>)}
    </View>;
  }
  reportNativeDiagnostic("observer-first-branch", { branch: "project-panel", project: active.configPath });
  return <View style={{ flex: 1 }}>
    <ProjectPanel key={active.configPath} {...props} projectConfig={active.configPath} onProjectReady={() => memory.remember(active.configPath)} onSwitchProject={!directory && (projects.data?.length || 0) > 1 ? () => setPickingProject(true) : undefined} />
  </View>;
}

function ProjectPanel(props: ObserverPanelContentProps & { projectConfig: string; onProjectReady?: () => void; onSwitchProject?: () => void }) {
  const { projectConfig } = props;
  reportNativeDiagnostic("project-panel-entry", { projectConfig });
  let foreground: boolean;
  let activity: ReturnType<typeof usePanelForeground>;
  try {
    activity = usePanelForeground();
    foreground = activity.foreground;
  } catch (error) {
    reportNativeRenderError("project-panel-foreground-failed", error);
    throw error;
  }
  reportNativeDiagnostic("project-panel-foreground-ready", { active: String(foreground) });
  const { hostWorkspaceId, paseoWorkspace } = props;
  const { theme, layout } = props;
  let localizedCopy: WorkbenchCopy;
  let locale: WorkbenchLocale;
  try {
    localizedCopy = useWorkbenchCopy();
    locale = useWorkbenchLocale();
  } catch (error) {
    reportNativeRenderError("project-panel-locale-failed", error);
    throw error;
  }
  const preferenceScopeKey = projectPreferenceScopeKey(projectConfig, hostWorkspaceId);
  const [panelWidth, setPanelWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [storageMenuOpen, setStorageMenuOpen] = useState(false);
  const [runtimeSettingsOpen, setRuntimeSettingsOpen] = useState(false);
  const openLayoutMenu = useCallback(() => { setStatusMenuOpen(false); setStorageMenuOpen(false); setRuntimeSettingsOpen(false); setLayoutMenuOpen(true); }, []);
  const openStorageMenu = useCallback(() => { setStatusMenuOpen(false); setLayoutMenuOpen(false); setRuntimeSettingsOpen(false); setStorageMenuOpen(true); }, []);
  const openRuntimeSettings = useCallback(() => { setStatusMenuOpen(false); setLayoutMenuOpen(false); setStorageMenuOpen(false); setReviewSettingsOpen(false); setRuntimeSettingsOpen(true); }, []);
  const compact = layout.compact || (panelWidth > 0 && panelWidth < 480);
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  let preferences: ReturnType<typeof useObserverPreferences>;
  try {
    preferences = useObserverPreferences(preferenceScopeKey);
  } catch (error) {
    reportNativeRenderError("project-panel-preferences-failed", error);
    throw error;
  }
  reportNativeDiagnostic("project-panel-preferences-ready", { ready: String(preferences.ready) });
  useEffect(() => {
    let mounted = true;
    const accessibility = AccessibilityInfo as unknown as {
      isReduceMotionEnabled?: () => Promise<boolean>;
      addEventListener?: (event: string, listener: (enabled: boolean) => void) => { remove?: () => void } | undefined;
    } | undefined;
    try {
      void accessibility?.isReduceMotionEnabled?.().then((enabled) => { if (mounted) setReduceMotion(enabled); }).catch(() => {});
      const subscription = accessibility?.addEventListener?.("reduceMotionChanged", setReduceMotion);
      return () => { mounted = false; try { subscription?.remove?.(); } catch { /* optional native API */ } };
    } catch (error) {
      reportNativeRenderError("accessibility-init-failed", error);
      return () => { mounted = false; };
    }
  }, []);
  reportNativeDiagnostic("project-panel-accessibility-ready");
  const queryClient = useQueryClient();
  const rawRpc = useRpc(observerQuery);
  reportNativeDiagnostic("project-panel-observer-rpc-ready");
  const rpc = (input: Parameters<typeof rawRpc>[0]) => rawRpc({ ...input, projectConfig });
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  let getStorage;
  try {
    getStorage = useRpc(projectStorageQuery);
    reportNativeDiagnostic("project-panel-storage-rpc-ready");
  } catch (error) {
    reportNativeRenderError("project-panel-storage-rpc-failed", error);
    throw error;
  }
  let storageQuery;
  try {
    storageQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "project-storage"],
    queryFn: () => getStorage({ projectConfig }),
    enabled: Boolean(projectConfig),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
    });
    reportNativeDiagnostic("project-panel-storage-query-ready", { pending: String(storageQuery.isPending) });
  } catch (error) {
    reportNativeRenderError("project-panel-storage-query-failed", error);
    throw error;
  }
  let startBackend;
  try {
    startBackend = useRpc(projectBackendStart);
    reportNativeDiagnostic("project-panel-backend-rpc-ready");
  } catch (error) {
    reportNativeRenderError("project-panel-backend-rpc-failed", error);
    throw error;
  }
  let backendQuery;
  try {
    backendQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "backend-start"],
    queryFn: () => startBackend({ projectConfig }),
    enabled: Boolean(projectConfig),
    retry: false,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    });
    reportNativeDiagnostic("project-panel-backend-query-ready", { pending: String(backendQuery.isPending) });
  } catch (error) {
    reportNativeRenderError("project-panel-backend-query-failed", error);
    throw error;
  }
  // Do not race the first Git observer request with backend startup. During a
  // cold start the socket can exist before it is ready to serve, which used to
  // turn the initial workspace list into a misleading observer_timeout.
  const backendReady = backendQuery.data?.state === "ready";
  reportNativeDiagnostic("project-panel-backend-readiness", { ready: String(backendReady), state: String(backendQuery.data?.state || "pending") });
  const observationTiming = useMemo(
    () => observationTimingFromWire(backendQuery.data?.timing),
    [backendQuery.data?.timing],
  );

  const toast = useToast();
  const selectedWorkspaceId = preferences.selectedWorkspaceId;
  const [selectedRepoPath, setSelectedRepoPath] = useState("");
  const refreshArea = useCallback((kind: string) => refreshObservations(queryClient, projectConfig, q =>
    q.key[2] === kind && (kind === "workspace-list" || kind === "review" ||
      q.key[3] === selectedWorkspaceId && (kind === "workspace-detail" || q.key[4] === selectedRepoPath))),
    [queryClient, projectConfig, selectedWorkspaceId, selectedRepoPath]);
  const [tab, setTab] = useState<"workspace" | "review">("workspace");
  const [reviewTab, setReviewTab] = useState<"set" | "agent">("set");
  const [reviewSessionId, setReviewSessionId] = useState("");
  const [mainReviewInstructions, setMainReviewInstructions] = useState("");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [changeScope, setChangeScope] = useState<Exclude<ChangeScope, "commit">>("branch");
  const [graphView, setGraphView] = useState<{ historyMode: "branch" | "full"; maxCommits: number }>({ historyMode: "branch", maxCommits: 50 });
  const [changeTreeMode, setChangeTreeMode] = useState<ChangeTreeMode | null>(null);
  const scopeRepositoryIdentity = useRef("");
  const [repositoryDetailsOpen, setRepositoryDetailsOpen] = useState(false);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [targetOverrides, setTargetOverrides] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [addRepositoriesOpen, setAddRepositoriesOpen] = useState(false);


  useEffect(() => {
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    setReviewSessionId("");
    scopeRepositoryIdentity.current = "";
  }, [preferenceScopeKey, selectedWorkspaceId]);

  const workspaceDirectory = paseoWorkspace?.directory || "";
  const onWorkspaceSelected=useCallback(()=>{setSelectedRepoPath("");setTab("workspace");},[]);
  const onWorkspaceSelectionLost=useCallback(()=>{setSelectedRepoPath("");setSelectedCommit("");setSelectedFile("");scopeRepositoryIdentity.current="";},[]);
  const {selectionResolved, selectorOpen, activityScanProgress, workspaceFilter, setWorkspaceFilter, listQuery, listState, listResult, listFailure, listReady, listContentState, listUnavailable, observedWorkspaces, allWorkspaces, historyWorkspaces, visibleWorkspaces, cancelWorkspaceActivityScan, openWorkspaceSelector, identifyQuery, selectWorkspace, selectCreatedWorkspace}=useWorkspaceSelection({projectConfig,foreground,backendReady,rpc,preferences,preferenceScopeKey,workspaceDirectory,observationTiming,localizedCopy,onProjectReady:props.onProjectReady,refreshArea,onSelect:onWorkspaceSelected,onSelectionLost:onWorkspaceSelectionLost});
  const {mainRepositoriesOpen, setMainRepositoriesOpen, mainRepositoryFilter, setMainRepositoryFilter, mainRepositoryDraft, setMainRepositoryDraft, savingMainRepositories, linkedWorkspacesOpen, setLinkedWorkspacesOpen, linkedWorkspaceFilter, setLinkedWorkspaceFilter, linkedWorkspaceDraft, setLinkedWorkspaceDraft, savingLinkedWorkspaces, orphanId, setOrphanId, orphanBranches, setOrphanBranches, adoptingOrphan, orphanError, orphanPreviewQuery, orphanPreview, mainRepositoriesQuery, mainRepositories, linkedWorkspacesQuery, linkedWorkspaces, saveMainRepositories, saveLinkedWorkspaces, adoptSelectedOrphan}=useWorkspaceCatalog({projectConfig,backendReady,rpc,localizedCopy,refreshArea,onAdopted:selectCreatedWorkspace});
  const observationVersionsEnabled = backendReady && foreground;
  const observationIssue = useObservationVersions(projectConfig, tab === "review" ? [selectedWorkspaceId, ...reviewIds] : [selectedWorkspaceId], observationVersionsEnabled);

  // The active selection is independent from the selector's filter. Changing
  // from “all” to “dirty” must not make a clean selected workspace disappear
  // and trigger an unwanted fallback.
  const selectedWorkspace = observedWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedWorkspaceIsMain = isMainWorkspace(selectedWorkspace);
  useEffect(() => {
    if (selectedWorkspace?.kind === "linked-live" && tab === "review" && reviewTab === "agent") setTab("workspace");
  }, [selectedWorkspace?.kind, tab, reviewTab]);
  const selectedWorkspaceUnavailable = selectedWorkspace?.state === "create_failed" || selectedWorkspace?.state === "record_invalid";
  const selectedWorkspaceBlocksTasks = selectedWorkspaceUnavailable || selectedWorkspace?.state === "deletion_pending" || selectedWorkspace?.state === "removed";
  const agentId="agentId" in props ? props.agentId:undefined;
  const {handoffGoal, setHandoffGoal, handoffRelationship, setHandoffRelationship, handoffPacketOpen, setHandoffPacketOpen, handoffPreviewOpen, setHandoffPreviewOpen, materialPreview, handoffUnderstanding, setHandoffUnderstanding, handoffPlan, setHandoffPlan, handoffAcceptance, setHandoffAcceptance, handoffReferences, setHandoffReferences, handoffReviewInstructions, setHandoffReviewInstructions, workerStartMode, setWorkerStartMode, delegating, parentAgentId, agentContextAvailable, agentContextState, bindingQuery, binding, boundAgent, bindingFailure, draftHandoff, draftPacket, handoffAssetOptions, delegateSelectedWorkspace, submitSelectedWorkspace}=useWorkspaceHandoff({projectConfig,selectedWorkspaceId,foreground,listReady,selectedWorkspaceIsMain,selectedWorkspaceBlocksTasks,agentCapability:!!listResult?.capabilities?.agent,agentId,locale,localizedCopy});
  const refreshCapable = backendQuery.data?.readCapabilities?.refreshProtocol === 1;
  const basicCapable = backendQuery.data?.readCapabilities?.basicSummaryProtocol === 1;
  const {detailQuery, detailState, detail, detailFailure, detailUnavailable, displayDetail, selectorWorkspace, selectedRepository, graphQuery, graphState, graph, graphFailure, changesScope, changesQuery, changesState, changes, changesFailure, selectedRefresh, basicSummaries, graphFeedback, changesFeedback, graphBusy, retryGraph}=useRepositoryObservation({projectConfig,selectedWorkspaceId,selectedWorkspace,selectedRepoPath,selectedCommit,changeScope,graphView,foreground,tab,backendReady,listReady,refreshCapable,basicCapable,selectedWorkspaceUnavailable,rpc,localizedCopy,observationTiming});
  const environmentQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "environment", selectedWorkspaceId],
    queryFn: () => rpc({ method: "workspace.environment", params: { workspaceId: selectedWorkspaceId, prepare: false } }),
    enabled: foreground && layoutMenuOpen && Boolean(selectedWorkspaceId && backendQuery.data?.readCapabilities?.environmentProtocol === 1),
    staleTime: 30_000, refetchOnWindowFocus: false, retry: false,
  });
  const menuToolchain = resultOf<any>(environmentQuery.data)?.toolchain;
  useEffect(() => {
    const first = displayDetail?.workspace.id === selectedWorkspaceId ? displayDetail.repositories[0]?.repoPath || "" : "";
    if (!selectedRepository && first) setSelectedRepoPath(first);
    if (!first && selectedRepoPath) setSelectedRepoPath("");
  }, [displayDetail, selectedRepoPath, selectedRepository, selectedWorkspaceId]);

  useEffect(() => {
    if (changeTreeMode !== null || !changes) return;
    setChangeTreeMode(defaultTreeMode(changes.files));
  }, [changeTreeMode, changes]);

  const repositoryIdentity = `${selectedWorkspaceId}:${selectedRepoPath}`;
  // Selection defaults are applied before any read finishes. Later summary
  // completion may refine the default scope, but must not clear a user's commit.
  useLayoutEffect(() => {
    setSelectedCommit("");
    setSelectedFile("");
    setGraphView({ historyMode: selectedWorkspaceIsMain ? "full" : "branch", maxCommits: 50 });
    setChangeScope(selectedWorkspaceIsMain ? "working" : "branch");
  }, [repositoryIdentity, selectedWorkspaceIsMain]);
  useLayoutEffect(() => {
    if (selectedRepository?.observationPending) return;
    if (!selectedRepository || !selectedRepoPath || scopeRepositoryIdentity.current === repositoryIdentity) return;
    scopeRepositoryIdentity.current = repositoryIdentity;
    setChangeScope(
      selectedRepository.branchScopeAvailable === false
        ? "working"
        : selectedRepository.dirty || (selectedRepository.workingChanges?.files ?? selectedRepository.dirtyPaths?.length ?? 0)
          ? "working"
          : "branch",
    );
  }, [repositoryIdentity, selectedRepoPath, selectedRepository]);
  const chooseScope = useCallback((scope: Exclude<ChangeScope, "commit">) => {
    scopeRepositoryIdentity.current = repositoryIdentity;
    setChangeScope(scope);
  }, [repositoryIdentity]);

  useEffect(() => {
    setRepositoryDetailsOpen(false);
  }, [selectedWorkspaceId]);

  const reviewQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "review", reviewIds, targetOverrides],
    queryFn: () => rpc({
      method: "review-set.brief",
      params: {
        workspaceIds: reviewIds,
        targetRefs: Object.fromEntries(
          Object.entries(targetOverrides).filter(([, value]) => typeof value === "string" && value.trim()),
        ),
      },
    }),
    enabled: foreground && tab === "review" && reviewIds.length > 0 && backendReady && listReady,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    ...observationQueryOptions,
  });
  const reviewState = useLastSuccessfulResponse(`review:${projectConfig}:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, { error: reviewQuery.error, staleAfterMs: observationTiming.staleWindowsMs.review });
  const review = resultOf<ReviewResult>(reviewState.response);
  const reviewFailure = queryFailureForDisplay(reviewState, reviewQuery.data, reviewQuery.error, localizedCopy);
  const onReviewStarted=useCallback(()=>setReviewSessionId(""),[]);
  const {agentReviewQuery,agentReviewHistoryQuery,agentReview,startAgentReview,controlAgentReview}=useReviewSession({projectConfig,selectedWorkspaceId,reviewSessionId,foreground,backendReady,listReady,selectedWorkspaceIsMain,boundAgentId:boundAgent?.id,locale,mainReviewInstructions,localizedCopy,onStarted:onReviewStarted});
  const closeSettingsPeers=useCallback(()=>{setLayoutMenuOpen(false);setStorageMenuOpen(false);setRuntimeSettingsOpen(false);},[]);
  const {reviewSettingsOpen, setReviewSettingsOpen, reviewSettingsScope, setReviewSettingsScope, reviewMode, setReviewMode, autoFix, setAutoFix, maxRounds, setMaxRounds, reviewerTimeoutMinutes, setReviewerTimeoutMinutes, repairTimeoutMinutes, setRepairTimeoutMinutes, reviewerRole, setReviewerRole, reviewInstructions, setReviewInstructions, reviewerSession, setReviewerSession, reviewerTarget, setReviewerTarget, executionModel, setExecutionModel, reviewerModel, setReviewerModel, reviewDirtyFields, sessionDefaultRelationship, setSessionDefaultRelationship, sessionPermissionMode, setSessionPermissionMode, sessionProviderRelationships, setSessionProviderRelationships, markReviewField, markSessionField, reviewModelsQuery, saveReviewSettings, closeReviewSettings, openReviewSettings, resetReviewField, resetAllProjectReviewOverrides, sessionProviders, sourceLabel, hasReviewOverride, sessionSourceLabel, sessionPermissionLabel}=useWorkbenchSettings({projectConfig,selectedWorkspaceId,foreground,backendReady,listReady,localizedCopy,boundAgentProvider:boundAgent?.provider,refreshAgentReview:agentReviewQuery.refetch,closeOtherMenus:closeSettingsPeers});
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const observationAreas: ObservationArea[] = [
    { label: localizedCopy.observationAreaList, snapshot: listState, fetching: listQuery.isFetching },
    { label: localizedCopy.observationAreaDetail, snapshot: detailState, fetching: detailQuery.isFetching },
    { label: localizedCopy.observationAreaGraph, snapshot: graphState, fetching: graphQuery.isFetching },
    { label: localizedCopy.observationAreaChanges, snapshot: changesState, fetching: changesQuery.isFetching },
    ...(tab === "review" ? [{ label: localizedCopy.tabReviewSet, snapshot: reviewState, fetching: reviewQuery.isFetching }] : []),
  ];
  const unavailableArea = observationAreas.find((area) => area.snapshot.status === "unavailable");
  const observerError = listUnavailable ? listFailure : unavailableArea ? localizedCopy.observationUnavailable : null;
  const observationExpired = Boolean(
    listState.expired ||
      detailState.expired ||
      graphState.expired ||
      changesState.expired ||
      (tab === "review" && reviewState.expired),
  );
  const observationRefreshing = foreground && (basicSummaries.currentRunning || (refreshCapable ? !selectedRefresh.slow && ((selectedRefresh.manual || !graph && !changes) && (observationMeta(selectedRefresh.query.data).readTask?.state === 'running' || selectedRefresh.query.isFetching && !selectedRefresh.query.data)) : manualRefreshing || observationAreas.some((area) => area.fetching && !area.snapshot.response)));
  const observationDegraded = selectedRefresh.failed || basicSummaries.failures.some(failure => failure.repoPath === selectedRepoPath) || Boolean(observationIssue) || observationAreas.some((area) => area.snapshot.status === "degraded");
  reportNativeDiagnostic("project-panel-observation-state", {
    foreground: String(foreground),
    listReady: String(listReady),
    listUnavailable: String(listUnavailable),
    listStatus: listState.status,
    detailStatus: detailState.status,
    graphStatus: graphState.status,
    changesStatus: changesState.status,
    unavailableArea: unavailableArea?.label || "",
    observationIssue: observationIssue || "",
    observerError: observerError || "",
    refreshing: String(observationRefreshing),
    expired: String(observationExpired),
    degraded: String(observationDegraded),
  });
  const lastSuccessfulAt = observationAreas.reduce<string | null>((latest, area) => {
    const candidate = area.snapshot.lastObservedAt;
    if (!candidate) return latest;
    if (!latest || (Date.parse(candidate) > Date.parse(latest))) return candidate;
    return latest;
  }, null);

  const prepareCapable = backendQuery.data?.readCapabilities?.prepareProtocol === 1;
  const preparation = usePreparationTask(projectConfig, selectedWorkspaceId, prepareCapable && foreground && backendReady && !!selectedWorkspaceId, rpc);
  const preparingToolchain = preparation.busy;
  const preparationLabels: Record<string, string> = locale === 'zh-CN'
    ? {queued:'排队中',running:'准备中',prepare:'准备中',checking:'检查运行时',installing:'安装中',verifying:'验证中','waiting-install-lock':'等待其他安装完成',ready:'已完成',failed:'准备失败',interrupted:'等待继续',reconcile:'核对已安装结果',reconciled:'已核对',recovering:'正在恢复任务状态'}
    : {queued:'Queued',running:'Preparing',prepare:'Preparing',checking:'Checking runtimes',installing:'Installing',verifying:'Verifying','waiting-install-lock':'Waiting for another installation',ready:'Complete',failed:'Preparation failed',interrupted:'Awaiting continuation',reconcile:'Checking installed results',reconciled:'Reconciled',recovering:'Recovering task status'};
  const preparationPhase = preparationLabels[String(preparation.task?.phase || '')] || preparation.task?.state || '';

  const prepareSelectedToolchain = useCallback(async () => {
    if (!prepareCapable) { toast.error(locale === 'zh-CN' ? '服务尚未支持任务式准备，请更新插件后重试' : 'Update the plugin service to prepare runtimes'); return; }
    if (!displayDetail || preparingToolchain) return;
    await preparation.start(displayDetail.repositories.map(repository => repository.repoPath));
  }, [prepareCapable, displayDetail, preparingToolchain, preparation.start, locale, toast]);
  useEffect(() => {
    if (['ready','failed','interrupted'].includes(preparation.task?.state)) void refreshArea('workspace-detail');
  }, [preparation.task?.state, preparation.task?.updatedAt]);


  const refreshLegacy = useObservationRefresh(() => [
      backendQuery.refetch(),
      ...(backendQuery.data?.state === "ready" ? [refreshArea("workspace-list")] : []),
      ...(workspaceDirectory && !selectionResolved ? [identifyQuery.refetch()] : []),
      ...(selectedWorkspaceId ? [refreshArea("workspace-detail")] : []),
      ...(selectedWorkspaceId && selectedRepoPath && !selectedWorkspaceUnavailable ? [refreshArea("repository-graph"), refreshArea("repository-changes")] : []),
      ...(tab === "review" && reviewIds.length ? [refreshArea("review")] : []),
      ...(selectedWorkspaceId && selectedWorkspace && !selectedWorkspaceIsMain && listResult?.capabilities?.agent
        ? [bindingQuery.refetch()]
        : []),
    ], observationTiming.clientRefreshTimeoutMs, setManualRefreshing);
  const refreshAll = useCallback(() => {
    if (!refreshCapable) return refreshLegacy();
    void backendQuery.refetch();
    selectedRefresh.refresh();
    basicSummaries.refresh();
    void refreshArea('workspace-list');
  }, [refreshCapable, refreshLegacy, selectedRefresh.refresh, refreshArea, basicSummaries.refresh, backendQuery.refetch]);


  // The version poll resumes observation queries; only bootstrap needs a direct retry.
  useRefreshOnForeground(Boolean(projectConfig && !listReady), () => {
    void backendQuery.refetch();
    void refreshArea("workspace-list");
  });

  const observationLabel = observerError
    ? localizedCopy.observationUnavailable
    : observationExpired
      ? localizedCopy.observationStale
      : observationRefreshing
        ? localizedCopy.observationRefreshing
        : observationDegraded
          ? localizedCopy.observationDegraded
          : localizedCopy.observationStatus;
  const observationIcon = observerError || observationExpired ? "CircleAlert" : "RefreshCw";
  const observationColor = observerError
    ? theme.colors.statusDanger
    : observationExpired || observationDegraded
      ? theme.colors.statusWarning
      : theme.colors.foregroundMuted;

  const {lifecycleWorkspaceId,lifecycleWorkspace,lifecycleMode,lifecycleResponse,lifecycleError,lifecycleBusyWorkspaceIds,
    closeLifecycle,inspectWorkspaceLifecycle,removeWorkspace,restoreWorkspace,permanentDeleteWorkspace} =
    useWorkspaceActions(projectConfig,selectedWorkspaceId,preferences.selectWorkspace,() => listQuery.refetch({cancelRefetch:false}),localizedCopy);

  const openWorkspaceTask = useCallback((task: WorkspaceTask) => {
    if (task.kind === "agent" && task.id && props.navigation) {
      props.navigation.openAgent({ agentId: task.id });
      return;
    }
    if (task.kind === "review") {
      setTab("review");
      setReviewTab("agent");
      setReviewSessionId(task.id || "");
      closeLifecycle();
    }
  }, [closeLifecycle, props.navigation]);

  function toggleReview(id: string): void {
    setReviewIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function copyBrief(text: string): void {
    void copyText(text)
      .then(() => toast.show(localizedCopy.text_2fb0b81c28, { variant: "success" }))
      .catch(() => toast.show(localizedCopy.text_514f0cbbf2, { variant: "warning" }));
  }

  const allocation = useSectionSizing(panelHeight, panelWidth, `${selectedWorkspaceId}:${selectedRepoPath}:${tab}`, preferences.sectionLayout, preferences.commitResize);
  const sectionDragging = allocation.dragging;
  const allocationRef = useRef(allocation);
  allocationRef.current = allocation;
  const onWorkspaceContentLayout = useCallback((contentHeight: number) => {
    const current = allocationRef.current;
    if (current.outerScroll || !selectedRepository) return;
    const used = Object.values(current.sizes).reduce((sum, height) => sum + height, 0);
    current.measureChrome?.(Math.max(0, contentHeight - used) + 24);
  }, [selectedRepository]);
  const animateSectionLayout = useCallback(() => {
    if (reduceMotion || Platform.OS === "web") return;
    try {
      if (Platform.OS === "android") {
        (UIManager as unknown as { setLayoutAnimationEnabledExperimental?: (enabled: boolean) => void }).setLayoutAnimationEnabledExperimental?.(true);
      }
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    } catch {
      // Unsupported hosts use the same correct immediate layout update.
    }
  }, [reduceMotion]);
  const onToggleRepositoryDetails = useCallback(() => {
    animateSectionLayout();
    setRepositoryDetailsOpen((current) => !current);
  }, [animateSectionLayout]);
  const {onCommit,onGraphBase,onGraphMore,onOpenChangedFile,onRepo}=useFileView({projectConfig,hostWorkspaceId,agentId,selectedWorkspace,selectedRepository,selectedRepoPath,selectedCommit,changesScope,graphView,setGraphView,graphBusy,retryGraph,graphLoadedCount:graph?.loadedCount || 50,animateSectionLayout,setSelectedCommit,setSelectedFile,setSelectedRepoPath,setRepositoryDetailsOpen});
  const chooseCommit = useCallback((sha: string) => {
    scopeRepositoryIdentity.current = repositoryIdentity;
    onCommit(sha);
  }, [repositoryIdentity, onCommit]);
  const onSectionToggle = useCallback((id: "repositories" | "graph" | "changes", collapsed: boolean) => {
    animateSectionLayout();
    preferences.updateSection(id, { collapsed });
  }, [animateSectionLayout, preferences.updateSection]);

  const collapseAll = useCallback(() => { animateSectionLayout(); preferences.setAllSectionsCollapsed(true); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.setAllSectionsCollapsed]);
  const expandAll = useCallback(() => { animateSectionLayout(); preferences.setAllSectionsCollapsed(false); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.setAllSectionsCollapsed]);
  const resetLayout = useCallback(() => { animateSectionLayout(); preferences.resetLayout(); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.resetLayout]);
  const BodyContainer = tab === "review" || allocation.outerScroll ? ScrollView : View;
  return (
    <View
      ref={activity.ref}
      style={styles.screen}
      accessibilityLabel={localizedCopy.productName}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (Math.abs(width - panelWidth) > 1) setPanelWidth(width);
      }}
    >
      {addRepositoriesOpen && selectedWorkspace ? <CreateWorkspace addTo={{ id: selectedWorkspaceId, repositoryPaths: detail?.repositories.map((repo) => repo.repoPath) || [] }} projectKey={projectConfig} currentRepo="" rpc={rpc} onClose={() => setAddRepositoriesOpen(false)} onCreated={async () => { await refreshArea("workspace-list"); await refreshArea("workspace-detail"); await refreshArea("workspace-prepare"); setAddRepositoriesOpen(false); }} styles={styles} /> : null}
      {mainRepositoriesOpen ? <Modal open onOpenChange={(open) => { if (!open && !savingMainRepositories) setMainRepositoriesOpen(false); }} title={localizedCopy.mainRepositoryTitle}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 8, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.mainRepositoryHint}</Text>
          <TextInput value={mainRepositoryFilter} onChangeText={setMainRepositoryFilter} placeholder={localizedCopy.mainRepositorySearch} style={styles.targetInput} />
          {mainRepositories?.scan?.incomplete ? <Text style={styles.warningText}>{localizedCopy.repositoryScanIncomplete}</Text> : null}
          {mainRepositoriesQuery.isError || mainRepositoriesQuery.data?.ok === false ? <Text style={styles.warningText}>{mainRepositoriesQuery.data?.error?.message || localizedCopy.setupScanFailed}</Text> : null}
          {mainRepositoriesQuery.isFetching && !mainRepositories ? <Text style={styles.emptyText}>{localizedCopy.mainRepositoryScanning}</Text> : null}
          {mainRepositories?.repositories.filter(repo => !mainRepositoryFilter.trim() || `${repo.name} ${repo.path}`.toLowerCase().includes(mainRepositoryFilter.trim().toLowerCase())).map(repo => {
            const selected = mainRepositoryDraft.includes(repo.path);
            return <Pressable key={repo.path} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => setMainRepositoryDraft(current => selected ? current.filter(path => path !== repo.path) : [...current, repo.path])} style={[styles.secondaryButton, selected && styles.scopeButtonActive]}>
              <Text style={styles.secondaryButtonText}>{selected ? "✓" : "○"} {repo.name} · {repo.missing ? localizedCopy.mainRepositoryMissing : repo.configured ? localizedCopy.mainRepositoryConfigured : localizedCopy.mainRepositoryDiscovered}</Text>
              <Text selectable style={styles.layoutMenuHint}>{repo.path}</Text>
            </Pressable>;
          })}
          {!mainRepositoriesQuery.isFetching && !mainRepositories?.repositories.length ? <Text style={styles.emptyText}>{localizedCopy.mainRepositoryEmpty}</Text> : null}
          <View style={styles.briefActions}>
            <Pressable accessibilityRole="button" onPress={() => { void mainRepositoriesQuery.refetch(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.mainRepositoryRescan}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={savingMainRepositories || !mainRepositories} onPress={() => { void saveMainRepositories(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{savingMainRepositories ? localizedCopy.mainRepositorySaving : localizedCopy.mainRepositorySave}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={savingMainRepositories} onPress={() => setMainRepositoriesOpen(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.mainRepositoryCancel}</Text></Pressable>
          </View>
        </Modal.Content>
      </Modal> : null}
      {linkedWorkspacesOpen ? <Modal open onOpenChange={(open) => { if (!open && !savingLinkedWorkspaces) setLinkedWorkspacesOpen(false); }} title={localizedCopy.linkedWorkspaceTitle}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 8, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.linkedWorkspaceHint}</Text>
          <TextInput value={linkedWorkspaceFilter} onChangeText={setLinkedWorkspaceFilter} placeholder={localizedCopy.mainRepositorySearch} style={styles.targetInput} />
          {linkedWorkspaces?.scan?.incomplete ? <Text style={styles.warningText}>{localizedCopy.repositoryScanIncomplete}</Text> : null}
          {linkedWorkspacesQuery.data?.ok === false ? <Text style={styles.warningText}>{linkedWorkspacesQuery.data.error?.message}</Text> : null}
          {linkedWorkspaces?.repositories.filter(item => !linkedWorkspaceFilter.trim() || `${item.name} ${item.path}`.toLowerCase().includes(linkedWorkspaceFilter.trim().toLowerCase())).map(item => {
            const selected = linkedWorkspaceDraft.includes(item.path);
            return <Pressable key={item.path} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => setLinkedWorkspaceDraft(current => selected ? current.filter(path => path !== item.path) : [...current, item.path])} style={[styles.secondaryButton, selected && styles.scopeButtonActive]}>
              <Text style={styles.secondaryButtonText}>{selected ? "✓" : "○"} {item.name} · {item.links?.length || 0} Gitlinks{item.missing ? ` · ${localizedCopy.mainRepositoryMissing}` : ""}</Text>
              <Text selectable style={styles.layoutMenuHint}>{item.path}</Text>
            </Pressable>;
          })}
          {!linkedWorkspacesQuery.isFetching && !linkedWorkspaces?.repositories.length ? <Text style={styles.emptyText}>{localizedCopy.linkedWorkspaceEmpty}</Text> : null}
          <View style={styles.briefActions}>
            <Pressable accessibilityRole="button" onPress={() => { void linkedWorkspacesQuery.refetch(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.mainRepositoryRescan}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={savingLinkedWorkspaces || !linkedWorkspaces} onPress={() => { void saveLinkedWorkspaces(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{savingLinkedWorkspaces ? localizedCopy.mainRepositorySaving : localizedCopy.mainRepositorySave}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={savingLinkedWorkspaces} onPress={() => setLinkedWorkspacesOpen(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.mainRepositoryCancel}</Text></Pressable>
          </View>
        </Modal.Content>
      </Modal> : null}
      {orphanId ? <Modal open onOpenChange={(open) => { if (!open && !adoptingOrphan) setOrphanId(""); }} title={localizedCopy.orphanAdoptTitle}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 9, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.orphanAdoptHint}</Text>
          <Text selectable style={styles.reviewDetailText}>{orphanPreview?.treePath || orphanId}</Text>
          {orphanPreviewQuery.isFetching && !orphanPreview ? <Text style={styles.emptyText}>{localizedCopy.mainRepositoryScanning}</Text> : null}
          {orphanPreviewQuery.data?.ok === false ? <Text style={styles.warningText}>{orphanPreviewQuery.data.error?.message}</Text> : null}
          {orphanPreview?.repositories.map(repo => {
            const createBranch = Object.prototype.hasOwnProperty.call(orphanBranches, repo.id);
            return <View key={repo.id} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{repo.repoPath} · {repo.branch || localizedCopy.orphanDetached}{repo.dirty ? ` · ${localizedCopy.workspaceStatusDirty}` : ""}</Text>
              {repo.configured === false ? <Text selectable style={styles.layoutMenuHint}>{localizedCopy.orphanInferredSource}: {repo.sourcePath}</Text> : null}
              <Text selectable style={styles.layoutMenuHint}>{localizedCopy.orphanSnapshot}: {repo.head}</Text>
              {repo.branch === null ? <View style={styles.briefActions}>
                <Pressable accessibilityRole="button" disabled={orphanPreview?.resume} accessibilityState={{ selected: !createBranch }} onPress={() => setOrphanBranches(current => { const next = { ...current }; delete next[repo.id]; return next; })} style={[styles.secondaryButton, !createBranch && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.orphanKeepDetached}</Text></Pressable>
                <Pressable accessibilityRole="button" disabled={orphanPreview?.resume} accessibilityState={{ selected: createBranch }} onPress={() => setOrphanBranches(current => ({ ...current, [repo.id]: current[repo.id] || `recovered/${orphanId}/${repo.id}` }))} style={[styles.secondaryButton, createBranch && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.orphanCreateBranch}</Text></Pressable>
              </View> : null}
              {createBranch ? <TextInput accessibilityLabel={`${localizedCopy.orphanCreateBranch} ${repo.id}`} editable={!orphanPreview?.resume} value={orphanBranches[repo.id]} onChangeText={value => setOrphanBranches(current => ({ ...current, [repo.id]: value }))} style={styles.targetInput} /> : null}
            </View>;
          })}
          {orphanPreview?.repositories.some(repo => repo.branch === null && !Object.prototype.hasOwnProperty.call(orphanBranches, repo.id)) ? <Text style={styles.layoutMenuHint}>{localizedCopy.orphanBranchHint}</Text> : null}
          {orphanPreview?.issues.map((item, index) => <Text key={`${item.code}:${index}`} style={styles.warningText}>{item.code}: {item.message}</Text>)}
          {orphanPreview?.warnings?.map((item, index) => <Text key={`${item.code}:warning:${index}`} style={styles.layoutMenuHint}>{item.code === "workspace_extra_path" ? localizedCopy.orphanExtraPath : item.code === "worktree_identity_unverified" ? localizedCopy.orphanUnmanagedPath : item.code === "workspace_metadata_unknown" ? localizedCopy.orphanMetadataWarning : item.code === "record_invalid" ? localizedCopy.orphanInvalidRecordWarning : item.message}{item.path ? `: ${item.path}` : ""}</Text>)}
          {orphanPreview && !orphanPreview.eligible ? <Text style={styles.warningText}>{localizedCopy.orphanCannotAdopt}</Text> : null}
          {orphanError ? <Text style={styles.warningText}>{orphanError}</Text> : null}
          <View style={styles.briefActions}>
            <Pressable accessibilityRole="button" onPress={() => { void orphanPreviewQuery.refetch(); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.orphanRefresh}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={!orphanPreview?.eligible || adoptingOrphan} onPress={() => { void adoptSelectedOrphan(); }} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{adoptingOrphan ? localizedCopy.orphanAdopting : orphanPreview?.resume ? localizedCopy.orphanResume : localizedCopy.orphanAdopt}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={adoptingOrphan} onPress={() => setOrphanId("")} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.mainRepositoryCancel}</Text></Pressable>
          </View>
        </Modal.Content>
      </Modal> : null}
      {createOpen ? <CreateWorkspace projectKey={projectConfig} currentRepo={selectedRepository?.repoPath || ""} linkedSources={allWorkspaces.filter(workspace => workspace.kind === "linked-live")} preferredSourceId={selectedWorkspace?.kind === "linked-live" ? selectedWorkspace.id : ""} rpc={rpc} onClose={() => setCreateOpen(false)} onCreated={async (id) => { await refreshArea("workspace-list"); selectCreatedWorkspace(id); setCreateOpen(false); }} styles={styles} /> : null}
      {handoffPacketOpen ? <Modal open onOpenChange={(open) => { if (!open) setHandoffPacketOpen(false); }} title={localizedCopy.handoffPacket}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 8, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.handoffPacketHint}</Text>
          <Text style={styles.layoutMenuHint}>子会话首次启动意图（不代表宿主当前模式）</Text>
          {(["plan-first", "adaptive"] as const).map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: workerStartMode === mode }} onPress={() => setWorkerStartMode(mode)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{mode === "plan-first" ? "先计划，等待明确执行授权" : "执行已授权任务"}</Text></Pressable>)}
          <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffUnderstanding}</Text>
          <TextInput accessibilityLabel={localizedCopy.handoffUnderstanding} multiline placeholder={localizedCopy.handoffUnderstandingPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} value={handoffUnderstanding} onChangeText={setHandoffUnderstanding} style={[styles.targetInput, { minHeight: 58 }]} />
          <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffPlan}</Text>
          <TextInput accessibilityLabel={localizedCopy.handoffPlan} multiline placeholder={localizedCopy.handoffPlanPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} value={handoffPlan} onChangeText={setHandoffPlan} style={[styles.targetInput, { minHeight: 70 }]} />
          <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffAcceptance}</Text>
          <TextInput accessibilityLabel={localizedCopy.handoffAcceptance} multiline placeholder={localizedCopy.handoffAcceptancePlaceholder} placeholderTextColor={theme.colors.foregroundMuted} value={handoffAcceptance} onChangeText={setHandoffAcceptance} style={[styles.targetInput, { minHeight: 70 }]} />
          <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffReferences}</Text>
          <TextInput accessibilityLabel={localizedCopy.handoffReferences} multiline placeholder={localizedCopy.handoffReferencesPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} value={handoffReferences} onChangeText={setHandoffReferences} style={[styles.targetInput, { minHeight: 70 }]} />
          {handoffAssetOptions.length ? <View>
            <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffAvailableAssets}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.briefActions}>
              {handoffAssetOptions.map((asset) => <Pressable key={asset.id} accessibilityRole="button" accessibilityLabel={`${asset.title} ${asset.id}`} onPress={() => setHandoffReferences((current) => appendAssetReference(current, asset.id))} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>{asset.title}</Text>
              </Pressable>)}
            </ScrollView>
          </View> : null}
          <Text style={styles.reviewEntryMeta}>{localizedCopy.handoffReviewInstructions}</Text>
          <TextInput accessibilityLabel={localizedCopy.handoffReviewInstructions} multiline placeholder={localizedCopy.handoffReviewInstructionsPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} value={handoffReviewInstructions} onChangeText={setHandoffReviewInstructions} style={[styles.targetInput, { minHeight: 70 }]} />
          <Pressable accessibilityRole="button" onPress={() => setHandoffPacketOpen(false)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.handoffDone}</Text></Pressable>
        </Modal.Content>
      </Modal> : null}
      {handoffPreviewOpen && draftHandoff ? <Modal open onOpenChange={(open) => { if (!open && !delegating) setHandoffPreviewOpen(false); }} title={localizedCopy.handoffPreviewTitle}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 8, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.handoffPreviewHint}</Text>
          {materialPreview?.materials ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffMaterials}: {materialPreview.materials.sourceCount} · {localizedCopy.handoffConversation}: {materialPreview.materials.conversation.state}</Text><Text style={styles.warningText}>{[...materialPreview.materials.blockers, ...materialPreview.materials.warnings].join("\n")}</Text></> : null}
          <Text style={styles.reviewEntryMeta}>{localizedCopy.text_1b37d56f7a}</Text>
          <Text selectable style={styles.reviewDetailText}>{draftHandoff.goal}</Text>
          {draftPacket?.requirementUnderstanding ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffUnderstanding}</Text><Text selectable style={styles.reviewDetailText}>{draftPacket.requirementUnderstanding}</Text></> : null}
          {draftPacket?.plan.length ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffPlan}</Text><Text selectable style={styles.reviewDetailText}>{draftPacket.plan.map((item, index) => `${index + 1}. ${item}`).join("\n")}</Text></> : null}
          {draftPacket?.acceptanceCriteria.length ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffAcceptance}</Text><Text selectable style={styles.reviewDetailText}>{draftPacket.acceptanceCriteria.map((item) => `${item.id}. ${item.text}`).join("\n")}</Text></> : null}
          {draftPacket?.references.length ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffReferences}</Text><Text selectable style={styles.reviewDetailText}>{draftPacket.references.map((item) => `${item.title || item.path || item.assetId || item.id}${item.path ? ` · ${item.repositoryId ? `${item.repositoryId}:` : ""}${item.path}` : item.assetId ? ` · asset:${item.assetId}` : ""}`).join("\n")}</Text></> : <Text style={styles.layoutMenuHint}>{localizedCopy.handoffNoPacket}</Text>}
          {draftPacket?.instructions ? <><Text style={styles.reviewEntryMeta}>{localizedCopy.handoffReviewInstructions}</Text><Text selectable style={styles.reviewDetailText}>{draftPacket.instructions}</Text></> : null}
          <Text style={styles.layoutMenuHint}>{localizedCopy.handoffReferenceCount.replace("{0}", String(draftPacket?.references.length || 0))} · {localizedCopy.handoffAcceptanceCount.replace("{0}", String(draftPacket?.acceptanceCriteria.length || 0))}</Text>
          <View style={styles.briefActions}>
            <Pressable accessibilityRole="button" disabled={delegating} onPress={() => { setHandoffPreviewOpen(false); setHandoffPacketOpen(true); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.handoffEdit}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={delegating || !materialPreview?.ok || materialPreview.materials?.ready === false} onPress={() => { void submitSelectedWorkspace(); }} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{localizedCopy.handoffConfirm}</Text></Pressable>
          </View>
        </Modal.Content>
      </Modal> : null}
      <WorkspaceSelector
        onOpenLayoutMenu={() => { if (selectorOpen) cancelWorkspaceActivityScan(); openLayoutMenu(); }}
        statusControl={<IconButton label={observationLabel} icon={observationIcon}
          busy={observationRefreshing}
          color={observationColor}
          onPress={() => { setLayoutMenuOpen(false); setStatusMenuOpen((open) => !open); }} />}
        workspaces={allWorkspaces}
        historyWorkspaces={historyWorkspaces}
        visibleWorkspaces={visibleWorkspaces}
        orphanCandidates={listResult?.orphanCandidates}
        selectedWorkspace={selectorWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        filter={workspaceFilter}
        open={selectorOpen}
        latestCommitProgress={activityScanProgress}
        ready={listReady}
        loading={listContentState === 'loading'}
        refreshing={manualRefreshing}
        failure={listUnavailable ? localizedCopy.workspaceListUnavailable : listFailure}
        retrying={listQuery.isFetching}
        onRetry={listUnavailable ? () => {
          reportNativeDiagnostic('workspace-list-retry', {projectConfig,at:String(Date.now()),fetching:String(listQuery.isFetching)});
          void listQuery.refetch({cancelRefetch:false});
        } : undefined}
        onOpen={openWorkspaceSelector}
        onFilter={setWorkspaceFilter}
        onSelect={(id) => { cancelWorkspaceActivityScan(); selectWorkspace(id); }}
        onOpenOrphan={(id) => { cancelWorkspaceActivityScan(); setOrphanId(id); }}
        onRemoveWorkspace={listResult?.capabilities?.remove ? (workspace) => { cancelWorkspaceActivityScan(false); void removeWorkspace(workspace); } : undefined}
        onRestoreWorkspace={listResult?.capabilities?.restore ? (workspace) => { cancelWorkspaceActivityScan(false); void restoreWorkspace(workspace); } : undefined}
        onPermanentDeleteWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { cancelWorkspaceActivityScan(); inspectWorkspaceLifecycle(workspace, "permanent"); } : undefined}
        onInspectWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { cancelWorkspaceActivityScan(); inspectWorkspaceLifecycle(workspace); } : undefined}
        lifecycleBusyWorkspaceIds={lifecycleBusyWorkspaceIds}
        theme={theme}
        styles={styles}
      />
      {!selectedWorkspaceIsMain && listResult?.capabilities?.agent ? (
        <View>
        {parentAgentId && agentContextAvailable && !selectedWorkspaceBlocksTasks && !binding?.agentId ? <View style={styles.targetRow}>
          <TextInput value={handoffGoal} onChangeText={setHandoffGoal} placeholder={localizedCopy.text_1b37d56f7a} style={styles.targetInput} />
          <View style={styles.briefActions}>
            {(["default", "independent", "child"] as const).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: handoffRelationship === relationship }} onPress={() => setHandoffRelationship(relationship)} style={[styles.secondaryButton, handoffRelationship === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "default" ? localizedCopy.reviewSettingsFollowDefault : relationship === "independent" ? localizedCopy.reviewSettingsIndependentShort : localizedCopy.reviewSettingsChildAgent}</Text></Pressable>)}
          </View>
          <Pressable onPress={() => setHandoffPacketOpen(true)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.handoffPacket}</Text></Pressable>
          <Pressable disabled={delegating || !handoffGoal.trim()} onPress={delegateSelectedWorkspace} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.handoffPreview}</Text></Pressable>
        </View> : null}
        <ExecutionBindingCard
          workspaceId={selectedWorkspaceId}
          binding={binding}
          agent={boundAgent}
          loading={Boolean(selectedWorkspaceId && bindingQuery.isFetching && !bindingQuery.data)}
          refreshing={manualRefreshing && bindingQuery.isFetching}
          error={bindingFailure}
          canDelegate={Boolean(parentAgentId && agentContextAvailable && !selectedWorkspaceBlocksTasks)}
          agentContextState={agentContextState}
          delegating={delegating}
          onDelegate={delegateSelectedWorkspace}
          onOpenAgent={boundAgent?.id && props.navigation ? () => props.navigation?.openAgent({ agentId: boundAgent.id }) : undefined}
          theme={theme}
          styles={styles}
        />
        {binding?.handoffBundle ? <HandoffMaterialsCard key={`${binding.handoffBundle.id}:${binding.handoffBundle.version}`} projectConfig={projectConfig} workspaceId={selectedWorkspaceId} bundle={binding.handoffBundle} styles={styles} /> : null}
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
        <TabButton active={tab === "workspace"} label={localizedCopy.tabWorkspace} onPress={() => setTab("workspace")} theme={theme} styles={styles} />
        <TabButton active={tab === "review" && reviewTab === "set"} label={`${localizedCopy.tabReviewSet}${reviewIds.length ? ` ${reviewIds.length}` : ""}`} onPress={() => { setTab("review"); setReviewTab("set"); }} theme={theme} styles={styles} />
        {selectedWorkspaceId && selectedWorkspace?.kind !== "linked-live" && listResult?.capabilities?.agent ? <TabButton active={tab === "review" && reviewTab === "agent"} label={localizedCopy.tabAgentReview} onPress={() => { setTab("review"); setReviewTab("agent"); }} theme={theme} styles={styles} /> : null}
      </ScrollView>
      <View
        style={styles.bodyShell}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          if (Math.abs(height - panelHeight) > 1) setPanelHeight(height);
        }}
      >
        <SectionAllocationContext.Provider value={allocation}>
        <BodyContainer {...(tab === "review" || allocation.outerScroll ? { scrollEnabled: !sectionDragging, contentContainerStyle: styles.bodyContent } : {})} style={[styles.body, tab === "workspace" && !allocation.outerScroll && styles.bodyContent, stableScrollbarStyle]}>
          {backendQuery.data && backendQuery.data.state !== "ready" && !listReady ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningTitle}>{localizedCopy.setupBackendTitle}</Text>
              <Text style={styles.warningText}>{backendQuery.data.message || (backendQuery.data.state === "starting" ? localizedCopy.setupBackendStarting : localizedCopy.setupBackendFailed)}</Text>
              <Pressable accessibilityRole="button" disabled={backendQuery.isFetching} onPress={() => { void backendQuery.refetch(); }} style={{ marginTop: 7 }}><Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{backendQuery.isFetching ? localizedCopy.setupBackendStarting : localizedCopy.setupRetry}</Text></Pressable>
            </View>
          ) : null}
          {tab === "workspace" ? (
            <WorkspaceView
              observationTimes={{ detail: detailState.lastSuccessfulAt, graph: graphState.lastSuccessfulAt, changes: changesState.lastSuccessfulAt }}
              detail={displayDetail}
              unavailable={listUnavailable || detailUnavailable}
              detailLoading={listContentState === 'loading' || detailQuery.isLoading && !detail}
              detailRefreshing={manualRefreshing}
              detailError={listUnavailable ? localizedCopy.workspaceListUnavailable : detailFailure}
              graph={displayDetail ? graph : null}
              graphLoading={Boolean(selectedRepository) && (refreshCapable ? graphFeedback.loading : graphQuery.isFetching && !graph)}
              graphRefreshing={manualRefreshing}
              graphError={graphFailure || (refreshCapable && graphFeedback.failed ? (graph ? localizedCopy.observationUpdatePending : localizedCopy.observationUpdateFailed) : null)}
              changes={displayDetail ? changes : null}
              changesLoading={Boolean(selectedRepository) && (refreshCapable ? changesFeedback.loading : changesQuery.isFetching && !changes)}
              changesRefreshing={manualRefreshing}
              changesError={changesFailure || (refreshCapable && changesFeedback.failed ? (changes ? localizedCopy.observationUpdatePending : localizedCopy.observationUpdateFailed) : null)}
              changesStale={changesState.expired}
              changesCurrent={Boolean(changes) && !changesState.stale && !changesFailure}
              treeMode={changeTreeMode || defaultTreeMode(changes?.files || [])}
              onTreeMode={setChangeTreeMode}
              selectedCommit={selectedCommit}
              selectedFile={selectedFile}
              changeScope={changeScope}
              selectedRepository={selectedRepository}
              repositoryDetailsOpen={repositoryDetailsOpen}
              onToggleRepositoryDetails={onToggleRepositoryDetails}
              onCommit={chooseCommit}
              onGraphBase={onGraphBase}
              onGraphMore={onGraphMore}
              graphIdentity={`${hostWorkspaceId}:${selectedWorkspaceId}:${selectedRepoPath}`}
              graphLoadingMore={graphBusy && Boolean(graph)}
              onScope={chooseScope}
              onFile={onOpenChangedFile}
              onRepo={onRepo}
              sectionLayout={preferences.sectionLayout}
              availableHeight={panelHeight}
              sectionDragging={sectionDragging}
              onContentLayout={onWorkspaceContentLayout}
              onSectionToggle={onSectionToggle}


              onOpenLayoutMenu={openLayoutMenu}
              onPrepareToolchain={!selectedWorkspaceIsMain ? prepareSelectedToolchain : undefined}
              preparingToolchain={preparingToolchain}
              confirmedRepositoryCount={basicCapable ? basicSummaries.confirmed : undefined}
              preparationProgress={preparation.task?.state === 'recovering' || preparation.error ? localizedCopy.prepareRecovering : preparation.task && preparation.task.state !== 'idle' ? `${localizedCopy.prepareProgress}: ${preparation.task.repositories?.filter((repo: any) => repo.state === 'ready').length || 0}/${preparation.task.repositories?.length || 0}${['failed','interrupted'].includes(preparation.task.state) ? ` · ${localizedCopy.prepareNeedsContinue}` : ''}` : undefined}
              graphPlatform={layout.platform}
              theme={theme}
              styles={styles}
            />
          ) : reviewTab === "agent" ? <View>
            {selectedWorkspaceIsMain ? <View style={styles.targetRow}>
              <Text style={styles.layoutMenuHint}>{localizedCopy.mainReviewHint}</Text>
              <TextInput value={mainReviewInstructions} onChangeText={setMainReviewInstructions} placeholder={localizedCopy.mainReviewInstructions} multiline style={styles.targetInput} />
            </View> : null}
            <AgentReviewView session={agentReview} history={agentReviewHistoryQuery.data?.sessions || []} loading={agentReviewQuery.isFetching} onStart={startAgentReview} onReview={() => controlAgentReview("review")} onRepair={() => controlAgentReview("repair")} onStop={() => controlAgentReview("stop")} onResume={() => controlAgentReview("resume")} onIndependent={() => controlAgentReview("independent")} onSelectHistory={setReviewSessionId} onOpenAgent={props.navigation ? (id) => props.navigation?.openAgent({ agentId: id }) : undefined} readOnly={selectedWorkspaceIsMain} theme={theme} styles={styles} />
          </View> : (
            <ReviewView
              key={reviewIds.join("|")}
              workspaces={allWorkspaces.filter((workspace) => !isMainWorkspace(workspace))}
              lastSuccessfulAt={reviewState.lastSuccessfulAt}
              review={review}
              refreshing={manualRefreshing}
              error={review ? null : reviewFailure}
              reviewIds={reviewIds}
              onToggle={toggleReview}
              targetOverrides={targetOverrides}
              onTargetOverride={(repoPath, value) => setTargetOverrides((current) => ({ ...current, [repoPath]: value }))}
              onCopy={copyBrief}
              theme={theme}
              styles={styles}
            />
          )}
        </BodyContainer>
        </SectionAllocationContext.Provider>
      </View>
      <AnchoredMenu open={statusMenuOpen} onClose={() => setStatusMenuOpen(false)} theme={theme}>
        <Text style={styles.layoutMenuHint}>{observationLabel}</Text>
        {backendReady && !basicCapable ? <Text style={styles.layoutMenuHint}>{localizedCopy.basicObservationCompatibility}</Text> : null}
        {preparation.task && preparation.task.state !== 'idle' ? <Text style={styles.layoutMenuHint}>{locale === 'zh-CN' ? '运行时准备' : 'Runtime preparation'} · {preparationPhase} · {(preparation.task.repositories || []).filter((repo: any) => repo.state === 'ready').length}/{preparation.task.repositories?.length || 0}</Text> : null}
        {basicCapable ? <Text style={styles.layoutMenuHint}>{locale === 'zh-CN' ? '仓库状态已确认' : 'Repositories verified'} {basicSummaries.confirmed}/{basicSummaries.total}</Text> : null}
        {preparation.task?.error?.message ? <Text style={styles.warningText}>{String(preparation.task.error.message).slice(0, 240)}</Text> : null}
        {(preparation.task?.repositories || []).filter((repo: any) => repo.state === 'failed').map((repo: any) => <Text key={repo.id} style={styles.warningText}>{repo.id} · {String(repo.result?.issues?.[0]?.message || localizedCopy.prepareNeedsContinue).slice(0, 240)}</Text>)}
        {basicSummaries.failures.map(failure => <Text key={failure.repoPath} style={styles.warningText}>{failure.repoPath} · {failure.message}</Text>)}
        {refreshCapable && selectedRefresh.slow && selectedRefresh.pending ? <Text style={styles.layoutMenuHint}>{locale === 'zh-CN' ? '当前仓库仍在更新，已有内容可继续使用' : 'Current repository is still updating; existing content remains available'}</Text> : null}
        {refreshCapable ? Object.entries(selectedRefresh.result?.regions || {}).map(([area, region]) => <Text key={area} style={region.state === 'failed' ? styles.warningText : styles.layoutMenuHint}>{area} · {region.state} · {region.phase}{region.durationMs !== undefined ? ` · ${region.durationMs} ms` : ''}{region.error ? ` · ${region.error.code}: ${region.error.message}` : ''}</Text>) : null}
        {refreshCapable && selectedRefresh.query.data?.error ? <Text style={styles.warningText}>{selectedRefresh.query.data.error.code} · {selectedRefresh.query.data.error.message}{(selectedRefresh.query.data.error.details as any)?.recovery === 'repository' ? (locale === 'zh-CN' ? ' · 将自动恢复' : ' · Automatic recovery scheduled') : ''}</Text> : null}
        {backendQuery.data && !backendQuery.data.readCapabilities ? <Text style={styles.layoutMenuHint}>{localizedCopy.diffCompatibility}</Text> : null}
        <Text style={styles.layoutMenuHint}>{localizedCopy.text_a6625c543c}{formatObservedTime(lastSuccessfulAt, localizedCopy)}</Text>
        {observationIssue ? <Text style={styles.warningText}>{localizedCopy.observationUnavailable}: {observationIssue}</Text> : null}
        {observationAreas.filter((area) => area.snapshot.response || area.fetching || area.snapshot.status !== "loading").map((area) => <Text key={area.label} style={area.snapshot.status === "expired" ? styles.warningText : styles.layoutMenuHint}>{observationAreaDetail(area, localizedCopy)}</Text>)}
        <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.refreshNow} disabled={refreshCapable ? selectedRefresh.manual : manualRefreshing} onPress={() => { setStatusMenuOpen(false); void (!refreshCapable && selectedWorkspaceId ? rpc({ method: "workspace.detail", params: { workspaceId: selectedWorkspaceId, force: true } }).catch(() => undefined).then(() => refreshAll()) : refreshAll()); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.refreshNow}</Text></Pressable>
      </AnchoredMenu>
      <ProjectStorageMenu
        open={storageMenuOpen}
        onClose={() => setStorageMenuOpen(false)}
        storage={storageQuery.data}
        loading={storageQuery.isPending}
        error={Boolean(storageQuery.isError)}
        onRetry={() => { void storageQuery.refetch(); }}
        compact={compact}
        theme={theme}
      />
      <ProjectRuntimeMenu
        open={runtimeSettingsOpen}
        onClose={() => setRuntimeSettingsOpen(false)}
        projectConfig={projectConfig}
        compact={compact}
        theme={theme}
        styles={styles}
        onSaved={() => { void Promise.allSettled([refreshArea("workspace-list"), refreshArea("workspace-detail"), storageQuery.refetch()]); }}
      />
      <WorkspaceDeletionPanel
        open={Boolean(lifecycleWorkspaceId)}
        workspace={observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId) || (lifecycleWorkspace?.id === lifecycleWorkspaceId ? lifecycleWorkspace : undefined)}
        mode={lifecycleMode}
        response={lifecycleResponse}
        busy={lifecycleBusyWorkspaceIds.includes(lifecycleWorkspaceId)}
        error={lifecycleError}
        onClose={closeLifecycle}
        onRemove={() => {
          const target = observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId) || (lifecycleWorkspace?.id === lifecycleWorkspaceId ? lifecycleWorkspace : undefined);
          if (target) void removeWorkspace(target);
        }}
        onRestore={() => {
          const target = observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId) || (lifecycleWorkspace?.id === lifecycleWorkspaceId ? lifecycleWorkspace : undefined);
          if (target) void restoreWorkspace(target);
        }}
        onConfirmPermanent={(confirmDataLoss) => { void permanentDeleteWorkspace(confirmDataLoss); }}
        onOpenTask={openWorkspaceTask}
        theme={theme}
        styles={styles}
      />
      <LayoutMenu
        onSwitchProject={props.onSwitchProject ? () => { setLayoutMenuOpen(false); props.onSwitchProject?.(); } : undefined}
        onCreate={listResult?.capabilities?.create ? () => { setLayoutMenuOpen(false); setCreateOpen(true); } : undefined}
        selectedWorkspace={selectedWorkspace}
        onAddRepositories={selectedWorkspace?.managed && selectedWorkspace.layout !== "gitlink" && !selectedWorkspaceBlocksTasks && listResult?.capabilities?.create ? () => { setLayoutMenuOpen(false); setAddRepositoriesOpen(true); } : undefined}
        onSelectMainRepositories={selectedWorkspaceId === "main" ? () => { setLayoutMenuOpen(false); setMainRepositoryFilter(""); setMainRepositoriesOpen(true); } : undefined}
        onSelectLinkedWorkspaces={() => { setLayoutMenuOpen(false); setLinkedWorkspaceFilter(""); setLinkedWorkspacesOpen(true); }}
        onOpenStorage={openStorageMenu}
        runtimeNotice={(menuToolchain || displayDetail?.workspace.toolchain) && (menuToolchain || displayDetail?.workspace.toolchain).status !== 'not_applicable' ? <ToolchainNotice toolchain={menuToolchain || displayDetail!.workspace.toolchain} repositoryCount={displayDetail?.repositories.length || 0} styles={styles} onPrepare={!selectedWorkspaceIsMain ? prepareSelectedToolchain : undefined} preparing={preparingToolchain} progress={preparation.task?.state !== 'idle' ? preparationPhase : undefined} /> : undefined}
        onOpenRuntimeSettings={openRuntimeSettings}
        onOpenReviewSettings={openReviewSettings}
        open={layoutMenuOpen}
        onClose={() => setLayoutMenuOpen(false)}
        onCollapseAll={collapseAll}
        onExpandAll={expandAll}
        onReset={resetLayout}
        theme={theme}
        styles={styles}
      />
      <AnchoredMenu open={reviewSettingsOpen} onClose={closeReviewSettings} theme={theme} width={compact ? 270 : 330}>
        <ScrollView style={{ maxHeight: compact ? 420 : 600 }} contentContainerStyle={{ gap: 6 }}>
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsTitle}</Text>
        <View style={styles.briefActions}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewSettingsScope === "project" }} onPress={() => { reviewDirtyFields.current.clear(); setReviewSettingsScope("project"); }} style={[styles.secondaryButton, reviewSettingsScope === "project" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsScopeProject}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewSettingsScope === "global" }} onPress={() => { reviewDirtyFields.current.clear(); setReviewSettingsScope("global"); }} style={[styles.secondaryButton, reviewSettingsScope === "global" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsScopeGlobal}</Text></Pressable>
        </View>
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsInheritedHint}</Text>
        <Text style={styles.layoutMenuHint}>{localizedCopy.agentSessionSettings} · {sessionSourceLabel("defaultRelationship")}</Text>
        <View style={styles.briefActions}>
          {(["independent", "child"] as AgentRelationship[]).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: sessionDefaultRelationship === relationship }} onPress={() => { markSessionField("defaultRelationship"); setSessionDefaultRelationship(relationship); }} style={[styles.secondaryButton, sessionDefaultRelationship === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "independent" ? localizedCopy.reviewSettingsIndependent : localizedCopy.reviewSettingsChildAgent}</Text></Pressable>)}
        </View>
        <Text style={styles.layoutMenuHint}>{localizedCopy.agentSessionPermissionSettings} · {sessionSourceLabel("permissionMode")}</Text>
        <Text style={styles.layoutMenuHint}>{localizedCopy.agentSessionPermissionHint}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.briefActions}>
          {(["inherit", "auto", "auto-review", "full-access"] as AgentPermissionMode[]).map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: sessionPermissionMode === mode }} onPress={() => { markSessionField("permissionMode"); setSessionPermissionMode(mode); }} style={[styles.secondaryButton, sessionPermissionMode === mode && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{sessionPermissionLabel(mode)}</Text></Pressable>)}
        </ScrollView>
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsProviderOverrides}</Text>
        {sessionProviders.map((provider) => {
          const selected = sessionProviderRelationships[provider];
          return <View key={provider} style={{ gap: 4 }}>
            <Text style={styles.reviewEntryMeta}>{provider} · {sessionSourceLabel(provider)}</Text>
            <View style={styles.briefActions}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: !selected }} onPress={() => { markSessionField("providerRelationships"); setSessionProviderRelationships((current) => { const next = { ...current }; delete next[provider]; return next; }); }} style={[styles.secondaryButton, !selected && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsFollowDefault}</Text></Pressable>
              {(["independent", "child"] as AgentRelationship[]).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: selected === relationship }} onPress={() => { markSessionField("providerRelationships"); setSessionProviderRelationships((current) => ({ ...current, [provider]: relationship })); }} style={[styles.secondaryButton, selected === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "independent" ? localizedCopy.reviewSettingsIndependentShort : localizedCopy.reviewSettingsChildAgent}</Text></Pressable>)}
            </View>
          </View>;
        })}
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsMode} · {sourceLabel("mode")}</Text>
        <View style={styles.briefActions}>
          {["off", "manual", "automatic"].map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: reviewMode === mode }} onPress={() => { markReviewField("mode"); setReviewMode(mode as "off" | "manual" | "automatic"); }} style={[styles.secondaryButton, reviewMode === mode && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{mode === "off" ? localizedCopy.reviewSettingsModeOff : mode === "manual" ? localizedCopy.reviewSettingsModeManual : localizedCopy.reviewSettingsModeAutomatic}</Text></Pressable>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: autoFix }} onPress={() => { markReviewField("autoFix"); setAutoFix((value) => !value); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{autoFix ? `✓ ${localizedCopy.reviewSettingsAutoFix}` : `○ ${localizedCopy.reviewSettingsManualFix}`} · {sourceLabel("autoFix")}</Text></Pressable>
        <TextInput accessibilityLabel={localizedCopy.reviewSettingsRole} onChangeText={(value) => { markReviewField("reviewerRole"); setReviewerRole(value); }} placeholder={`${localizedCopy.reviewSettingsRole} · ${sourceLabel("reviewerRole")}`} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={reviewerRole} />
        <TextInput accessibilityLabel={localizedCopy.reviewSettingsInstructions} multiline onChangeText={(value) => { markReviewField("instructions"); setReviewInstructions(value); }} placeholder={`${localizedCopy.reviewSettingsInstructions} · ${sourceLabel("instructions")}`} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { minHeight: 48 }]} value={reviewInstructions} />
        <TextInput accessibilityLabel={localizedCopy.reviewSettingsMaxRounds} keyboardType="number-pad" onChangeText={(value) => { markReviewField("maxRounds"); setMaxRounds(value); }} placeholder={`${localizedCopy.reviewSettingsMaxRounds} · ${sourceLabel("maxRounds")}`} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={maxRounds} />
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsTimeout} · {localizedCopy.reviewSettingsReviewerTimeout} {sourceLabel("reviewerTimeoutMs")} / {localizedCopy.reviewSettingsRepairTimeout} {sourceLabel("repairTimeoutMs")}</Text>
        <View style={styles.briefActions}>
          <TextInput accessibilityLabel={localizedCopy.reviewSettingsReviewerTimeout} keyboardType="number-pad" onChangeText={(value) => { markReviewField("reviewerTimeoutMs"); setReviewerTimeoutMinutes(value); }} placeholder={localizedCopy.reviewSettingsReviewerTimeoutPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { flex: 1 }]} value={reviewerTimeoutMinutes} />
          <TextInput accessibilityLabel={localizedCopy.reviewSettingsRepairTimeout} keyboardType="number-pad" onChangeText={(value) => { markReviewField("repairTimeoutMs"); setRepairTimeoutMinutes(value); }} placeholder={localizedCopy.reviewSettingsRepairTimeoutPlaceholder} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { flex: 1 }]} value={repairTimeoutMinutes} />
        </View>
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsReviewerSession} · {sourceLabel("reviewerSession")}</Text>
        <View style={styles.reviewTagRow}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerTarget === "coordinator" }} onPress={() => { markReviewField("reviewerTarget"); setReviewerTarget("coordinator"); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewCoordinator}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerTarget === "independent" }} onPress={() => { markReviewField("reviewerTarget"); setReviewerTarget("independent"); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewIndependentSwitch}</Text></Pressable>
        </View>
        <View style={styles.briefActions}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerSession === "reuse" }} onPress={() => { markReviewField("reviewerSession"); setReviewerSession("reuse"); }} style={[styles.secondaryButton, reviewerSession === "reuse" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsReuse}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerSession === "new_per_round" }} onPress={() => { markReviewField("reviewerSession"); setReviewerSession("new_per_round"); }} style={[styles.secondaryButton, reviewerSession === "new_per_round" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsNewPerRound}</Text></Pressable>
        </View>
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsExecutionModel} · {sourceLabel("executionModel")}</Text>
        <Pressable accessibilityRole="button" onPress={() => { markReviewField("executionModel"); setExecutionModel(""); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.reviewSettingsFollowExecution}{!executionModel ? " ✓" : ""}</Text></Pressable>
        {(reviewModelsQuery.data?.models || []).slice(0, 6).map((model) => <Pressable key={`exec-${model.id}`} accessibilityRole="button" onPress={() => { markReviewField("executionModel"); setExecutionModel(model.id); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{model.label}{executionModel === model.id ? " ✓" : ""}</Text></Pressable>)}
        {reviewSettingsScope === "project" && hasReviewOverride("executionModel") ? <Pressable accessibilityRole="button" onPress={() => resetReviewField("executionModel")} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.reviewSettingsResetExecution}</Text></Pressable> : null}
        <Text style={styles.layoutMenuHint}>{localizedCopy.reviewSettingsReviewerModel} · {sourceLabel("reviewerModel")}</Text>
        <Pressable accessibilityRole="button" onPress={() => { markReviewField("reviewerModel"); setReviewerModel(""); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.reviewSettingsFollowExecution}{!reviewerModel ? " ✓" : ""}</Text></Pressable>
        {(reviewModelsQuery.data?.models || []).slice(0, 6).map((model) => <Pressable key={`review-${model.id}`} accessibilityRole="button" onPress={() => { markReviewField("reviewerModel"); setReviewerModel(model.id); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{model.label}{reviewerModel === model.id ? " ✓" : ""}</Text></Pressable>)}
        {reviewSettingsScope === "project" && hasReviewOverride("reviewerModel") ? <Pressable accessibilityRole="button" onPress={() => resetReviewField("reviewerModel")} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.reviewSettingsResetReviewer}</Text></Pressable> : null}
        {reviewSettingsScope === "project" ? <Pressable accessibilityRole="button" onPress={() => { void resetAllProjectReviewOverrides(); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.reviewSettingsResetAll}</Text></Pressable> : null}
        <Pressable accessibilityRole="button" onPress={saveReviewSettings} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{localizedCopy.reviewSettingsSave}</Text></Pressable>
        </ScrollView>
      </AnchoredMenu>
    </View>
  );
}
