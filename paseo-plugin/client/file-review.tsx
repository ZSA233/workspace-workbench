import { useObservationVersions } from "./use-observation-versions";
import { useForegroundActivity } from "./foreground-activity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { FlatList, Icon, ScrollView } from "./native-components";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { copy, formatCopyFrom, type WorkbenchCopy } from "../shared/copy";
import { observerQuery, type ObserverResponse } from "../shared/observer";
import { projectBackendStatus } from "../shared/setup";
import {
  DEFAULT_OBSERVATION_TIMING,
  observationTimingFromWire,
} from "../shared/observation-timing";
import {
  buildDiffDisplayRows,
  buildDiffOverviewMarkers,
  DIFF_HUNK_ROW_HEIGHT,
  DIFF_LINE_ROW_HEIGHT,
  diffDisplayRowMetrics,
  type DiffHunk,
  type DiffLine,
  type DiffDisplayRow,
  type DiffOverviewMarker,
  type DiffResult,
  formatDiffReferences,
  isTransientIssueCode,
  issueDisplayLabel,
  parseUnifiedPatch,
} from "./model";
import {
  closeFileReview,
  selectionKey,
  setActiveFileReview,
  type FileReviewSelection,
  useActiveFileReviewKey,
  useFileReviews,
} from "./file-review-store";
import { boundedRefresh, useBoundedCacheRefresh, useLastSuccessfulResponse } from "./observation";
import { IconButton } from "./components/icon-button";
import { useReviewModePreference } from "./review-preferences";
import type { ReviewMode } from "./review-mode";
import { editorCodeFontFamily, HighlightedCode } from "./syntax";
import { Svg, Rect } from "./graph/svg-web";
import { observerAccent } from "./theme";
import { useWorkbenchCopy } from "./i18n";
import { reportNativeDiagnostic } from "./native-diagnostics";

type FilePanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
const MIN_SPLIT_PANEL_WIDTH = 860;

function resultOf<T>(response: ObserverResponse | undefined): T | null {
  if (!response?.ok) return null;
  return response.result as T;
}

function responseErrorLabel(
  response: ObserverResponse | undefined,
  error: unknown,
  hasSnapshot: boolean,
  strings: WorkbenchCopy = copy,
): string | null {
  if (response && !response.ok) {
    const code = response.error?.code || "";
    if (isTransientIssueCode(code)) return hasSnapshot ? null : strings.text_a7fc5b37a4;
    return issueDisplayLabel(code, strings);
  }
  if (error) return hasSnapshot ? null : strings.text_a7fc5b37a4;
  return null;
}

function statusColor(status: string, theme: FilePanelProps["theme"]): string {
  if (status === "A") return theme.colors.statusSuccess;
  if (status === "D") return theme.colors.statusDanger;
  if (status === "R") return observerAccent(theme);
  return theme.colors.statusWarning;
}

function scopeLabel(scope: FileReviewSelection["scope"], strings: WorkbenchCopy = copy): string {
  if (scope === "working") return strings.text_c580606e1c;
  if (scope === "commit") return strings.text_09cbc97ae2;
  return strings.text_d1d2ccdd33;
}

