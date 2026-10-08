import {useDiffNotes,type DiffNotes} from './components/diff-notes';
import {DIFF_CHANGE_GUTTER_STYLE} from './diff-layout';
import {DiffToolbar} from './components/diff-toolbar';
import {useDiffReading,type DiffReading} from './use-diff-reading';
import type {ReactNode} from 'react';
import { comparisonKey } from '../shared/comparison';
import { useDisplaySettings } from './use-display-settings';
import { clientDiagnostic } from "../shared/client-diagnostics.ts";
import { createDiffReadClient, type DiffRpc } from "./diff-read-client.ts";
import { DIFF_READ_PROTOCOL, DIFF_READ_BUILD } from "../shared/diff-read.ts";
import { observationMeta } from "./observation-coordinator.ts";
import { observationQueryOptions } from './observation-content.ts';
import { useObservationVersions, observationRefreshDiagnostics } from "./use-observation-versions";
import { usePanelForeground } from "./foreground-activity";
import { useEffect, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginAgentPanelProps,
  type PluginWorkspacePanelProps,
  useRpc,
} from "@getpaseo/plugin/client";
import { FlatList, ScrollView } from "./native-components";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { copy, formatCopyFrom, type WorkbenchCopy } from "../shared/copy";
import { observerQuery, type ObserverResponse } from "../shared/observer";
import { projectBackendStatus } from "../shared/setup";
import {
  DEFAULT_OBSERVATION_TIMING,
  observationTimingFromWire,
} from "../shared/observation-timing";
import {
  DIFF_HUNK_ROW_HEIGHT,
  DIFF_LINE_ROW_HEIGHT,
  type DiffHunk,
  type DiffLine,
  type DiffDisplayRow,
  type DiffOverviewMarker,
  type DiffResult,
  isTransientIssueCode,
  issueDisplayLabel,
} from "./model";
import {
  openFileReview,
  closeFileReview,
  getFileReviewPosition,
  selectionKey,
  setActiveFileReview,
  type FileReviewSelection,
  useActiveFileReviewKey,
  useFileReviews,
} from "./file-review-store";
import { useLastSuccessfulResponse } from "./observation";
import { useReviewModePreference } from "./review-preferences";
import type { ReviewMode } from "./review-mode";
import { editorCodeFontFamily, HighlightedCode } from "./syntax";
import { Svg, Rect } from "./graph/svg-web";
import { observerAccent } from "./theme";
import { useWorkbenchCopy } from "./i18n";
import { reportNativeDiagnostic } from "./native-diagnostics";

type FilePanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
const MIN_SPLIT_PANEL_WIDTH = 900;

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

