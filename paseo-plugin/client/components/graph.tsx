import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { memo,useCallback,useLayoutEffect,useMemo,useRef,useState } from "react";
import { ActivityIndicator,Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { formatCopyFrom } from "../../shared/copy";
import { uniqueCommits } from '../graph/continuity';
import { createHistoryLoadGate } from "../graph/pagination";
import { ScrollView, Modal, Icon } from "../native-components";
import { IconButton } from "./icon-button";
import { ObservationIndicator } from './observation-indicator';

import { GraphCanvas } from "../graph/canvas";
import { commitReferenceNames,formatCommitTime } from "../graph/commit-details";
import { GRAPH_LANE_WIDTH,GRAPH_ROW_HEIGHT } from "../graph/constants";
import { graphLaneColor } from "../graph/palette";
import { useWorkbenchCopy,useWorkbenchLocale } from "../i18n";
import {
layoutGraph,
type ChangeScope,
type GraphResult,
type GraphRow,
type RepositorySummary,
type SectionLayoutPreference
} from "../model";
import { observerAccent } from "../theme";
import { ChangeCounts,MiniTag,ScopeButton,SectionDisclosureButton,SectionViewport,fileCountLabel,makeStyles,repositoryCurrentRefDetail,repositoryRefMismatch } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;




type GraphReferenceTag = { label: string; color: string };

function graphReferenceTags(row: GraphRow, theme: PanelProps["theme"], includeReferences = true): GraphReferenceTag[] {
  const isHead = row.node.decorations.some((decoration) => decoration === "HEAD" || decoration.startsWith("HEAD "));
  const refLabel = (value: string): string => value.length > 22 ? `…${value.slice(-21)}` : value;
  const tags: GraphReferenceTag[] = [];
  if (isHead) tags.push({ label: "HEAD", color: observerAccent(theme) });
  if (row.node.isBase) tags.push({ label: "BASE", color: theme.colors.foregroundMuted });
  if (!includeReferences) return tags;
  const laneColor = graphLaneColor(theme, row.colorIndex);
  for (const ref of (row.node.refs || []).filter((ref) => !ref.isHead).slice(0, 2)) {
    tags.push({ label: refLabel(ref.shortName || ref.name), color: laneColor });
  }
  const taggedNames = new Set(tags.map((tag) => tag.label));
  for (const name of commitReferenceNames(row.node).filter((name) => !taggedNames.has(name)).slice(0, 2 - tags.filter((tag) => tag.label !== "HEAD" && tag.label !== "BASE").length)) {
    tags.push({ label: refLabel(name), color: laneColor });
  }
  const mergeRefs = (row.node.mergeSources || [])
    .flatMap((source, sourceIndex) => (source.refs || [])
      .filter((ref) => !ref.isHead)
      .slice(0, 1)
      .map((ref) => ({ label: `↳ ${refLabel(ref.shortName || ref.name)}`, color: graphLaneColor(theme, row.parentLanes[sourceIndex + 1]?.colorIndex) })))
    .slice(0, 1);
  tags.push(...mergeRefs);
  return tags;
}

export const CommitDetailCard = memo(function CommitDetailCard({
  row,
  compact,
  locale,
  theme,
  styles,
}: {
  row: GraphRow;
  compact?: boolean;
  locale: Parameters<typeof formatCommitTime>[1];
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const node = row.node;
  const time = formatCommitTime(node.authoredAt, locale, copy);
  const tags = graphReferenceTags(row, theme);
  const references = commitReferenceNames(node);
  const title = node.subject || (node.isBase ? copy.commitBase : node.shortSha);
  const isMerge = node.parents.length > 1;
  return (
    <View accessibilityLabel={copy.commitDetails} style={[styles.graphCommitDetail, compact && styles.graphCommitDetailCompact]}>
      <View style={styles.graphCommitDetailTitleRow}>
        <Text numberOfLines={compact ? 2 : 3} style={styles.graphCommitDetailTitle}>{title}</Text>
        {node.isBase ? <Text style={styles.graphCommitDetailRole}>{copy.commitBase}</Text> : null}
      </View>
      <Text selectable numberOfLines={1} style={styles.graphCommitDetailSha}>{node.sha || node.shortSha}</Text>
      <View style={styles.graphCommitDetailMeta}>
        <Text style={styles.graphCommitDetailMetaText}>
          <Text style={styles.graphCommitDetailMetaLabel}>{copy.commitAuthor}: </Text>
          {node.author || copy.commitAuthorUnknown}
        </Text>
        <Text style={styles.graphCommitDetailMetaText}>
          <Text style={styles.graphCommitDetailMetaLabel}>{copy.commitTime}: </Text>
          {time.absolute}{time.relative ? ` · ${time.relative}` : ""}
        </Text>
        <Text style={styles.graphCommitDetailMetaText}>
          {formatCopyFrom(copy, "commitParentCount", [node.parents.length])}{isMerge ? ` · ${copy.commitMerge}` : ""}
        </Text>
      </View>
      <View style={styles.graphCommitDetailMetaBlock}>
        <Text style={styles.graphCommitDetailMetaLabel}>{copy.commitReferences}</Text>
        <View style={styles.graphCommitDetailTagRow}>
          {tags.length ? tags.map((tag, index) => <MiniTag key={`${tag.label}-${index}`} label={tag.label} color={tag.color} styles={styles} />) : (
            <Text style={styles.graphCommitDetailMetaText}>{references.length ? references.join(" · ") : copy.commitNoReferences}</Text>
          )}
        </View>
      </View>
    </View>
  );
});

export function CommitGraph({
  graph,
  loading,
  error,
  selectedCommit,
  onCompare,
  onCommit,
  lastSuccessfulAt,
  onGraphBase,
  onGraphMore,
  graphIdentity,
  loadingMore,
  changeScope,
  onScope,
  repository,
  detailsOpen,
  onToggleDetails,
  sectionLayout,
  availableHeight,
  onSectionToggle,


  onOpenLayoutMenu,
  graphPlatform,
  refreshing,
  theme,
  styles,
}: {
  graph: GraphResult | null;
  loading: boolean;
  error: string | null;
  lastSuccessfulAt?: string | null;
  selectedCommit: string;
  onCompare?: (sha:string, role:"from"|"to")=>void;
  onCommit: (sha: string) => void;
  onGraphBase: () => void;
  onGraphMore: () => void;
  graphIdentity: string;
  loadingMore: boolean;
  changeScope: Exclude<ChangeScope, "commit">;
  onScope: (scope: Exclude<ChangeScope, "commit">) => void;
  repository: RepositorySummary;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  sectionLayout: SectionLayoutPreference;
  availableHeight: number;
  onSectionToggle: (collapsed: boolean) => void;


  onOpenLayoutMenu: () => void;
  graphPlatform: PanelProps["layout"]["platform"];
  refreshing: boolean;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const locale = useWorkbenchLocale();
  const [hoveredCommit, setHoveredCommit] = useState("");
  const historyGate = useRef<ReturnType<typeof createHistoryLoadGate> | null>(null);
  if (historyGate.current === null) historyGate.current = createHistoryLoadGate();
  const historyOffset = useRef(0);
  const historyIdentity = `${graphIdentity}:${repository.head}:${graph?.historyMode}`;
  useLayoutEffect(() => { historyGate.current?.reset(historyIdentity, historyOffset.current); }, [historyIdentity]);
  const rows = useMemo(() => layoutGraph(uniqueCommits(graph?.nodes || [])), [graph?.nodes]);
  const selectedRow = useMemo(() => selectedCommit ? rows.find((row) => row.node.sha === selectedCommit) || null : null, [rows, selectedCommit]);
  const onHoverCommit = useCallback((sha: string) => {
    if (Platform.OS === "web") setHoveredCommit(sha);
  }, []);
  const onHoverClear = useCallback((sha: string) => {
    setHoveredCommit((current) => current === sha ? "" : current);
  }, []);
  const laneCount = Math.max(1, ...rows.map((row) => row.laneCount));
  const railWidth = laneCount * GRAPH_LANE_WIDTH + 8;
  const workingFileCount = Math.max((repository.workingChanges?.files ?? repository.dirtyPaths?.length ?? 0), repository.dirtyPaths?.length || 0);
  const showWorktree = Boolean(repository.dirty || workingFileCount > 0);
  const scrollAnchor = useMemo(() => ({ identity: graphIdentity, keys: [...(showWorktree ? ['WORKTREE'] : []), ...rows.map(row => row.node.sha)], rowHeight: GRAPH_ROW_HEIGHT }), [graphIdentity, rows, showWorktree]);
  const graphHeight = (rows.length + (showWorktree ? 1 : 0)) * GRAPH_ROW_HEIGHT;
  const branchScopeAvailable = repository.branchScopeAvailable !== false;

  const hasOlder = Boolean(graph?.hasOlder && (graphViewLimit(graph) < 200 || graph?.historyMode === "branch"));
  useLayoutEffect(() => {
    if (historyGate.current?.resume(historyIdentity, graph?.loadedCount || 0, loadingMore, Boolean(hasOlder && graph?.historyMode === 'full'))) onGraphMore();
  }, [historyIdentity, graph?.loadedCount, loadingMore, hasOlder, graph?.historyMode, onGraphMore]);
  return (
    <View style={styles.graphSection}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <SectionDisclosureButton
            expanded={!sectionLayout.collapsed}
            label={copy.text_eac4c5d4a1}
            onLongPress={onOpenLayoutMenu}
            onPress={() => onSectionToggle(!sectionLayout.collapsed)}
            theme={theme}
            styles={styles}
          />
          <ObservationIndicator lastSuccessfulAt={lastSuccessfulAt} hasContent={Boolean(graph)} error={error} loading={loading} refreshing={refreshing} theme={theme} styles={styles} />
        </View>
        <View style={styles.graphHeaderActions}>
          {!selectedCommit ? (
            <View style={styles.changeScopeRow}>
              {showWorktree ? <ScopeButton label={formatCopyFrom(copy, "text_22c7a14625", [workingFileCount])} active={changeScope === "working"} onPress={() => onScope("working")} styles={styles} /> : null}
              {branchScopeAvailable ? <ScopeButton label={formatCopyFrom(copy, "text_46b798f402", [(repository.changes?.files ?? "—")])} active={changeScope === "branch"} onPress={() => onScope("branch")} styles={styles} /> : null}
            </View>
          ) : <IconButton label={copy.text_62b4069970} icon="ArrowLeft" color={theme.colors.foregroundMuted} onPress={() => onCommit("")} />}
          <IconButton label={copy.text_4f55ee1e68} icon="Info" active={detailsOpen} color={theme.colors.foregroundMuted} onPress={onToggleDetails} />
          {graph?.hasOlder && graphViewLimit(graph) >= 200 ? <IconButton label={copy.text_f9d6d6a329} icon="Ellipsis" color={theme.colors.statusWarning} onPress={onToggleDetails} /> : null}
        </View>
      </View>
      {!sectionLayout.collapsed ? (
        <SectionViewport
          id="graph"
          scrollAnchor={scrollAnchor}

          availableHeight={availableHeight}


          theme={theme}
          styles={styles}
          onScroll={(event) => {
            const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
            historyOffset.current = contentOffset.y;
            if (historyGate.current?.allow(historyIdentity, graph?.loadedCount || 0, contentOffset.y, layoutMeasurement.height, contentSize.height, loadingMore, Boolean(hasOlder && graph?.historyMode === "full"))) onGraphMore();
          }}
        >
          {rows.length || showWorktree ? (
            <View testID="workbench-graph-content" style={[styles.graphSurface, { minHeight: graphHeight }, Platform.OS === "web" ? { overflowAnchor: "none" } as unknown as ViewStyle : undefined]}>
              <View style={styles.graphRows}>
                {showWorktree ? (
                  <WorkingTreeRow
                    repository={repository}
                    selected={changeScope === "working"}
                    onPress={() => {
                      onCommit("");
                      onScope("working");
                    }}
                    railWidth={railWidth}
                    theme={theme}
                    styles={styles}
                  />
                ) : null}
                {rows.map((row) => (
                  <GraphCommitRow
                    key={row.node.sha}
                    row={row}
                    selected={row.node.sha === selectedCommit}
                    hovered={row.node.sha === hoveredCommit}
                    onCompare={onCompare}
                    onCommit={onCommit}
                    onHoverCommit={onHoverCommit}
                    onHoverClear={onHoverClear}
                    railWidth={railWidth}
                    theme={theme}
                    styles={styles}
                  />
                ))}
              </View>
              <GraphCanvas rows={rows} width={railWidth} height={graphHeight} selectedCommit={selectedCommit} showWorktree={showWorktree} worktreeSelected={changeScope === "working"} platform={graphPlatform} theme={theme} />
            </View>
          ) : null}
          {graph && !loading && !error && !rows.length ? <Text style={styles.emptyText}>{copy.text_a07cd6a10e}</Text> : null}
          {graph?.historyMode === "branch" ? (
            <Pressable accessibilityRole="button" disabled={loadingMore} onPress={onGraphBase} style={[styles.historyButton, loadingMore && styles.historyButtonDisabled]}>
              <ActivityIndicator animating={loadingMore} hidesWhenStopped color={observerAccent(theme)} size="small" />
              <Text style={styles.historyButtonText}>{copy.text_80a8716fca}</Text>
            </Pressable>
          ) : graph?.historyMode === "full" && hasOlder ? (
            <Pressable accessibilityRole="button" disabled={loadingMore} onPress={onGraphMore} style={[styles.historyButton, loadingMore && styles.historyButtonDisabled]}>
              {loadingMore ? <ActivityIndicator color={observerAccent(theme)} size="small" /> : null}
              <Text style={styles.historyButtonText}>{loadingMore ? copy.text_76c6f5f575 : formatCopyFrom(copy, "historyScroll", [graph.loadedCount || rows.filter((row) => !row.node.isBase).length])}</Text>
            </Pressable>
          ) : graph?.historyMode === "full" && graph.loadedCount ? (
            <Text style={styles.historyEndText}>{graph.hasOlder ? copy.text_f9d6d6a329 : copy.text_5731f87e8f} {copy.text_c9b020caa5}{graph.loadedCount}</Text>
          ) : null}
        </SectionViewport>
      ) : null}
      {!sectionLayout.collapsed && detailsOpen ? (
        <View style={styles.graphDetailsPanel}>
          <View style={styles.graphDetailsHeader}>
            <Text numberOfLines={1} style={styles.graphDetailsHeaderTitle}>
              {selectedRow ? copy.commitDetails : copy.text_4f55ee1e68}
            </Text>
            {selectedRow ? <Text style={styles.graphDetailsHeaderMeta}>{selectedRow.node.shortSha}</Text> : null}
          </View>
          <ScrollView
            contentContainerStyle={styles.graphDetailsContent}
            nestedScrollEnabled
            showsVerticalScrollIndicator
            style={styles.graphDetailsScroll}
          >
            {selectedRow ? (
              <CommitDetailCard compact row={selectedRow} locale={locale} theme={theme} styles={styles} />
            ) : (
              <View style={styles.repositoryDisclosure}>
                <Text selectable style={styles.repositoryDisclosureBranch}>{copy.repositoryCurrentRef}: {repositoryCurrentRefDetail(repository, copy)}</Text>
                <Text selectable style={styles.repositoryDisclosureMeta}>{copy.repositoryHead}: {repository.head || repository.headShort || "—"}</Text>
                {repositoryRefMismatch(repository) ? <Text selectable style={styles.repositoryDisclosureMeta}>{copy.repositoryRegisteredBranch}: {repository.registeredBranch || "—"}</Text> : null}
                <Text selectable style={styles.repositoryDisclosureMeta}>
                  {copy.text_1405df66cb}{repository.baseRef || "—"} · {repository.baseSha || repository.baseShaShort || "—"}
                </Text>
                {(repository.workingChanges || repository.changes) ? <Text selectable style={styles.repositoryDisclosureMeta}>
                  {copy.repositoryChanges}: +{repository.workingChanges?.additions ?? repository.changes?.additions ?? 0} / −{repository.workingChanges?.deletions ?? repository.changes?.deletions ?? 0} · {(repository.workingChanges?.files ?? repository.changes?.files ?? 0)}
                </Text> : null}
                {repository.dirtyPaths.length ? <Text selectable style={styles.repositoryDisclosureMeta}>{fileCountLabel(repository.dirtyPaths.length, copy)}</Text> : null}
              </View>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

export function graphViewLimit(graph: GraphResult): number {
  return graph.loadedCount || graph.nodes.filter((node) => !node.isBase).length;
}

export function WorkingTreeRow({
  repository,
  selected,
  onPress,
  railWidth,
  theme,
  styles,
}: {
  repository: RepositorySummary;
  selected: boolean;
  onPress: () => void;
  railWidth: number;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.graphRow, styles.graphWorktreeRow, selected && styles.graphRowActive]}>
      <View style={{ width: railWidth }} />
      <View style={styles.graphRowCopy}>
          <Text numberOfLines={1} style={styles.graphSubject}>
          <Text style={styles.graphWorktreeLabel}>{copy.text_ef7c82a2b7}</Text>
          {!repository.basicOnly || repository.workingChanges ? <Text style={styles.graphSha}>{formatCopyFrom(copy, "text_29e918bbdd", [formatCopyFrom(copy, "fileCountLabel", [Math.max((repository.workingChanges?.files ?? repository.dirtyPaths?.length ?? 0), repository.dirtyPaths?.length || 0)])])}</Text> : null}
          <Text>{" · "}</Text>
          {repository.workingChanges && (repository.workingChanges.additions || repository.workingChanges.deletions)
            ? <ChangeCounts additions={repository.workingChanges.additions} deletions={repository.workingChanges.deletions} styles={styles} />
            : null}
        </Text>
      </View>
    </Pressable>
  );
}

export const GraphCommitRow = memo(function GraphCommitRow({
  row,
  selected,
  hovered,
  onCompare,
  onCommit,
  onHoverCommit,
  onHoverClear,
  railWidth,
  theme,
  styles,
}: {
  row: GraphRow;
  selected: boolean;
  hovered: boolean;
  onCompare?: (sha:string, role:"from"|"to")=>void;
  onCommit: (sha: string) => void;
  onHoverCommit?: (sha: string) => void;
  onHoverClear?: (sha: string) => void;
  railWidth: number;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const tags = graphReferenceTags(row, theme, false);
  const [menu,setMenu]=useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={`workbench-commit-${row.node.sha}`}
      onHoverIn={() => onHoverCommit?.(row.node.sha)}
      onHoverOut={() => onHoverClear?.(row.node.sha)}
      onPress={() => {
        onHoverClear?.(row.node.sha);
        onCommit(row.node.sha);
      }}
      style={[styles.graphRow, hovered && styles.graphRowHover, selected && styles.graphRowActive]}
    >
      <View style={{ width: railWidth }} />
      <View style={styles.graphRowCopy}>
        <Text numberOfLines={1} style={styles.graphSubject}>
          <Text style={styles.graphSha}>{row.node.shortSha}</Text>
          {`  ${row.node.subject || (row.node.isBase ? copy.graphBaseLabel : row.node.shortSha)}`}
        </Text>
        {onCompare ? <Pressable accessibilityRole="button" accessibilityLabel="提交比较操作" onPress={event=>{event.stopPropagation();setMenu(value=>!value);}}><Icon name="Ellipsis" size={16} color={theme.colors.foregroundMuted}/></Pressable>:null}
        {menu&&onCompare?<Modal open onOpenChange={setMenu} title={`${row.node.shortSha} · 比较`}><Modal.Content style={{padding:16}}>{(['from','to'] as const).map(role=><Pressable key={role} onPress={event=>{event.stopPropagation();setMenu(false);onCompare(row.node.sha,role);}}><Text style={styles.graphSha}>{role==='from'?'设为比较起点':'与起点比较'}　</Text></Pressable>)}</Modal.Content></Modal>:null}
        {tags.map((tag, index) => <MiniTag key={`${tag.label}-${index}`} label={tag.label} color={tag.color} styles={styles} />)}
      </View>
    </Pressable>
  );
});
