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
import { copy } from "../shared/copy";

import {
agentContextQuery,
workspaceBindingQuery,
workspaceDelegate,
type AgentContextResponse,
type WorkspaceBindingResponse,
type WorkspaceDelegateResponse,
} from "../shared/handoff";
import { agentSessionProviders, agentSessionSettingsGet, agentSessionSettingsUpdate, type AgentRelationship, type AgentSessionPatch } from "../shared/agent-session";
import { observerQuery } from "../shared/observer";
import { projectsQuery, type ProjectInfo } from "../shared/projects";
import { projectBackendStart, projectStorageQuery } from "../shared/setup";
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
type WorkspaceFilter
} from "./model";
import { useLastSuccessfulResponse, type ObserverSnapshot } from "./observation";
import { useRefreshOnForeground } from "./foreground-refresh";
import { useObserverPreferences } from "./preferences";
import { readSurfaceWorkspace, type WorkbenchSurfaceProps } from "./surface-context";

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

function responseIsRefreshing(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as { ok?: unknown; result?: unknown };
  if (response.ok !== true || !response.result || typeof response.result !== "object") return false;
  const observation = (response.result as { observation?: { cacheState?: unknown; refreshing?: unknown } }).observation;
  return observation?.refreshing === true || observation?.cacheState === "refreshing";
}

function observationInterval(interval: number): (query: { state: { data: unknown } }) => number {
  return (query) => responseIsRefreshing(query.state.data) ? 1_000 : interval;
}

type ObservationArea = {
  label: string;
  snapshot: ObserverSnapshot;
  fetching: boolean;
};

function observationStatusLabel(status: ObserverSnapshot["status"]): string {
  if (status === "loading") return copy.text_fcabadb2a7;
  if (status === "refreshing") return copy.observationRefreshing;
  if (status === "degraded") return copy.observationDegraded;
  if (status === "expired") return copy.observationStale;
  if (status === "unavailable") return copy.observationUnavailable;
  return copy.observationStatus;
}

function observationAreaDetail(area: ObservationArea): string {
  const status = area.snapshot.status === "expired"
    ? "expired"
    : area.fetching || area.snapshot.refreshing
      ? "refreshing"
      : area.snapshot.status;
  const timestamp = area.snapshot.lastSuccessfulAt ? ` · ${formatObservedTime(area.snapshot.lastSuccessfulAt)}` : "";
  return `${area.label}：${observationStatusLabel(status)}${timestamp}`;
}

const PREFERENCE_SCOPE_FALLBACK = "global";
const noSectionDragState = () => {};

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
  return <ObserverPanelContent {...props} hostWorkspaceId={hostWorkspaceId} paseoWorkspace={paseoWorkspace} />;
}

export function WorkbenchSurfacePanel(props: WorkbenchSurfaceProps) {
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
  if (workspaceId && !workspace.data) return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foregroundMuted }}>{workspace.isPending ? copy.hostWorkspaceLoading : copy.hostWorkspaceUnavailable}</Text>
    {workspace.isError ? <Pressable accessibilityRole="button" onPress={() => { void workspace.refetch(); }}><Text style={{ color: props.theme.colors.foreground }}>{copy.refreshNow}</Text></Pressable> : null}
  </View>;
  const context = props.target?.agentId
    ? { context: "agent" as const, workspaceId, agentId: props.target.agentId }
    : { context: "workspace" as const, workspaceId };
  return <ObserverPanelContent {...props} {...context} hostWorkspaceId={workspaceId} paseoWorkspace={workspace.data || null} />;
}

