import {fileReviewQueryKey,fileReviewParams} from './file-review-query';
import {ComparisonReviewPanel} from './comparison-review';
import {HunkRow,OverviewRail,UnifiedRow,SplitRow,makeStyles} from './components/diff-rendering';
import {useDiffNotes,type DiffNotes} from './components/diff-notes';
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
import { Platform, Pressable, Text, View } from "react-native";

import { copy, formatCopyFrom, type WorkbenchCopy } from "../shared/copy";
import { observerQuery, type ObserverResponse } from "../shared/observer";
import { projectBackendStatus } from "../shared/setup";
import {
  DEFAULT_OBSERVATION_TIMING,
  observationTimingFromWire,
} from "../shared/observation-timing";
import {
  DIFF_LINE_ROW_HEIGHT,
  type DiffDisplayRow,
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

export function FileReviewPanel(props:FilePanelProps){
 const selections=useFileReviews(props.workspaceId),key=useActiveFileReviewKey(props.workspaceId);
 const active=selections.find(s=>selectionKey(s)===key)||selections.at(-1);
 return active?.kind==='comparison'?<ComparisonReviewPanel key={selectionKey(active)} {...props} selection={active}/>:<SingleFileReviewPanel {...props}/>;
}
function SingleFileReviewPanel(props: FilePanelProps) {
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
    queryKey: activeSelection?fileReviewQueryKey(activeSelection,hostWorkspaceId):['file-review-empty'],
    queryFn: () => reader.read(readKey, fileReviewParams(activeSelection!), diffRpc, capable),
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
    openFileReview({...activeSelection,scope:snapshot.scope as FileReviewSelection['scope'],comparison:snapshot.scope==='compare'?snapshot.comparison as FileReviewSelection['comparison']:undefined,commitSha:snapshot.scope==='commit'?snapshot.right||undefined:undefined,baseSha:snapshot.left||undefined,head:snapshot.right||undefined,path:anchor.path,oldPath:snapshot.files.find(f=>f.path===anchor.path)?.oldPath,changeNoteId:note.id}, {hostWorkspaceId,panelId:'agentId' in props?'workspace-workbench-file-agent':'workspace-workbench-file',...('agentId' in props?{agentId:props.agentId}:{})});
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