export function FileReviewPanel(props: FilePanelProps) {
  reportNativeDiagnostic("file-review-render", { entry: "FileReviewPanel" });
  const foreground = useForegroundActivity();
  const copy = useWorkbenchCopy();
  const hostWorkspaceId = props.workspaceId;
  const selections = useFileReviews(hostWorkspaceId);
  const { theme, layout } = props;
  const [panelWidth, setPanelWidth] = useState(0);
  const narrow = layout.compact || (panelWidth > 0 && panelWidth < MIN_SPLIT_PANEL_WIDTH);
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const activeKey = useActiveFileReviewKey(hostWorkspaceId);
  const { mode, setMode } = useReviewModePreference(hostWorkspaceId, narrow);
  const activeSelection = selections.find((item) => selectionKey(item) === activeKey) || selections.at(-1);
  const rpc = useRpc(observerQuery);
  // Android does not provide the query-client/version subscription boundary
  // used by the desktop panel. A file review only needs its direct diff read.
  const observationIssue = useObservationVersions(
    activeSelection?.projectConfig,
    activeSelection ? [activeSelection.workspaceId] : [],
    foreground && Platform.OS === "web",
  );
  const backendStatusRpc = useRpc(projectBackendStatus);
  const backendStatusQuery = useQuery({
    queryKey: ["workspace-workbench", "file-review-backend", activeSelection?.projectConfig],
    queryFn: () => backendStatusRpc({ projectConfig: activeSelection?.projectConfig || "" }),
    enabled: Boolean(activeSelection?.projectConfig),
    refetchInterval: foreground ? DEFAULT_OBSERVATION_TIMING.refreshIntervalsMs.list : false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const observationTiming = useMemo(
    () => observationTimingFromWire(backendStatusQuery.data?.timing),
    [backendStatusQuery.data?.timing],
  );
  const seenBackendInstanceId = useRef<string | null>(null);
  useEffect(() => {
    reportNativeDiagnostic("hook-effect-start", { hook: "file-review-backend-instance" });
    seenBackendInstanceId.current = null;
  }, [activeSelection?.projectConfig]);

  useEffect(() => {
    reportNativeDiagnostic("hook-effect-start", { hook: "file-review-selection-sync" });
    if (!activeSelection) {
      return;
    }
    const nextKey = selectionKey(activeSelection);
    if (nextKey !== activeKey) {
      setActiveFileReview(hostWorkspaceId, nextKey);
    }
  }, [activeKey, activeSelection, hostWorkspaceId]);

  const diffQuery = useQuery({
    queryKey: [
      "workspace-workbench",
      "file-review",
      activeSelection?.projectConfig,
      hostWorkspaceId,
      activeSelection?.workspaceId,
      activeSelection?.repoPath,
      activeSelection?.path,
      activeSelection?.scope,
      activeSelection?.commitSha,
    ],
    queryFn: () =>
      rpc({
        method: "repository.diff",
        projectConfig: activeSelection?.projectConfig,
        params: {
          workspaceId: activeSelection?.workspaceId,
          repoPath: activeSelection?.repoPath,
          path: activeSelection?.path,
          scope: activeSelection?.scope,
          commitSha: activeSelection?.commitSha || undefined,
        },
    }),
    enabled: Boolean(activeSelection),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: observationTiming.clientQueryStaleTimeMs,
  });
  const diffState = useLastSuccessfulResponse(
    `file-review:${hostWorkspaceId}:${activeSelection ? selectionKey(activeSelection) : ""}`,
    diffQuery.data,
    { error: diffQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository },
  );
  useBoundedCacheRefresh(
    `file-review:${hostWorkspaceId}:${activeSelection ? selectionKey(activeSelection) : ""}`,
    diffQuery.data,
    diffQuery.refetch,
    observationTiming.followUpDelaysMs,
    foreground,
  );
  useEffect(() => {
    const instanceId = backendStatusQuery.data?.instanceId;
    if (!instanceId) return;
    if (seenBackendInstanceId.current === null) {
      seenBackendInstanceId.current = instanceId;
      return;
    }
    if (seenBackendInstanceId.current === instanceId) return;
    seenBackendInstanceId.current = instanceId;
    void boundedRefresh(diffQuery.refetch(), observationTiming.clientRefreshTimeoutMs);
  }, [backendStatusQuery.data?.instanceId, diffQuery.refetch, observationTiming.clientRefreshTimeoutMs]);
  const durableFailure = diffQuery.data && !diffQuery.data.ok && ["file_not_changed", "path_invalid", "worktree_missing", "commit_missing", "base_missing"].includes(diffQuery.data.error?.code || "");
  const diff = durableFailure ? null : resultOf<DiffResult>(diffState.response);
  const error = responseErrorLabel(diffQuery.data, diffQuery.error, Boolean(diff), copy);

  function close(selection: FileReviewSelection): void {
    closeFileReview(hostWorkspaceId, selectionKey(selection));
  }

  return (
    <View style={styles.screen} accessibilityLabel={copy.changesTitle} onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.title}>{copy.text_01970ba582}</Text>
        </View>
        <View style={styles.headerActions}>
          <IconButton
            label={mode === "split" ? copy.switchToUnified : copy.switchToSplit}
            icon={mode === "split" ? "Columns2" : "Rows3"}
            active={!narrow && mode === "split"}
            color={narrow ? theme.colors.foregroundMuted : observerAccent(theme)}
            onPress={() => { if (!narrow) setMode(mode === "split" ? "unified" : "split"); }}
          />
          <View accessibilityLabel={copy.readOnlyBadge} style={styles.readOnlyBadge}>
            <Icon name="Lock" size={13} color={theme.colors.foregroundMuted} />
          </View>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabs}
        style={styles.tabsScroll}
      >
        {selections.map((selection) => {
          const key = selectionKey(selection);
          const active = key === (activeSelection ? selectionKey(activeSelection) : "");
          return (
            <View
              key={key}
              style={[styles.fileTab, active && styles.fileTabActive]}
              {...(layout.platform === "web"
                ? ({
                    onAuxClick: (event: { button?: number; preventDefault?: () => void }) => {
                      if (event.button === 1) {
                        event.preventDefault?.();
                        close(selection);
                      }
                    },
                  } as Record<string, unknown>)
                : {})}
            >
              <Pressable
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setActiveFileReview(hostWorkspaceId, key)}
                style={styles.fileTabButton}
              >
                <Text style={[styles.fileTabStatus, { color: statusColor(selection.status, theme) }]}>
                  {selection.status || "M"}
                </Text>
                {active && diffState.stale ? <Text style={styles.fileTabStale}>·</Text> : null}
                <Text numberOfLines={1} style={styles.fileTabText}>
                  {selection.path.split("/").at(-1) || selection.path}
                </Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => close(selection)} style={styles.closeTab}>
                <Text style={styles.closeTabText}>×</Text>
              </Pressable>
            </View>
          );
        })}
        {!selections.length ? <Text style={styles.emptyText}>{copy.text_336884b48e}</Text> : null}
      </ScrollView>

      {activeSelection ? (
        <View style={styles.body}>
          <View style={styles.fileHeader}>
            <View style={styles.fileHeaderCopy}>
              <Text numberOfLines={1} style={styles.filePath}>{activeSelection.path}</Text>
              <Text style={styles.metaText} numberOfLines={1}>
                {activeSelection.branch || copy.graphDetached} · {scopeLabel(activeSelection.scope, copy)} · {activeSelection.statusLabel}
              </Text>
            </View>
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {diffState.expired ? <Text style={styles.staleText}>{copy.text_6d6e071a12}</Text> : null}
          {diffQuery.isLoading ? <Text style={styles.emptyText}>{copy.text_a74b5d91fa}</Text> : null}
          {diff ? (
            <DiffViewer
              diff={diff}
              mode={mode}
              path={activeSelection.path}
              selection={activeSelection}
              compact={narrow}
              platform={layout.platform}
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{copy.text_982b60ebcc}</Text>
          <Text style={styles.emptyText}>{copy.text_5720774925}</Text>
        </View>
      )}
    </View>
  );
}

