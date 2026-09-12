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
  const [createOpen, setCreateOpen] = useState(false);
  const newlyCreatedWorkspace = useRef<string | null>(null);
  const [delegating, setDelegating] = useState(false);

  useEffect(() => {
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
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
        <TabButton active={tab === "review"} label={`Review set${reviewIds.length ? ` ${reviewIds.length}` : ""}`} onPress={() => setTab("review")} theme={theme} styles={styles} />
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
          ) : (
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
        open={layoutMenuOpen}
        onClose={() => setLayoutMenuOpen(false)}
        onCollapseAll={collapseAll}
        onExpandAll={expandAll}
        onReset={resetLayout}
        theme={theme}
        styles={styles}
      />
    </View>
  );
}
