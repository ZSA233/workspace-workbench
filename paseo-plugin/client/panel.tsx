import { useObservationRefresh } from "./use-observation-refresh";
import { useObservationVersions } from "./use-observation-versions";
import {
useRpc,
type PluginAgentPanelProps,
type PluginSurfaceProps,
type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { copyText,Modal,ScrollView,TextInput,useToast } from "./native-components";
import { useQuery } from "@tanstack/react-query";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { AccessibilityInfo,LayoutAnimation,Platform,Pressable,Text,UIManager,View,type ViewStyle } from "react-native";
import { copy, getWorkbenchCopy, localizedReviewError, type WorkbenchCopy, type WorkbenchLocale } from "../shared/copy";

import {
  agentContextQuery,
  workspaceBindingQuery,
  workspaceDelegate,
  workspaceHandoffPreview,
  type AgentContextResponse,
  type WorkspaceBindingResponse,
  type WorkspaceDelegateResponse,
} from "../shared/handoff";
import type { Handoff } from "../shared/handoff";
import type { ReviewPacket } from "../shared/review-packet";
import { artifactList } from "../shared/artifacts";
import { agentSessionProviders, agentSessionSettingsGet, agentSessionSettingsUpdate, type AgentPermissionMode, type AgentRelationship, type AgentSessionPatch } from "../shared/agent-session";
import { observerQuery } from "../shared/observer";
import { projectsQuery, type ProjectInfo } from "../shared/projects";
import { projectBackendStart, projectStorageQuery } from "../shared/setup";
import {
  DEFAULT_OBSERVATION_TIMING,
  observationTimingFromWire,
} from "../shared/observation-timing";
import { workspaceLifecycle, type WorkspaceLifecycleResponse } from "../shared/workspace-lifecycle";
import { isMainWorkspace,isRecoverableObserverFailure,makeStyles,mergeDetailResponse,queryErrorMessage,queryFailureForDisplay,resultOf,TabButton,workspaceIdFromProps } from "./components/ui";
import { openFileReview } from "./file-review-store";
import {
defaultTreeMode,
formatObservedTime,
matchesWorkspaceFilter,
  resolveWorkspaceSelection,
  sortWorkspaces,
  sortWorkspacesByLatestCommit,
type ChangeScope,
type ChangesResult,
type DetailResult,
  type FileChange,
  type GraphResult,
  type ListResult,
type ReviewResult,
type WorkspaceFilter,
type WorkspaceSummary,
type WorkspaceTask
} from "./model";
import { boundedRefresh, RECOVERABLE_FAILURE_GRACE_MS, useBoundedCacheRefresh, useLastSuccessfulResponse } from "./observation";
import { useRefreshOnForeground } from "./foreground-refresh";
import { useForegroundActivity } from "./foreground-activity";
import { useObserverPreferences } from "./preferences";
import { type WorkbenchSurfaceProps, useWorkbenchWorkspaceSnapshot, useWorkbenchWorkspaceSnapshotStatus } from "./surface-context";
import { localeFromHostProps, useWorkbenchCopy, WorkbenchLocaleProvider, useWorkbenchLocale } from "./i18n";
import { reportNativeDiagnostic } from "./native-diagnostics";
import { queryDiagnosticDetails, observationAreaDetail, type ObservationArea } from "./panel/observation-display";
import { useTransientObserverRetry } from "./panel/use-transient-observer-retry";
import { projectPreferenceScopeKey } from "./panel/scope";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";
type MainRepositorySelection = {
  revision: number;
  sourceRoot: string;
  scan?: { incomplete: boolean; reason?: "directory_limit" | "entry_limit" | "time_limit" | "cancelled"; scannedDirectories: number };
  repositories: Array<{ id: string; name: string; path: string; configured: boolean; exists: boolean; missing: boolean; selected: boolean }>;
};
type LinkedWorkspaceSelection = {
  revision: number;
  scan?: { incomplete: boolean };
  repositories: Array<{ path: string; name: string; selected: boolean; missing?: boolean; links?: Array<{ path: string }> }>;
};
type OrphanPreview = {
  id: string; treePath: string; eligible: boolean; fingerprint: string;
  repositories: Array<{ id: string; repoPath: string; sourcePath: string; configured?: boolean; worktreePath: string; head: string; branch: string | null; dirty: boolean; dirtyPaths: string[] }>;
  issues: Array<{ code: string; message: string; path?: string }>;
  warnings?: Array<{ code: string; message: string; path?: string }>;
  plannedBranches?: Record<string, string>;
  resume?: boolean;
};

const noSectionDragState = () => {};

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function referenceKind(path: string): "file" | "document" | "prototype" | "image" | "pdf" {
  const lower = path.toLowerCase();
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return "image";
  if (lower.endsWith(".pdf")) return "pdf";
  if (/\.(md|markdown|txt|json|html?)$/.test(lower)) return "document";
  return "file";
}

function reviewPacketFromEditor(input: { understanding: string; plan: string; acceptance: string; references: string; instructions: string }): ReviewPacket {
  const acceptanceCriteria = nonEmptyLines(input.acceptance).map((text, index) => ({ id: `AC-${index + 1}`, text, required: true }));
  const references = nonEmptyLines(input.references).map((value, index) => {
    if (value.startsWith("asset:")) {
      const assetId = value.slice("asset:".length).trim();
      return { id: `REF-${index + 1}`, kind: "image" as const, title: assetId || `Asset ${index + 1}`, assetId, required: true };
    }
    const separator = value.indexOf(":");
    const hasRepositoryPrefix = separator > 0 && !value.startsWith("./") && !value.startsWith("../") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value);
    const repositoryId = hasRepositoryPrefix ? value.slice(0, separator).trim() : undefined;
    const path = hasRepositoryPrefix ? value.slice(separator + 1).trim() : value;
    return { id: `REF-${index + 1}`, kind: referenceKind(path), title: path, required: true, ...(repositoryId ? { repositoryId } : {}), path };
  }).filter((reference) => Boolean(reference.assetId || ("path" in reference && reference.path)));
  return {
    requirementUnderstanding: input.understanding.trim(),
    plan: nonEmptyLines(input.plan),
    acceptanceCriteria,
    references,
    instructions: input.instructions.trim(),
  };
}

function appendAssetReference(current: string, assetId: string): string {
  const line = `asset:${assetId}`;
  if (nonEmptyLines(current).some((value) => value === line)) return current;
  return current.trim() ? `${current.trim()}\n${line}` : line;
}

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

// React Native's shared cursor type only exposes `auto` and `pointer`, while
// the web renderer forwards the full CSS cursor value. Keep the native style
// portable and add the vertical resize affordance only where it is supported.
const verticalResizeCursorStyle: ViewStyle | null = Platform.OS === "web"
  ? ({ cursor: "ns-resize" } as unknown as ViewStyle)
  : null;

import { AnchoredMenu,LayoutMenu,WorkspaceSelector } from "./components/navigation";
import { IconButton } from "./components/icon-button";
import { stableScrollbarStyle } from "./components/ui";
import { SectionAllocationContext } from "./components/ui";
import { allocateSections } from "./section-allocation";
import { useSectionSizing } from "./use-section-sizing";
import { chooseProject, useProjectMemory } from "./project-memory";
import { CreateWorkspace } from "./components/create-workspace";
import { ProjectSetup } from "./components/project-setup";
import { ProjectStorageMenu } from "./components/project-storage";
import { ProjectRuntimeMenu } from "./components/project-runtime";
import { WorkspaceDeletionPanel } from "./components/workspace-deletion";

import { ExecutionBindingCard } from "./components/agent";

import { WorkspaceView } from "./components/repositories";