export function FileReviewPanel(props: FilePanelProps) {
  reportNativeDiagnostic("file-review-render", { entry: "FileReviewPanel" });
  const activity = usePanelForeground();
  const foreground = activity.foreground;
  const copy = useWorkbenchCopy();
  const hostWorkspaceId = props.workspaceId;
  const selections = useFileReviews(hostWorkspaceId);
  const { theme, layout } = props;
  const [panelWidth, setPanelWidth] = useState(0);
  const narrow = layout.compact || (panelWidth > 0 && panelWidth < MIN_SPLIT_PANEL_WIDTH);
  const display = useDisplaySettings();
  const styles = useMemo(() => makeStyles(theme, display.fontSize, display.wrap), [theme, display.fontSize, display.wrap]);
  const activeKey = useActiveFileReviewKey(hostWorkspaceId);
  const { mode, setMode } = useReviewModePreference(hostWorkspaceId, narrow);
  const activeSelection = selections.find((item) => selectionKey(item) === activeKey) || selections.at(-1);
  const rpc = useRpc(observerQuery);
  const sendDiagnostic = useRpc(clientDiagnostic);
  const queryClient = useQueryClient();
  // Native shares activation/retry decisions but keeps version polling disabled.
  const observationIssue = useObservationVersions(
    activeSelection?.projectConfig,
    activeSelection ? [activeSelection.workspaceId] : [],
    foreground,
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

  const reader = useRef(createDiffReadClient()).current;
  const readKey = activeSelection ? selectionKey(activeSelection) : '';
  const viewKey = JSON.stringify([hostWorkspaceId, readKey, mode]);
  const viewPosition = getFileReviewPosition(hostWorkspaceId, readKey, mode);
  const readRpcRef = useRef<DiffRpc>(async () => ({ ok: false }));
  const diffRpc: DiffRpc = (method, params) => rpc({ method, params, projectConfig: activeSelection?.projectConfig });
  readRpcRef.current = diffRpc;
  const capable = backendStatusQuery.data?.readCapabilities?.protocol === DIFF_READ_PROTOCOL;
  useEffect(() => {
    if (!readKey || !foreground) return;
    const call = readRpcRef.current;
    return () => reader.release(readKey, call);
  }, [readKey, foreground, reader]);
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
      comparisonKey(activeSelection?.comparison),
    ],
    queryFn: () => reader.read(readKey, {
      workspaceId: activeSelection?.workspaceId, repoPath: activeSelection?.repoPath,
      path: activeSelection?.path, oldPath: activeSelection?.oldPath,
      comparison: activeSelection?.comparison, scope: activeSelection?.scope, commitSha: activeSelection?.commitSha || undefined,
    }, diffRpc, capable),
    enabled: Boolean(activeSelection && foreground && backendStatusQuery.data),
    refetchInterval: false,
    ...observationQueryOptions,
  });
  const diffState = useLastSuccessfulResponse(
    `file-review:${hostWorkspaceId}:${activeSelection ? selectionKey(activeSelection) : ""}`,
    diffQuery.data,
    { error: diffQuery.error, staleAfterMs: observationTiming.staleWindowsMs.repository },
  );
  const durableFailure = diffQuery.data && !diffQuery.data.ok && ["file_not_changed", "path_invalid", "worktree_missing", "commit_missing", "base_missing"].includes(diffQuery.data.error?.code || "");
  const candidate = resultOf<DiffResult>(diffState.response);
  const diff = durableFailure || typeof candidate?.patch !== "string" ? null : candidate;
  const readTask = observationMeta(diffQuery.data).readTask;
  useEffect(() => {
    if (!readTask || !activeSelection?.projectConfig) return;
    void sendDiagnostic({ phase: 'file-read-pending', platform: Platform.OS, details: { foreground: String(foreground), coordinator: JSON.stringify(observationRefreshDiagnostics(queryClient, activeSelection.projectConfig)).slice(0, 4000) } }).catch(() => {});
  }, [readTask, foreground, activeSelection?.projectConfig, queryClient]);
  const trace = useRef({ key: '', id: '', at: 0, shown: false, active: false });
  if (trace.current.key !== readKey || foreground && !trace.current.active) trace.current = { key: readKey, id: `click:${Date.now()}:${Math.random().toString(36).slice(2)}`, at: Date.now(), shown: false, active: foreground };
  trace.current.active = foreground;
  useEffect(() => {
    if (!readKey || !foreground) return;
    void sendDiagnostic({ phase: 'file-read-click', platform: Platform.OS, details: { interactionId: trace.current.id, clientBuild: DIFF_READ_BUILD, protocol: String(capable ? DIFF_READ_PROTOCOL : 0) } }).catch(() => {});
  }, [readKey, foreground]);
  useEffect(() => {
    if (!foreground || !diff || trace.current.shown) return;
    trace.current.shown = true;
    const observation = (diff as unknown as { observation?: { requestId?: string } }).observation;
    void sendDiagnostic({ phase: 'file-read-visible', platform: Platform.OS, details: { interactionId: trace.current.id, requestId: observation?.requestId || '', elapsedMs: String(Date.now() - trace.current.at), clientBuild: DIFF_READ_BUILD } }).catch(() => {});
  }, [diff, readKey, foreground]);
  const notes=useDiffNotes(activeSelection,diff,foreground,theme,(anchor,note,data)=>{
    if(!activeSelection)return;
    const snapshot=data.snapshots[note.snapshotId];if(!snapshot)return;
    openFileReview({...activeSelection,path:anchor.path,oldPath:undefined,changeNoteId:note.id}, {hostWorkspaceId,panelId:'agentId' in props?'workspace-workbench-file-agent':'workspace-workbench-file',...('agentId' in props?{agentId:props.agentId}:{})});
  });
  const error = responseErrorLabel(diffQuery.data, diffQuery.error, Boolean(diff), copy);

  function close(selection: FileReviewSelection): void {
    closeFileReview(hostWorkspaceId, selectionKey(selection));
  }

  return (
    <View testID="workbench-diff-panel" ref={activity.ref} style={styles.screen} accessibilityLabel={copy.changesTitle} onLayout={(event) => setPanelWidth(event.nativeEvent.layout.width)}>
      <DiffReadingSurface path={activeSelection?.path||""} key={viewKey} diff={diff} mode={mode} wrap={display.wrap} fontSize={display.fontSize} position={viewPosition} foreground={foreground}
        renderToolbar={reading=><DiffToolbar extra={notes.toolbar} selections={selections} activeKey={readKey} onSelect={key=>setActiveFileReview(hostWorkspaceId,key)} onClose={close}
          selection={activeSelection} diff={diff} reading={reading} width={panelWidth} theme={theme} mode={mode} narrow={narrow} onMode={()=>setMode(mode==='split'?'unified':'split')}
          fontSize={display.fontSize} wrap={display.wrap} onDisplay={display.update} stale={diffState.stale}
          retry={diffQuery.data?.ok===false&&(diffQuery.data.error?.details as {terminal?:boolean})?.terminal?()=>{reader.retry(readKey);void diffQuery.refetch({cancelRefetch:false});}:undefined}/>}>
        {reading=>activeSelection?<View style={styles.body}>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {!capable && backendStatusQuery.data?.state === "ready" ? <Text style={styles.metaText}>{copy.diffCompatibility}</Text> : null}
          {readTask && !diff ? <Text style={styles.emptyText}>{readTask.state === 'queued' ? copy.diffQueued : copy.text_a74b5d91fa}</Text> : null}
          {error ? <Pressable accessibilityRole="button" onPress={() => { reader.retry(readKey); void diffQuery.refetch({ cancelRefetch: false }); }}><Text style={styles.metaText}>{copy.refreshNow}</Text></Pressable> : null}
          {diffQuery.isLoading ? <Text style={styles.emptyText}>{copy.text_a74b5d91fa}</Text> : null}
          {diff?<DiffViewer notes={notes} reading={reading} wrap={display.wrap} position={viewPosition} foreground={foreground} diff={diff} mode={mode} path={activeSelection.path} platform={layout.platform} theme={theme} styles={styles}/>:null}
        </View>:<View style={styles.emptyState}><Text style={styles.emptyTitle}>{copy.text_982b60ebcc}</Text><Text style={styles.emptyText}>{copy.text_5720774925}</Text></View>}
      </DiffReadingSurface>
      {notes.overlay}
    </View>
  );
}

