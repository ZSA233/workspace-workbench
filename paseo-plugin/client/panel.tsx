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
import { projectsQuery } from "../shared/projects";
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
import { useLastSuccessfulResponse } from "./observation";
import { useObserverPreferences } from "./preferences";
import { readSurfaceWorkspace, type WorkbenchSurfaceProps } from "./surface-context";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";

const PREFERENCE_SCOPE_FALLBACK = "global";
const noSectionDragState = () => {};

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
  const projects = useQuery({ queryKey: ["workbench-projects", props.host.id], queryFn: () => getProjects({}), refetchOnWindowFocus: false, retry: false });
  const memory = useProjectMemory(props.host.id);
  const [pickingProject, setPickingProject] = useState(false);
  const [chosen, setChosen] = useState("");
  const directory = props.paseoWorkspace?.directory;
  const detected = directory ? projects.data?.filter((p) => [p.sourceRoot, p.workspaceRoot].some((root) => directory === root || directory.startsWith(root + "/"))).sort((a, b) => b.sourceRoot.length - a.sourceRoot.length)[0] : undefined;
  const active = chooseProject(projects.data || [], detected, chosen, memory.saved, Boolean(directory));
  if (!directory && !memory.ready) return <Text style={{ color: props.theme.colors.foregroundMuted }}>{copy.projectLoading}</Text>;
  if (!active || pickingProject) return <View style={{ padding: 12, gap: 8 }}>
    <Text style={{ color: props.theme.colors.foreground }}>{projects.isPending ? copy.projectLoading : projects.isError ? copy.projectLoadFailed : !projects.data?.length ? copy.noRegisteredProjects : copy.selectProject}</Text>
    {projects.data?.map((p) => <Pressable key={p.configPath} onPress={() => { setChosen(p.configPath); setPickingProject(false); }}><Text style={{ color: props.theme.colors.foreground }}>{p.displayName}</Text></Pressable>)}
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
  const openLayoutMenu = useCallback(() => { setStatusMenuOpen(false); setLayoutMenuOpen(true); }, []);
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
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const listState = useLastSuccessfulResponse("workspace-list", listQuery.data, { error: listQuery.error });
  const listResult = resultOf<ListResult>(listState.response);
  const listFailure = queryFailureForDisplay(listState, listQuery.data, listQuery.error);
  const listReady = Boolean(listResult);
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
    refetchInterval: 30_000,
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
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const detailState = useLastSuccessfulResponse(`workspace-detail:${selectedWorkspaceId}`, detailQuery.data, {
    error: detailQuery.error,
    mergePartial: mergeDetailResponse,
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
    refetchInterval: 45_000,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const graphState = useLastSuccessfulResponse(`repository-graph:${selectedWorkspaceId}:${selectedRepoPath}`, graphQuery.data, { error: graphQuery.error });
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
    refetchInterval: 45_000,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const changesState = useLastSuccessfulResponse(
    `repository-changes:${selectedWorkspaceId}:${selectedRepoPath}:${changesScope}:${selectedCommit}`,
    changesQuery.data,
    { error: changesQuery.error },
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
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1_500,
  });
  const reviewState = useLastSuccessfulResponse(`review:${reviewIds.join("|")}:${JSON.stringify(targetOverrides)}`, reviewQuery.data, { error: reviewQuery.error });
  const review = resultOf<ReviewResult>(reviewState.response);
  const reviewFailure = queryFailureForDisplay(reviewState, reviewQuery.data, reviewQuery.error);
  const observerError = listUnavailable ? listFailure : null;
  const observationExpired = Boolean(
    listState.expired ||
      detailState.expired ||
      graphState.expired ||
      changesState.expired ||
      (tab === "review" && reviewState.expired),
  );
  const lastSuccessfulAt = listState.lastSuccessfulAt || detailState.lastSuccessfulAt;

  const [manualRefreshing, setManualRefreshing] = useState(false);

  async function refreshAll(): Promise<void> {
    setManualRefreshing(true);
    try {
      await listQuery.refetch().catch(() => undefined);
      if (workspaceDirectory && !selectionResolved) await identifyQuery.refetch().catch(() => undefined);
      if (selectedWorkspaceId) await detailQuery.refetch().catch(() => undefined);
      if (selectedWorkspaceId && selectedRepoPath) {
        await graphQuery.refetch().catch(() => undefined);
        await changesQuery.refetch().catch(() => undefined);
      }
      if (tab === "review" && reviewIds.length) await reviewQuery.refetch().catch(() => undefined);
      if (selectedWorkspaceId) await bindingQuery.refetch().catch(() => undefined);
    } finally {
      setManualRefreshing(false);
    }
  }

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
        statusControl={<IconButton label={observerError ? copy.observationUnavailable : observationExpired ? copy.observationStale : copy.observationStatus} icon={observerError || observationExpired ? "CircleAlert" : "RefreshCw"}
          busy={manualRefreshing || listQuery.isFetching || detailQuery.isFetching || graphQuery.isFetching || changesQuery.isFetching}
          color={observerError ? theme.colors.statusDanger : observationExpired ? theme.colors.statusWarning : theme.colors.foregroundMuted}
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
        <Text style={styles.layoutMenuHint}>{observationExpired ? copy.observationStale : copy.observationStatus}</Text>
        <Text style={styles.layoutMenuHint}>{copy.text_a6625c543c}{formatObservedTime(lastSuccessfulAt)}</Text>
        {[listState.expired && copy.statusWorkspaceList, detailState.expired && copy.statusRepositories, graphState.expired && copy.statusGraph, changesState.expired && copy.statusChanges, tab === "review" && reviewState.expired && "Review set"].filter(Boolean).map((area) => <Text key={String(area)} style={styles.warningText}>{area}</Text>)}
        <Pressable accessibilityRole="button" accessibilityLabel={copy.refreshNow} disabled={manualRefreshing} onPress={() => { void refreshAll(); }} style={styles.layoutMenuItem}><Text style={styles.layoutMenuItemText}>{copy.refreshNow}</Text></Pressable>
      </AnchoredMenu>
      <LayoutMenu
        onSwitchProject={props.onSwitchProject ? () => { setLayoutMenuOpen(false); props.onSwitchProject?.(); } : undefined}
        onCreate={listResult?.capabilities?.create ? () => { setLayoutMenuOpen(false); setCreateOpen(true); } : undefined}
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