import { ReviewView } from "./components/review";
import { AgentReviewView } from "./components/agent-review";
import { HandoffMaterialsCard } from "./components/handoff-materials";
import { reviewModels, reviewSessionControl, reviewSessionList, reviewSessionQuery, reviewSessionStart, reviewSettingsGet, reviewSettingsUpdate, type ReviewModelOverride, type ReviewPreferencePatch, type ReviewSession } from "../shared/agent-review";

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
  if (hostContextPending || (!directory && !memory.ready)) {
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
    {projects.data?.map((p) => <Pressable key={p.configPath} onPress={() => { setChosen(p.configPath); setSetupProject(null); setPickingProject(false); }}><Text style={{ color: props.theme.colors.foreground }}>{p.displayName}</Text></Pressable>)}
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
  try {
    foreground = useForegroundActivity();
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
  const [reviewSettingsOpen, setReviewSettingsOpen] = useState(false);
  const [reviewSettingsScope, setReviewSettingsScope] = useState<"project" | "global">("project");
  const [reviewMode, setReviewMode] = useState<"off" | "manual" | "automatic">("off");
  const [autoFix, setAutoFix] = useState(false);
  const [maxRounds, setMaxRounds] = useState("3");
  const [reviewerTimeoutMinutes, setReviewerTimeoutMinutes] = useState("15");
  const [repairTimeoutMinutes, setRepairTimeoutMinutes] = useState("30");
  const [reviewerRole, setReviewerRole] = useState("");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const [reviewerSession, setReviewerSession] = useState<"reuse" | "new_per_round">("reuse");
  const [reviewerTarget, setReviewerTarget] = useState<"coordinator" | "independent">("independent");
  const [executionModel, setExecutionModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const reviewDirtyFields = useRef(new Set<string>());
  const sessionDirtyFields = useRef(new Set<string>());
  const [sessionDefaultRelationship, setSessionDefaultRelationship] = useState<AgentRelationship>("independent");
  const [sessionPermissionMode, setSessionPermissionMode] = useState<AgentPermissionMode>("inherit");
  const [sessionProviderRelationships, setSessionProviderRelationships] = useState<Record<string, AgentRelationship>>({});
  const markReviewField = useCallback((field: string) => { reviewDirtyFields.current.add(field); }, []);
  const markSessionField = useCallback((field: string) => { sessionDirtyFields.current.add(field); }, []);
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
  const seenBackendInstanceId = useRef<string | null>(null);
  useEffect(() => {
    seenBackendInstanceId.current = null;
  }, [projectConfig]);
  const rawBindingRpc = useRpc(workspaceBindingQuery);
  const bindingRpc = (input: Parameters<typeof rawBindingRpc>[0]) => rawBindingRpc({ ...input, projectConfig });
  const rawDelegateRpc = useRpc(workspaceDelegate);
  const delegateRpc = (input: Parameters<typeof rawDelegateRpc>[0]) => rawDelegateRpc({ ...input, projectConfig });
  const artifactListRpc = useRpc(artifactList);
  const lifecycleRpc = useRpc(workspaceLifecycle);
  const toast = useToast();
  const selectedWorkspaceId = preferences.selectedWorkspaceId;
  const [selectionResolved, setSelectionResolved] = useState(false);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [activityScanId, setActivityScanId] = useState("");
  const activityScanIdRef = useRef("");
  const [activityScanProgress, setActivityScanProgress] = useState<{ completed: number; total: number } | null>(null);
  const [sortByLatestCommit, setSortByLatestCommit] = useState(false);
  const [selectedRepoPath, setSelectedRepoPath] = useState("");
  const [tab, setTab] = useState<"workspace" | "review">("workspace");
  const [reviewTab, setReviewTab] = useState<"set" | "agent">("set");
  const [reviewSessionId, setReviewSessionId] = useState("");
  const [mainReviewInstructions, setMainReviewInstructions] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceFilter>("all");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [changeScope, setChangeScope] = useState<Exclude<ChangeScope, "commit">>("branch");
  const [graphView, setGraphView] = useState<{ historyMode: "branch" | "full"; maxCommits: number }>({ historyMode: "branch", maxCommits: 50 });
  const [changeTreeMode, setChangeTreeMode] = useState<ChangeTreeMode | null>(null);
  const scopeRepositoryIdentity = useRef("");
  const [repositoryDetailsOpen, setRepositoryDetailsOpen] = useState(false);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [targetOverrides, setTargetOverrides] = useState<Record<string, string>>({});
  const [handoffGoal, setHandoffGoal] = useState("");
  const [handoffRelationship, setHandoffRelationship] = useState<"default" | AgentRelationship>("default");
  const [handoffPacketOpen, setHandoffPacketOpen] = useState(false);
  const [handoffPreviewOpen, setHandoffPreviewOpen] = useState(false);
  const previewHandoffRpc = useRpc(workspaceHandoffPreview);
  const handoffPreviewEpoch = useRef(0);
  const [materialPreview, setMaterialPreview] = useState<{ ok: boolean; signature: string; materials?: { ready: boolean; sourceCount: number; blockers: string[]; warnings: string[]; conversation: { state: string } } | null } | null>(null);
  const [handoffUnderstanding, setHandoffUnderstanding] = useState("");
  const [handoffPlan, setHandoffPlan] = useState("");
  const [handoffAcceptance, setHandoffAcceptance] = useState("");
  const [handoffReferences, setHandoffReferences] = useState("");
  const [handoffReviewInstructions, setHandoffReviewInstructions] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [workerStartMode, setWorkerStartMode] = useState<"adaptive" | "plan-first">("adaptive");
  const [addRepositoriesOpen, setAddRepositoriesOpen] = useState(false);
  const [mainRepositoriesOpen, setMainRepositoriesOpen] = useState(false);
  const [mainRepositoryFilter, setMainRepositoryFilter] = useState("");
  const [mainRepositoryDraft, setMainRepositoryDraft] = useState<string[]>([]);
  const [savingMainRepositories, setSavingMainRepositories] = useState(false);
  const [linkedWorkspacesOpen, setLinkedWorkspacesOpen] = useState(false);
  const [linkedWorkspaceFilter, setLinkedWorkspaceFilter] = useState("");
  const [linkedWorkspaceDraft, setLinkedWorkspaceDraft] = useState<string[]>([]);
  const [savingLinkedWorkspaces, setSavingLinkedWorkspaces] = useState(false);
  const [orphanId, setOrphanId] = useState("");
  const [orphanBranches, setOrphanBranches] = useState<Record<string, string>>({});
  const [adoptingOrphan, setAdoptingOrphan] = useState(false);
  const [orphanError, setOrphanError] = useState("");
  const newlyCreatedWorkspace = useRef<string | null>(null);
  const [delegating, setDelegating] = useState(false);
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState("");
  const [lifecycleMode, setLifecycleMode] = useState<"inspect" | "permanent">("inspect");
  const [lifecycleResponse, setLifecycleResponse] = useState<WorkspaceLifecycleResponse | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleBusyWorkspaceId, setLifecycleBusyWorkspaceId] = useState("");
  const [preparingToolchain, setPreparingToolchain] = useState(false);

  useEffect(() => {
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    setReviewSessionId("");
    setHandoffGoal("");
    setHandoffRelationship("default");
    setHandoffPacketOpen(false);
    setHandoffPreviewOpen(false);
    handoffPreviewEpoch.current++; setMaterialPreview(null);
    setHandoffUnderstanding("");
    setHandoffPlan("");
    setHandoffAcceptance("");
    setHandoffReferences("");
    setHandoffReviewInstructions("");
    scopeRepositoryIdentity.current = "";
  }, [preferenceScopeKey, selectedWorkspaceId]);

  const listQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "workspace-list"],
    queryFn: () => rpc({ method: "workspace.list", params: { includeRemoved: true } }),
    enabled: Boolean(projectConfig && backendReady),
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const listState = useLastSuccessfulResponse("workspace-list", listQuery.data, { error: listQuery.error, staleAfterMs: observationTiming.staleWindowsMs.list });
  const listResult = resultOf<ListResult>(listState.response);
  const listFailure = queryFailureForDisplay(listState, listQuery.data, listQuery.error, localizedCopy);
  reportNativeDiagnostic("project-panel-list-state", queryDiagnosticDetails(listQuery.data, listQuery.error, listQuery, listState));
  useTransientObserverRetry(listQuery, listState, Boolean(projectConfig && backendReady && foreground));
  const listReady = Boolean(listResult);
  const orphanPreviewQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "orphan-preview", orphanId],
    queryFn: () => rpc({ method: "workspace.orphan.preview", params: { workspaceId: orphanId } }),
    enabled: Boolean(projectConfig && backendReady && orphanId), retry: false, staleTime: 0, refetchOnWindowFocus: false,
  });
  const orphanPreview = resultOf<OrphanPreview>(orphanPreviewQuery.data);
  useEffect(() => { setOrphanBranches(orphanPreview?.plannedBranches || {}); setOrphanError(""); }, [orphanId, orphanPreview?.fingerprint]);
  const observationVersionsEnabled = listReady && foreground && Platform.OS === "web";
  const observationIssue = useObservationVersions(projectConfig, [selectedWorkspaceId], observationVersionsEnabled);
  if (Platform.OS !== "web") reportNativeDiagnostic("observation-versions-native-disabled", { reason: "android-render-diagnostic" });
  useEffect(() => {
    if (!backendReady || listReady) return;
    void listQuery.refetch();
  }, [backendQuery.data?.state, listReady, listQuery.refetch]);
  useEffect(() => { if (listReady) props.onProjectReady?.(); }, [listReady, props.onProjectReady]);
  const listUnavailable = !listReady
    && listState.initialFailure
    && (!isRecoverableObserverFailure(listQuery.data, listQuery.error)
      || (listState.failureAgeMs ?? RECOVERABLE_FAILURE_GRACE_MS) >= RECOVERABLE_FAILURE_GRACE_MS);
  const observedWorkspaces = useMemo(() => {
    const rows = listReady ? listResult?.workspaces || [] : [];
    return sortByLatestCommit ? sortWorkspacesByLatestCommit(rows) : sortWorkspaces(rows);
  }, [listReady, listResult?.workspaces, sortByLatestCommit]);
  const allWorkspaces = useMemo(
    () => observedWorkspaces.filter((workspace) => workspace.state !== "removed"),
    [observedWorkspaces],
  );
  const mainRepositoriesQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "main-repositories"],
    queryFn: () => rpc({ method: "main.repositories.list", params: {} }),
    enabled: Boolean(projectConfig && backendReady && mainRepositoriesOpen),
    retry: false,
    staleTime: 0,
  });
  const mainRepositories = resultOf<MainRepositorySelection>(mainRepositoriesQuery.data);
  useEffect(() => {
    if (mainRepositories) setMainRepositoryDraft(mainRepositories.repositories.filter(repo => repo.selected).map(repo => repo.path));
  }, [mainRepositories?.revision]);
  const linkedWorkspacesQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "linked-workspaces"],
    queryFn: () => rpc({ method: "linked.workspaces.list", params: {} }),
    enabled: Boolean(projectConfig && backendReady && linkedWorkspacesOpen), retry: false, staleTime: 0,
  });
  const linkedWorkspaces = resultOf<LinkedWorkspaceSelection>(linkedWorkspacesQuery.data);
  useEffect(() => {
    if (linkedWorkspaces) setLinkedWorkspaceDraft(linkedWorkspaces.repositories.filter(item => item.selected).map(item => item.path));
  }, [linkedWorkspaces?.revision]);
  const historyWorkspaces = useMemo(
    () => observedWorkspaces.filter((workspace) => workspace.state === "removed"),
    [observedWorkspaces],
  );
  const workspacePool = workspaceFilter === "history" ? historyWorkspaces : allWorkspaces;
  const visibleWorkspaces = useMemo(
    () => workspacePool.filter((workspace) => matchesWorkspaceFilter(workspace, workspaceFilter)),
    [workspacePool, workspaceFilter],
  );
  const cancelWorkspaceActivityScan = useCallback((closeSelector = true) => {
    const scanId = activityScanIdRef.current;
    activityScanIdRef.current = "";
    if (closeSelector) setSelectorOpen(false);
    setActivityScanId("");
    setActivityScanProgress(null);
    if (scanId) void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
  }, []);
  const openWorkspaceSelector = useCallback(() => {
    if (selectorOpen) {
      cancelWorkspaceActivityScan();
      return;
    }
    setSelectorOpen(true);
    setSortByLatestCommit(false);
    const scanId = `selector-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    activityScanIdRef.current = scanId;
    void rpcRef.current({
      method: "workspace.activity",
      params: { action: "start", scanId, workspaceIds: observedWorkspaces.map((workspace) => workspace.id) },
    }).then((response) => {
      if (activityScanIdRef.current !== scanId) return;
      if (!response.ok) {
        activityScanIdRef.current = "";
        setActivityScanId("");
        setActivityScanProgress(null);
        void listQuery.refetch().finally(() => setSortByLatestCommit(true));
        return;
      }
      const status = response.result as { state?: string; completed?: number; total?: number } | undefined;
      setActivityScanProgress({ completed: status?.completed || 0, total: status?.total || 0 });
      if (status?.state === "running") {
        setActivityScanId(scanId);
      } else {
        activityScanIdRef.current = "";
        setActivityScanId("");
        setActivityScanProgress(null);
        void listQuery.refetch().finally(() => setSortByLatestCommit(true));
      }
    }).catch(() => {
      if (activityScanIdRef.current !== scanId) return;
      activityScanIdRef.current = "";
      void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
      setActivityScanId("");
      setActivityScanProgress(null);
      setSortByLatestCommit(true);
    });
  }, [cancelWorkspaceActivityScan, listQuery.refetch, observedWorkspaces, selectorOpen]);
  useEffect(() => {
    if (!selectorOpen || !foreground || !activityScanId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const response = await rpcRef.current({ method: "workspace.activity", params: { action: "status", scanId: activityScanId } }).catch(() => null);
      if (stopped || activityScanIdRef.current !== activityScanId) return;
      const status = response?.ok ? response.result as { state?: string; completed?: number; total?: number } | undefined : undefined;
      if (!status) {
        timer = setTimeout(poll, 1_000);
        return;
      }
      setActivityScanProgress({ completed: status.completed || 0, total: status.total || 0 });
      if (status.state === "running") {
        timer = setTimeout(poll, 750);
        return;
      }
      activityScanIdRef.current = "";
      setActivityScanId("");
      setActivityScanProgress(null);
      void listQuery.refetch().finally(() => setSortByLatestCommit(true));
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [activityScanId, foreground, listQuery.refetch, selectorOpen]);
  useEffect(() => {
    if (foreground || !activityScanIdRef.current) return;
    cancelWorkspaceActivityScan();
  }, [cancelWorkspaceActivityScan, foreground]);
  useEffect(() => () => {
    const scanId = activityScanIdRef.current;
    if (scanId) void rpcRef.current({ method: "workspace.activity", params: { action: "cancel", scanId } });
  }, []);
  const workspaceDirectory = paseoWorkspace?.directory || "";
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
  const agentId = "agentId" in props ? props.agentId : undefined;
  const parentAgentId = agentId || null;
  const rawAgentContextRpc = useRpc(agentContextQuery);
  const agentContextRpc = (input: Parameters<typeof rawAgentContextRpc>[0]) => rawAgentContextRpc(input);
  const agentContextQueryState = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-context", parentAgentId],
    queryFn: () => agentContextRpc({ projectConfig, agentId: parentAgentId! }),
    enabled: Boolean(parentAgentId && listReady),
    refetchInterval: foreground ? 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5_000,
  });
  const agentContext = agentContextQueryState.data as AgentContextResponse | undefined;
  const agentContextAvailable = Boolean(agentContext?.ok && agentContext.available);
  const agentContextState: "ready" | "loading" | "unavailable" | "missing" = !parentAgentId
    ? "missing"
    : agentContextQueryState.isPending
      ? "loading"
      : agentContextAvailable
        ? "ready"
        : "unavailable";
  const bindingQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "execution-binding", selectedWorkspaceId],
    queryFn: () => bindingRpc({ workspaceId: selectedWorkspaceId }),
    enabled: Boolean(selectedWorkspaceId && listReady && !selectedWorkspaceIsMain && listResult?.capabilities?.agent),
    refetchInterval: foreground ? 60_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_000,
  });
  const binding = (bindingQuery.data?.binding || null) as WorkspaceBindingResponse["binding"];
  const savedHandoff = bindingQuery.data?.handoff || null;
  const artifactListQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "handoff-artifacts"],
    queryFn: () => artifactListRpc({ projectConfig }),
    enabled: Boolean(projectConfig && handoffPacketOpen),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5_000,
  });
  const boundAgent = (bindingQuery.data?.agent || null) as WorkspaceBindingResponse["agent"];
  const bindingFailure = bindingQuery.data?.error?.message || queryErrorMessage(bindingQuery.error, localizedCopy);
  const identifyQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "identify", workspaceDirectory],
    queryFn: () => rpc({ method: "workspace.identify", params: { directory: workspaceDirectory } }),
    enabled: Boolean(workspaceDirectory && backendReady && preferences.hydrated && !selectionResolved && listReady),
    refetchInterval: false,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
    refetchOnWindowFocus: false,
  });
  const identified = resultOf<{ matched: boolean; workspaceId: string | null }>(identifyQuery.data);

  useEffect(() => {
    if (!listReady || !preferences.hydrated || selectionResolved) return;
    const hasSavedSelection = Boolean(
      preferences.savedWorkspaceId &&
        observedWorkspaces.some((workspace) => workspace.id === preferences.savedWorkspaceId && workspace.state !== "removed"),
    );
    const identifySettled = Boolean(identifyQuery.data || identifyQuery.error);
    if (!hasSavedSelection && workspaceDirectory && !identifySettled) return;
    const resolution = resolveWorkspaceSelection({
      currentWorkspaceId: selectedWorkspaceId,
      savedWorkspaceId: preferences.savedWorkspaceId,
      identifiedWorkspaceId: identified?.matched ? identified.workspaceId : null,
      workspaces: observedWorkspaces,
    });
    if (!resolution) return;
    if (resolution.source === "current" || resolution.source === "saved") {
      setSelectionResolved(true);
      return;
    }
    preferences.selectWorkspace(resolution.workspaceId);
    setSelectionResolved(true);
  }, [
    identifyQuery.data,
    identifyQuery.error,
    identified,
    listReady,
    observedWorkspaces,
    preferences.hydrated,
    preferences.savedWorkspaceId,
    preferences.selectWorkspace,
    selectedWorkspaceId,
    selectionResolved,
    workspaceDirectory,
  ]);

  useEffect(() => {
    if (!listReady || !preferences.hydrated || !selectionResolved || !selectedWorkspaceId) return;
    const currentSelection = observedWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId);
    if (currentSelection && (currentSelection.state !== "removed" || workspaceFilter === "history")) { newlyCreatedWorkspace.current = null; return; }
    // A successful create can precede the last-good roster's React update.
    // Its absence from that older snapshot is not evidence of deletion.
    if (newlyCreatedWorkspace.current === selectedWorkspaceId) return;
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    scopeRepositoryIdentity.current = "";
  }, [listReady, observedWorkspaces, preferences.hydrated, selectedWorkspaceId, selectionResolved, workspaceFilter]);

  const detailQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "workspace-detail", selectedWorkspaceId],
    queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: selectedWorkspaceId, mode: "summary", refreshToolchain: false } }),
    enabled: Boolean(selectedWorkspaceId && selectedWorkspace && backendReady && listReady),
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const detailState = useLastSuccessfulResponse(`workspace-detail:${selectedWorkspaceId}`, detailQuery.data, {
    error: detailQuery.error,
    mergePartial: mergeDetailResponse,
    staleAfterMs: observationTiming.staleWindowsMs.detail,
  });
  const detail = resultOf<DetailResult>(detailState.response);
  const detailFailure = queryFailureForDisplay(detailState, detailQuery.data, detailQuery.error, localizedCopy);
  reportNativeDiagnostic("project-panel-detail-state", queryDiagnosticDetails(detailQuery.data, detailQuery.error, detailQuery, detailState));
  useTransientObserverRetry(detailQuery, detailState, Boolean(projectConfig && backendReady && foreground && selectedWorkspaceId && selectedWorkspace && listReady));
  const detailUnavailable = !detail
    && detailState.initialFailure
    && (!isRecoverableObserverFailure(detailQuery.data, detailQuery.error)
      || (detailState.failureAgeMs ?? RECOVERABLE_FAILURE_GRACE_MS) >= RECOVERABLE_FAILURE_GRACE_MS);
  const displayDetail = listReady && detail?.workspace.id === selectedWorkspaceId
    ? detail
    : null;
  const selectorWorkspace = selectedWorkspace && displayDetail
    ? { ...selectedWorkspace, ...displayDetail.workspace }
    : selectedWorkspace;
  const saveMainRepositories = useCallback(async () => {
    if (!mainRepositories || savingMainRepositories) return;
    setSavingMainRepositories(true);
    try {
      const response = await rpc({ method: "main.repositories.save", params: { revision: mainRepositories.revision, repositories: mainRepositoryDraft } });
      if (!response.ok) throw new Error(response.error?.message || localizedCopy.mainRepositorySaveFailed);
      await Promise.allSettled([listQuery.refetch(), detailQuery.refetch(), mainRepositoriesQuery.refetch()]);
      setMainRepositoriesOpen(false);
    } catch (error) { toast.error(error instanceof Error ? error.message : localizedCopy.mainRepositorySaveFailed); }
    finally { setSavingMainRepositories(false); }
  }, [detailQuery.refetch, listQuery.refetch, localizedCopy.mainRepositorySaveFailed, mainRepositories, mainRepositoriesQuery.refetch, mainRepositoryDraft, rpc, savingMainRepositories, toast]);
  const saveLinkedWorkspaces = useCallback(async () => {
    if (!linkedWorkspaces || savingLinkedWorkspaces) return;
    setSavingLinkedWorkspaces(true);
    try {
      const response = await rpc({ method: "linked.workspaces.save", params: { revision: linkedWorkspaces.revision, repositories: linkedWorkspaceDraft } });
      if (!response.ok) throw new Error(response.error?.message || localizedCopy.linkedWorkspaceSaveFailed);
      await Promise.allSettled([listQuery.refetch(), linkedWorkspacesQuery.refetch()]);
      setLinkedWorkspacesOpen(false);
    } catch (error) { toast.error(error instanceof Error ? error.message : localizedCopy.linkedWorkspaceSaveFailed); }
    finally { setSavingLinkedWorkspaces(false); }
  }, [linkedWorkspaces, savingLinkedWorkspaces, linkedWorkspaceDraft, rpc, localizedCopy.linkedWorkspaceSaveFailed, listQuery.refetch, linkedWorkspacesQuery.refetch, toast]);
  const selectedRepository = displayDetail?.workspace.id === selectedWorkspaceId
    ? displayDetail.repositories.find((repository) => repository.repoPath === selectedRepoPath)
    : undefined;

  useEffect(() => {
    const first = displayDetail?.workspace.id === selectedWorkspaceId ? displayDetail.repositories[0]?.repoPath || "" : "";
    if (!selectedRepository && first) setSelectedRepoPath(first);
    if (!first && selectedRepoPath) setSelectedRepoPath("");
  }, [displayDetail, selectedRepoPath, selectedRepository, selectedWorkspaceId]);

  const graphQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "repository-graph", selectedWorkspaceId, selectedRepoPath, graphView.historyMode, graphView.maxCommits],
    queryFn: () => rpc({
      method: "repository.graph",
      params: {
        workspaceId: selectedWorkspaceId,
        repoPath: selectedRepoPath,
        historyMode: graphView.historyMode,
        maxCommits: graphView.maxCommits,
      },
    }),
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && backendReady && listReady && !selectedWorkspaceUnavailable),
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const graphState = useLastSuccessfulResponse(`repository-graph:${selectedWorkspaceId}:${selectedRepoPath}`, graphQuery.data, { error: graphQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository });
  const graph = resultOf<GraphResult>(graphState.response);
  const graphFailure = queryFailureForDisplay(graphState, graphQuery.data, graphQuery.error, localizedCopy);
  reportNativeDiagnostic("project-panel-graph-state", queryDiagnosticDetails(graphQuery.data, graphQuery.error, graphQuery, graphState));
  useTransientObserverRetry(graphQuery, graphState, Boolean(projectConfig && backendReady && foreground && selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady && !selectedWorkspaceUnavailable));
  const changesScope: ChangeScope = selectedCommit ? "commit" : changeScope;
  const changesQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "repository-changes", selectedWorkspaceId, selectedRepoPath, changesScope, selectedCommit],
    queryFn: () => rpc({
      method: "repository.changes",
      params: {
        workspaceId: selectedWorkspaceId,
        repoPath: selectedRepoPath,
        scope: changesScope,
        commitSha: selectedCommit || undefined,
      },
    }),
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && backendReady && listReady && !selectedWorkspaceUnavailable),
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const changesState = useLastSuccessfulResponse(
    `repository-changes:${selectedWorkspaceId}:${selectedRepoPath}:${changesScope}:${selectedCommit}`,
    changesQuery.data,
    { error: changesQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository },
  );
  const changes = resultOf<ChangesResult>(changesState.response);
  const changesFailure = queryFailureForDisplay(changesState, changesQuery.data, changesQuery.error, localizedCopy);
  reportNativeDiagnostic("project-panel-changes-state", queryDiagnosticDetails(changesQuery.data, changesQuery.error, changesQuery, changesState));
  useTransientObserverRetry(changesQuery, changesState, Boolean(projectConfig && backendReady && foreground && selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady && !selectedWorkspaceUnavailable));

  useEffect(() => {
    if (changeTreeMode !== null || !changes) return;
    setChangeTreeMode(defaultTreeMode(changes.files));
  }, [changeTreeMode, changes]);

  const repositoryIdentity = `${selectedWorkspaceId}:${selectedRepoPath}`;
  useEffect(() => {
    if (!selectedRepository || !selectedRepoPath || scopeRepositoryIdentity.current === repositoryIdentity) return;
    scopeRepositoryIdentity.current = repositoryIdentity;
    setSelectedCommit("");
    setSelectedFile("");
    setChangeScope(
      selectedRepository.branchScopeAvailable === false
        ? "working"
        : selectedRepository.dirty || (selectedRepository.workingChanges?.files ?? selectedRepository.dirtyPaths?.length ?? 0)
          ? "working"
          : "branch",
    );
    setGraphView({ historyMode: isMainWorkspace(selectedWorkspace) ? "full" : "branch", maxCommits: 50 });
  }, [repositoryIdentity, selectedRepoPath, selectedRepository, selectedWorkspace]);

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
    enabled: tab === "review" && reviewIds.length > 0 && backendReady && listReady,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const reviewState = useLastSuccessfulResponse(`review:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, { error: reviewQuery.error, staleAfterMs: observationTiming.staleWindowsMs.review });
  const review = resultOf<ReviewResult>(reviewState.response);
  const reviewFailure = queryFailureForDisplay(reviewState, reviewQuery.data, reviewQuery.error, localizedCopy);
  const reviewSessionRpc = useRpc(reviewSessionQuery);
  const reviewSessionListRpc = useRpc(reviewSessionList);
  const reviewStartRpc = useRpc(reviewSessionStart);
  const reviewControlRpc = useRpc(reviewSessionControl);
  const reviewSettingsGetRpc = useRpc(reviewSettingsGet);
  const reviewSettingsUpdateRpc = useRpc(reviewSettingsUpdate);
  const reviewModelsRpc = useRpc(reviewModels);
  const agentSessionSettingsGetRpc = useRpc(agentSessionSettingsGet);
  const agentSessionSettingsUpdateRpc = useRpc(agentSessionSettingsUpdate);
  const agentSessionProvidersRpc = useRpc(agentSessionProviders);
  const agentReviewQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review", selectedWorkspaceId, reviewSessionId],
    queryFn: () => reviewSessionRpc({ projectConfig, workspaceId: selectedWorkspaceId, ...(reviewSessionId ? { sessionId: reviewSessionId } : {}) }),
    enabled: Boolean(selectedWorkspaceId && backendReady && listReady), refetchInterval: false, refetchOnWindowFocus: false, retry: false,
  });
  const agentReviewHistoryQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-history", selectedWorkspaceId],
    queryFn: () => reviewSessionListRpc({ projectConfig, workspaceId: selectedWorkspaceId }),
    enabled: Boolean(selectedWorkspaceId && backendReady && listReady), refetchInterval: false, refetchOnWindowFocus: false, retry: false,
  });
  const reviewSettingsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-settings"],
    queryFn: () => reviewSettingsGetRpc({ projectConfig }),
    enabled: Boolean(projectConfig), refetchOnWindowFocus: false, retry: false,
  });
  const agentSessionSettingsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-session-settings"],
    queryFn: () => agentSessionSettingsGetRpc({ projectConfig }),
    enabled: Boolean(projectConfig), refetchOnWindowFocus: false, retry: false,
  });
  const agentSessionProvidersQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-session-providers"],
    queryFn: () => agentSessionProvidersRpc({ projectConfig }),
    enabled: Boolean(projectConfig), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const reviewModelsQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-models", selectedWorkspaceId],
    queryFn: () => reviewModelsRpc({ projectConfig, workspaceId: selectedWorkspaceId }),
    enabled: Boolean(projectConfig && backendReady && selectedWorkspaceId && listReady), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const agentReview = (agentReviewQuery.data?.session || null) as ReviewSession | null;
  const reviewPreferences = reviewSettingsQuery.data?.effective;
  const agentSessionPreferences = agentSessionSettingsQuery.data?.effective;
  const syncReviewEditor = useCallback(() => {
    if (reviewPreferences) {
      reviewDirtyFields.current.clear();
      setReviewMode(reviewPreferences.mode);
      setAutoFix(reviewPreferences.autoFix);
      setMaxRounds(String(reviewPreferences.maxRounds));
      setReviewerTimeoutMinutes(String(Math.max(1, Math.round(reviewPreferences.reviewerTimeoutMs / 60_000))));
      setRepairTimeoutMinutes(String(Math.max(1, Math.round(reviewPreferences.repairTimeoutMs / 60_000))));
      const builtInRole = reviewPreferences.reviewerRole === "Code reviewer" || reviewPreferences.reviewerRole === "代码审核者";
      const builtInInstructions = reviewPreferences.instructions === "Check requirement fit, correctness, regressions and tests; keep the implementation simple."
        || reviewPreferences.instructions === "检查需求是否满足、实现是否正确、是否引入回归、测试是否充分；保持实现简单。";
      setReviewerRole(builtInRole ? localizedCopy.reviewDefaultRole : reviewPreferences.reviewerRole);
      setReviewInstructions(builtInInstructions ? localizedCopy.reviewDefaultInstructions : reviewPreferences.instructions);
      setReviewerSession(reviewPreferences.reviewerSession);
      setReviewerTarget(reviewPreferences.reviewerTarget);
      setExecutionModel(reviewPreferences.executionModel || "");
      setReviewerModel(reviewPreferences.reviewerModel || "");
    }
    if (agentSessionPreferences) {
      sessionDirtyFields.current.clear();
      const sessionPatch = reviewSettingsScope === "project"
        ? agentSessionSettingsQuery.data?.project
        : agentSessionSettingsQuery.data?.global;
      setSessionDefaultRelationship(sessionPatch?.defaultRelationship || agentSessionPreferences.defaultRelationship);
      setSessionPermissionMode(sessionPatch?.permissionMode || agentSessionPreferences.permissionMode);
      setSessionProviderRelationships(sessionPatch?.providerRelationships || {});
    }
  }, [agentSessionPreferences, agentSessionSettingsQuery.data?.global, agentSessionSettingsQuery.data?.project, localizedCopy, reviewPreferences, reviewSettingsScope]);
  useEffect(() => { syncReviewEditor(); }, [syncReviewEditor]);
  const saveReviewSettings = useCallback(async () => {
    try {
      const dirty = reviewDirtyFields.current;
      const shared: ReviewPreferencePatch = {};
      if (dirty.has("mode")) shared.mode = reviewMode;
      if (dirty.has("autoFix")) shared.autoFix = autoFix;
      if (dirty.has("maxRounds")) shared.maxRounds = Number(maxRounds) || 3;
      if (dirty.has("reviewerTimeoutMs")) shared.reviewerTimeoutMs = Math.max(1, Number(reviewerTimeoutMinutes) || 15) * 60_000;
      if (dirty.has("repairTimeoutMs")) shared.repairTimeoutMs = Math.max(1, Number(repairTimeoutMinutes) || 30) * 60_000;
      if (dirty.has("reviewerRole")) shared.reviewerRole = reviewerRole.trim() || localizedCopy.reviewDefaultRole;
      if (dirty.has("instructions")) shared.instructions = reviewInstructions;
      if (dirty.has("reviewerSession")) shared.reviewerSession = reviewerSession;
      if (dirty.has("reviewerTarget")) shared.reviewerTarget = reviewerTarget;
      const models: ReviewModelOverride = {};
      const modelReset: string[] = [];
      if (dirty.has("executionModel")) executionModel.trim() ? models.executionModel = executionModel.trim() : modelReset.push("executionModel");
      if (dirty.has("reviewerModel")) reviewerModel.trim() ? models.reviewerModel = reviewerModel.trim() : modelReset.push("reviewerModel");
      const sessionPatch: AgentSessionPatch = {};
      if (sessionDirtyFields.current.has("defaultRelationship")) sessionPatch.defaultRelationship = sessionDefaultRelationship;
      if (sessionDirtyFields.current.has("permissionMode")) sessionPatch.permissionMode = sessionPermissionMode;
      if (sessionDirtyFields.current.has("providerRelationships")) sessionPatch.providerRelationships = sessionProviderRelationships;
      if (reviewSettingsScope === "project") {
        if (Object.keys(shared).length) await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: shared, resetFields: [] });
        if (Object.keys(models).length || modelReset.length) await reviewSettingsUpdateRpc({ projectConfig, scope: "project-model", patch: models, resetFields: modelReset });
      } else if (Object.keys(shared).length || Object.keys(models).length || modelReset.length) {
        await reviewSettingsUpdateRpc({ projectConfig, scope: "global", patch: { ...shared, ...models }, resetFields: modelReset });
      }
      if (Object.keys(sessionPatch).length) await agentSessionSettingsUpdateRpc({ projectConfig, scope: reviewSettingsScope, patch: sessionPatch, resetFields: [] });
      reviewDirtyFields.current.clear();
      sessionDirtyFields.current.clear();
      setReviewSettingsOpen(false);
      await reviewSettingsQuery.refetch();
      await agentSessionSettingsQuery.refetch();
      await agentReviewQuery.refetch();
    } catch (error) {
      toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed));
    }
  }, [agentReviewQuery, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, autoFix, executionModel, localizedCopy, maxRounds, projectConfig, repairTimeoutMinutes, reviewInstructions, reviewerModel, reviewerRole, reviewerSession, reviewerTarget, reviewerTimeoutMinutes, reviewMode, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, sessionDefaultRelationship, sessionPermissionMode, sessionProviderRelationships, toast]);
  const closeReviewSettings = useCallback(() => {
    syncReviewEditor();
    setReviewSettingsOpen(false);
  }, [syncReviewEditor]);
  const openReviewSettings = useCallback(() => {
    setLayoutMenuOpen(false);
    setStorageMenuOpen(false);
    setRuntimeSettingsOpen(false);
    syncReviewEditor();
    setReviewSettingsOpen(true);
  }, [syncReviewEditor]);
  const resetReviewField = useCallback((field: string) => {
    const modelField = field === "executionModel" || field === "reviewerModel";
    void reviewSettingsUpdateRpc({ projectConfig, scope: reviewSettingsScope === "global" ? "global" : modelField ? "project-model" : "project", patch: {}, resetFields: [field] }).then(() => {
      reviewDirtyFields.current.clear();
      return reviewSettingsQuery.refetch();
    }).catch((error) => toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed)));
  }, [localizedCopy, projectConfig, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, toast]);
  const resetAllProjectReviewOverrides = useCallback(async () => {
    try {
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTarget", "reviewerTimeoutMs", "repairTimeoutMs"] });
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project-model", patch: {}, resetFields: ["executionModel", "reviewerModel"] });
      await agentSessionSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["defaultRelationship", "permissionMode", "providerRelationships"] });
      reviewDirtyFields.current.clear();
      sessionDirtyFields.current.clear();
      await reviewSettingsQuery.refetch();
      await agentReviewQuery.refetch();
      await agentSessionSettingsQuery.refetch();
    } catch (error) {
      toast.error(localizedReviewError(error instanceof Error ? { code: error.message } : null, localizedCopy, localizedCopy.reviewSettingsSaveFailed));
    }
  }, [agentReviewQuery, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, localizedCopy, projectConfig, reviewSettingsQuery, reviewSettingsUpdateRpc, toast]);
  const reviewSources = reviewSettingsQuery.data?.sources || {};
  const reviewProject = reviewSettingsQuery.data?.project || {};
  const reviewGlobal = reviewSettingsQuery.data?.global || {};
  const reviewProjectModels = reviewSettingsQuery.data?.models || {};
  const sessionSources = agentSessionSettingsQuery.data?.sources;
  const sessionProviders = useMemo(() => {
    const values = new Set((agentSessionProvidersQuery.data?.providers || []).map((item) => item.provider));
    const current = boundAgent?.provider?.split("/")[0];
    if (current) values.add(current);
    return [...values].sort();
  }, [agentSessionProvidersQuery.data?.providers, boundAgent?.provider]);
  const sourceLabel = (field: string) => {
    const source = reviewSources[field];
    return source === "project" || source === "project-model" ? localizedCopy.reviewSourceProject : source === "global" || source === "global-model" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefault;
  };
  const hasReviewOverride = (field: string) => {
    const source = reviewSettingsScope === "project"
      ? field === "executionModel" || field === "reviewerModel" ? reviewProjectModels : reviewProject
      : reviewGlobal;
    return Object.prototype.hasOwnProperty.call(source, field);
  };
  const sessionSourceLabel = (field: string) => {
    if (field === "defaultRelationship") {
      const source = sessionSources?.defaultRelationship;
      return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
    }
    if (field === "permissionMode") {
      const source = sessionSources?.permissionMode;
      return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
    }
    const source = sessionSources?.providerRelationships?.[field];
    return source === "project" ? localizedCopy.reviewSourceProject : source === "global" ? localizedCopy.reviewSourceGlobal : localizedCopy.reviewSourceDefaultShort;
  };
  const sessionPermissionLabel = (mode: AgentPermissionMode) => mode === "inherit"
    ? localizedCopy.agentSessionPermissionInherit
    : mode === "auto"
      ? localizedCopy.agentSessionPermissionAuto
      : mode === "auto-review"
        ? localizedCopy.agentSessionPermissionAutoReview
        : localizedCopy.agentSessionPermissionFullAccess;
  const startAgentReview = useCallback(() => {
    if (!selectedWorkspaceId) return;
    void reviewStartRpc({ projectConfig, workspaceId: selectedWorkspaceId, executionAgentId: selectedWorkspaceIsMain ? undefined : boundAgent?.id, locale, ...(selectedWorkspaceIsMain && mainReviewInstructions.trim() ? { instructions: mainReviewInstructions.trim() } : {}) }).then((result) => {
      if (!result.ok) toast.error(localizedReviewError(result.error, localizedCopy));
      else setReviewSessionId("");
      return agentReviewQuery.refetch();
    }).catch(() => toast.error(localizedCopy.reviewErrorGeneric));
  }, [agentReviewQuery, boundAgent?.id, locale, localizedCopy, mainReviewInstructions, projectConfig, reviewStartRpc, selectedWorkspaceId, selectedWorkspaceIsMain, toast]);
  const controlAgentReview = useCallback((action: "stop" | "resume" | "review" | "repair" | "independent") => {
    if (!selectedWorkspaceId || !agentReview) return;
    void reviewControlRpc({ projectConfig, workspaceId: selectedWorkspaceId, sessionId: agentReview.id, action }).then((result) => {
      if (!result.ok) toast.error(localizedReviewError(result.error, localizedCopy));
      return agentReviewQuery.refetch();
    }).catch(() => toast.error(localizedCopy.reviewErrorGeneric));
  }, [agentReview, agentReviewQuery, localizedCopy, projectConfig, reviewControlRpc, selectedWorkspaceId, toast]);
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
  const observationRecovering = observationAreas.some((area) =>
    area.snapshot.initialFailure && (area.snapshot.failureAgeMs ?? RECOVERABLE_FAILURE_GRACE_MS) < RECOVERABLE_FAILURE_GRACE_MS,
  );
  const observationRefreshing = manualRefreshing || observationRecovering || observationAreas.some((area) => area.fetching || area.snapshot.refreshing);
  const observationDegraded = observationAreas.some((area) => area.snapshot.status === "degraded");
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

  const prepareSelectedToolchain = useCallback(async () => {
    if (!selectedWorkspaceId || selectedWorkspaceIsMain || !displayDetail || preparingToolchain) return;
    setPreparingToolchain(true);
    let failure: string | null = null;
    try {
      for (const repository of displayDetail.repositories) {
        const response = await rpc({ method: "workspace.prepare", params: { workspaceId: selectedWorkspaceId, repositoryId: repository.repoPath } });
        const result = response.result as { status?: string; issues?: Array<{ message?: string }> } | undefined;
        if (!response.ok || result?.status === "prepare_failed") {
          failure = response.error?.message || result?.issues?.find((issue) => issue.message)?.message || localizedCopy.text_273309c58d;
          break;
        }
      }
      await Promise.allSettled([detailQuery.refetch(), listQuery.refetch()]);
    } catch (error) {
      failure = error instanceof Error ? error.message : localizedCopy.text_273309c58d;
    } finally {
      setPreparingToolchain(false);
    }
    if (failure) toast.error(failure);
  }, [detailQuery.refetch, displayDetail, listQuery.refetch, localizedCopy.text_273309c58d, preparingToolchain, rpc, selectedWorkspaceId, selectedWorkspaceIsMain, toast]);

  const refreshAll = useObservationRefresh(() => [
      backendQuery.refetch(),
      ...(backendQuery.data?.state === "ready" ? [listQuery.refetch()] : []),
      ...(workspaceDirectory && !selectionResolved ? [identifyQuery.refetch()] : []),
      ...(selectedWorkspaceId ? [detailQuery.refetch()] : []),
      ...(selectedWorkspaceId && selectedRepoPath && !selectedWorkspaceUnavailable ? [graphQuery.refetch(), changesQuery.refetch()] : []),
      ...(tab === "review" && reviewIds.length ? [reviewQuery.refetch()] : []),
      ...(selectedWorkspaceId && selectedWorkspace && !selectedWorkspaceIsMain && listResult?.capabilities?.agent
        ? [bindingQuery.refetch()]
        : []),
    ], observationTiming.clientRefreshTimeoutMs, setManualRefreshing);

  useBoundedCacheRefresh("workspace-list", listQuery.data, listQuery.refetch, observationTiming.followUpDelaysMs, foreground);
  useBoundedCacheRefresh(`workspace-detail:${selectedWorkspaceId}`, detailQuery.data, detailQuery.refetch, observationTiming.followUpDelaysMs, foreground);
  useBoundedCacheRefresh(`repository-graph:${selectedWorkspaceId}:${selectedRepoPath}`, graphQuery.data, graphQuery.refetch, observationTiming.followUpDelaysMs, foreground);
  useBoundedCacheRefresh(`repository-changes:${selectedWorkspaceId}:${selectedRepoPath}:${changesScope}:${selectedCommit}`, changesQuery.data, changesQuery.refetch, observationTiming.followUpDelaysMs, foreground);
  useBoundedCacheRefresh(`review:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, reviewQuery.refetch, observationTiming.followUpDelaysMs, foreground);

  useEffect(() => {
    const instanceId = backendQuery.data?.instanceId;
    if (!instanceId || backendQuery.data?.state !== "ready") return;
    if (seenBackendInstanceId.current === null) {
      seenBackendInstanceId.current = instanceId;
      return;
    }
    if (seenBackendInstanceId.current === instanceId) return;
    seenBackendInstanceId.current = instanceId;
    void refreshAll();
  }, [backendQuery.data?.instanceId, backendQuery.data?.state, refreshAll]);

  // The version poll resumes observation queries; only bootstrap needs a direct retry.
  useRefreshOnForeground(Boolean(projectConfig && !listReady), () => {
    void backendQuery.refetch();
    void listQuery.refetch();
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

  function buildSelectedHandoff(): Handoff | null {
    const goal = handoffGoal.trim();
    if (!selectedWorkspaceId || (!savedHandoff && !goal && !binding?.agentId)) return null;
    if (savedHandoff) return savedHandoff;
    return {
      version: "workspace.workbench.handoff/v1",
      goal: goal || localizedCopy.text_36cdf2a07a,
      decisions: [],
      inScope: [],
      outOfScope: [],
      steps: [],
      acceptance: [],
      constraints: [],
      ambiguities: [],
      reviewPacket: reviewPacketFromEditor({
        understanding: handoffUnderstanding,
        plan: handoffPlan,
        acceptance: handoffAcceptance,
        references: handoffReferences,
        instructions: handoffReviewInstructions,
      }),
      startMode: workerStartMode,
      reviewLocale: locale,
      ...(handoffRelationship === "default" ? {} : { relationship: handoffRelationship }),
      policy: { placementGuard: true },
      expected: { branchByRepository: {}, baseByRepository: {} },
    };
  }

  async function delegateSelectedWorkspace(): Promise<void> {
    if (selectedWorkspaceBlocksTasks) {
      toast.show(localizedCopy.workspaceDeleteQueued, { variant: "warning" });
      return;
    }
    if (selectedWorkspaceIsMain) {
      toast.show(localizedCopy.text_bb57803d41, { variant: "warning" });
      return;
    }
    if (!selectedWorkspaceId || !parentAgentId) {
      toast.show(localizedCopy.text_d7dd46e5e3, { variant: "warning" });
      return;
    }
    if (!buildSelectedHandoff()) {
      toast.show(localizedCopy.text_afa9beb681, { variant: "warning" });
      return;
    }
    setHandoffPreviewOpen(true);
    setMaterialPreview(null);
    const epoch = ++handoffPreviewEpoch.current;
    const handoff = buildSelectedHandoff()!;
    try {
      const response = await previewHandoffRpc({ projectConfig, workspaceId: selectedWorkspaceId, parentAgentId, handoff }) as Omit<NonNullable<typeof materialPreview>, "signature">;
      if (epoch === handoffPreviewEpoch.current) setMaterialPreview({ ...response, signature: JSON.stringify(handoff) });
    } catch { if (epoch === handoffPreviewEpoch.current) toast.error(localizedCopy.handoffMaterialsUnavailable); }
  }

  async function submitSelectedWorkspace(): Promise<void> {
    const handoff = buildSelectedHandoff();
    if (!handoff || !selectedWorkspaceId || !parentAgentId) return;
    if (!materialPreview?.ok || materialPreview.materials?.ready === false || materialPreview.signature !== JSON.stringify(handoff)) return;
    setDelegating(true);
    try {
      const result: WorkspaceDelegateResponse = await delegateRpc({
        workspaceId: selectedWorkspaceId,
        parentAgentId,
        handoff,
      });
      if (result.ok) {
        const actionLabel = result.action === "created"
          ? localizedCopy.text_a2eb60ef6c
          : result.action === "already-running"
            ? localizedCopy.text_0561f1d18e
            : result.action === "reused"
              ? localizedCopy.text_050246dd54
              : localizedCopy.text_962c002fa2;
        toast.show(actionLabel, { variant: "success" });
        setHandoffPreviewOpen(false);
      } else {
        toast.show(result.error ? localizedReviewError(result.error, localizedCopy) : localizedCopy.text_b4f57a0af8, { variant: result.action === "blocked" ? "warning" : "error" });
      }
      await bindingQuery.refetch().catch(() => undefined);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : localizedCopy.text_341baadc12, { variant: "error" });
    } finally {
      setDelegating(false);
    }
  }

  const closeLifecycle = useCallback(() => {
    if (lifecycleBusyWorkspaceId) return;
    setLifecycleWorkspaceId("");
    setLifecycleResponse(null);
    setLifecycleError(null);
  }, [lifecycleBusyWorkspaceId]);

  const inspectWorkspaceLifecycle = useCallback((workspace: WorkspaceSummary, mode: "inspect" | "permanent" = "inspect") => {
    setLifecycleWorkspaceId(workspace.id);
    setLifecycleMode(mode);
    setLifecycleResponse(null);
    setLifecycleError(null);
    setLifecycleBusyWorkspaceId(workspace.id);
    void lifecycleRpc({ projectConfig, workspaceId: workspace.id, action: "inspect" })
      .then((result) => {
        setLifecycleResponse(result);
        if (!result.ok) setLifecycleError(result.error?.message || localizedCopy.workspaceDeleteUnavailable);
      })
      .catch((error) => setLifecycleError(error instanceof Error ? error.message : localizedCopy.workspaceDeleteUnavailable))
      .finally(() => { setLifecycleBusyWorkspaceId(""); });
  }, [lifecycleRpc, localizedCopy.workspaceDeleteUnavailable, projectConfig]);

  const removeWorkspace = useCallback(async (workspace: WorkspaceSummary): Promise<void> => {
    setLifecycleBusyWorkspaceId(workspace.id);
    setLifecycleError(null);
    try {
      const result = await lifecycleRpc({ projectConfig, workspaceId: workspace.id, action: "remove" });
      setLifecycleResponse(result);
      if (!result.ok) {
        const message = result.error?.message || localizedCopy.workspaceDeleteFailed;
        setLifecycleError(message);
        setLifecycleWorkspaceId(workspace.id);
        setLifecycleMode("inspect");
        toast.error(message);
        return;
      }
      await listQuery.refetch();
      if (result.pending) {
        setLifecycleWorkspaceId(workspace.id);
        setLifecycleMode("inspect");
        toast.show(localizedCopy.workspaceDeleteQueued, { variant: "warning" });
      } else {
        if (selectedWorkspaceId === workspace.id) preferences.selectWorkspace("main");
        setLifecycleWorkspaceId("");
        toast.show(localizedCopy.workspaceDeleteSuccess, { variant: "success" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedCopy.workspaceDeleteFailed;
      setLifecycleError(message);
      toast.error(message);
    } finally {
      setLifecycleBusyWorkspaceId("");
    }
  }, [lifecycleRpc, listQuery, localizedCopy, preferences, projectConfig, selectedWorkspaceId, toast]);

  const restoreWorkspace = useCallback(async (workspace: WorkspaceSummary): Promise<void> => {
    setLifecycleBusyWorkspaceId(workspace.id);
    try {
      const result = await lifecycleRpc({ projectConfig, workspaceId: workspace.id, action: "restore" });
      if (!result.ok) {
        const message = result.error?.message || localizedCopy.workspaceDeleteFailed;
        setLifecycleError(message);
        toast.error(message);
        return;
      }
      await listQuery.refetch();
      setLifecycleWorkspaceId("");
      toast.show(localizedCopy.workspaceRestoreSuccess, { variant: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedCopy.workspaceDeleteFailed;
      setLifecycleError(message);
      toast.error(message);
    } finally {
      setLifecycleBusyWorkspaceId("");
    }
  }, [lifecycleRpc, listQuery, localizedCopy, projectConfig, toast]);

  const permanentDeleteWorkspace = useCallback(async (confirmDataLoss: boolean): Promise<void> => {
    if (!lifecycleWorkspaceId) return;
    setLifecycleBusyWorkspaceId(lifecycleWorkspaceId);
    setLifecycleError(null);
    try {
      const result = await lifecycleRpc({ projectConfig, workspaceId: lifecycleWorkspaceId, action: "delete", confirm: true, confirmDataLoss });
      setLifecycleResponse(result);
      if (!result.ok) {
        const message = result.error?.message || localizedCopy.workspaceDeleteFailed;
        setLifecycleError(message);
        toast.error(message);
        return;
      }
      await listQuery.refetch();
      if (selectedWorkspaceId === lifecycleWorkspaceId) preferences.selectWorkspace("main");
      setLifecycleWorkspaceId("");
      toast.show(localizedCopy.workspacePermanentDeleteSuccess, { variant: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : localizedCopy.workspaceDeleteFailed;
      setLifecycleError(message);
      toast.error(message);
    } finally {
      setLifecycleBusyWorkspaceId("");
    }
  }, [lifecycleRpc, lifecycleWorkspaceId, listQuery, localizedCopy, preferences, projectConfig, selectedWorkspaceId, toast]);

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

  function selectWorkspace(id: string): void {
    if (newlyCreatedWorkspace.current !== id) newlyCreatedWorkspace.current = null;
    preferences.selectWorkspace(id);
    setSelectionResolved(true);
    setSelectedRepoPath("");
    setSelectorOpen(false);
    setTab("workspace");
  }

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
  const onCommit = useCallback((sha: string) => {
    setSelectedCommit(sha);
    setSelectedFile("");
  }, []);
  const onGraphBase = useCallback(() => setGraphView((current) => ({ ...current, historyMode: "full", maxCommits: 50 })), []);
  const graphRefetch = graphQuery.refetch;
  const graphFetching = graphQuery.isFetching;
  const graphLoadedCount = graph?.loadedCount || 50;
  const onGraphMore = useCallback(() => {
    if (graphFetching) return;
    const next = Math.min(graphLoadedCount + 50, 200);
    if (next <= graphView.maxCommits) { void graphRefetch(); return; }
    setGraphView((current) => ({ ...current, maxCommits: next }));
  }, [graphFetching, graphLoadedCount, graphRefetch, graphView.maxCommits]);
  const onOpenChangedFile = useCallback((file: FileChange) => {
    if (!selectedRepository || !selectedWorkspace) return;
    setSelectedFile(file.path);
    openFileReview(
      {
        projectConfig,
        workspaceId: selectedWorkspace.id,
        repoPath: selectedRepository.repoPath,
        path: file.path,
        oldPath: file.oldPath,
        scope: changesScope,
        commitSha: selectedCommit || undefined,
        branch: selectedRepository.branch,
        baseSha: selectedRepository.baseSha,
        head: selectedRepository.head,
        status: file.status,
        statusLabel: file.statusLabel,
      },
      {
        hostWorkspaceId,
        directory: selectedWorkspace.treePath || selectedWorkspace.sourceRoot,
        panelId: agentId ? "workspace-workbench-file-agent" : "workspace-workbench-file",
        agentId,
      },
    );
  }, [agentId, changesScope, hostWorkspaceId, projectConfig, selectedCommit, selectedRepository, selectedWorkspace]);
  const onRepo = useCallback((repoPath: string) => {
    animateSectionLayout();
    const changingRepository = selectedRepoPath !== repoPath;
    setSelectedRepoPath(repoPath);
    setSelectedFile("");
    setRepositoryDetailsOpen(changingRepository ? true : (current) => !current);
  }, [animateSectionLayout, selectedRepoPath]);
  const onSectionToggle = useCallback((id: "repositories" | "graph" | "changes", collapsed: boolean) => {
    animateSectionLayout();
    preferences.updateSection(id, { collapsed });
  }, [animateSectionLayout, preferences.updateSection]);
  const noHeightCommit = useCallback((_id: "repositories" | "graph" | "changes", _height: number | null) => {}, []);
  const collapseAll = useCallback(() => { animateSectionLayout(); preferences.setAllSectionsCollapsed(true); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.setAllSectionsCollapsed]);
  const expandAll = useCallback(() => { animateSectionLayout(); preferences.setAllSectionsCollapsed(false); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.setAllSectionsCollapsed]);
  const resetLayout = useCallback(() => { animateSectionLayout(); preferences.resetLayout(); setLayoutMenuOpen(false); }, [animateSectionLayout, preferences.resetLayout]);
  const BodyContainer = tab === "review" || allocation.outerScroll ? ScrollView : View;
  const draftHandoff = buildSelectedHandoff();
  const adoptSelectedOrphan = async () => {
    if (!orphanPreview?.eligible || adoptingOrphan) return;
    setAdoptingOrphan(true); setOrphanError("");
    try {
      const response = await rpc({ method: "workspace.orphan.adopt", params: {
        workspaceId: orphanPreview.id, fingerprint: orphanPreview.fingerprint, branches: orphanBranches,
      } });
      if (!response.ok) throw new Error(response.error?.message || localizedCopy.orphanCannotAdopt);
      const adoptedId = orphanPreview.id;
      await listQuery.refetch();
      newlyCreatedWorkspace.current = adoptedId;
      selectWorkspace(adoptedId);
      setOrphanId("");
    } catch (error) { setOrphanError(error instanceof Error ? error.message : String(error)); }
    finally { setAdoptingOrphan(false); }
  };
  const draftPacket = draftHandoff?.reviewPacket || null;
  const handoffAssetOptions = useMemo(
    () => (artifactListQuery.data?.artifacts || []).filter((artifact) => artifact.kind === "image" || artifact.mimeType.startsWith("image/")),
    [artifactListQuery.data?.artifacts],
  );
  return (
    <View
      style={styles.screen}
      accessibilityLabel={localizedCopy.productName}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (Math.abs(width - panelWidth) > 1) setPanelWidth(width);
      }}
    >
      {observationIssue ? <Text accessibilityRole="alert" style={styles.layoutMenuHint}>{localizedCopy.observationDegraded}: {observationIssue}</Text> : null}
      {addRepositoriesOpen && selectedWorkspace ? <CreateWorkspace addTo={{ id: selectedWorkspaceId, repositoryPaths: detail?.repositories.map((repo) => repo.repoPath) || [] }} projectKey={projectConfig} currentRepo="" rpc={rpc} onClose={() => setAddRepositoriesOpen(false)} onCreated={async () => { await listQuery.refetch(); await detailQuery.refetch(); setAddRepositoriesOpen(false); }} styles={styles} /> : null}
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
      {createOpen ? <CreateWorkspace projectKey={projectConfig} currentRepo={selectedRepository?.repoPath || ""} linkedSources={allWorkspaces.filter(workspace => workspace.kind === "linked-live")} preferredSourceId={selectedWorkspace?.kind === "linked-live" ? selectedWorkspace.id : ""} rpc={rpc} onClose={() => setCreateOpen(false)} onCreated={async (id) => { await listQuery.refetch(); newlyCreatedWorkspace.current = id; selectWorkspace(id); setCreateOpen(false); }} styles={styles} /> : null}
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
        loading={!listResult && listQuery.isFetching}
        refreshing={manualRefreshing}
        failure={listFailure}
        onOpen={openWorkspaceSelector}
        onFilter={setWorkspaceFilter}
        onSelect={(id) => { cancelWorkspaceActivityScan(); selectWorkspace(id); }}
        onOpenOrphan={(id) => { cancelWorkspaceActivityScan(); setOrphanId(id); }}
        onRemoveWorkspace={listResult?.capabilities?.remove ? (workspace) => { cancelWorkspaceActivityScan(); void removeWorkspace(workspace); } : undefined}
        onRestoreWorkspace={listResult?.capabilities?.restore ? (workspace) => { cancelWorkspaceActivityScan(); void restoreWorkspace(workspace); } : undefined}
        onPermanentDeleteWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { cancelWorkspaceActivityScan(); inspectWorkspaceLifecycle(workspace, "permanent"); } : undefined}
        onInspectWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { cancelWorkspaceActivityScan(); inspectWorkspaceLifecycle(workspace); } : undefined}
        lifecycleBusyWorkspaceId={lifecycleBusyWorkspaceId}
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
          {observerError ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningTitle}>{localizedCopy.text_ddb6624fda}</Text>
              <Text style={styles.warningText}>{observerError}</Text>
            </View>
          ) : null}
          {tab === "workspace" ? (
            <WorkspaceView
              detail={displayDetail}
              unavailable={listUnavailable || detailUnavailable}
              detailLoading={detailQuery.isLoading && !detail}
              detailRefreshing={manualRefreshing}
              detailError={detailFailure}
              graph={displayDetail ? graph : null}
              graphLoading={graphQuery.isFetching && !graph}
              graphRefreshing={manualRefreshing}
              graphError={graphFailure}
              changes={displayDetail ? changes : null}
              changesLoading={changesQuery.isFetching && !changes}
              changesRefreshing={manualRefreshing}
              changesError={changesFailure}
              changesStale={changesState.expired}
              changesCurrent={!changesQuery.isFetching && !changesState.stale && !changesState.expired && !changesState.refreshing && !changesFailure}
              treeMode={changeTreeMode || defaultTreeMode(changes?.files || [])}
              onTreeMode={setChangeTreeMode}
              selectedCommit={selectedCommit}
              selectedFile={selectedFile}
              changeScope={changeScope}
              selectedRepository={selectedRepository}
              repositoryDetailsOpen={repositoryDetailsOpen}
              onToggleRepositoryDetails={onToggleRepositoryDetails}
              onCommit={onCommit}
              onGraphBase={onGraphBase}
              onGraphMore={onGraphMore}
              graphIdentity={`${hostWorkspaceId}:${selectedWorkspaceId}:${selectedRepoPath}`}
              graphLoadingMore={graphQuery.isFetching && Boolean(graph) && (graph?.loadedCount || 0) < graphView.maxCommits}
              onScope={setChangeScope}
              onFile={onOpenChangedFile}
              onRepo={onRepo}
              sectionLayout={preferences.sectionLayout}
              availableHeight={panelHeight}
              sectionDragging={sectionDragging}
              onContentLayout={onWorkspaceContentLayout}
              onSectionToggle={onSectionToggle}
              onSectionHeightCommit={noHeightCommit}
              onSectionDragState={noSectionDragState}
              onOpenLayoutMenu={openLayoutMenu}
              onPrepareToolchain={!selectedWorkspaceIsMain ? prepareSelectedToolchain : undefined}
              preparingToolchain={preparingToolchain}
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
        <Text style={styles.layoutMenuHint}>{localizedCopy.text_a6625c543c}{formatObservedTime(lastSuccessfulAt, localizedCopy)}</Text>
        {observationAreas.filter((area) => area.fetching || (area.snapshot.status !== "fresh" && area.snapshot.status !== "loading")).map((area) => <Text key={area.label} style={area.snapshot.status === "expired" ? styles.warningText : styles.layoutMenuHint}>{observationAreaDetail(area, localizedCopy)}</Text>)}
        <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.refreshNow} disabled={manualRefreshing} onPress={() => { void (selectedWorkspaceId ? rpc({ method: "workspace.detail", params: { workspaceId: selectedWorkspaceId, force: true } }).catch(() => undefined).then(() => refreshAll()) : refreshAll()); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.refreshNow}</Text></Pressable>
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
        onSaved={() => { void Promise.allSettled([listQuery.refetch(), detailQuery.refetch(), storageQuery.refetch()]); }}
      />
      <WorkspaceDeletionPanel
        open={Boolean(lifecycleWorkspaceId)}
        workspace={observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId)}
        mode={lifecycleMode}
        response={lifecycleResponse}
        busy={Boolean(lifecycleBusyWorkspaceId)}
        error={lifecycleError}
        onClose={closeLifecycle}
        onRemove={() => {
          const target = observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId);
          if (target) void removeWorkspace(target);
        }}
        onRestore={() => {
          const target = observedWorkspaces.find((workspace) => workspace.id === lifecycleWorkspaceId);
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