function DiffReadingSurface({renderToolbar,children,...input}:Parameters<typeof useDiffReading>[0]&{renderToolbar(reading:DiffReading):ReactNode;children(reading:DiffReading):ReactNode}){
 const reading=useDiffReading(input);
 return <>{renderToolbar(reading)}{children(reading)}</>;
}

function DiffViewer({
  notes,
  reading,
  wrap,
  foreground,
  position,
  diff,
  mode,
  path,
  platform,
  theme,
  styles,
}: {
  notes:DiffNotes;
  reading:DiffReading;
  wrap: boolean;
  foreground: boolean;
  position: { offset: number; hunk: number };
  diff: DiffResult;
  mode: ReviewMode;
  path: string;
  platform: FilePanelProps["layout"]["platform"];
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  reportNativeDiagnostic("file-review-diff-render", { entry: "DiffViewer" });
  const copy = useWorkbenchCopy();
  const {nativeTokens,parsed,rows,setMeasured,width,setWidth,rowMetrics,overviewMarkers,listRef,horizontalRef,copyRoot,currentHunk,viewportHeight,scrollOffset,setScrollOffset,restoredPosition,initialOffset,contentHeight,setContentHeight,onListLayout,jumpToHunk,jumpToRow,onScrollToIndexFailed,onViewableItemsChanged,viewabilityConfig}=reading;

  const noteScroll=useRef({x:0,y:position.offset});
  const notesRef=useRef(notes);notesRef.current=notes;
  const noteViewable=useCallback((event:any)=>{onViewableItemsChanged(event);notesRef.current.onVisible();},[onViewableItemsChanged]);
  const notePlacements=useMemo(()=>notes.positions(rows),[rows,notes.positionsKey]);
  const jumpToNote=useCallback((index:number)=>{
    // Explicit note navigation supersedes a newly mounted tab's saved offset.
    position.offset=rowMetrics.offsets[index]||0;initialOffset.y=position.offset;restoredPosition.current=true;
    jumpToRow(index,false);
  },[jumpToRow,position,rowMetrics,restoredPosition,initialOffset]);
  useLayoutEffect(()=>{notes.bindReading(rows,notePlacements,jumpToNote);},[rows,notePlacements,jumpToNote]);
  if (diff.binary) {
    return (
      <View style={styles.binaryState}>
        {diff.truncated?<Text style={styles.warningText}>{copy.text_1d3d755616}</Text>:null}
        <Text style={styles.binaryTitle}>{copy.text_a1a0e61a02}</Text>
        <Text style={styles.emptyText}>{copy.text_8476fa5fe9}</Text>
      </View>
    );
  }
  if (!parsed.hunks.length) {
    return (
      <View style={styles.binaryState}>
        {diff.truncated?<Text style={styles.warningText}>{copy.text_1d3d755616}</Text>:null}
        <Text style={styles.binaryTitle}>{copy.text_fd707df26d}</Text>
        <Text style={styles.emptyText}>{copy.text_81f977c1ab}</Text>
      </View>
    );
  }
  return (
    <View ref={copyRoot} style={styles.diffShell}>
      {diff.truncated ? <Text style={styles.warningText}>{copy.text_1d3d755616}</Text> : null}
      <View style={styles.diffViewport} onLayout={event=>setWidth(event.nativeEvent.layout.width)}>
        <ScrollView
          ref={horizontalRef}
          testID="diff-horizontal-scroll"
          horizontal
          onScroll={event=>{const x=Number(event.nativeEvent.contentOffset.x)||0;if(x!==noteScroll.current.x){noteScroll.current.x=x;notes.onScroll();}}}
          scrollEventThrottle={16}
          scrollEnabled={!wrap}
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.diffScrollContent}
          style={styles.diffHorizontal}
        >
          <View style={[styles.diffListViewport, mode === "split" ? styles.diffListViewportSplit : styles.diffListViewportUnified, wrap && {width:Math.max(0,width-14),minWidth:0}]}>
            <FlatList
              testID="workbench-diff-lines"
              ref={listRef}
              data={rows}
              getItemLayout={wrap ? undefined : (_, index) => ({
                index,
                length: rowMetrics.lengths[index] || DIFF_LINE_ROW_HEIGHT,
                offset: rowMetrics.offsets[index] || 0,
              })}
              initialNumToRender={100}
              contentOffset={initialOffset}
              keyExtractor={(item: DiffDisplayRow) => item.key}
              onLayout={onListLayout}
              onContentSizeChange={(_, height) => setContentHeight(height)}
              onScroll={(event: any) => {
                const offset = Number(event.nativeEvent?.contentOffset?.y) || 0;
                if(offset!==noteScroll.current.y){noteScroll.current.y=offset;notes.onScroll();}
                if (restoredPosition.current && foreground && event.nativeEvent?.layoutMeasurement?.height !== 0) { position.offset = offset; setScrollOffset(offset); }
              }}
              onScrollToIndexFailed={onScrollToIndexFailed}
              onViewableItemsChanged={noteViewable as any}
              renderItem={({ item,index }: { item: DiffDisplayRow;index:number }) => <View onLayout={event=>{if(wrap){const h=event.nativeEvent.layout.height;if(!Number.isFinite(h)||h<=0)return;setMeasured(current=>current[item.key]===h?current:{...current,[item.key]:h});}}}>
                {item.kind === "hunk" ? (
                  <HunkRow
                    active={item.hunkIndex === currentHunk}
                    hunk={item.hunk}
                    onPress={() => jumpToHunk(item.hunkIndex)}
                    styles={styles}
                  />
                ) : item.kind === "split" ? (
                  <SplitRow nativeTokens={nativeTokens} left={item.left} right={item.right} path={path} theme={theme} styles={styles} />
                ) : (
                  <UnifiedRow nativeTokens={nativeTokens} line={item.line} path={path} theme={theme} styles={styles} />
                )
              }{notes.renderRow(item,index,notePlacements)}</View>}
              removeClippedSubviews={!wrap}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.diffList}
              viewabilityConfig={viewabilityConfig}
              windowSize={11}
            />
          </View>
        </ScrollView>
        <OverviewRail
          contentHeight={rowMetrics.contentHeight}
          currentHunk={currentHunk}
          markers={overviewMarkers}
          onSelectRow={jumpToRow}
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
  onSelectRow,
  scrollOffset,
  platform,
  theme,
  height,
  styles,
}: {
  contentHeight: number;
  currentHunk: number;
  markers: DiffOverviewMarker[];
  onSelectRow: (index: number) => void;
  scrollOffset: number;
  platform: FilePanelProps["layout"]["platform"];
  theme: FilePanelProps["theme"];
  height: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return platform === "web"
    ? <OverviewRailWeb contentHeight={contentHeight} currentHunk={currentHunk} markers={markers} onSelectRow={onSelectRow} scrollOffset={scrollOffset} theme={theme} height={height} styles={styles} />
    : <OverviewRailNative contentHeight={contentHeight} currentHunk={currentHunk} markers={markers} onSelectRow={onSelectRow} scrollOffset={scrollOffset} theme={theme} height={height} styles={styles} />;
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
  if (marker.kind === "added") return theme.colors.statusSuccess;
  if (marker.kind === "removed") return theme.colors.statusDanger;
  return observerAccent(theme);
}

