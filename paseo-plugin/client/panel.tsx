import {
useRpc,
useWorkspace,
type PluginAgentPanelProps,
type PluginSurfaceProps,
type PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { copyText,Modal,ScrollView,TextInput,useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect,useMemo,useRef,useState } from "react";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy } from "../shared/copy";

import {
workspaceBindingQuery,
workspaceDelegate,
type WorkspaceBindingResponse,
type WorkspaceDelegateResponse,
} from "../shared/handoff";
import { observerQuery } from "../shared/observer";
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

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";

const PREFERENCE_SCOPE_FALLBACK = "global";

// React Native's shared cursor type only exposes `auto` and `pointer`, while
// the web renderer forwards the full CSS cursor value. Keep the native style
// portable and add the vertical resize affordance only where it is supported.
const verticalResizeCursorStyle: ViewStyle | null = Platform.OS === "web"
  ? ({ cursor: "ns-resize" } as unknown as ViewStyle)
  : null;

import { LayoutMenu,PanelHeader,WorkspaceSelector } from "./components/navigation";

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

export function WorkbenchSurfacePanel(props: PluginSurfaceProps) {
  return <ObserverPanelContent {...props} context="workspace" workspaceId="" hostWorkspaceId="" paseoWorkspace={null} />;
}

export function ObserverPanelContent(props: ObserverPanelContentProps) {
  const { hostWorkspaceId, paseoWorkspace } = props;
  const { theme, layout } = props;
  const preferenceScopeKey = `paseo-workspace:${hostWorkspaceId || PREFERENCE_SCOPE_FALLBACK}`;
  const [panelWidth, setPanelWidth] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const compact = layout.compact || (panelWidth > 0 && panelWidth < 480);
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const preferences = useObserverPreferences(preferenceScopeKey);
  const rpc = useRpc(observerQuery);
  const bindingRpc = useRpc(workspaceBindingQuery);
  const delegateRpc = useRpc(workspaceDelegate);
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
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const [sectionDragging, setSectionDragging] = useState(false);

  useEffect(() => {
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    scopeRepositoryIdentity.current = "";
  }, [preferenceScopeKey]);

  const listQuery = useQuery({
    queryKey: ["workspace-workbench", "workspace-list"],
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
  const parentAgentId = "agentId" in props ? props.agentId : null;
  const bindingQuery = useQuery({
    queryKey: ["workspace-workbench", "execution-binding", selectedWorkspaceId],
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
    queryKey: ["workspace-workbench", "identify", workspaceDirectory],
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
    if (observedWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)) return;
    setSelectionResolved(false);
    setSelectedRepoPath("");
    setSelectedCommit("");
    setSelectedFile("");
    scopeRepositoryIdentity.current = "";
  }, [listReady, observedWorkspaces, preferences.hydrated, selectedWorkspaceId, selectionResolved]);

  const detailQuery = useQuery({
    queryKey: ["workspace-workbench", "workspace-detail", selectedWorkspaceId],
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
    queryKey: ["workspace-workbench", "repository-graph", selectedWorkspaceId, selectedRepoPath, graphView.historyMode, graphView.maxCommits],
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
    queryKey: ["workspace-workbench", "repository-changes", selectedWorkspaceId, selectedRepoPath, changesScope, selectedCommit],
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
    queryKey: ["workspace-workbench", "review", reviewIds, targetOverrides],
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
    preferences.selectWorkspace(id);
    setSelectionResolved(true);
    setSelectedRepoPath("");
    setSelectorOpen(false);
    setTab("workspace");
  }

  function openChangedFile(file: FileChange): void {
    if (!selectedRepository || !selectedWorkspace) return;
    setSelectedFile(file.path);
    openFileReview(
      {
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
        panelId: "agentId" in props ? "workspace-workbench-file-agent" : "workspace-workbench-file",
        agentId: "agentId" in props ? props.agentId : undefined,
      },
    );
  }

  function toggleReview(id: string): void {
    setReviewIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  function copyBrief(text: string): void {
    void copyText(text)
      .then(() => toast.show(copy.text_2fb0b81c28, { variant: "success" }))
      .catch(() => toast.show(copy.text_514f0cbbf2, { variant: "warning" }));
  }

  return (
    <View
      style={styles.screen}
      accessibilityLabel="Workspace Workbench"
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        if (Math.abs(width - panelWidth) > 1) setPanelWidth(width);
      }}
    >
      <PanelHeader agentEnabled={listResult?.capabilities?.agent} onOpenLayoutMenu={() => setLayoutMenuOpen(true)} theme={theme} styles={styles} />
      {listResult?.capabilities?.create ? <Pressable onPress={() => setCreateOpen(true)} style={styles.footerButton}><Text style={styles.footerButtonText}>{copy.text_1623afda9e}</Text></Pressable> : null}
      <Modal open={createOpen} onOpenChange={setCreateOpen} title={copy.text_1623afda9e}>
        <Modal.Content scrollable={false}>
        <TextInput value={createName} onChangeText={setCreateName} placeholder={copy.text_76848596cb} style={styles.targetInput} />
        <Pressable disabled={creating || !createName.trim()} onPress={async () => {
          setCreating(true);
          try {
            const response = await rpc({ method: "workspace.create", params: { name: createName.trim() } });
            if (!response.ok) throw new Error(response.error?.message || copy.text_deb3990191);
            await listQuery.refetch();
            const result = response.result as { id: string };
            selectWorkspace(result.id);
            setCreateOpen(false);
          } catch (error) { toast.show(error instanceof Error ? error.message : copy.text_deb3990191, { variant: "error" }); }
          finally { setCreating(false); }
        }} style={styles.copyButton}><Text style={styles.copyButtonText}>{creating ? copy.text_1680b04bf6 : copy.text_fcbd093292}</Text></Pressable>
        </Modal.Content>
      </Modal>
      <WorkspaceSelector
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
        onSelect={selectWorkspace}
        theme={theme}
        styles={styles}
      />
      {!selectedWorkspaceIsMain && listResult?.capabilities?.agent ? (
        <View>
        {parentAgentId && !binding?.agentId ? <View style={styles.targetRow}>
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
          canDelegate={Boolean(parentAgentId)}
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
        <ScrollView scrollEnabled={!sectionDragging} style={styles.body} contentContainerStyle={styles.bodyContent}>
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
              onToggleRepositoryDetails={() => setRepositoryDetailsOpen((current) => !current)}
              onCommit={(sha) => {
                setSelectedCommit(sha);
                setSelectedFile("");
              }}
              onGraphBase={() => setGraphView((current) => ({ ...current, historyMode: "full", maxCommits: 50 }))}
              onGraphMore={() => setGraphView((current) => ({ ...current, maxCommits: Math.min(current.maxCommits + 50, 200) }))}
              graphLoadingMore={graphQuery.isFetching && Boolean(graph) && (graph?.loadedCount || 0) < graphView.maxCommits}
              onScope={setChangeScope}
              onFile={openChangedFile}
              onRepo={(repoPath) => {
                setSelectedRepoPath(repoPath);
                setSelectedFile("");
                setRepositoryDetailsOpen(false);
              }}
              sectionLayout={preferences.sectionLayout}
              availableHeight={panelHeight}
              sectionDragging={sectionDragging}
              onSectionToggle={(id, collapsed) => preferences.updateSection(id, { collapsed })}
              onSectionHeightCommit={(id, height) => preferences.updateSection(id, { height })}
              onSectionDragState={setSectionDragging}
              onOpenLayoutMenu={() => setLayoutMenuOpen(true)}
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
        </ScrollView>
      </View>
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" disabled={manualRefreshing} onPress={refreshAll} style={styles.footerButton}>
          <Text style={styles.footerButtonText}>{copy.text_d019a92a84}</Text>
        </Pressable>
        <Text style={[styles.footerTime, observationExpired && styles.footerStaleTime]}>
          {observationExpired ? copy.text_0334dc4b93 : copy.text_a6625c543c}
          {formatObservedTime(lastSuccessfulAt)}
        </Text>
      </View>
      <LayoutMenu
        open={layoutMenuOpen}
        onClose={() => setLayoutMenuOpen(false)}
        onCollapseAll={() => {
          preferences.setAllSectionsCollapsed(true);
          setLayoutMenuOpen(false);
        }}
        onExpandAll={() => {
          preferences.setAllSectionsCollapsed(false);
          setLayoutMenuOpen(false);
        }}
        onReset={() => {
          preferences.resetLayout();
          setLayoutMenuOpen(false);
        }}
        theme={theme}
        styles={styles}
      />
    </View>
  );
}
