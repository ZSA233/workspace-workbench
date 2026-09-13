import {
useRpc,
usePaseo,
useWorkspace,
type PluginAgentPanelProps,
type PluginSurfaceProps,
type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { copyText,Modal,ScrollView,TextInput,useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import { AccessibilityInfo,LayoutAnimation,Platform,Pressable,Text,UIManager,View,type ViewStyle } from "react-native";
import { copy, getWorkbenchCopy, localizedReviewError } from "../shared/copy";

import {
  agentContextQuery,
  workspaceBindingQuery,
  workspaceDelegate,
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
import { workspaceLifecycle, type WorkspaceLifecycleResponse } from "../shared/workspace-lifecycle";
import { isMainWorkspace,isRecoverableObserverFailure,makeStyles,mergeDetailResponse,queryErrorMessage,queryFailureForDisplay,resultOf,TabButton,workspaceIdFromProps } from "./components/ui";
import { openFileReview } from "./file-review-store";
import {
defaultTreeMode,
formatObservedTime,
matchesWorkspaceFilter,
resolveWorkspaceSelection,
sortWorkspaces,
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
import { useLastSuccessfulResponse, type ObserverSnapshot } from "./observation";
import { useRefreshOnForeground } from "./foreground-refresh";
import { useObserverPreferences } from "./preferences";
import { readSurfaceWorkspace, type WorkbenchSurfaceProps } from "./surface-context";
import { localeFromHostProps, useWorkbenchCopy, WorkbenchLocaleProvider, useWorkbenchLocale } from "./i18n";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";

const REFRESH_INTERVALS = {
  list: 30_000,
  detail: 30_000,
  repository: 45_000,
  review: 60_000,
} as const;

const STALE_WINDOWS = {
  list: 90_000,
  detail: 90_000,
  repository: 120_000,
  review: 150_000,
} as const;

const REFRESH_REQUEST_TIMEOUT = 12_000;

function boundedRefresh<T>(request: Promise<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), REFRESH_REQUEST_TIMEOUT);
    request.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); },
    );
  });
}

type ObservationArea = {
  label: string;
  snapshot: ObserverSnapshot;
  fetching: boolean;
};

function observationStatusLabel(status: ObserverSnapshot["status"], strings = copy): string {
  if (status === "loading") return strings.text_fcabadb2a7;
  if (status === "refreshing") return strings.observationRefreshing;
  if (status === "degraded") return strings.observationDegraded;
  if (status === "expired") return strings.observationStale;
  if (status === "unavailable") return strings.observationUnavailable;
  return strings.observationStatus;
}

function observationAreaDetail(area: ObservationArea, strings = copy): string {
  const status = area.snapshot.status === "expired"
    ? "expired"
    : area.fetching
      ? "refreshing"
      : area.snapshot.status;
  const timestamp = area.snapshot.lastObservedAt ? ` · ${formatObservedTime(area.snapshot.lastObservedAt, strings)}` : "";
  return `${area.label}: ${observationStatusLabel(status, strings)}${timestamp}`;
}

const PREFERENCE_SCOPE_FALLBACK = "global";
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
import { WorkspaceDeletionPanel } from "./components/workspace-deletion";

import { ExecutionBindingCard } from "./components/agent";

import { WorkspaceView } from "./components/repositories";

import { ReviewView } from "./components/review";
import { AgentReviewView } from "./components/agent-review";
import { reviewModels, reviewSessionControl, reviewSessionList, reviewSessionQuery, reviewSessionStart, reviewSettingsGet, reviewSettingsUpdate, type ReviewModelOverride, type ReviewPreferencePatch, type ReviewSession } from "../shared/agent-review";

export function WorkbenchPanel(props: PanelProps) {
  const hostWorkspaceId = workspaceIdFromProps(props);
  const paseoWorkspace = useWorkspace(
    hostWorkspaceId,
    (workspace) => (workspace ? { directory: workspace.directory, name: workspace.name } : null),
  );
  return <WorkbenchLocaleProvider locale={localeFromHostProps(props)}><ObserverPanelContent {...props} hostWorkspaceId={hostWorkspaceId} paseoWorkspace={paseoWorkspace} /></WorkbenchLocaleProvider>;
}