export function ObserverPanelContent(props: ObserverPanelContentProps) {
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
  if (!directory && !memory.ready) return <Text style={{ color: props.theme.colors.foregroundMuted }}>{copy.projectLoading}</Text>;
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
    <Text style={{ color: props.theme.colors.foreground }}>{projects.isPending ? copy.projectLoading : projects.isError ? copy.projectLoadFailed : !projects.data?.length ? copy.noRegisteredProjects : copy.selectProject}</Text>
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
  const [reviewerRole, setReviewerRole] = useState("Code reviewer");
  const [reviewInstructions, setReviewInstructions] = useState("");
  const [reviewerSession, setReviewerSession] = useState<"reuse" | "new_per_round">("reuse");
  const [executionModel, setExecutionModel] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const reviewDirtyFields = useRef(new Set<string>());
  const sessionDirtyFields = useRef(new Set<string>());
  const [sessionDefaultRelationship, setSessionDefaultRelationship] = useState<AgentRelationship>("independent");
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
  const [createOpen, setCreateOpen] = useState(false);
  const newlyCreatedWorkspace = useRef<string | null>(null);
  const [delegating, setDelegating] = useState(false);

  useEffect(() => {
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    setReviewSessionId("");
    scopeRepositoryIdentity.current = "";
  }, [preferenceScopeKey]);

  const listQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "workspace-list"],
    queryFn: () => rpc({ method: "workspace.list", params: { includeRemoved: true } }),
    refetchInterval: observationInterval(REFRESH_INTERVALS.list),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const listState = useLastSuccessfulResponse("workspace-list", listQuery.data, { error: listQuery.error, staleAfterMs: STALE_WINDOWS.list });
  const listResult = resultOf<ListResult>(listState.response);
  const listFailure = queryFailureForDisplay(listState, listQuery.data, listQuery.error);
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
  const boundAgent = (bindingQuery.data?.agent || null) as WorkspaceBindingResponse["agent"];
  const bindingFailure = bindingQuery.data?.error?.message || queryErrorMessage(bindingQuery.error);
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
        observedWorkspaces.some((workspace) => workspace.id === preferences.savedWorkspaceId),
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
    if (observedWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)) { newlyCreatedWorkspace.current = null; return; }
    // A successful create can precede the last-good roster's React update.
    // Its absence from that older snapshot is not evidence of deletion.
    if (newlyCreatedWorkspace.current === selectedWorkspaceId) return;
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    scopeRepositoryIdentity.current = "";
  }, [listReady, observedWorkspaces, preferences.hydrated, selectedWorkspaceId, selectionResolved]);

  const detailQuery = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "workspace-detail", selectedWorkspaceId],
    queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: selectedWorkspaceId, mode: "summary", refreshToolchain: false } }),
    enabled: Boolean(selectedWorkspaceId && selectedWorkspace && listReady),
    refetchInterval: observationInterval(REFRESH_INTERVALS.detail),
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
  const detailFailure = queryFailureForDisplay(detailState, detailQuery.data, detailQuery.error);
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
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady),
    refetchInterval: observationInterval(REFRESH_INTERVALS.repository),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const graphState = useLastSuccessfulResponse(`repository-graph:${selectedWorkspaceId}:${selectedRepoPath}`, graphQuery.data, { error: graphQuery.error, staleAfterMs: STALE_WINDOWS.repository });
  const graph = resultOf<GraphResult>(graphState.response);
  const graphFailure = queryFailureForDisplay(graphState, graphQuery.data, graphQuery.error);
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
    enabled: Boolean(selectedWorkspaceId && selectedRepoPath && selectedRepository && listReady),
    refetchInterval: observationInterval(REFRESH_INTERVALS.repository),
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
  const changesFailure = queryFailureForDisplay(changesState, changesQuery.data, changesQuery.error);

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
    refetchInterval: observationInterval(REFRESH_INTERVALS.review),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const reviewState = useLastSuccessfulResponse(`review:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, { error: reviewQuery.error, staleAfterMs: STALE_WINDOWS.review });
  const review = resultOf<ReviewResult>(reviewState.response);
  const reviewFailure = queryFailureForDisplay(reviewState, reviewQuery.data, reviewQuery.error);
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
      setReviewerRole(reviewPreferences.reviewerRole);
      setReviewInstructions(reviewPreferences.instructions);
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
      setSessionProviderRelationships(sessionPatch?.providerRelationships || {});
    }
  }, [agentSessionPreferences, agentSessionSettingsQuery.data?.global, agentSessionSettingsQuery.data?.project, reviewPreferences, reviewSettingsScope]);
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
      if (dirty.has("reviewerRole")) shared.reviewerRole = reviewerRole.trim() || "Code reviewer";
      if (dirty.has("instructions")) shared.instructions = reviewInstructions;
      if (dirty.has("reviewerSession")) shared.reviewerSession = reviewerSession;
      const models: ReviewModelOverride = {};
      const modelReset: string[] = [];
      if (dirty.has("executionModel")) executionModel.trim() ? models.executionModel = executionModel.trim() : modelReset.push("executionModel");
      if (dirty.has("reviewerModel")) reviewerModel.trim() ? models.reviewerModel = reviewerModel.trim() : modelReset.push("reviewerModel");
      const sessionPatch: AgentSessionPatch = {};
      if (sessionDirtyFields.current.has("defaultRelationship")) sessionPatch.defaultRelationship = sessionDefaultRelationship;
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
      toast.error(error instanceof Error ? error.message : "审核设置保存失败");
    }
  }, [agentReviewQuery, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, autoFix, executionModel, maxRounds, projectConfig, repairTimeoutMinutes, reviewInstructions, reviewerModel, reviewerRole, reviewerSession, reviewerTimeoutMinutes, reviewMode, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, sessionDefaultRelationship, sessionProviderRelationships, toast]);
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
    }).catch((error) => toast.error(error instanceof Error ? error.message : "恢复继承失败"));
  }, [projectConfig, reviewSettingsQuery, reviewSettingsScope, reviewSettingsUpdateRpc, toast]);
  const resetAllProjectReviewOverrides = useCallback(async () => {
    try {
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["mode", "autoFix", "maxRounds", "reviewerRole", "instructions", "reviewerSession", "reviewerTimeoutMs", "repairTimeoutMs"] });
      await reviewSettingsUpdateRpc({ projectConfig, scope: "project-model", patch: {}, resetFields: ["executionModel", "reviewerModel"] });
      await agentSessionSettingsUpdateRpc({ projectConfig, scope: "project", patch: {}, resetFields: ["defaultRelationship", "providerRelationships"] });
      reviewDirtyFields.current.clear();
      sessionDirtyFields.current.clear();
      await reviewSettingsQuery.refetch();
      await agentReviewQuery.refetch();
      await agentSessionSettingsQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "恢复继承失败");
    }
  }, [agentReviewQuery, agentSessionSettingsQuery, agentSessionSettingsUpdateRpc, projectConfig, reviewSettingsQuery, reviewSettingsUpdateRpc, toast]);
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
    return source === "project" || source === "project-model" ? "本项目" : source === "global" || source === "global-model" ? "全局" : "默认/跟随";
  };
  const hasReviewOverride = (field: string) => {
    const source = reviewSettingsScope === "project"
      ? field === "executionModel" || field === "reviewerModel" ? reviewProjectModels : reviewProject
      : reviewGlobal;
    return Object.prototype.hasOwnProperty.call(source, field);
  };
  const sessionSourceLabel = (field: "defaultRelationship" | string) => {
    if (field === "defaultRelationship") {
      const source = sessionSources?.defaultRelationship;
      return source === "project" ? "本项目" : source === "global" ? "全局" : "默认";
    }
    const source = sessionSources?.providerRelationships?.[field];
    return source === "project" ? "本项目" : source === "global" ? "全局" : "默认";
  };
  const startAgentReview = useCallback(() => {
    if (!selectedWorkspaceId) return;
    void reviewStartRpc({ projectConfig, workspaceId: selectedWorkspaceId, executionAgentId: boundAgent?.id }).then((result) => {
      if (!result.ok) toast.error(result.error?.message || "审核无法开始");
      else setReviewSessionId("");
      return agentReviewQuery.refetch();
    }).catch((error) => toast.error(error instanceof Error ? error.message : "审核无法开始"));
  }, [agentReviewQuery, boundAgent?.id, projectConfig, reviewStartRpc, selectedWorkspaceId, toast]);
  const controlAgentReview = useCallback((action: "stop" | "resume" | "review" | "repair") => {
    if (!selectedWorkspaceId || !agentReview) return;
    void reviewControlRpc({ projectConfig, workspaceId: selectedWorkspaceId, sessionId: agentReview.id, action }).then((result) => {
      if (!result.ok) toast.error(result.error?.message || "审核操作失败");
      return agentReviewQuery.refetch();
    }).catch((error) => toast.error(error instanceof Error ? error.message : "审核操作失败"));
  }, [agentReview, agentReviewQuery, projectConfig, reviewControlRpc, selectedWorkspaceId, toast]);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const observationAreas: ObservationArea[] = [
    { label: copy.observationAreaList, snapshot: listState, fetching: listQuery.isFetching },
    { label: copy.observationAreaDetail, snapshot: detailState, fetching: detailQuery.isFetching },
    { label: copy.observationAreaGraph, snapshot: graphState, fetching: graphQuery.isFetching },
    { label: copy.observationAreaChanges, snapshot: changesState, fetching: changesQuery.isFetching },
    ...(tab === "review" ? [{ label: "Review set", snapshot: reviewState, fetching: reviewQuery.isFetching }] : []),
  ];
  const unavailableArea = observationAreas.find((area) => area.snapshot.status === "unavailable");
  const observerError = listUnavailable ? listFailure : unavailableArea ? copy.observationUnavailable : null;
  const observationExpired = Boolean(
    listState.expired ||
      detailState.expired ||
      graphState.expired ||
      changesState.expired ||
      (tab === "review" && reviewState.expired),
  );
  const observationRefreshing = manualRefreshing || observationAreas.some((area) => area.fetching || area.snapshot.refreshing);
  const observationDegraded = observationAreas.some((area) => area.snapshot.status === "degraded");
  const lastSuccessfulAt = observationAreas.reduce<string | null>((latest, area) => {
    const candidate = area.snapshot.lastSuccessfulAt;
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
      boundedRefresh(listQuery.refetch()),
      ...(workspaceDirectory && !selectionResolved ? [boundedRefresh(identifyQuery.refetch())] : []),
      ...(selectedWorkspaceId ? [boundedRefresh(detailQuery.refetch())] : []),
      ...(selectedWorkspaceId && selectedRepoPath ? [boundedRefresh(graphQuery.refetch()), boundedRefresh(changesQuery.refetch())] : []),
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
  }, [backendQuery.refetch, bindingQuery.refetch, changesQuery.refetch, detailQuery.refetch, graphQuery.refetch, identifyQuery.refetch, listQuery.refetch, listResult?.capabilities?.agent, reviewIds.length, reviewQuery.refetch, selectedRepoPath, selectedWorkspace, selectedWorkspaceId, selectedWorkspaceIsMain, selectionResolved, tab, workspaceDirectory]);

  useRefreshOnForeground(Boolean(projectConfig), refreshAll);

  const observationLabel = observerError
    ? copy.observationUnavailable
    : observationExpired
      ? copy.observationStale
      : observationRefreshing
        ? copy.observationRefreshing
        : observationDegraded
          ? copy.observationDegraded
          : copy.observationStatus;
  const observationIcon = observerError || observationExpired ? "CircleAlert" : "RefreshCw";
  const observationColor = observerError
    ? theme.colors.statusDanger
    : observationExpired || observationDegraded
      ? theme.colors.statusWarning
      : theme.colors.foregroundMuted;

  async function delegateSelectedWorkspace(): Promise<void> {
    if (selectedWorkspaceIsMain) {
      toast.show(copy.text_bb57803d41, { variant: "warning" });
      return;
    }
    if (!selectedWorkspaceId || !parentAgentId) {
      toast.show(copy.text_d7dd46e5e3, { variant: "warning" });
      return;
    }
    const goal = handoffGoal.trim();
    if (!savedHandoff && !goal && !binding?.agentId) {
      toast.show(copy.text_afa9beb681, { variant: "warning" });
      return;
    }
    const handoff = savedHandoff || (binding?.agentId ? {
      version: "workspace.workbench.handoff/v1" as const,
      goal: copy.text_36cdf2a07a,
      decisions: [],
      inScope: [],
      outOfScope: [],
      steps: [],
      acceptance: [],
      constraints: [],
      ambiguities: [],
      startMode: "adaptive" as const,
      ...(handoffRelationship === "default" ? {} : { relationship: handoffRelationship }),
      expected: { branchByRepository: {}, baseByRepository: {} },
    } : {
      version: "workspace.workbench.handoff/v1" as const,
      goal,
      decisions: [],
      inScope: [],
      outOfScope: [],
      steps: [],
      acceptance: [],
      constraints: [],
      ambiguities: [],
      startMode: "adaptive" as const,
      ...(handoffRelationship === "default" ? {} : { relationship: handoffRelationship }),
      expected: { branchByRepository: {}, baseByRepository: {} },
    });
    setDelegating(true);
    try {
      const result: WorkspaceDelegateResponse = await delegateRpc({
        workspaceId: selectedWorkspaceId,
        parentAgentId,
        handoff,
      });
      if (result.ok) {
        const actionLabel = result.action === "created"
          ? copy.text_a2eb60ef6c
          : result.action === "already-running"
            ? copy.text_0561f1d18e
            : result.action === "reused"
              ? copy.text_050246dd54
              : copy.text_962c002fa2;
        toast.show(actionLabel, { variant: "success" });
      } else {
        toast.show(result.error?.message || copy.text_b4f57a0af8, { variant: result.action === "blocked" ? "warning" : "error" });
      }
      await bindingQuery.refetch().catch(() => undefined);
    } catch (error) {
      toast.show(error instanceof Error ? error.message : copy.text_341baadc12, { variant: "error" });
    } finally {
      setDelegating(false);
    }
  }

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
      .then(() => toast.show(copy.text_2fb0b81c28, { variant: "success" }))
      .catch(() => toast.show(copy.text_514f0cbbf2, { variant: "warning" }));
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
  return (
    <View
      style={styles.screen}
      accessibilityLabel="Workspace Workbench"
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (Math.abs(width - panelWidth) > 1) setPanelWidth(width);
      }}
    >
      {createOpen ? <CreateWorkspace projectKey={projectConfig} currentRepo={selectedRepository?.repoPath || ""} rpc={rpc} onClose={() => setCreateOpen(false)} onCreated={async (id) => { await listQuery.refetch(); newlyCreatedWorkspace.current = id; selectWorkspace(id); setCreateOpen(false); }} styles={styles} /> : null}
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
        theme={theme}
        styles={styles}
      />
      {!selectedWorkspaceIsMain && listResult?.capabilities?.agent ? (
        <View>
        {parentAgentId && agentContextAvailable && !binding?.agentId ? <View style={styles.targetRow}>
          <TextInput value={handoffGoal} onChangeText={setHandoffGoal} placeholder={copy.text_1b37d56f7a} style={styles.targetInput} />
          <View style={styles.briefActions}>
            {(["default", "independent", "child"] as const).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: handoffRelationship === relationship }} onPress={() => setHandoffRelationship(relationship)} style={[styles.secondaryButton, handoffRelationship === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "default" ? "默认" : relationship === "independent" ? "独立" : "子 Agent"}</Text></Pressable>)}
          </View>
          <Pressable disabled={delegating || !handoffGoal.trim()} onPress={delegateSelectedWorkspace} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{copy.text_99ad8551f2}</Text></Pressable>
        </View> : null}
        <ExecutionBindingCard
          workspaceId={selectedWorkspaceId}
          binding={binding}
          agent={boundAgent}
          loading={Boolean(selectedWorkspaceId && bindingQuery.isFetching && !bindingQuery.data)}
          refreshing={manualRefreshing && bindingQuery.isFetching}
          error={bindingFailure}
          canDelegate={Boolean(parentAgentId && agentContextAvailable)}
          agentContextState={agentContextState}
          delegating={delegating}
          onDelegate={delegateSelectedWorkspace}
          onOpenAgent={boundAgent?.id && props.navigation ? () => props.navigation?.openAgent({ agentId: boundAgent.id }) : undefined}
          theme={theme}
          styles={styles}
        />
        </View>
      ) : null}
      <View style={styles.tabs}>
        <TabButton active={tab === "workspace"} label="Workspace" onPress={() => setTab("workspace")} theme={theme} styles={styles} />
        <TabButton active={tab === "review" && reviewTab === "set"} label={`Review set${reviewIds.length ? ` ${reviewIds.length}` : ""}`} onPress={() => { setTab("review"); setReviewTab("set"); }} theme={theme} styles={styles} />
        {selectedWorkspaceId && !selectedWorkspaceIsMain ? <TabButton active={tab === "review" && reviewTab === "agent"} label="Agent Review" onPress={() => { setTab("review"); setReviewTab("agent"); }} theme={theme} styles={styles} /> : null}
      </View>
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
              <Text style={styles.warningTitle}>{copy.setupBackendTitle}</Text>
              <Text style={styles.warningText}>{backendQuery.data.message || (backendQuery.data.state === "starting" ? copy.setupBackendStarting : copy.setupBackendFailed)}</Text>
              <Pressable accessibilityRole="button" disabled={backendQuery.isFetching} onPress={() => { void backendQuery.refetch(); }} style={{ marginTop: 7 }}><Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{backendQuery.isFetching ? copy.setupBackendStarting : copy.setupRetry}</Text></Pressable>
            </View>
          ) : null}
          {observerError ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningTitle}>{copy.text_ddb6624fda}</Text>
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
          ) : reviewTab === "agent" ? <AgentReviewView session={agentReview} history={agentReviewHistoryQuery.data?.sessions || []} loading={agentReviewQuery.isFetching} onStart={startAgentReview} onReview={() => controlAgentReview("review")} onRepair={() => controlAgentReview("repair")} onStop={() => controlAgentReview("stop")} onResume={() => controlAgentReview("resume")} onSelectHistory={setReviewSessionId} theme={theme} styles={styles} /> : (
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
        <Text style={styles.layoutMenuHint}>{copy.text_a6625c543c}{formatObservedTime(lastSuccessfulAt)}</Text>
        {observationAreas.filter((area) => area.fetching || (area.snapshot.status !== "fresh" && area.snapshot.status !== "loading")).map((area) => <Text key={area.label} style={area.snapshot.status === "expired" ? styles.warningText : styles.layoutMenuHint}>{observationAreaDetail(area)}</Text>)}
        <Pressable accessibilityRole="button" accessibilityLabel={copy.refreshNow} disabled={manualRefreshing} onPress={() => { void refreshAll(); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{copy.refreshNow}</Text></Pressable>
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
        <Text style={styles.layoutMenuHint}>Agent 会话设置</Text>
        <View style={styles.briefActions}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewSettingsScope === "project" }} onPress={() => { reviewDirtyFields.current.clear(); setReviewSettingsScope("project"); }} style={[styles.secondaryButton, reviewSettingsScope === "project" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>本项目</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewSettingsScope === "global" }} onPress={() => { reviewDirtyFields.current.clear(); setReviewSettingsScope("global"); }} style={[styles.secondaryButton, reviewSettingsScope === "global" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>全局默认</Text></Pressable>
        </View>
        <Text style={styles.layoutMenuHint}>未单独设置的字段继承全局默认。</Text>
        <Text style={styles.layoutMenuHint}>执行会话关系 · {sessionSourceLabel("defaultRelationship")}</Text>
        <View style={styles.briefActions}>
          {(["independent", "child"] as AgentRelationship[]).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: sessionDefaultRelationship === relationship }} onPress={() => { markSessionField("defaultRelationship"); setSessionDefaultRelationship(relationship); }} style={[styles.secondaryButton, sessionDefaultRelationship === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "independent" ? "独立会话" : "子 Agent"}</Text></Pressable>)}
        </View>
        <Text style={styles.layoutMenuHint}>Provider 覆盖</Text>
        {sessionProviders.map((provider) => {
          const selected = sessionProviderRelationships[provider];
          return <View key={provider} style={{ gap: 4 }}>
            <Text style={styles.reviewEntryMeta}>{provider} · {sessionSourceLabel(provider)}</Text>
            <View style={styles.briefActions}>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: !selected }} onPress={() => { markSessionField("providerRelationships"); setSessionProviderRelationships((current) => { const next = { ...current }; delete next[provider]; return next; }); }} style={[styles.secondaryButton, !selected && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>跟随默认</Text></Pressable>
              {(["independent", "child"] as AgentRelationship[]).map((relationship) => <Pressable key={relationship} accessibilityRole="button" accessibilityState={{ selected: selected === relationship }} onPress={() => { markSessionField("providerRelationships"); setSessionProviderRelationships((current) => ({ ...current, [provider]: relationship })); }} style={[styles.secondaryButton, selected === relationship && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{relationship === "independent" ? "独立" : "子 Agent"}</Text></Pressable>)}
            </View>
          </View>;
        })}
        <Text style={styles.layoutMenuHint}>审核模式 · {sourceLabel("mode")}</Text>
        <View style={styles.briefActions}>
          {["off", "manual", "automatic"].map((mode) => <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: reviewMode === mode }} onPress={() => { markReviewField("mode"); setReviewMode(mode as "off" | "manual" | "automatic"); }} style={[styles.secondaryButton, reviewMode === mode && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>{mode === "off" ? "关闭" : mode === "manual" ? "手动" : "自动"}</Text></Pressable>)}
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: autoFix }} onPress={() => { markReviewField("autoFix"); setAutoFix((value) => !value); }} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{autoFix ? "✓ 自动修复" : "○ 手动修复"} · {sourceLabel("autoFix")}</Text></Pressable>
        <TextInput accessibilityLabel="Reviewer role" onChangeText={(value) => { markReviewField("reviewerRole"); setReviewerRole(value); }} placeholder={`Reviewer 角色 · ${sourceLabel("reviewerRole")}`} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={reviewerRole} />
        <TextInput accessibilityLabel="Review instructions" multiline onChangeText={(value) => { markReviewField("instructions"); setReviewInstructions(value); }} placeholder={`审核要求 · ${sourceLabel("instructions")}`} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { minHeight: 48 }]} value={reviewInstructions} />
        <TextInput accessibilityLabel="Maximum review rounds" keyboardType="number-pad" onChangeText={(value) => { markReviewField("maxRounds"); setMaxRounds(value); }} placeholder={`最大轮次 · ${sourceLabel("maxRounds")}`} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={maxRounds} />
        <Text style={styles.layoutMenuHint}>超时 · 审核 {sourceLabel("reviewerTimeoutMs")} / 修复 {sourceLabel("repairTimeoutMs")}</Text>
        <View style={styles.briefActions}>
          <TextInput accessibilityLabel="Reviewer timeout minutes" keyboardType="number-pad" onChangeText={(value) => { markReviewField("reviewerTimeoutMs"); setReviewerTimeoutMinutes(value); }} placeholder="审核超时（分钟）" placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { flex: 1 }]} value={reviewerTimeoutMinutes} />
          <TextInput accessibilityLabel="Repair timeout minutes" keyboardType="number-pad" onChangeText={(value) => { markReviewField("repairTimeoutMs"); setRepairTimeoutMinutes(value); }} placeholder="修复超时（分钟）" placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { flex: 1 }]} value={repairTimeoutMinutes} />
        </View>
        <Text style={styles.layoutMenuHint}>Reviewer 会话 · {sourceLabel("reviewerSession")}</Text>
        <View style={styles.briefActions}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerSession === "reuse" }} onPress={() => { markReviewField("reviewerSession"); setReviewerSession("reuse"); }} style={[styles.secondaryButton, reviewerSession === "reuse" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>复用会话</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: reviewerSession === "new_per_round" }} onPress={() => { markReviewField("reviewerSession"); setReviewerSession("new_per_round"); }} style={[styles.secondaryButton, reviewerSession === "new_per_round" && styles.scopeButtonActive]}><Text style={styles.secondaryButtonText}>每轮新建</Text></Pressable>
        </View>
        <Text style={styles.layoutMenuHint}>执行模型 · {sourceLabel("executionModel")}</Text>
        <Pressable accessibilityRole="button" onPress={() => { markReviewField("executionModel"); setExecutionModel(""); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>跟随执行会话{!executionModel ? " ✓" : ""}</Text></Pressable>
        {(reviewModelsQuery.data?.models || []).slice(0, 6).map((model) => <Pressable key={`exec-${model.id}`} accessibilityRole="button" onPress={() => { markReviewField("executionModel"); setExecutionModel(model.id); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{model.label}{executionModel === model.id ? " ✓" : ""}</Text></Pressable>)}
        {reviewSettingsScope === "project" && hasReviewOverride("executionModel") ? <Pressable accessibilityRole="button" onPress={() => resetReviewField("executionModel")} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>恢复执行模型继承</Text></Pressable> : null}
        <Text style={styles.layoutMenuHint}>Reviewer 模型 · {sourceLabel("reviewerModel")}</Text>
        <Pressable accessibilityRole="button" onPress={() => { markReviewField("reviewerModel"); setReviewerModel(""); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>跟随执行模型{!reviewerModel ? " ✓" : ""}</Text></Pressable>
        {(reviewModelsQuery.data?.models || []).slice(0, 6).map((model) => <Pressable key={`review-${model.id}`} accessibilityRole="button" onPress={() => { markReviewField("reviewerModel"); setReviewerModel(model.id); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{model.label}{reviewerModel === model.id ? " ✓" : ""}</Text></Pressable>)}
        {reviewSettingsScope === "project" && hasReviewOverride("reviewerModel") ? <Pressable accessibilityRole="button" onPress={() => resetReviewField("reviewerModel")} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>恢复 Reviewer 模型继承</Text></Pressable> : null}
        {reviewSettingsScope === "project" ? <Pressable accessibilityRole="button" onPress={() => { void resetAllProjectReviewOverrides(); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>恢复本项目全部继承</Text></Pressable> : null}
        <Pressable accessibilityRole="button" onPress={saveReviewSettings} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>保存设置</Text></Pressable>
        </ScrollView>
      </AnchoredMenu>
    </View>
  );
}
