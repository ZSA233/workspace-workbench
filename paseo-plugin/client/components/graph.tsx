import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { ActivityIndicator,Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy, formatCopy } from "../../shared/copy";

import { GraphCanvas } from "../graph/canvas";
import { GRAPH_LANE_WIDTH,GRAPH_ROW_HEIGHT } from "../graph/constants";
import { graphLaneColor } from "../graph/palette";
import {
layoutGraph,
type ChangeScope,
type GraphResult,
type GraphRow,
type RepositorySummary,
type SectionLayoutPreference
} from "../model";
import { observerAccent } from "../theme";
import { ChangeCounts,InlineRefresh,MiniTag,ScopeButton,SectionDisclosureButton,SectionViewport,fileCountLabel,makeStyles } from "./ui";

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

export function CommitGraph({
  graph,
  loading,
  error,
  selectedCommit,
  onCommit,
  onGraphBase,
  onGraphMore,
  loadingMore,
  changeScope,
  onScope,
  repository,
  detailsOpen,
  onToggleDetails,
  sectionLayout,
  availableHeight,
  onSectionToggle,
  onHeightCommit,
  onSectionDragState,
  onOpenLayoutMenu,
  graphPlatform,
  refreshing,
  theme,
  styles,
}: {
  graph: GraphResult | null;
  loading: boolean;
  error: string | null;
  selectedCommit: string;
  onCommit: (sha: string) => void;
  onGraphBase: () => void;
  onGraphMore: () => void;
  loadingMore: boolean;
  changeScope: Exclude<ChangeScope, "commit">;
  onScope: (scope: Exclude<ChangeScope, "commit">) => void;
  repository: RepositorySummary;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  sectionLayout: SectionLayoutPreference;
  availableHeight: number;
  onSectionToggle: (collapsed: boolean) => void;
  onHeightCommit: (height: number | null) => void;
  onSectionDragState: (dragging: boolean) => void;
  onOpenLayoutMenu: () => void;
  graphPlatform: PanelProps["layout"]["platform"];
  refreshing: boolean;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const rows = useMemo(() => layoutGraph(graph?.nodes || []), [graph?.nodes]);
  const laneCount = Math.max(1, ...rows.map((row) => row.laneCount));
  const railWidth = laneCount * GRAPH_LANE_WIDTH + 8;
  const workingFileCount = Math.max(repository.workingChanges.files, repository.dirtyPaths?.length || 0);
  const showWorktree = !selectedCommit && (repository.dirty || workingFileCount > 0);
  const graphHeight = (rows.length + (showWorktree ? 1 : 0)) * GRAPH_ROW_HEIGHT;
  const branchScopeAvailable = repository.branchScopeAvailable !== false;
  const graphScope = selectedCommit
    ? "commit changes"
    : graph?.historyMode === "full"
      ? copy.text_80a8716fca
      : changeScope === "working"
        ? "HEAD → WORKTREE"
        : branchScopeAvailable
          ? "base → HEAD"
          : copy.text_ddde5db955;
  const hasOlder = Boolean(graph?.hasOlder && (graphViewLimit(graph) < 200 || graph?.historyMode === "branch"));
  return (
    <View style={styles.graphSection}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <SectionDisclosureButton
            expanded={!sectionLayout.collapsed}
            label={`${repository.name} · ${selectedCommit ? copy.text_b5d0217a47 : copy.text_eac4c5d4a1}`}
            onLongPress={onOpenLayoutMenu}
            onPress={() => onSectionToggle(!sectionLayout.collapsed)}
            theme={theme}
            styles={styles}
          />
          <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
        </View>
        <View style={styles.graphHeaderActions}>
          <Text style={styles.graphScope}>{graphScope}</Text>
          {!selectedCommit ? (
            <View style={styles.changeScopeRow}>
              {showWorktree ? <ScopeButton label={formatCopy("text_22c7a14625", [workingFileCount])} active={changeScope === "working"} onPress={() => onScope("working")} styles={styles} /> : null}
              {branchScopeAvailable ? <ScopeButton label={formatCopy("text_46b798f402", [repository.changes.files])} active={changeScope === "branch"} onPress={() => onScope("branch")} styles={styles} /> : null}
            </View>
          ) : <Pressable accessibilityRole="button" onPress={() => onCommit("")} style={styles.scopeButton}><Text style={styles.scopeButtonText}>{copy.text_62b4069970}</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: detailsOpen }} onPress={onToggleDetails} style={styles.scopeButton}>
            <Text style={styles.scopeButtonText}>{detailsOpen ? copy.text_a86af73bae : copy.text_4f55ee1e68}</Text>
          </Pressable>
          {graph?.truncated ? <MiniTag label="TRUNCATED" color={theme.colors.statusWarning} styles={styles} /> : null}
        </View>
      </View>
      {!sectionLayout.collapsed ? (
        <SectionViewport
          id="graph"
          layout={sectionLayout}
          availableHeight={availableHeight}
          onDragStateChange={onSectionDragState}
          onHeightCommit={onHeightCommit}
          theme={theme}
          styles={styles}
        >
          {detailsOpen ? (
            <View style={styles.repositoryDisclosure}>
              <Text selectable style={styles.repositoryDisclosureBranch}>{repository.branch || "detached"}</Text>
              <Text selectable style={styles.repositoryDisclosureMeta}>
                {copy.text_1405df66cb}{repository.baseRef || "—"} · {repository.baseSha || repository.baseShaShort || "—"} {copy.text_97def2ca9e}{repository.head || repository.headShort || "—"}
              </Text>
            </View>
          ) : null}
          {error ? <Text style={styles.warningText}>{error}</Text> : null}
          {loading ? <Text style={styles.emptyText}>{copy.text_fcabadb2a7}</Text> : null}
          {rows.length || showWorktree ? (
            <View style={[styles.graphSurface, { minHeight: graphHeight }]}>
              <View style={styles.graphRows}>
                {showWorktree ? (
                  <WorkingTreeRow
                    repository={repository}
                    selected={changeScope === "working"}
                    onPress={() => onScope("working")}
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
                    onPress={() => (row.node.isBase ? onGraphBase() : onCommit(row.node.sha))}
                    railWidth={railWidth}
                    theme={theme}
                    styles={styles}
                  />
                ))}
              </View>
              <GraphCanvas rows={rows} width={railWidth} height={graphHeight} selectedCommit={selectedCommit} showWorktree={showWorktree} worktreeSelected={changeScope === "working"} platform={graphPlatform} theme={theme} />
            </View>
          ) : null}
          {!loading && !rows.length ? <Text style={styles.emptyText}>{copy.text_a07cd6a10e}</Text> : null}
          {graph?.historyMode === "full" && hasOlder ? (
            <Pressable accessibilityRole="button" disabled={loadingMore} onPress={onGraphMore} style={[styles.historyButton, loadingMore && styles.historyButtonDisabled]}>
              {loadingMore ? <ActivityIndicator color={observerAccent(theme)} size="small" /> : null}
              <Text style={styles.historyButtonText}>{loadingMore ? copy.text_76c6f5f575 : formatCopy("text_f69ff23be4", [graph.loadedCount || rows.filter((row) => !row.node.isBase).length])}</Text>
            </Pressable>
          ) : graph?.historyMode === "full" && graph.loadedCount ? (
            <Text style={styles.historyEndText}>{graph.hasOlder ? copy.text_f9d6d6a329 : copy.text_5731f87e8f} {copy.text_c9b020caa5}{graph.loadedCount}</Text>
          ) : null}
        </SectionViewport>
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
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.graphRow, styles.graphWorktreeRow, selected && styles.graphRowActive]}>
      <View style={{ width: railWidth }} />
      <View style={styles.graphRowCopy}>
          <Text numberOfLines={1} style={styles.graphSubject}>
          <Text style={styles.graphWorktreeLabel}>{copy.text_ef7c82a2b7}</Text>
          <Text style={styles.graphSha}>{formatCopy("text_29e918bbdd", [fileCountLabel(Math.max(repository.workingChanges.files, repository.dirtyPaths?.length || 0))])}</Text>
          <Text>{" · "}</Text>
          <ChangeCounts additions={repository.workingChanges.additions} deletions={repository.workingChanges.deletions} styles={styles} />
        </Text>
      </View>
    </Pressable>
  );
}