function OverviewRailNative({
  contentHeight,
  currentHunk,
  markers,
  onSelectRow,
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
            testID={`diff-overview-marker-${index}`}
            accessibilityLabel={`${copy.diffOverview}: ${marker.startLine}–${marker.endLine}`}
            accessibilityRole="button"
            onPress={() => onSelectRow(marker.startRow)}
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
  onSelectRow,
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
            data-testid={`diff-overview-marker-${index}`}
              role="button"
              aria-label={`${copy.diffOverview}: ${marker.startLine}–${marker.endLine}`}
              data-start-row={marker.startRow}
              fill={overviewMarkerColor(marker, currentHunk, theme)}
              height={frame.height}
              onPress={() => onSelectRow(marker.startRow)}
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
  nativeTokens,
  line,
  path,
  theme,
  styles,
}: {
  nativeTokens:DiffReading["nativeTokens"];
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
      <Text selectable testID="diff-code-unified" style={styles.codeText}>
        {Platform.OS!=='web'?<HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} spans={nativeTokens(line.content)} inlineChange={line.inlineChange} changeBackground={line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`}/>:line.inlineChange ? <>{line.inlineChange[0]>0?<HighlightedCode code={line.content.slice(0,line.inlineChange[0])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}<Text style={[styles.codeSyntaxText,{backgroundColor:line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`} ]}>{line.content.slice(...line.inlineChange)}</Text>{line.inlineChange[1]<line.content.length?<HighlightedCode code={line.content.slice(line.inlineChange[1])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}</> : <HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} />}
      </Text>
    </View>
  );
}