function DiffViewer({
  diff,
  mode,
  path,
  selection,
  compact,
  platform,
  theme,
  styles,
}: {
  diff: DiffResult;
  mode: ReviewMode;
  path: string;
  selection: FileReviewSelection;
  compact: boolean;
  platform: FilePanelProps["layout"]["platform"];
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  reportNativeDiagnostic("file-review-diff-render", { entry: "DiffViewer" });
  const copy = useWorkbenchCopy();
  const parsed = useMemo(() => parseUnifiedPatch(diff.patch), [diff.patch]);
  const rows = useMemo(() => buildDiffDisplayRows(parsed, mode), [mode, parsed]);
  const rowMetrics = useMemo(() => diffDisplayRowMetrics(rows), [rows]);
  const references = useMemo(() => formatDiffReferences({
    scope: selection.scope,
    baseSha: diff.baseSha || selection.baseSha,
    head: diff.head || selection.head,
    commitSha: selection.commitSha,
    branch: selection.branch,
  }), [diff, selection]);
  const overviewMarkers = useMemo(() => buildDiffOverviewMarkers(rows), [rows]);
  const hunkRowIndexes = useMemo(
    () => rows.flatMap((item, index) => (item.kind === "hunk" ? [index] : [])),
    [rows],
  );
  const rowHunkIndexes = useMemo(() => {
    return rows.map((item) => item.hunkIndex);
  }, [rows]);
  const rowHunkIndexesRef = useRef(rowHunkIndexes);
  rowHunkIndexesRef.current = rowHunkIndexes;
  const listRef = useRef<any>(null);
  const [currentHunk, setCurrentHunk] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);

  const onListLayout = useCallback((event: any) => {
    const nextHeight = Number(event.nativeEvent?.layout?.height) || 0;
    setViewportHeight((previous) => previous === nextHeight ? previous : nextHeight);
  }, []);

  useEffect(() => {
    setCurrentHunk(0);
    setScrollOffset(0);
    setContentHeight(0);
  }, [diff.patch, mode]);

  const jumpToHunk = useCallback((requestedIndex: number) => {
    if (!hunkRowIndexes.length) return;
    const nextIndex = (requestedIndex + hunkRowIndexes.length) % hunkRowIndexes.length;
    setCurrentHunk(nextIndex);
    listRef.current?.scrollToIndex?.({
      index: hunkRowIndexes[nextIndex],
      animated: true,
      viewPosition: 0.08,
    });
  }, [hunkRowIndexes]);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
    const visibleIndexes = viewableItems
      .map((item) => item.index)
      .filter((index): index is number => typeof index === "number")
      .sort((left, right) => left - right);
    const firstIndex = visibleIndexes[0];
    if (firstIndex === undefined) return;
    const nextHunk = rowHunkIndexesRef.current[firstIndex] || 0;
    setCurrentHunk((previous) => previous === nextHunk ? previous : nextHunk);
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;

  if (diff.binary) {
    return (
      <View style={styles.binaryState}>
        <Text style={styles.binaryTitle}>{copy.text_a1a0e61a02}</Text>
        <Text style={styles.emptyText}>{copy.text_8476fa5fe9}</Text>
      </View>
    );
  }
  if (!diff.patch && !parsed.hunks.length) {
    return (
      <View style={styles.binaryState}>
        <Text style={styles.binaryTitle}>{copy.text_fd707df26d}</Text>
        <Text style={styles.emptyText}>{copy.text_81f977c1ab}</Text>
      </View>
    );
  }
  return (
    <View style={styles.diffShell}>
      {diff.truncated ? <Text style={styles.warningText}>{copy.text_1d3d755616}</Text> : null}
      {parsed.prelude.length ? (
        <View style={styles.preludeBar}>
          <Text numberOfLines={1} style={styles.preludeText}>{parsed.prelude.join(" · ")}</Text>
        </View>
      ) : null}
      <View style={[styles.diffToolbar, compact && styles.diffToolbarCompact]}>
        <View
          accessibilityLabel={`${references.from} → ${references.to}`}
          style={[styles.diffRefGroup, compact && styles.diffRefGroupCompact]}
        >
          <Text numberOfLines={1} style={styles.diffRefValue}>{references.from}</Text>
          <Text style={styles.diffRefArrow}>→</Text>
          <Text numberOfLines={1} style={styles.diffRefValue}>{references.to}</Text>
        </View>
        <View style={[styles.diffToolbarActions, compact && styles.diffToolbarActionsCompact]}>
          {!compact ? <Text style={styles.diffLegendAdded}>{copy.text_dd4a011844}</Text> : null}
          {!compact ? <Text style={styles.diffLegendModified}>{copy.text_e103af637d}</Text> : null}
          {!compact ? <Text style={styles.diffLegendRemoved}>{copy.text_2e359e4f5a}</Text> : null}
          {hunkRowIndexes.length ? (
            <View style={styles.hunkNavigator}>
              <Pressable
                accessibilityLabel={copy.text_0d310558b7}
                accessibilityRole="button"
                onPress={() => jumpToHunk(currentHunk - 1)}
                style={styles.hunkButton}
              >
                <Text style={styles.hunkButtonText}>‹</Text>
              </Pressable>
              <Text style={styles.hunkCount}>{currentHunk + 1} {copy.text_42099b4af0}{hunkRowIndexes.length}</Text>
              <Pressable
                accessibilityLabel={copy.text_d8b1574142}
                accessibilityRole="button"
                onPress={() => jumpToHunk(currentHunk + 1)}
                style={styles.hunkButton}
              >
                <Text style={styles.hunkButtonText}>›</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
      <View style={styles.diffViewport}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.diffScrollContent}
          style={styles.diffHorizontal}
        >
          <View style={[styles.diffListViewport, mode === "split" ? styles.diffListViewportSplit : styles.diffListViewportUnified]}>
            <FlatList
              ref={listRef}
              data={rows}
              getItemLayout={(_, index) => ({
                index,
                length: rowMetrics.lengths[index] || DIFF_LINE_ROW_HEIGHT,
                offset: rowMetrics.offsets[index] || 0,
              })}
              initialNumToRender={100}
              keyExtractor={(item: DiffDisplayRow) => item.key}
              onLayout={onListLayout}
              onContentSizeChange={(_, height) => setContentHeight(height)}
              onScroll={(event: any) => setScrollOffset(Number(event.nativeEvent?.contentOffset?.y) || 0)}
              onScrollToIndexFailed={({ index }: { index: number }) => {
                listRef.current?.scrollToOffset?.({ offset: Math.max(0, rowMetrics.offsets[index] || 0), animated: true });
              }}
              onViewableItemsChanged={onViewableItemsChanged as any}
              renderItem={({ item }: { item: DiffDisplayRow }) =>
                item.kind === "hunk" ? (
                  <HunkRow
                    active={item.hunkIndex === currentHunk}
                    hunk={item.hunk}
                    onPress={() => jumpToHunk(item.hunkIndex)}
                    styles={styles}
                  />
                ) : item.kind === "split" ? (
                  <SplitRow left={item.left} right={item.right} path={path} theme={theme} styles={styles} />
                ) : (
                  <UnifiedRow line={item.line} path={path} theme={theme} styles={styles} />
                )
              }
              removeClippedSubviews
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.diffList}
              viewabilityConfig={viewabilityConfig}
              windowSize={11}
            />
          </View>
        </ScrollView>
        <OverviewRail
          contentHeight={contentHeight || rowMetrics.contentHeight}
          currentHunk={currentHunk}
          markers={overviewMarkers}
          onSelectHunk={jumpToHunk}
          scrollOffset={scrollOffset}
          platform={platform}
          theme={theme}
          height={viewportHeight}
          styles={styles}
        />
      </View>
    </View>
  );
}