export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
  const locale = localeFromHostProps(props);
  const localizedCopy = getWorkbenchCopy(locale);
  const paseo = usePaseo();
  const workspaceId = props.target?.workspaceId || "";
  const workspace = useQuery({
    queryKey: ["workbench-surface-workspace", props.host.id, workspaceId],
    queryFn: () => readSurfaceWorkspace(paseo, workspaceId),
    enabled: Boolean(workspaceId), retry: false, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!workspaceId) return;
    return paseo.workspaces.ref(workspaceId).subscribe(() => { void workspace.refetch(); });
  }, [paseo, workspaceId, workspace.refetch]);
  if (workspaceId && !workspace.data) return <WorkbenchLocaleProvider locale={locale}><View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foregroundMuted }}>{workspace.isPending ? localizedCopy.hostWorkspaceLoading : localizedCopy.hostWorkspaceUnavailable}</Text>
    {workspace.isError ? <Pressable accessibilityRole="button" onPress={() => { void workspace.refetch(); }}><Text style={{ color: props.theme.colors.foreground }}>{localizedCopy.refreshNow}</Text></Pressable> : null}
  </View></WorkbenchLocaleProvider>;
  const context = props.target?.agentId
    ? { context: "agent" as const, workspaceId, agentId: props.target.agentId }
    : { context: "workspace" as const, workspaceId };
  return <WorkbenchLocaleProvider locale={locale}><ObserverPanelContent {...props} {...context} hostWorkspaceId={workspaceId} paseoWorkspace={workspace.data || null} /></WorkbenchLocaleProvider>;
}

export function ObserverPanelContent(props: ObserverPanelContentProps) {
  const localizedCopy = useWorkbenchCopy();
  const getProjects = useRpc(projectsQuery);
  const directory = props.paseoWorkspace?.directory || "";
  const projects = useQuery({ queryKey: ["workbench-projects", props.host.id, directory], queryFn: () => getProjects({ directory: directory || undefined }), refetchOnWindowFocus: false, retry: false });
  const memory = useProjectMemory(props.host.id);
  const [pickingProject, setPickingProject] = useState(false);
  const [chosen, setChosen] = useState("");
  const [setupProject, setSetupProject] = useState<ProjectInfo | null>(null);
  const detected = directory ? projects.data?.filter((p) => [p.sourceRoot, p.workspaceRoot].some((root) => pathContains(root, directory))).sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0] : undefined;
  const active = setupProject || chooseProject(projects.data || [], detected, chosen, memory.saved, Boolean(directory));
  useEffect(() => {
    setSetupProject(null);
    setChosen("");
  }, [directory]);
  if (!directory && !memory.ready) return <Text style={{ color: props.theme.colors.foregroundMuted }}>{localizedCopy.projectLoading}</Text>;
  if (directory && !active) return <ProjectSetup
    directory={directory}
    theme={props.theme}
    onSaved={(project) => {
      setSetupProject(project);
      setChosen(project.configPath);
      void projects.refetch();
    }}
  />;
  if (!active || pickingProject) return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{projects.isPending ? localizedCopy.projectLoading : projects.isError ? localizedCopy.projectLoadFailed : !projects.data?.length ? localizedCopy.noRegisteredProjects : localizedCopy.selectProject}</Text>
    {projects.data?.map((p) => <Pressable key={p.configPath} onPress={() => { setChosen(p.configPath); setSetupProject(null); setPickingProject(false); }}><Text style={{ color: props.theme.colors.foreground }}>{p.displayName}</Text></Pressable>)}
  </View>;
  return <View style={{ flex: 1 }}>
    <ProjectPanel key={active.configPath} {...props} projectConfig={active.configPath} onProjectReady={() => memory.remember(active.configPath)} onSwitchProject={!directory && (projects.data?.length || 0) > 1 ? () => setPickingProject(true) : undefined} />
  </View>;
}