function SplitRow({
  nativeTokens,
  left,
  right,
  path,
  theme,
  styles,
}: {
  nativeTokens:DiffReading["nativeTokens"];
  left: DiffLine | null;
  right: DiffLine | null;
  path: string;
  theme: FilePanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.splitRow}>
      <DiffCell nativeTokens={nativeTokens} line={left} path={path} theme={theme} styles={styles} side="left" />
      <View style={styles.splitDivider} />
      <DiffCell nativeTokens={nativeTokens} line={right} path={path} theme={theme} styles={styles} side="right" />
    </View>
  );
}

function DiffCell({
  nativeTokens,
  line,
  path,
  theme,
  styles,
  side,
}: {
  nativeTokens:DiffReading["nativeTokens"];
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
      <Text selectable testID={`diff-code-${side}`} style={styles.codeText}>
        {Platform.OS!=='web'?<HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} spans={nativeTokens(line.content)} inlineChange={line.inlineChange} changeBackground={line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`}/>:line.inlineChange ? <>{line.inlineChange[0]>0?<HighlightedCode code={line.content.slice(0,line.inlineChange[0])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}<Text style={[styles.codeSyntaxText,{backgroundColor:line.kind==='added'?`${theme.colors.statusSuccess}38`:`${theme.colors.statusDanger}38`} ]}>{line.content.slice(...line.inlineChange)}</Text>{line.inlineChange[1]<line.content.length?<HighlightedCode code={line.content.slice(line.inlineChange[1])} path={path} theme={theme} style={styles.codeSyntaxText}/>:null}</> : <HighlightedCode code={line.content} path={path} theme={theme} style={styles.codeSyntaxText} />}
      </Text>
    </View>
  );
}

function makeStyles(theme: FilePanelProps["theme"], fontSize=14, wrap=false) {
  const accent = observerAccent(theme);
  return StyleSheet.create({
    screen: { backgroundColor: theme.colors.surface0, flex: 1 },
    body: { flex: 1, minHeight: 0 },
    metaText: { color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 2 },
    errorText: { color: theme.colors.statusDanger, fontSize: 11, paddingHorizontal: 12, paddingTop: 6 },
    emptyState: { alignItems: "center", flex: 1, justifyContent: "center", padding: 12 },
    emptyTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    emptyText: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
    diffShell: { backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0 },
    diffViewport: { flex: 1, minHeight: 0, overflow: "hidden", position: "relative" },
    diffHorizontal: { flex: 1, minHeight: 0 },
    diffScrollContent: { flexGrow: 1, minHeight: "100%", minWidth: "100%", paddingRight: 14 },
    diffListViewport: { flex: 1, minHeight: 0 },
    diffListViewportSplit: { minWidth: 840 },
    diffListViewportUnified: { minWidth: 620 },
    diffList: { flex: 1, minHeight: 0, minWidth: "100%" },
    hunkRow: { alignItems: "center", backgroundColor: theme.colors.surface2, borderBottomColor: theme.colors.border, borderBottomWidth: 1, borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", height: DIFF_HUNK_ROW_HEIGHT, justifyContent: "space-between", paddingHorizontal: 10 },
    hunkRowActive: { backgroundColor: `${theme.colors.statusWarning}18`, borderLeftColor: theme.colors.statusWarning, borderLeftWidth: 2 },
    hunkText: { color: accent, flex: 1, fontFamily: "monospace", fontSize: 11 },
    warningText: { backgroundColor: theme.colors.surface2, color: theme.colors.statusWarning, fontSize: 11, paddingHorizontal: 12, paddingVertical: 6 },
    diffRow: { alignItems: "stretch", borderBottomColor: `${theme.colors.border}38`, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", minHeight: fontSize+8, ...(wrap?{}:{height:fontSize+8}) },
    splitRow: { alignItems: "stretch", borderBottomColor: `${theme.colors.border}38`, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", minHeight: fontSize+8, ...(wrap?{}:{height:fontSize+8}) },
    diffCell: { alignItems: "stretch", flexDirection: "row", minWidth: wrap ? 0 : 419, paddingVertical: 0, width: "50%" },
    emptyDiffCell: { backgroundColor: theme.colors.surface2, minWidth: wrap ? 0 : 419, width: "50%" },
    splitDivider: { backgroundColor: theme.colors.border, width: 1 },
    contextRow: { backgroundColor: theme.colors.surface0 },
    addedRow: { backgroundColor: `${theme.colors.statusSuccess}1f` },
    removedRow: { backgroundColor: `${theme.colors.statusDanger}1f` },
    changeGutter: DIFF_CHANGE_GUTTER_STYLE,
    contextGutter: { backgroundColor: "transparent" },
    addedGutter: { backgroundColor: theme.colors.statusSuccess },
    removedGutter: { backgroundColor: theme.colors.statusDanger },
    lineNumber: { backgroundColor: theme.colors.surface1, color: theme.colors.foregroundMuted, fontFamily: editorCodeFontFamily, fontSize: fontSize-1, lineHeight:fontSize+8, userSelect:"none", minWidth: 42, paddingHorizontal: 5, textAlign: "right" },
    diffMarker: { backgroundColor: theme.colors.surface1, fontFamily: editorCodeFontFamily, fontSize, lineHeight:fontSize+8, userSelect:"none", textAlign: "center", width: 18 },
    contextMarker: { color: theme.colors.foregroundMuted },
    addedMarker: { color: theme.colors.statusSuccess, fontWeight: "700" },
    removedMarker: { color: theme.colors.statusDanger, fontWeight: "700" },
    codeText: { color: theme.colors.foreground, flexShrink: wrap ? 1 : 0, ...(wrap?{flex:1}:{}), fontFamily: editorCodeFontFamily, fontSize, lineHeight: fontSize+8, ...(Platform.OS === "web" ? {whiteSpace:wrap?"pre-wrap":"pre",overflowWrap:"anywhere",tabSize:4} as any : {}), paddingLeft: 8, paddingRight: 16 },
    codeSyntaxText: { color: theme.colors.foreground, flexShrink: wrap ? 1 : 0, ...(wrap?{flex:1}:{}), fontFamily: editorCodeFontFamily, fontSize, lineHeight: fontSize+8, ...(Platform.OS === "web" ? {whiteSpace:wrap?"pre-wrap":"pre",overflowWrap:"anywhere",tabSize:4} as any : {}) },
    overviewRail: { backgroundColor: theme.colors.surface2, borderLeftColor: theme.colors.border, borderLeftWidth: 1, position: "absolute", right: 0, top: 0, width: 14, zIndex: 5 },
    overviewSvg: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
    overviewBackground: { left: 0, position: "absolute", top: 0, width: 12 },
    overviewMarker: { borderRadius: 1.5, left: 2, position: "absolute", width: 7 },
    overviewThumb: { backgroundColor: `${theme.colors.foregroundMuted}88`, borderRadius: 3, left: 9, position: "absolute", width: 3 },
    binaryState: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, margin: 20, padding: 16 },
    binaryTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
  });
}