function HunkRow({
  active,
  hunk,
  onPress,
  styles,
}: {
  active: boolean;
  hunk: DiffHunk;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.hunkRow, active && styles.hunkRowActive]}
    >
      <Text numberOfLines={1} style={styles.hunkText}>{hunk.header}</Text>
    </Pressable>
  );
}

function OverviewRail({
  contentHeight,
  currentHunk,
  markers,
  onSelectHunk,
  scrollOffset,
  platform,
  theme,
  height,
  styles,
}: {
  contentHeight: number;
  currentHunk: number;
  markers: DiffOverviewMarker[];
  onSelectHunk: (index: number) => void;
  scrollOffset: number;
  platform: FilePanelProps["layout"]["platform"];
  theme: FilePanelProps["theme"];
  height: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return platform === "web"
    ? <OverviewRailWeb contentHeight={contentHeight} currentHunk={currentHunk} markers={markers} onSelectHunk={onSelectHunk} scrollOffset={scrollOffset} theme={theme} height={height} styles={styles} />
    : <OverviewRailNative contentHeight={contentHeight} currentHunk={currentHunk} markers={markers} onSelectHunk={onSelectHunk} scrollOffset={scrollOffset} theme={theme} height={height} styles={styles} />;
}

type OverviewRailProps = Omit<Parameters<typeof OverviewRail>[0], "platform">;

function overviewRailMetrics(contentHeight: number, height: number, scrollOffset: number) {
  const scrollable = height > 0 && contentHeight > height;
  const thumbHeight = scrollable
    ? Math.min(height, Math.max(18, (height / contentHeight) * height))
    : height;
  const maxThumbTop = Math.max(0, height - thumbHeight);
  const thumbTop = scrollable
    ? Math.min(maxThumbTop, Math.max(0, (scrollOffset / Math.max(1, contentHeight - height)) * maxThumbTop))
    : 0;
  return { thumbHeight, thumbTop };
}

function overviewMarkerMetrics(marker: DiffOverviewMarker, height: number) {
  const markerHeight = Math.min(height, Math.max(3, marker.extent * height));
  const maxTop = Math.max(0, height - markerHeight);
  const markerTop = Math.min(maxTop, Math.max(0, marker.position * height));
  return { height: markerHeight, top: markerTop };
}

function overviewMarkerColor(marker: DiffOverviewMarker, currentHunk: number, theme: FilePanelProps["theme"]): string {
  if (marker.hunkIndex === currentHunk) return theme.colors.statusWarning;
  if (marker.kind === "added") return theme.colors.statusSuccess;
  if (marker.kind === "removed") return theme.colors.statusDanger;
  return observerAccent(theme);
}

function OverviewRailNative({
  contentHeight,
  currentHunk,
  markers,
  onSelectHunk,
  scrollOffset,
  theme,
  height,
  styles,
}: OverviewRailProps) {
  if (!height) return null;
  const { thumbHeight, thumbTop } = overviewRailMetrics(contentHeight, height, scrollOffset);
  return (
    <View accessibilityLabel={copy.diffOverview} style={[styles.overviewRail, { height }]}>
      <View pointerEvents="none" style={[styles.overviewBackground, { height }]} />
      {markers.map((marker, index) => {
        const frame = overviewMarkerMetrics(marker, height);
        return (
          <Pressable
            key={`${marker.hunkIndex}-${marker.kind}-${marker.startLine}-${index}`}
            accessibilityLabel={formatCopyFrom(copy, "diffHunk", [marker.hunkIndex + 1])}
            accessibilityRole="button"
            onPress={() => onSelectHunk(marker.hunkIndex)}
            style={[styles.overviewMarker, {
              backgroundColor: overviewMarkerColor(marker, currentHunk, theme),
              height: frame.height,
              top: frame.top,
            }]}
          />
        );
      })}
      {contentHeight > height ? <View pointerEvents="none" style={[styles.overviewThumb, { height: thumbHeight, top: thumbTop }]} /> : null}
    </View>
  );
}

function OverviewRailWeb({
  contentHeight,
  currentHunk,
  markers,
  onSelectHunk,
  scrollOffset,
  theme,
  height,
  styles,
}: OverviewRailProps) {
  if (!height) return null;
  const { thumbHeight, thumbTop } = overviewRailMetrics(contentHeight, height, scrollOffset);
  return (
    <View accessibilityLabel={copy.diffOverview} style={[styles.overviewRail, { height }]}>
      <Svg height={height} style={styles.overviewSvg} width={12}>
        <Rect fill={theme.colors.surface2} height={height} width={12} x={0} y={0} />
        {markers.map((marker, index) => {
          const frame = overviewMarkerMetrics(marker, height);
          return (
            <Rect
              key={`${marker.hunkIndex}-${marker.kind}-${marker.startLine}-${index}`}
              fill={overviewMarkerColor(marker, currentHunk, theme)}
              height={frame.height}
              onPress={() => onSelectHunk(marker.hunkIndex)}
              rx={1.5}
              width={7}
              x={2}
              y={frame.top}
            />
          );
        })}
        {contentHeight > height ? (
          <Rect
            fill={`${theme.colors.foregroundMuted}88`}
            height={thumbHeight}
            rx={3}
            width={3}
            x={9}
            y={thumbTop}
          />
        ) : null}
      </Svg>
    </View>
  );
}

function UnifiedRow({
  line,
  path,
  theme,
  styles,
}: {
  line: DiffLine;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const background = line.kind === "added" ? styles.addedRow : line.kind === "removed" ? styles.removedRow : styles.contextRow;
  const gutter = line.kind === "added" ? styles.addedGutter : line.kind === "removed" ? styles.removedGutter : styles.contextGutter;
  const marker = line.kind === "added" ? styles.addedMarker : line.kind === "removed" ? styles.removedMarker : styles.contextMarker;
  return (
    <View style={[styles.diffRow, background]}>
      <View style={[styles.changeGutter, gutter]} />
      <Text style={styles.lineNumber}>{line.oldLine ?? ""}</Text>
      <Text style={styles.lineNumber}>{line.newLine ?? ""}</Text>
      <Text style={[styles.diffMarker, marker]}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</Text>
      <Text selectable style={styles.codeText}>
        <HighlightedCode code={line.content || " "} path={path} theme={theme} style={styles.codeSyntaxText} />
      </Text>
    </View>
  );
}

function SplitRow({
  left,
  right,
  path,
  theme,
  styles,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.splitRow}>
      <DiffCell line={left} path={path} theme={theme} styles={styles} side="left" />
      <View style={styles.splitDivider} />
      <DiffCell line={right} path={path} theme={theme} styles={styles} side="right" />
    </View>
  );
}

function DiffCell({
  line,
  path,
  theme,
  styles,
  side,
}: {
  line: DiffLine | null;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
  side: "left" | "right";
}) {
  if (!line) return <View style={styles.emptyDiffCell} />;
  const background = line.kind === "added" ? styles.addedRow : line.kind === "removed" ? styles.removedRow : styles.contextRow;
  const gutter = line.kind === "added" ? styles.addedGutter : line.kind === "removed" ? styles.removedGutter : styles.contextGutter;
  const marker = line.kind === "added" ? styles.addedMarker : line.kind === "removed" ? styles.removedMarker : styles.contextMarker;
  return (
    <View style={[styles.diffCell, background]}>
      <View style={[styles.changeGutter, gutter]} />
      <Text style={styles.lineNumber}>{side === "left" ? line.oldLine ?? "" : line.newLine ?? ""}</Text>
      <Text style={[styles.diffMarker, marker]}>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</Text>
      <Text selectable style={styles.codeText}>
        <HighlightedCode code={line.content || " "} path={path} theme={theme} style={styles.codeSyntaxText} />
      </Text>
    </View>
  );
}

function makeStyles(theme: FilePanelProps["theme"]) {
  const accent = observerAccent(theme);
  return StyleSheet.create({
    screen: { backgroundColor: theme.colors.surface0, flex: 1 },
    header: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 42, paddingHorizontal: 12, paddingVertical: 5 },
    headerCopy: { flex: 1, minWidth: 0 },
    title: { color: theme.colors.foreground, flexShrink: 1, fontSize: 13, fontWeight: "700" },
    headerActions: { alignItems: "center", flexDirection: "row", gap: 1, marginLeft: 6 },
    readOnlyBadge: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 4, borderWidth: 1, height: 24, justifyContent: "center", marginLeft: 1, width: 24 },
    readOnlyIcon: { color: theme.colors.foregroundMuted, fontSize: 8, fontWeight: "700" },
    tabsScroll: { flexGrow: 0, flexShrink: 0, height: 34 },
    tabs: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, minHeight: 34, paddingHorizontal: 10, gap: 4 },
    fileTab: { alignItems: "center", borderColor: "transparent", borderRadius: 6, borderWidth: 1, flexDirection: "row", maxWidth: 230 },
    fileTabActive: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
    fileTabButton: { alignItems: "center", flexDirection: "row", gap: 5, minWidth: 0, paddingHorizontal: 8, paddingVertical: 6 },
    fileTabStatus: { fontSize: 12, fontWeight: "800" },
    fileTabStale: { color: theme.colors.statusWarning, fontSize: 14, fontWeight: "800" },
    fileTabText: { color: theme.colors.foreground, fontSize: 12, maxWidth: 155 },
    closeTab: { paddingHorizontal: 7, paddingVertical: 6 },
    closeTabText: { color: theme.colors.foregroundMuted, fontSize: 15, lineHeight: 15 },
    body: { flex: 1, minHeight: 0 },
    fileHeader: { alignItems: "center", backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", paddingHorizontal: 12, paddingVertical: 7 },
    fileHeaderCopy: { flex: 1, minWidth: 0 },
    filePath: { color: theme.colors.foreground, fontSize: 12, fontWeight: "700" },
    metaText: { color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 2 },
    errorText: { color: theme.colors.statusDanger, fontSize: 11, paddingHorizontal: 12, paddingTop: 6 },
    staleText: { color: theme.colors.foregroundMuted, fontSize: 10, paddingHorizontal: 12, paddingTop: 5 },
    emptyState: { alignItems: "center", flex: 1, justifyContent: "center", padding: 12 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    emptyText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
    diffShell: { backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0 },
    diffToolbar: { alignItems: "center", backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 32, paddingHorizontal: 10 },
    diffToolbarCompact: { minHeight: 30, paddingHorizontal: 8 },
    diffRefGroup: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 8, minWidth: 0 },
    diffRefGroupCompact: { flex: 1, width: undefined },
    diffRefValue: { color: theme.colors.foreground, flexShrink: 1, fontSize: 11, fontWeight: "600", maxWidth: 180 },
    diffRefArrow: { color: theme.colors.foregroundMuted, fontSize: 12, marginHorizontal: 2 },
    diffToolbarActions: { alignItems: "center", flexDirection: "row", gap: 8, marginLeft: 8 },
    diffToolbarActionsCompact: { flexShrink: 0, justifyContent: "flex-end", marginLeft: 3, width: undefined },
    diffLegendAdded: { color: theme.colors.statusSuccess, fontSize: 11 },
    diffLegendModified: { color: accent, fontSize: 11 },
    diffLegendRemoved: { color: theme.colors.statusDanger, fontSize: 11 },
    hunkNavigator: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, flexDirection: "row", marginLeft: 4 },
    hunkButton: { alignItems: "center", height: 24, justifyContent: "center", width: 24 },
    hunkButtonText: { color: theme.colors.foreground, fontSize: 17, lineHeight: 18 },
    hunkCount: { color: theme.colors.foregroundMuted, fontSize: 11, minWidth: 38, textAlign: "center" },
    diffViewport: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    diffHorizontal: { flex: 1, minHeight: 0 },
    diffScrollContent: { flexGrow: 1, minHeight: "100%", minWidth: "100%", paddingRight: 14 },
    diffListViewport: { flex: 1, minHeight: 0 },
    diffListViewportSplit: { minWidth: 840 },
    diffListViewportUnified: { minWidth: 620 },
    diffList: { flex: 1, minHeight: 0, minWidth: "100%" },
    preludeBar: { backgroundColor: theme.colors.surface2, borderBottomColor: theme.colors.border, borderBottomWidth: 1, paddingHorizontal: 12, paddingVertical: 5 },
    preludeText: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    hunkRow: { alignItems: "center", backgroundColor: theme.colors.surface2, borderBottomColor: theme.colors.border, borderBottomWidth: 1, borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", height: DIFF_HUNK_ROW_HEIGHT, justifyContent: "space-between", paddingHorizontal: 10 },
    hunkRowActive: { backgroundColor: `${theme.colors.statusWarning}18`, borderLeftColor: theme.colors.statusWarning, borderLeftWidth: 2 },
    hunkText: { color: accent, flex: 1, fontFamily: "monospace", fontSize: 11 },
    warningText: { backgroundColor: theme.colors.surface2, color: theme.colors.statusWarning, fontSize: 11, paddingHorizontal: 12, paddingVertical: 6 },
    diffRow: { alignItems: "stretch", borderBottomColor: `${theme.colors.border}38`, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", height: DIFF_LINE_ROW_HEIGHT },
    splitRow: { alignItems: "stretch", borderBottomColor: `${theme.colors.border}38`, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", height: DIFF_LINE_ROW_HEIGHT },
    diffCell: { alignItems: "stretch", flexDirection: "row", minWidth: 419, paddingVertical: 0, width: "50%" },
    emptyDiffCell: { backgroundColor: theme.colors.surface2, minWidth: 419, width: "50%" },
    splitDivider: { backgroundColor: theme.colors.border, width: 1 },
    contextRow: { backgroundColor: theme.colors.surface0 },
    addedRow: { backgroundColor: `${theme.colors.statusSuccess}1f` },
    removedRow: { backgroundColor: `${theme.colors.statusDanger}1f` },
    changeGutter: { minHeight: "100%", width: 3 },
    contextGutter: { backgroundColor: "transparent" },
    addedGutter: { backgroundColor: theme.colors.statusSuccess },
    removedGutter: { backgroundColor: theme.colors.statusDanger },
    lineNumber: { backgroundColor: theme.colors.surface1, color: theme.colors.foregroundMuted, fontFamily: editorCodeFontFamily, fontSize: 11, minWidth: 42, paddingHorizontal: 5, textAlign: "right" },
    diffMarker: { backgroundColor: theme.colors.surface1, fontFamily: editorCodeFontFamily, fontSize: 12, textAlign: "center", width: 18 },
    contextMarker: { color: theme.colors.foregroundMuted },
    addedMarker: { color: theme.colors.statusSuccess, fontWeight: "700" },
    removedMarker: { color: theme.colors.statusDanger, fontWeight: "700" },
    codeText: { color: theme.colors.foreground, flexShrink: 0, fontFamily: editorCodeFontFamily, fontSize: 12, lineHeight: 20, paddingLeft: 8, paddingRight: 16 },
    codeSyntaxText: { color: theme.colors.foreground, flexShrink: 0, fontFamily: editorCodeFontFamily, fontSize: 12, lineHeight: 20 },
    overviewRail: { backgroundColor: theme.colors.surface2, borderLeftColor: theme.colors.border, borderLeftWidth: 1, position: "absolute", right: 0, top: 0, width: 14, zIndex: 5 },
    overviewSvg: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    overviewBackground: { left: 0, position: "absolute", top: 0, width: 12 },
    overviewMarker: { borderRadius: 1.5, left: 2, position: "absolute", width: 7 },
    overviewThumb: { backgroundColor: `${theme.colors.foregroundMuted}88`, borderRadius: 3, left: 9, position: "absolute", width: 3 },
    binaryState: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, margin: 20, padding: 16 },
    binaryTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
  });
}
