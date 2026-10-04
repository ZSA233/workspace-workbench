import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { memo,useEffect,useState } from "react";
import { Pressable,Text,View } from "react-native";
import { ObservationIndicator } from './observation-indicator';

import { useWorkbenchCopy } from "../i18n";
import {
isTransientIssueCode,
sectionRemainingHeight,
type ChangeScope,
type ChangesResult,
type ChangeSummary,
type DetailResult,
type FileChange,
type GraphResult,
type ObserverSectionId,
type ObserverSectionLayout,
type RepositorySummary,
type WorkspaceSummary
} from "../model";
import { selectedChangeSummary } from "../repository-metrics";
import { ChangeCounts,fileCountLabel,issueDetail,issueLabel,makeStyles,repositoryBranchLabel,SectionDisclosureButton,SectionViewport,statusColor,visibleIssues } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;

type ChangeTreeMode = "tree" | "files";




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
  changesCurrent,
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


  onOpenLayoutMenu,
  onPrepareToolchain,
  preparingToolchain,
  preparationProgress,
  confirmedRepositoryCount,
  observationTimes,
  graphPlatform,
  theme,
  styles,
}: {
  detail: DetailResult | null;
  observationTimes?: { detail?: string | null; graph?: string | null; changes?: string | null };
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
  changesCurrent: boolean;
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


  onOpenLayoutMenu: () => void;
  onPrepareToolchain?: () => void;
  preparingToolchain?: boolean;
  preparationProgress?: string;
  confirmedRepositoryCount?: number;
  graphPlatform: PanelProps["layout"]["platform"];
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const [repositoryDetailTop, setRepositoryDetailTop] = useState<number | null>(null);
  const [changesRelativeTop, setChangesRelativeTop] = useState<number | null>(null);

  useEffect(() => {
    setRepositoryDetailTop(null);
    setChangesRelativeTop(null);
  }, [selectedRepository?.repoPath]);

  if (!detail) {
    return <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{copy.text_c91e6e6a53}</Text>
      <ObservationIndicator error={detailError || (unavailable ? copy.observationUpdateFailed : null)} loading={detailLoading}
        hasContent={false} lastSuccessfulAt={observationTimes?.detail} theme={theme} styles={styles} />
    </View>;
  }
  const repositories = detail.repositories;
  const changeSummary = selectedChangeSummary(
    selectedRepository,
    changes,
    detail.workspace.id,
    selectedCommit ? "commit" : changeScope,
    changesCurrent,
  );
  const graphRepository = selectedRepository && changeSummary
    ? changeScope === "working"
      ? { ...selectedRepository, workingChanges: changeSummary }
      : { ...selectedRepository, changes: changeSummary }
    : selectedRepository;
  if (detail.workspace.state === "create_failed") {
    return (
      <View onLayout={(event) => onContentLayout(event.nativeEvent.layout.height)}>
        <View style={[styles.warningCard, { borderColor: theme.colors.statusDanger }]}>
          <Text style={[styles.warningTitle, { color: theme.colors.statusDanger }]}>{copy.workspaceCreateFailedTitle}</Text>
          <Text style={styles.warningText}>{copy.workspaceCreateFailedDescription}</Text>
          {detail.workspace.issues?.map((issue, index) => <Text key={`${issue.code}-${index}`} style={styles.repositoryIssueDetail}>{issue.message}</Text>)}
          <Text style={styles.layoutMenuHint}>{copy.workspaceCreateFailedRecovery}</Text>
        </View>
      </View>
    );
  }
  const selectedRepositoryIssues = selectedRepository
    ? selectedRepository.issues.concat(selectedRepository.changeIssues)
    : [];
  const attentionIssues = visibleIssues(selectedRepositoryIssues);
  const changesAvailableHeight = repositoryDetailTop !== null && changesRelativeTop !== null
    ? sectionRemainingHeight(availableHeight, repositoryDetailTop + changesRelativeTop, 12)
    : availableHeight;
  return (
    <View onLayout={(event) => onContentLayout(event.nativeEvent.layout.height)}>
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
            <ObservationIndicator lastSuccessfulAt={observationTimes?.detail} hasContent={Boolean(detail)} error={detailError} loading={detailLoading} refreshing={detailRefreshing} theme={theme} styles={styles} />
            <Text accessibilityLabel={copy.repositoryVerificationCount.replace("{0}", String(confirmedRepositoryCount ?? repositories.filter(repo => !repo.observationPending && !!repo.branch).length)).replace("{1}", String(repositories.length))} style={styles.sectionCount}>{detailLoading ? "…" : `${repositories.length}`}</Text>
          </View>
        </View>
        {!sectionLayout.repositories.collapsed ? (
          <SectionViewport
            id="repositories"

            availableHeight={availableHeight}


            theme={theme}
            styles={styles}
          >
            <View style={styles.repositoryList}>
              {repositories.map((repository) => (
                <RepositoryRow
                  key={repository.repoPath}
                  repository={repository}
                  selected={selectedRepository?.repoPath === repository.repoPath}
                  changeSummary={selectedRepository?.repoPath === repository.repoPath
                    ? changeSummary
                    : changeScope === "working" ? repository.workingChanges : repository.changes}
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

      {detail.gitlinks ? <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{copy.linkedPointerTitle}</Text>
          <Text style={styles.sectionCount}>{detail.gitlinks.length}</Text>
        </View>
        {detail.gitlinks.map(link => {
          const available = repositories.some(repo => repo.repoPath === link.path);
          const drift = link.committedSha !== link.indexSha || link.indexSha !== link.checkoutSha;
          return <Pressable key={link.path} accessibilityRole="button" disabled={!available} onPress={() => onRepo(link.path)} style={styles.repositoryRow}>
            <View style={[styles.repositoryDot, { backgroundColor: link.issue ? theme.colors.statusDanger : drift ? theme.colors.statusWarning : theme.colors.statusSuccess }]} />
            <View style={styles.repositoryCopy}>
              <Text style={styles.repositoryLine}>{link.path}{link.issue ? ` · ${copy.linkedMissing}` : ""}</Text>
              <Text style={styles.repositoryMeta}>{copy.linkedCommitted} {(link.committedSha || "—").slice(0, 8)} · {copy.linkedIndex} {(link.indexSha || "—").slice(0, 8)} · {copy.linkedCheckout} {(link.checkoutSha || "—").slice(0, 8)}</Text>
            </View>
          </Pressable>;
        })}
      </View> : null}

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
            <Text key={`${issue.code}-${issue.path || ""}`} style={styles.warningText}>{issueLabel(issue, copy)}</Text>
          ))}
          {repositoryDetailsOpen ? selectedRepositoryIssues.filter((issue) => !isTransientIssueCode(issue.code)).map((issue) => (
            <Text key={`detail-${issue.code}-${issue.path || ""}`} selectable style={styles.repositoryIssueDetail}>{issueDetail(issue)}</Text>
          )) : null}
          <CommitGraph
            graphIdentity={graphIdentity}
            lastSuccessfulAt={observationTimes?.graph}
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
            repository={graphRepository || selectedRepository}
            detailsOpen={repositoryDetailsOpen}
            onToggleDetails={onToggleRepositoryDetails}
            sectionLayout={sectionLayout.graph}
            availableHeight={availableHeight}

            onSectionToggle={(collapsed) => onSectionToggle("graph", collapsed)}

            onOpenLayoutMenu={onOpenLayoutMenu}
            graphPlatform={graphPlatform}
            refreshing={graphRefreshing}
            theme={theme}
            styles={styles}
          />
          <ChangedTree
            lastSuccessfulAt={observationTimes?.changes}
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
  onPrepare,
  preparing,
  progress,
}: {
  toolchain: NonNullable<WorkspaceSummary["toolchain"]>;
  repositoryCount: number;
  styles: ReturnType<typeof makeStyles>;
  onPrepare?: () => void;
  preparing?: boolean;
  progress?: string;
}) {
  const copy = useWorkbenchCopy();
  const preparedCount = Object.values(toolchain.preparedRepositories).filter((item) => item.status === "ready").length;
  const statusLabel: Record<string, string> = {
    needs_prepare: copy.text_9fd34d1b5f,
    partial: copy.text_5395180221,
    prepare_failed: copy.text_273309c58d,
    missing_manager: copy.text_005b60faae,
    missing_system_command: copy.text_81772f8606,
    version_conflict: copy.text_a94df0c5c2,
  };
  const detail = progress || toolchain.issues[0]?.message || copy.text_9e44dbbc0e;
  return (
    <View style={styles.toolchainNotice}>
      <View style={styles.sectionHeader}>
        <Text style={styles.toolchainTitle}>{toolchain.manager.toUpperCase()} {copy.toolchainLabel}{statusLabel[toolchain.status] || toolchain.status}</Text>
        <Text style={styles.toolchainCount}>{preparedCount}{copy.text_42099b4af0}{repositoryCount} {copy.text_ededcbb377}</Text>
      </View>
      <Text numberOfLines={2} style={styles.toolchainText}>{detail}</Text>
      <Pressable
        accessibilityRole="button"
        disabled={!onPrepare || preparing}
        onPress={onPrepare}
        style={styles.layoutMenuItem}
      >
        <Text style={styles.layoutMenuItemText}>{preparing ? copy.toolchainPreparing : copy.toolchainPrepare}</Text>
      </Pressable>
    </View>
  );
}

export function RepositoryRow({
  repository,
  selected,
  changeSummary,
  onPress,
  theme,
  styles,
}: {
  repository: RepositorySummary;
  selected: boolean;
  changeSummary: ChangeSummary | null;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const hasTransientIssue = repository.issues.concat(repository.changeIssues).some((issue) => isTransientIssueCode(issue.code));
  const stale = Boolean(repository.observationStale || hasTransientIssue);
  const status = stale ? "stale" : repository.status || (repository.dirty ? "dirty" : "clean");
  const statusTone = status === "unknown" && repository.issues.length === 0
    ? theme.colors.foregroundMuted : statusColor(status, theme);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.repositoryRow, selected && styles.repositoryRowActive]}>
      <View style={[styles.repositoryDot, { backgroundColor: statusTone }]} />
      <View style={styles.repositoryCopy}>
        <View style={styles.repositoryLineRow}>
          <Text numberOfLines={1} style={styles.repositoryName}>{repository.name}</Text>
          <Text numberOfLines={1} style={styles.repositoryBranch}>{repositoryBranchLabel(repository, copy)}</Text>
        </View>
      </View>
      <View style={styles.repositoryMetrics}>
        {changeSummary && (changeSummary.additions || changeSummary.deletions)
          ? <ChangeCounts additions={changeSummary.additions} deletions={changeSummary.deletions} styles={styles} />
          : changeSummary
            ? <Text style={styles.repositoryDelta}>{fileCountLabel(changeSummary.files, copy)}</Text>
            : null}
      </View>
    </Pressable>
  );
}