function ProjectPanel(props: ObserverPanelContentProps & { projectConfig: string; onProjectReady?: () => void; onSwitchProject?: () => void }) {
  const { projectConfig } = props;
  const { hostWorkspaceId, paseoWorkspace } = props;
  const { theme, layout } = props;
  const localizedCopy = useWorkbenchCopy();
  const locale = useWorkbenchLocale();
  const preferenceScopeKey = `project:${projectConfig}:paseo-workspace:${hostWorkspaceId || PREFERENCE_SCOPE_FALLBACK}`;
  const [panelWidth, setPanelWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [storageMenuOpen, setStorageMenuOpen] = useState(false);
  const [reviewSettingsOpen, setReviewSettingsOpen] = useState(false);
  const [reviewSettingsScope, setReviewSettingsScope] = useState<"project" | "global">("project");
  const [reviewMode, setReviewMode] = useState<"off" | "manual" | "automatic">("manual");
  const [autoFix, setAutoFix] = useState(true);
  const [maxRounds, setMaxRounds] = useState("3");
  const [reviewerTimeoutMinutes, setReviewerTimeoutMinutes] = useState("15");
  const [repairTimeoutMinutes, setRepairTimeoutMinutes] = useState("30");
  const [reviewerRole, setReviewerRole] = useState("");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const [reviewerSession, setReviewerSession] = useState<"reuse" | "new_per_round">("reuse");
  const [executionModel, setExecutionModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const reviewDirtyFields = useRef(new Set<string>());
  const sessionDirtyFields = useRef(new Set<string>());
  const [sessionDefaultRelationship, setSessionDefaultRelationship] = useState<AgentRelationship>("independent");
  const [sessionPermissionMode, setSessionPermissionMode] = useState<AgentPermissionMode>("inherit");
  const [sessionProviderRelationships, setSessionProviderRelationships] = useState<Record<string, AgentRelationship>>({});
  const markReviewField = useCallback((field: string) => { reviewDirtyFields.current.add(field); }, []);
  const markSessionField = useCallback((field: string) => { sessionDirtyFields.current.add(field); }, []);
  const openLayoutMenu = useCallback(() => { setStatusMenuOpen(false); setStorageMenuOpen(false); setLayoutMenuOpen(true); }, []);
  const openStorageMenu = useCallback(() => { setStatusMenuOpen(false); setLayoutMenuOpen(false); setStorageMenuOpen(true); }, []);
  const compact = layout.compact || (panelWidth > 0 && panelWidth < 480);
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const preferences = useObserverPreferences(preferenceScopeKey);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (mounted) setReduceMotion(enabled); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  const rawRpc = useRpc(observerQuery);
  const rpc = (input: Parameters<typeof rawRpc>[0]) => rawRpc({ ...input, projectConfig });
  const getStorage = useRpc(projectStorageQuery);
  const storageQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "project-storage"],
    queryFn: () => getStorage({ projectConfig }),
    enabled: Boolean(projectConfig),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60_000,
  });
  const startBackend = useRpc(projectBackendStart);
  const backendQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "backend-start"],
    queryFn: () => startBackend({ projectConfig }),
    enabled: Boolean(projectConfig),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
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
  const [selectedRepoPath, setSelectedRepoPath] = useState("");
  const [tab, setTab] = useState<"workspace" | "review">("workspace");
  const [reviewTab, setReviewTab] = useState<"set" | "agent">("set");
  const [reviewSessionId, setReviewSessionId] = useState("");
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
  const [handoffUnderstanding, setHandoffUnderstanding] = useState("");
  const [handoffPlan, setHandoffPlan] = useState("");
  const [handoffAcceptance, setHandoffAcceptance] = useState("");
  const [handoffReferences, setHandoffReferences] = useState("");
  const [handoffReviewInstructions, setHandoffReviewInstructions] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const newlyCreatedWorkspace = useRef<string | null>(null);
  const [delegating, setDelegating] = useState(false);
  const [lifecycleWorkspaceId, setLifecycleWorkspaceId] = useState("");
  const [lifecycleMode, setLifecycleMode] = useState<"inspect" | "permanent">("inspect");
  const [lifecycleResponse, setLifecycleResponse] = useState<WorkspaceLifecycleResponse | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [lifecycleBusyWorkspaceId, setLifecycleBusyWorkspaceId] = useState("");

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
    enabled: Boolean(projectConfig && backendQuery.data?.state === "ready"),
    refetchInterval: REFRESH_INTERVALS.list,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const listState = useLastSuccessfulResponse("workspace-list", listQuery.data, { error: listQuery.error, staleAfterMs: STALE_WINDOWS.list });
  const listResult = resultOf<ListResult>(listState.response);
  const listFailure = queryFailureForDisplay(listState, listQuery.data, listQuery.error, localizedCopy);
  const listReady = Boolean(listResult);
  useEffect(() => {
    if (backendQuery.data?.state !== "ready" || listReady) return;
    void listQuery.refetch();
  }, [backendQuery.data?.state, listReady, listQuery.refetch]);
  useEffect(() => { if (listReady) props.onProjectReady?.(); }, [listReady, props.onProjectReady]);
  const listUnavailable = !listReady
    && listState.initialFailure
    && !isRecoverableObserverFailure(listQuery.data, listQuery.error);
  const observedWorkspaces = useMemo(
    () => (listReady ? sortWorkspaces(listResult?.workspaces || []) : []),
    [listReady, listResult?.workspaces],
  );
  const allWorkspaces = useMemo(
    () => observedWorkspaces.filter((workspace) => workspace.state !== "removed"),
    [observedWorkspaces],
  );
  const historyWorkspaces = useMemo(
    () => observedWorkspaces.filter((workspace) => workspace.state === "removed"),
    [observedWorkspaces],
  );
  const workspacePool = workspaceFilter === "history" ? historyWorkspaces : allWorkspaces;
  const visibleWorkspaces = useMemo(
    () => workspacePool.filter((workspace) => matchesWorkspaceFilter(workspace, workspaceFilter)),
    [workspacePool, workspaceFilter],
  );
  const workspaceDirectory = paseoWorkspace?.directory || "";
  // The active selection is independent from the selector's filter. Changing
  // from “all” to “dirty” must not make a clean selected workspace disappear
  // and trigger an unwanted fallback.
  const selectedWorkspace = observedWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedWorkspaceIsMain = isMainWorkspace(selectedWorkspace);
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
    refetchInterval: 10_000,
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
    refetchInterval: 10_000,
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
    enabled: Boolean(workspaceDirectory && preferences.hydrated && !selectionResolved && listReady),
    refetchInterval: REFRESH_INTERVALS.list,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 1_500,
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
    enabled: Boolean(selectedWorkspaceId && selectedWorkspace && listReady),
    refetchInterval: REFRESH_INTERVALS.detail,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const detailState = useLastSuccessfulResponse(`workspace-detail:${selectedWorkspaceId}`, detailQuery.data, {
    error: detailQuery.error,
    mergePartial: mergeDetailResponse,
    staleAfterMs: STALE_WINDOWS.detail,
  });
  const detail = resultOf<DetailResult>(detailState.response);
  const detailFailure = queryFailureForDisplay(detailState, detailQuery.data, detailQuery.error, localizedCopy);
  const detailUnavailable = !detail
    && detailState.initialFailure
    && !isRecoverableObserverFailure(detailQuery.data, detailQuery.error);
  const displayDetail = listReady && detail?.workspace.id === selectedWorkspaceId
    ? detail
    : null;
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
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady && !selectedWorkspaceUnavailable),
    refetchInterval: REFRESH_INTERVALS.repository,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const graphState = useLastSuccessfulResponse(`repository-graph:${selectedWorkspaceId}:${selectedRepoPath}`, graphQuery.data, { error: graphQuery.error, staleAfterMs: STALE_WINDOWS.repository });
  const graph = resultOf<GraphResult>(graphState.response);
  const graphFailure = queryFailureForDisplay(graphState, graphQuery.data, graphQuery.error, localizedCopy);
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
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady && !selectedWorkspaceUnavailable),
    refetchInterval: REFRESH_INTERVALS.repository,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const changesState = useLastSuccessfulResponse(
    `repository-changes:${selectedWorkspaceId}:${selectedRepoPath}:${changesScope}:${selectedCommit}`,
    changesQuery.data,
    { error: changesQuery.error, staleAfterMs: STALE_WINDOWS.repository },
  );
  const changes = resultOf<ChangesResult>(changesState.response);
  const changesFailure = queryFailureForDisplay(changesState, changesQuery.data, changesQuery.error, localizedCopy);

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
        : selectedRepository.dirty || selectedRepository.workingChanges.files
          ? "working"
          : "branch",
    );
    setGraphView({ historyMode: isMainWorkspace(selectedWorkspace) ? "full" : "branch", maxCommits: 50 });
    setRepositoryDetailsOpen(false);
  }, [repositoryIdentity, selectedRepoPath, selectedRepository, selectedWorkspace]);

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
    enabled: tab === "review" && reviewIds.length > 0 && listReady,
    refetchInterval: REFRESH_INTERVALS.review,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const reviewState = useLastSuccessfulResponse(`review:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, { error: reviewQuery.error, staleAfterMs: STALE_WINDOWS.review });
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
    enabled: Boolean(selectedWorkspaceId && listReady), refetchInterval: 2_000, refetchOnWindowFocus: false, retry: false,
  });
  const agentReviewHistoryQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "agent-review-history", selectedWorkspaceId],
    queryFn: () => reviewSessionListRpc({ projectConfig, workspaceId: selectedWorkspaceId }),
    enabled: Boolean(selectedWorkspaceId && listReady), refetchInterval: 15_000, refetchOnWindowFocus: false, retry: false,
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
    enabled: Boolean(projectConfig && selectedWorkspaceId && listReady), staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: false,
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
  }, [agentReviewQuery, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, autoFix, executionModel, localizedCopy, maxRounds, projectConfig, repairTimeoutMinutes, reviewInstructions, reviewerModel, reviewerRole, reviewerSession, reviewerTimeoutMinutes, reviewMode, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, sessionDefaultRelationship, sessionPermissionMode, sessionProviderRelationships, toast]);
  const closeReviewSettings = useCallback(() => {
    syncReviewEditor();
    setReviewSettingsOpen(false);
  }, [syncReviewEditor]);
  const openReviewSettings = useCallback(() => {
    setLayoutMenuOpen(false);
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
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTimeoutMs", "repairTimeoutMs"] });
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
    void reviewStartRpc({ projectConfig, workspaceId: selectedWorkspaceId, executionAgentId: boundAgent?.id, locale }).then((result) => {
      if (!result.ok) toast.error(localizedReviewError(result.error, localizedCopy));
      else setReviewSessionId("");
      return agentReviewQuery.refetch();
    }).catch(() => toast.error(localizedCopy.reviewErrorGeneric));
  }, [agentReviewQuery, boundAgent?.id, locale, localizedCopy, projectConfig, reviewStartRpc, selectedWorkspaceId, toast]);
  const controlAgentReview = useCallback((action: "stop" | "resume" | "review" | "repair") => {
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
  const observationRefreshing = manualRefreshing || observationAreas.some((area) => area.fetching);
  const observationDegraded = observationAreas.some((area) => area.snapshot.status === "degraded");
  const lastSuccessfulAt = observationAreas.reduce<string | null>((latest, area) => {
    const candidate = area.snapshot.lastObservedAt;
    if (!candidate) return latest;
    if (!latest || (Date.parse(candidate) > Date.parse(latest))) return candidate;
    return latest;
  }, null);
  const refreshFlight = useRef<Promise<void> | null>(null);

  const refreshAll = useCallback((): Promise<void> => {
    if (refreshFlight.current) return refreshFlight.current;
    setManualRefreshing(true);
    const requests: Array<Promise<unknown>> = [
      boundedRefresh(backendQuery.refetch()),
      ...(backendQuery.data?.state === "ready" ? [boundedRefresh(listQuery.refetch())] : []),
      ...(workspaceDirectory && !selectionResolved ? [boundedRefresh(identifyQuery.refetch())] : []),
      ...(selectedWorkspaceId ? [boundedRefresh(detailQuery.refetch())] : []),
      ...(selectedWorkspaceId && selectedRepoPath && !selectedWorkspaceUnavailable ? [boundedRefresh(graphQuery.refetch()), boundedRefresh(changesQuery.refetch())] : []),
      ...(tab === "review" && reviewIds.length ? [boundedRefresh(reviewQuery.refetch())] : []),
      ...(selectedWorkspaceId && selectedWorkspace && !selectedWorkspaceIsMain && listResult?.capabilities?.agent
        ? [boundedRefresh(bindingQuery.refetch())]
        : []),
    ];
    const flight = Promise.allSettled(requests).then(() => undefined).finally(() => {
      refreshFlight.current = null;
      setManualRefreshing(false);
    });
    refreshFlight.current = flight;
    return flight;
  }, [backendQuery.data?.state, backendQuery.refetch, bindingQuery.refetch, changesQuery.refetch, detailQuery.refetch, graphQuery.refetch, identifyQuery.refetch, listQuery.refetch, listResult?.capabilities?.agent, reviewIds.length, reviewQuery.refetch, selectedRepoPath, selectedWorkspace, selectedWorkspaceId, selectedWorkspaceIsMain, selectedWorkspaceUnavailable, selectionResolved, tab, workspaceDirectory]);

  useRefreshOnForeground(Boolean(projectConfig), refreshAll);

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
      startMode: "adaptive",
      reviewLocale: locale,
      ...(handoffRelationship === "default" ? {} : { relationship: handoffRelationship }),
      policy: { placementGuard: true },
      expected: { branchByRepository: {}, baseByRepository: {} },
    };
  }

  function delegateSelectedWorkspace(): void {
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
  }

  async function submitSelectedWorkspace(): Promise<void> {
    const handoff = buildSelectedHandoff();
    if (!handoff || !selectedWorkspaceId || !parentAgentId) return;
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

  const permanentDeleteWorkspace = useCallback(async (): Promise<void> => {
    if (!lifecycleWorkspaceId) return;
    setLifecycleBusyWorkspaceId(lifecycleWorkspaceId);
    setLifecycleError(null);
    try {
      const result = await lifecycleRpc({ projectConfig, workspaceId: lifecycleWorkspaceId, action: "delete", confirm: true });
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
  const onToggleRepositoryDetails = useCallback(() => setRepositoryDetailsOpen((current) => !current), []);
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
    setSelectedRepoPath(repoPath);
    setSelectedFile("");
    setRepositoryDetailsOpen(false);
  }, []);
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
      {createOpen ? <CreateWorkspace projectKey={projectConfig} currentRepo={selectedRepository?.repoPath || ""} rpc={rpc} onClose={() => setCreateOpen(false)} onCreated={async (id) => { await listQuery.refetch(); newlyCreatedWorkspace.current = id; selectWorkspace(id); setCreateOpen(false); }} styles={styles} /> : null}
      {handoffPacketOpen ? <Modal open onOpenChange={(open) => { if (!open) setHandoffPacketOpen(false); }} title={localizedCopy.handoffPacket}>
        <Modal.Content scrollable style={{ maxHeight: 640, width: "100%" }} contentContainerStyle={{ gap: 8, padding: 14 }}>
          <Text style={styles.layoutMenuHint}>{localizedCopy.handoffPacketHint}</Text>
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
            <Pressable accessibilityRole="button" disabled={delegating} onPress={() => { void submitSelectedWorkspace(); }} style={styles.primaryReviewButton}><Text style={styles.primaryReviewButtonText}>{localizedCopy.handoffConfirm}</Text></Pressable>
          </View>
        </Modal.Content>
      </Modal> : null}
      <WorkspaceSelector
        onOpenLayoutMenu={openLayoutMenu}
        statusControl={<IconButton label={observationLabel} icon={observationIcon}
          busy={observationRefreshing}
          color={observationColor}
          onPress={() => { setLayoutMenuOpen(false); setStatusMenuOpen((open) => !open); }} />}
        workspaces={allWorkspaces}
        historyWorkspaces={historyWorkspaces}
        visibleWorkspaces={visibleWorkspaces}
        selectedWorkspace={selectedWorkspace}
        selectedWorkspaceId={selectedWorkspaceId}
        filter={workspaceFilter}
        open={selectorOpen}
        loading={!listResult && listQuery.isFetching}
        refreshing={manualRefreshing}
        failure={listFailure}
        onOpen={() => setSelectorOpen((current) => !current)}
        onFilter={setWorkspaceFilter}
        onSelect={(id) => { selectWorkspace(id); setSelectorOpen(false); }}
        onRemoveWorkspace={listResult?.capabilities?.remove ? (workspace) => { void removeWorkspace(workspace); } : undefined}
        onRestoreWorkspace={listResult?.capabilities?.restore ? (workspace) => { void restoreWorkspace(workspace); } : undefined}
        onPermanentDeleteWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { inspectWorkspaceLifecycle(workspace, "permanent"); } : undefined}
        onInspectWorkspace={listResult?.capabilities?.permanentDelete ? (workspace) => { inspectWorkspaceLifecycle(workspace); } : undefined}
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
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
        <TabButton active={tab === "workspace"} label={localizedCopy.tabWorkspace} onPress={() => setTab("workspace")} theme={theme} styles={styles} />
        <TabButton active={tab === "review" && reviewTab === "set"} label={`${localizedCopy.tabReviewSet}${reviewIds.length ? ` ${reviewIds.length}` : ""}`} onPress={() => { setTab("review"); setReviewTab("set"); }} theme={theme} styles={styles} />
        {selectedWorkspaceId && !selectedWorkspaceIsMain ? <TabButton active={tab === "review" && reviewTab === "agent"} label={localizedCopy.tabAgentReview} onPress={() => { setTab("review"); setReviewTab("agent"); }} theme={theme} styles={styles} /> : null}
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
          {backendQuery.data && backendQuery.data.state !== "ready" ? (
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
              graphPlatform={layout.platform}
              theme={theme}
              styles={styles}
            />
          ) : reviewTab === "agent" ? <AgentReviewView session={agentReview} history={agentReviewHistoryQuery.data?.sessions || []} loading={agentReviewQuery.isFetching} onStart={startAgentReview} onReview={() => controlAgentReview("review")} onRepair={() => controlAgentReview("repair")} onStop={() => controlAgentReview("stop")} onResume={() => controlAgentReview("resume")} onSelectHistory={setReviewSessionId} onOpenAgent={props.navigation ? (id) => props.navigation?.openAgent({ agentId: id }) : undefined} theme={theme} styles={styles} /> : (
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
        <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.refreshNow} disabled={manualRefreshing} onPress={() => { void refreshAll(); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{localizedCopy.refreshNow}</Text></Pressable>
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
        onConfirmPermanent={() => { void permanentDeleteWorkspace(); }}
        onOpenTask={openWorkspaceTask}
        theme={theme}
        styles={styles}
      />
      <LayoutMenu
        onSwitchProject={props.onSwitchProject ? () => { setLayoutMenuOpen(false); props.onSwitchProject?.(); } : undefined}
        onCreate={listResult?.capabilities?.create ? () => { setLayoutMenuOpen(false); setCreateOpen(true); } : undefined}
        onOpenStorage={openStorageMenu}
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
