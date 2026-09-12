import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { memo,useEffect,useState } from "react";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy } from "../../shared/copy";

import {
isTransientIssueCode,
sectionRemainingHeight,
type ChangeScope,
type ChangesResult,
type DetailResult,
type FileChange,
type GraphResult,
type ObserverSectionId,
type ObserverSectionLayout,
type RepositorySummary,
type WorkspaceSummary
} from "../model";
import { ChangeCounts,InlineRefresh,SectionDisclosureButton,SectionViewport,fileCountLabel,issueDetail,issueLabel,makeStyles,repositoryBranchLabel,statusColor,visibleIssues } from "./ui";

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

import { CommitGraph } from "./graph";

import { ChangedTree } from "./changes";

export const WorkspaceView = memo(function WorkspaceView({
  detail,
  unavailable,
  detailLoading,
  detailRefreshing,
  detailError,
  graph,
  graphLoading,
  graphRefreshing,
  graphError,
  changes,
  changesLoading,
  changesRefreshing,
  changesError,
  changesStale,
  treeMode,
  onTreeMode,
  selectedCommit,
  selectedFile,
  changeScope,
  selectedRepository,
  onContentLayout,
  repositoryDetailsOpen,
  onToggleRepositoryDetails,
  onCommit,
  onGraphBase,
  onGraphMore,
  graphIdentity,
  graphLoadingMore,
  onScope,
  onFile,
  onRepo,
  sectionLayout,
  availableHeight,
  sectionDragging,
  onSectionToggle,
  onSectionHeightCommit,
  onSectionDragState,
  onOpenLayoutMenu,
  graphPlatform,
  theme,
  styles,
}: {
  detail: DetailResult | null;
  unavailable: boolean;
  detailLoading: boolean;
  detailRefreshing: boolean;
  detailError: string | null;
  graph: GraphResult | null;
  graphLoading: boolean;
  graphRefreshing: boolean;
  graphError: string | null;
  changes: ChangesResult | null;
  changesLoading: boolean;
  changesRefreshing: boolean;
  changesError: string | null;
  changesStale: boolean;
  treeMode: ChangeTreeMode;
  onTreeMode: (mode: ChangeTreeMode) => void;
  selectedCommit: string;
  selectedFile: string;
  changeScope: Exclude<ChangeScope, "commit">;
  selectedRepository: RepositorySummary | undefined;
  onContentLayout: (height: number) => void;
  repositoryDetailsOpen: boolean;
  onToggleRepositoryDetails: () => void;
  onCommit: (sha: string) => void;
  onGraphBase: () => void;
  onGraphMore: () => void;
  graphIdentity: string;
  graphLoadingMore: boolean;
  onScope: (scope: Exclude<ChangeScope, "commit">) => void;
  onFile: (file: FileChange) => void;
  onRepo: (repoPath: string) => void;
  sectionLayout: ObserverSectionLayout;
  availableHeight: number;
  sectionDragging: boolean;
  onSectionToggle: (id: ObserverSectionId, collapsed: boolean) => void;
  onSectionHeightCommit: (id: ObserverSectionId, height: number | null) => void;
  onSectionDragState: (dragging: boolean) => void;
  onOpenLayoutMenu: () => void;
  graphPlatform: PanelProps["layout"]["platform"];
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const [repositoryDetailTop, setRepositoryDetailTop] = useState<number | null>(null);
  const [changesRelativeTop, setChangesRelativeTop] = useState<number | null>(null);

  useEffect(() => {
    setRepositoryDetailTop(null);
    setChangesRelativeTop(null);
  }, [selectedRepository?.repoPath]);

  if (unavailable) {
    return (
      <View>
        {detailError ? <Text style={styles.warningText}>{detailError}</Text> : null}
        <Text style={styles.emptyText}>{detailLoading ? copy.text_96c3e67563 : copy.text_07f7471155}</Text>
      </View>
    );
  }
  if (!detail) {
    return <Text style={styles.emptyText}>{detailLoading ? copy.text_96c3e67563 : copy.text_981b8eb33f}</Text>;
  }
  const repositories = detail.repositories;
  const toolchain = detail.workspace.toolchain;
  const selectedRepositoryIssues = selectedRepository
    ? selectedRepository.issues.concat(selectedRepository.changeIssues)
    : [];
  const attentionIssues = visibleIssues(selectedRepositoryIssues);
  const changesAvailableHeight = repositoryDetailTop !== null && changesRelativeTop !== null
    ? sectionRemainingHeight(availableHeight, repositoryDetailTop + changesRelativeTop, 12)
    : availableHeight;
  return (
    <View onLayout={(event) => onContentLayout(event.nativeEvent.layout.height)}>
      {detailError ? <Text style={styles.warningText}>{detailError}</Text> : null}
      {toolchain && toolchain.status !== "ready" && toolchain.status !== "not_applicable" ? (
        <ToolchainNotice toolchain={toolchain} repositoryCount={repositories.length} styles={styles} />
      ) : null}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <SectionDisclosureButton
            expanded={!sectionLayout.repositories.collapsed}
            label={copy.text_c91e6e6a53}
            onLongPress={onOpenLayoutMenu}
            onPress={() => onSectionToggle("repositories", !sectionLayout.repositories.collapsed)}
            theme={theme}
            styles={styles}
          />
          <View style={styles.sectionHeaderRight}>
            <InlineRefresh visible={detailRefreshing} theme={theme} styles={styles} />
            <Text style={styles.sectionCount}>{detailLoading ? "…" : `${repositories.length}`}</Text>
          </View>
        </View>
        {!sectionLayout.repositories.collapsed ? (
          <SectionViewport
            id="repositories"
            layout={sectionLayout.repositories}
            availableHeight={availableHeight}
            onDragStateChange={onSectionDragState}
            onHeightCommit={(height) => onSectionHeightCommit("repositories", height)}
            theme={theme}
            styles={styles}
          >
            <View style={styles.repositoryList}>
              {repositories.map((repository) => (
                <RepositoryRow
                  key={repository.repoPath}
                  repository={repository}
                  selected={selectedRepository?.repoPath === repository.repoPath}
                  onPress={() => onRepo(repository.repoPath)}
                  theme={theme}
                  styles={styles}
                />
              ))}
            </View>
            {!detailLoading && !repositories.length ? <Text style={styles.emptyText}>{copy.text_6bb9866496}</Text> : null}
          </SectionViewport>
        ) : null}
      </View>

      {selectedRepository ? (
        <View
          onLayout={(event) => {
            if (sectionDragging) return;
            const next = Math.round(event.nativeEvent.layout.y);
            setRepositoryDetailTop((current) => current === next ? current : next);
          }}
          style={styles.repositoryDetail}
        >
          {attentionIssues.map((issue) => (
            <Text key={`${issue.code}-${issue.path || ""}`} style={styles.warningText}>{issueLabel(issue)}</Text>
          ))}
          {repositoryDetailsOpen ? selectedRepositoryIssues.filter((issue) => !isTransientIssueCode(issue.code)).map((issue) => (
            <Text key={`detail-${issue.code}-${issue.path || ""}`} selectable style={styles.repositoryIssueDetail}>{issueDetail(issue)}</Text>
          )) : null}
          <CommitGraph
            graphIdentity={graphIdentity}
            graph={graph}
            loading={graphLoading}
            error={graphError}
            selectedCommit={selectedCommit}
            onCommit={onCommit}
            onGraphBase={onGraphBase}
            onGraphMore={onGraphMore}
            loadingMore={graphLoadingMore}
            changeScope={changeScope}
            onScope={onScope}
            repository={selectedRepository}
            detailsOpen={repositoryDetailsOpen}
            onToggleDetails={onToggleRepositoryDetails}
            sectionLayout={sectionLayout.graph}
            availableHeight={availableHeight}
            onSectionDragState={onSectionDragState}
            onSectionToggle={(collapsed) => onSectionToggle("graph", collapsed)}
            onHeightCommit={(height) => onSectionHeightCommit("graph", height)}
            onOpenLayoutMenu={onOpenLayoutMenu}
            graphPlatform={graphPlatform}
            refreshing={graphRefreshing}
            theme={theme}
            styles={styles}
          />
          <ChangedTree
            changes={changes}
            loading={changesLoading}
            refreshing={changesRefreshing}
            error={changesError}
            stale={changesStale}
            mode={treeMode}
            onMode={onTreeMode}
            scope={changeScope}
            selectedCommit={selectedCommit}
            selectedFile={selectedFile}
            onSelectFile={onFile}
            onLayout={(offset) => {
              if (sectionDragging) return;
              const next = Math.round(offset);
              setChangesRelativeTop((current) => current === next ? current : next);
            }}
            sectionLayout={sectionLayout.changes}
            availableHeight={changesAvailableHeight}
            onSectionToggle={(collapsed) => onSectionToggle("changes", collapsed)}
            onHeightCommit={(height) => onSectionHeightCommit("changes", height)}
            onOpenLayoutMenu={onOpenLayoutMenu}
            theme={theme}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
});

export function ToolchainNotice({
  toolchain,
  repositoryCount,
  styles,
}: {
  toolchain: NonNullable<WorkspaceSummary["toolchain"]>;
  repositoryCount: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  const preparedCount = Object.values(toolchain.preparedRepositories).filter((item) => item.status === "ready").length;
  const statusLabel: Record<string, string> = {
    needs_prepare: copy.text_9fd34d1b5f,
    partial: copy.text_5395180221,
    prepare_failed: copy.text_273309c58d,
    missing_manager: copy.text_005b60faae,
    missing_system_command: copy.text_81772f8606,
    version_conflict: copy.text_a94df0c5c2,
  };
  const detail = toolchain.issues[0]?.message || copy.text_9e44dbbc0e;
  return (
    <View style={styles.toolchainNotice}>
      <View style={styles.sectionHeader}>
        <Text style={styles.toolchainTitle}>{toolchain.manager.toUpperCase()} {copy.toolchainLabel}{statusLabel[toolchain.status] || toolchain.status}</Text>
        <Text style={styles.toolchainCount}>{preparedCount}{copy.text_42099b4af0}{repositoryCount} {copy.text_ededcbb377}</Text>
      </View>
      <Text numberOfLines={2} style={styles.toolchainText}>{detail}</Text>
    </View>
  );
}

export function RepositoryRow({
  repository,
  selected,
  onPress,
  theme,
  styles,
}: {
  repository: RepositorySummary;
  selected: boolean;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const hasTransientIssue = repository.issues.concat(repository.changeIssues).some((issue) => isTransientIssueCode(issue.code));
  const stale = Boolean(repository.observationStale || hasTransientIssue);
  const status = stale ? "stale" : repository.status || (repository.dirty ? "dirty" : "clean");
  const statusTone = statusColor(status, theme);
  const workingFiles = Math.max(repository.workingChanges.files, repository.dirtyPaths?.length || 0);
  const metaStatus = stale
    ? copy.text_f9f75e6112
    : repository.dirty && workingFiles
    ? `${status} · ${fileCountLabel(workingFiles)}`
    : status;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.repositoryRow, selected && styles.repositoryRowActive]}>
      <View style={[styles.repositoryDot, { backgroundColor: statusTone }]} />
      <View style={styles.repositoryCopy}>
        <Text numberOfLines={1} style={styles.repositoryLine}>{repository.name} · {repositoryBranchLabel(repository)}</Text>
        <Text numberOfLines={1} style={styles.repositoryMeta}>{metaStatus} {copy.text_97def2ca9e}{repository.headShort || "—"}</Text>
      </View>
      <View style={styles.repositoryMetrics}>
        {repository.changes.files ? <ChangeCounts additions={repository.changes.additions} deletions={repository.changes.deletions} styles={styles} /> : null}
        {workingFiles ? <ChangeCounts additions={repository.workingChanges.additions} deletions={repository.workingChanges.deletions} fileCount={workingFiles} prefix="dirty" styles={styles} /> : null}
        {!repository.changes.files && !workingFiles ? <Text style={styles.repositoryDelta}>{stale ? copy.text_f9f75e6112 : copy.text_8fae4f2a02}</Text> : null}
      </View>
    </Pressable>
  );
}