export function GraphCommitRow({
  row,
  selected,
  onPress,
  railWidth,
  theme,
  styles,
}: {
  row: GraphRow;
  selected: boolean;
  onPress: () => void;
  railWidth: number;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const isHead = row.node.decorations.some((decoration) => decoration === "HEAD" || decoration.startsWith("HEAD "));
  const laneColor = graphLaneColor(theme, row.colorIndex);
  const branchRefs = (row.node.refs || []).filter((ref) => !ref.isHead).slice(0, 2);
  const mergeRefs = (row.node.mergeSources || [])
    .flatMap((source, sourceIndex) => (source.refs || [])
      .filter((ref) => !ref.isHead)
      .slice(0, 1)
      .map((ref) => ({ ref, color: graphLaneColor(theme, row.parentLanes[sourceIndex + 1]?.colorIndex) })))
    .slice(0, 1);
  const refLabel = (value: string): string => value.length > 22 ? `…${value.slice(-21)}` : value;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.graphRow, selected && styles.graphRowActive]}>
      <View style={{ width: railWidth }} />
      <View style={styles.graphRowCopy}>
        <Text numberOfLines={1} style={styles.graphSubject}>
          <Text style={styles.graphSha}>{row.node.shortSha}</Text>
          {row.node.isBase ? "  base" : `  ${row.node.subject}`}
        </Text>
        {isHead ? <MiniTag label="HEAD" color={observerAccent(theme)} styles={styles} /> : null}
        {row.node.isBase ? <MiniTag label="BASE" color={theme.colors.foregroundMuted} styles={styles} /> : null}
        {branchRefs.map((ref) => <MiniTag key={`${ref.name}-${ref.sha}`} label={refLabel(ref.shortName)} color={laneColor} styles={styles} />)}
        {mergeRefs.map(({ ref, color }) => <MiniTag key={`merge-${ref.name}-${ref.sha}`} label={`↳ ${refLabel(ref.shortName)}`} color={color} styles={styles} />)}
      </View>
    </Pressable>
  );
}
