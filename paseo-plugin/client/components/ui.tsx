import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { Icon,ScrollView } from "@getpaseo/plugin/client/react-native";
import { createContext,useContext,useEffect,useMemo,useRef,useState,type ReactNode } from "react";
import { ActivityIndicator,PanResponder,Platform,Pressable,StyleSheet,Text,View,type ViewStyle,type ScrollViewProps } from "react-native";
import { copy, formatCopyFrom, type WorkbenchCopy } from "../../shared/copy";

import { type ObserverResponse } from "../../shared/observer";
import { GRAPH_ROW_HEIGHT } from "../graph/constants";
import {
MIN_SECTION_HEIGHT,
clampSectionHeight,
formatChangeCount,
isTransientIssueCode,
issueDisplayLabel,
mergePartialDetail,
sectionAutoMaxHeight,
type DetailResult,
type Issue,
type ObserverSectionId,
type RepositorySummary,
type SectionLayoutPreference,
type WorkspaceSummary
} from "../model";
import { observerAccent } from "../theme";
import { useWorkbenchCopy } from "../i18n";

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
export const stableScrollbarStyle = Platform.OS === "web" ? { scrollbarGutter: "stable" } as unknown as ViewStyle : null;
export function resultOf<T>(response: ObserverResponse | undefined): T | null {
  if (!response?.ok) return null;
  return response.result as T;
}

export function queryErrorMessage(error: unknown, strings: WorkbenchCopy = copy): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : strings.text_fb36ad230f;
}

export function responseErrorCode(response: ObserverResponse | undefined): string | null {
  return response && !response.ok ? response.error?.code || null : null;
}

export function isRecoverableObserverFailure(response: ObserverResponse | undefined, error: unknown): boolean {
  const code = responseErrorCode(response);
  if (code) {
    return isTransientIssueCode(code)
      && code !== "observer_unavailable"
      && code !== "observer_connection_refused";
  }
  return Boolean(error);
}

export function mergeDetailResponse(previous: ObserverResponse, next: ObserverResponse): ObserverResponse {
  const previousResult = resultOf<DetailResult>(previous);
  const nextResult = resultOf<DetailResult>(next);
  if (!previousResult || !nextResult) return previous;
  return { ...next, result: mergePartialDetail(previousResult, nextResult) };
}

export function workspaceIdFromProps(props: PanelProps): string {
  return typeof props.workspaceId === "string" ? props.workspaceId : "";
}

export function statusColor(status: string, theme: PanelProps["theme"]): string {
  if (["approved", "completed"].includes(status)) {
    return theme.colors.statusSuccess;
  }
  if (["reviewing", "queued", "fixing"].includes(status)) {
    return observerAccent(theme);
  }
  if (["ready_for_review", "changes_requested", "stopping", "limit_reached"].includes(status)) {
    return theme.colors.statusWarning;
  }
  if (["blocked", "failed"].includes(status)) {
    return theme.colors.statusDanger;
  }
  if (["waiting_execution", "stopped"].includes(status)) {
    return theme.colors.foregroundMuted;
  }
  if (["dirty", "needs-review", "diverged", "modified", "stale"].includes(status)) {
    return theme.colors.statusWarning;
  }
  if (["missing", "error", "unknown", "invalid", "record_invalid", "create_failed"].includes(status)) {
    return theme.colors.statusDanger;
  }
  if (["already-contained", "fast-forward-candidate", "clean"].includes(status)) {
    return theme.colors.statusSuccess;
  }
  return observerAccent(theme);
}

export function fileColor(status: string, theme: PanelProps["theme"]): string {
  if (status === "A") return theme.colors.statusSuccess;
  if (status === "D") return theme.colors.statusDanger;
  if (status === "R") return observerAccent(theme);
  return theme.colors.statusWarning;
}

export function relationLabel(relation: string, strings: WorkbenchCopy = copy): string {
  const labels: Record<string, string> = {
    "fast-forward-candidate": strings.text_f7e720248d,
    "already-contained": strings.text_ee5b0077ae,
    diverged: strings.text_da56864458,
    unknown: strings.text_27b5842c97,
  };
  return labels[relation] || relation;
}

export function workspaceClaim(workspace: WorkspaceSummary): string {
  if (workspace.claim?.agent) return `claim agent:${workspace.claim.agent}`;
  if (workspace.claim?.owner) return `claim ${workspace.claim.owner}`;
  if (workspace.claim?.label) return `claim ${workspace.claim.label}`;
  return "";
}

export function isMainWorkspace(workspace: WorkspaceSummary | undefined): boolean {
  return Boolean(workspace && (workspace.kind === "live" || workspace.managed === false));
}

export function workspaceDisplayName(workspace: WorkspaceSummary | undefined, strings: WorkbenchCopy = copy): string {
  if (!workspace) return strings.text_c7ae08f54c;
  return workspace.displayName || workspace.id;
}

export function workspaceSignals(workspace: WorkspaceSummary, strings: WorkbenchCopy = copy): string[] {
  const signals: string[] = [];
  if ((workspace.dirtyRepositoryCount || 0) > 0) signals.push(`${workspace.dirtyRepositoryCount} ${strings.workspaceStatusDirty}`);
  if (workspace.unpushed) signals.push(strings.workspaceStatusUnpushed);
  if (workspace.blockerCount > 0) signals.push(strings.workspaceStatusNeedsReview);
  if (workspace.toolchain?.status && workspace.toolchain.status !== "ready") {
    signals.push(`toolchain ${workspace.toolchain.status}`);
  }
  return signals;
}

export function workspaceMeta(workspace: WorkspaceSummary, strings: WorkbenchCopy = copy): string {
  const parts: string[] = [];
  if (isMainWorkspace(workspace)) return workspaceSignals(workspace, strings).join(" · ");
  if (workspace.state && workspace.state !== "active") parts.push(workspace.state);
  if (workspace.repositoryCount > 1) parts.push(formatCopyFrom(strings, "repoCountLabel", [workspace.repositoryCount]));
  parts.push(...workspaceSignals(workspace, strings));
  const claim = workspaceClaim(workspace);
  if (claim) parts.push(claim);
  return parts.join(" · ");
}

export function repositoryBranchLabel(repository: Pick<RepositorySummary, "branch" | "status" | "issues">, strings: WorkbenchCopy = copy): string {
  if (repository.status === "missing" || repository.issues.some((issue) => issue.code === "worktree_missing")) {
    return strings.branchMissing;
  }
  const branch = repository.branch;
  const parts = branch.split("/").filter(Boolean);
  if (parts.length <= 3) return branch || strings.branchDetached;
  return `${parts.slice(0, 2).join("/")}/…/${parts.at(-1)}`;
}

export function repositoryCountLabel(count: number, strings: WorkbenchCopy = copy): string {
  return formatCopyFrom(strings, "repoCountLabel", [count]);
}

export function fileCountLabel(count: number, strings: WorkbenchCopy = copy): string {
  return formatCopyFrom(strings, "fileCountLabel", [count]);
}

export function issueLabel(issue: Issue, strings: WorkbenchCopy = copy): string {
  return issueDisplayLabel(issue.code, strings);
}

export function issueDetail(issue: Issue): string {
  return `${issue.message}${issue.path ? ` · ${issue.path}` : ""}`;
}

export function visibleIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (isTransientIssueCode(issue.code) || issue.code === "workspace_dirty" || issue.code === "unpushed") return false;
    const key = `${issue.code}:${issue.path || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function queryFailureForDisplay(
  snapshot: { response: ObserverResponse | undefined; failed: boolean },
  response: ObserverResponse | undefined,
  error: unknown,
  strings: WorkbenchCopy = copy,
): string | null {
  if (response && !response.ok) {
    const code = response.error?.code || "";
    if (snapshot.response && isTransientIssueCode(code)) return null;
    if (isTransientIssueCode(code)
      && code !== "observer_unavailable"
      && code !== "observer_connection_refused") {
      return snapshot.response ? null : strings.text_f496a15d9d;
    }
    return response.error?.message || issueDisplayLabel(code, strings);
  }
  if (response?.ok && response.result && typeof response.result === "object") {
    const observation = (response.result as { observation?: { cacheState?: unknown } }).observation;
    if (typeof observation?.cacheState === "string") return null;
  }
  if (snapshot.response) return null;
  if (error) return strings.text_b30f770e31;
  return snapshot.failed ? strings.text_b71f1b83e5 : null;
}

export function LayoutMenuItem({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.layoutMenuItem}>
      <Text style={styles.layoutMenuItemText}>{label}</Text>
    </Pressable>
  );
}

export function InlineRefresh({
  visible,
  theme,
  styles,
}: {
  visible: boolean;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  if (!visible) return null;
  return <ActivityIndicator accessibilityLabel={copy.text_21eaf73725} color={observerAccent(theme)} size="small" style={styles.inlineRefresh} />;
}

export function SectionDisclosureButton({
  expanded,
  label,
  onLongPress,
  onPress,
  theme,
  styles,
}: {
  expanded: boolean;
  label: string;
  onLongPress: () => void;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onLongPress={onLongPress}
      onPress={onPress}
      style={styles.sectionDisclosureButton}
    >
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={observerAccent(theme)} />
      <Text numberOfLines={1} style={styles.sectionTitle}>{label}</Text>
    </Pressable>
  );
}

export const SectionAllocationContext = createContext<{
  sizes: Record<ObserverSectionId, number>; outerScroll: boolean;
  dragging: boolean;
  begin(id: ObserverSectionId): boolean;
  move(dy: number): void;
  finish(dy: number): void;
  cancel(): void;
  measureChrome?(height: number): void;
  measureContent?(id: ObserverSectionId, height: number): void;
} | null>(null);

export function SectionViewport({
  onScroll,
  id,
  layout,
  availableHeight,
  resizable = true,
  onDragStateChange,
  onHeightCommit,
  theme,
  styles,
  children,
}: {
  onScroll?: ScrollViewProps["onScroll"];
  id: ObserverSectionId;
  layout: SectionLayoutPreference;
  availableHeight: number;
  resizable?: boolean;
  onDragStateChange?: (dragging: boolean) => void;
  onHeightCommit: (height: number | null) => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
  children: ReactNode;
}) {
  const copy = useWorkbenchCopy();
  const allocation = useContext(SectionAllocationContext);
  const [contentHeight, setContentHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const latest = useRef(allocation);
  latest.current = allocation;
  const active = useRef(false);
  const responder = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (!responder.current) responder.current = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { active.current = latest.current?.begin(id) || false; },
    onPanResponderMove: (_, gesture) => { if (active.current) latest.current?.move(gesture.dy); },
    onPanResponderRelease: (_, gesture) => { if (active.current) latest.current?.finish(gesture.dy); active.current = false; },
    onPanResponderTerminate: () => { if (active.current) latest.current?.cancel(); active.current = false; },
  });
  useEffect(() => () => { if (active.current) latest.current?.cancel(); }, []);
  const dragging = Boolean(allocation?.dragging);
  const viewportStyle = { maxHeight: sectionAutoMaxHeight(id, availableHeight, id === "changes"), minHeight: MIN_SECTION_HEIGHT };
  const boundedStyle = allocation ? allocation.outerScroll ? { maxHeight: undefined, minHeight: 0 } : { height: allocation.sizes[id], minHeight: 0, maxHeight: allocation.sizes[id] } : viewportStyle;
  return (
    <View style={[styles.sectionViewportFrame, !resizable && { minHeight: MIN_SECTION_HEIGHT }]}>
      <ScrollView
        onScroll={onScroll}
        scrollEventThrottle={32}
        nestedScrollEnabled
        scrollEnabled={!dragging && !allocation?.outerScroll}
        onContentSizeChange={(_, height) => { setContentHeight(height); allocation?.measureContent?.(id, height + (resizable ? 6 : 0)); }}
        onLayout={(event) => {
          const height = event.nativeEvent.layout.height;
          setViewportHeight(height);
        }}
        contentContainerStyle={[styles.sectionViewportContent, !resizable && styles.sectionViewportContentNoResize]}
        showsVerticalScrollIndicator={contentHeight > viewportHeight + 1}
        style={[styles.sectionViewport, boundedStyle, stableScrollbarStyle]}
      >
        {children}
      </ScrollView>
      {resizable && !allocation?.outerScroll ? (
        <View
          {...responder.current.panHandlers}
          accessibilityLabel={formatCopyFrom(copy, "text_39e5b16a6b", [id])}
          accessibilityRole="button"
          hitSlop={{ bottom: 10, top: 10 }}
          style={[styles.sectionResizeHandle, verticalResizeCursorStyle]}
        >
          <View style={styles.sectionResizeGrip}>
            <Icon
              name="ChevronsUpDown"
              size={10}
              color={dragging ? observerAccent(theme) : theme.colors.foregroundMuted}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function ChangeCounts({
  additions,
  deletions,
  fileCount,
  prefix,
  styles,
}: {
  additions: number | null | undefined;
  deletions: number | null | undefined;
  fileCount?: number;
  prefix?: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  if (fileCount === 0) return null;
  const showCounts = fileCount === undefined || typeof additions === "number" || typeof deletions === "number";
  return (
    <Text style={styles.changeCounts}>
      {prefix ? <Text style={styles.changePrefix}>{prefix} </Text> : null}
      {showCounts ? (
        <>
          <Text style={styles.additionCount}>+{formatChangeCount(additions)}</Text>
          <Text style={styles.changeSeparator}> </Text>
          <Text style={styles.deletionCount}>−{formatChangeCount(deletions)}</Text>
        </>
      ) : (
        <Text style={styles.changePrefix}>{fileCountLabel(fileCount || 0, copy)}</Text>
      )}
    </Text>
  );
}

export function TabButton({ active, label, onPress, theme, styles }: { active: boolean; label: string; onPress: () => void; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles> }) {
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={onPress} style={[styles.tabButton, active && styles.tabButtonActive]}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function MiniTag({ label, color, styles }: { label: string; color: string; styles: ReturnType<typeof makeStyles> }) {
  return <View style={[styles.miniTag, { borderColor: color }]}><Text style={[styles.miniTagText, { color }]}>{label}</Text></View>;
}

export function SmallToggle({ label, active, onPress, theme, styles }: { label: string; active: boolean; onPress: () => void; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles> }) {
  const accent = observerAccent(theme);
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={[styles.smallToggle, active && { backgroundColor: accent, borderColor: accent }]}><Text style={[styles.smallToggleText, active && { color: theme.colors.accentForeground }]}>{label}</Text></Pressable>;
}

export function ScopeButton({ label, active, onPress, styles }: { label: string; active: boolean; onPress: () => void; styles: ReturnType<typeof makeStyles> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={[styles.scopeButton, active && styles.scopeButtonActive]}>
      <Text style={[styles.scopeButtonText, active && styles.scopeButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function StatusPill({ status, label, theme, styles }: { status: string; label?: string; theme: PanelProps["theme"]; styles: ReturnType<typeof makeStyles> }) {
  const color = statusColor(status, theme);
  return <View style={[styles.statusPill, { borderColor: color }]}><Text style={[styles.statusPillText, { color }]}>{label || status}</Text></View>;
}

export function makeStyles(theme: PanelProps["theme"], compact: boolean) {
  const accent = observerAccent(theme);
  return StyleSheet.create({
    screen: { backgroundColor: theme.colors.surface0, flex: 1 },
    panelHeader: { alignItems: "center", backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 58, paddingHorizontal: compact ? 13 : 15 },
    panelHeaderActions: { alignItems: "center", flexDirection: "row", gap: 5 },
    panelTitleGroup: { alignItems: "center", flexDirection: "row", gap: 8, minWidth: 0 },
    pluginIcon: { alignItems: "center", backgroundColor: theme.colors.surface2, borderRadius: 6, height: 22, justifyContent: "center", width: 22 },
    panelTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "500" },
    readOnlyText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "500" },
    layoutMenuButton: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, height: 26, justifyContent: "center", width: 28 },
    layoutMenuButtonText: { color: theme.colors.foregroundMuted, fontSize: 18, lineHeight: 18, marginTop: -4 },
    layoutMenuContent: { gap: 6, padding: 2 },
    layoutMenuHint: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15, marginBottom: 3 },
    layoutMenuItem: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, minHeight: 36, justifyContent: "center", paddingHorizontal: 10 },
    layoutMenuItemText: { color: theme.colors.foreground, fontSize: 12 },
    layoutMenuCancel: { alignItems: "center", minHeight: 30, justifyContent: "center", marginTop: 2 },
    layoutMenuCancelText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    selector: { backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, paddingHorizontal: compact ? 13 : 15, paddingVertical: 6 },
    selectorButton: { alignItems: "center", flexDirection: "row", gap: 8 },
    selectorCopy: { flex: 1, minWidth: 0 },
    selectorValueRow: { alignItems: "center", flexDirection: "row", gap: 6 },
    selectorValue: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 12 },
    selectorMeta: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 4 },
    selectorFailure: { color: theme.colors.statusWarning, fontSize: 10, lineHeight: 14, marginTop: 4 },
    selectorChevron: { alignItems: "center", height: 20, justifyContent: "center", width: 20 },
    selectorExpanded: { marginTop: 10 },
    filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
    filterButton: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, flexDirection: "row", gap: 4, paddingHorizontal: 7, paddingVertical: 4 },
    filterButtonActive: { backgroundColor: accent, borderColor: accent },
    filterButtonText: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "500" },
    filterButtonTextActive: { color: theme.colors.accentForeground },
    filterCount: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    filterCountActive: { color: theme.colors.accentForeground },
    selectorListHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginTop: 11, paddingBottom: 4 },
    selectorListLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "500" },
    selectorListCount: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    workspaceOptionList: { flexGrow: 0, flexShrink: 1, maxHeight: 320, minHeight: 0 },
    workspaceOption: { alignItems: "center", borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", gap: 7, minHeight: 42, paddingVertical: 6 },
    workspaceOptionActive: { backgroundColor: theme.colors.surface2, borderLeftColor: accent, borderLeftWidth: 2, marginHorizontal: -5, paddingHorizontal: 5 },
    workspaceStatusDot: { borderRadius: 4, height: 7, width: 7 },
    workspaceOptionCopy: { flex: 1, minWidth: 0 },
    workspaceOptionTitle: { color: theme.colors.foreground, fontSize: 11, fontWeight: "500" },
    workspaceOptionMeta: { color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 2 },
    workspaceOptionState: { fontFamily: "monospace", fontSize: 10 },
    tabsScroll: { flexGrow: 0, flexShrink: 0 },
    tabs: { backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", flexGrow: 0, flexShrink: 0, paddingHorizontal: compact ? 13 : 15 },
    tabButton: { borderBottomColor: "transparent", borderBottomWidth: 2, flexShrink: 0, marginRight: compact ? 14 : 22, paddingBottom: 8, paddingTop: 9 },
    tabButtonActive: { borderBottomColor: accent },
    tabText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" },
    tabTextActive: { color: theme.colors.foreground, fontWeight: "700" },
    bodyShell: { backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0, position: "relative" },
    body: { backgroundColor: theme.colors.surface0, flex: 1 },
    bodyContent: { gap: 10, paddingHorizontal: compact ? 13 : 15, paddingVertical: 10, paddingBottom: 14 },
    warningCard: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.statusWarning, borderRadius: 7, borderWidth: 1, padding: 9 },
    warningTitle: { color: theme.colors.statusWarning, fontSize: 12, fontWeight: "700" },
    warningText: { color: theme.colors.statusWarning, fontSize: 11, lineHeight: 15, marginTop: 4 },
    staleNotice: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14, marginTop: 4 },
    repositoryIssueDetail: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9, lineHeight: 13, marginTop: 3 },
    executionBar: { alignItems: "center", backgroundColor: theme.colors.surface1, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 8, justifyContent: "space-between", minHeight: 36, paddingHorizontal: compact ? 13 : 15, paddingVertical: 6 },
    executionSummary: { alignItems: "center", flex: 1, flexDirection: "row", gap: 6, minWidth: 0 },
    executionLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    executionStatus: { alignItems: "center", borderRadius: 999, borderWidth: 1, flexDirection: "row", gap: 4, paddingHorizontal: 7, paddingVertical: 3 },
    executionStatusDot: { borderRadius: 4, height: 6, width: 6 },
    executionStatusText: { fontSize: 10, fontWeight: "700" },
    executionActions: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: 5 },
    executionButtonDisabled: { opacity: 0.6 },
    toolchainNotice: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.statusWarning, borderRadius: 6, borderWidth: 1, padding: 8 },
    toolchainTitle: { color: theme.colors.statusWarning, flex: 1, fontSize: 11, fontWeight: "700" },
    toolchainCount: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    toolchainText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14, marginTop: 3 },
    section: { marginTop: 0 },
    sectionHeader: { alignItems: "center", flexDirection: "row", gap: 4, justifyContent: "space-between", minHeight: Platform.OS === "web" ? 28 : 32 },
    sectionHeaderRight: { alignItems: "center", flexDirection: "row", gap: 6 },
    sectionDisclosureButton: { alignItems: "center", flex: 1, flexDirection: "row", gap: 4, minWidth: 0 },
    sectionTitleRow: { alignItems: "center", flex: 1, flexDirection: "row", gap: 6, minWidth: 0 },
    inlineRefresh: { flexShrink: 0, height: 14, width: 14 },
    sectionTitle: { color: theme.colors.foreground, flex: 1, fontSize: 14, fontWeight: "500", minWidth: 0 },
    sectionCount: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 },
    repositoryList: { marginTop: 4 },
    repositoryRow: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 7, minHeight: 46, paddingHorizontal: 4, paddingVertical: 7 },
    repositoryRowActive: { backgroundColor: theme.colors.surface2 },
    repositoryDot: { borderRadius: 4, height: 7, width: 7 },
    repositoryCopy: { flex: 1, minWidth: 0 },
    repositoryLine: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13 },
    repositoryMeta: { color: theme.colors.foregroundMuted, fontSize: 11, marginTop: 3 },
    repositoryMetrics: { alignItems: "flex-end", minWidth: 94 },
    repositoryDelta: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, textAlign: "right" },
    changeCounts: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, textAlign: "right" },
    changePrefix: { color: theme.colors.statusWarning },
    additionCount: { color: theme.colors.statusSuccess },
    deletionCount: { color: theme.colors.statusDanger },
    changeSeparator: { color: theme.colors.foregroundMuted },
    repositoryDetail: { borderTopColor: theme.colors.border, borderTopWidth: 1, marginTop: 10, paddingTop: 0 },
    repositoryDisclosure: { backgroundColor: theme.colors.surface2, borderRadius: 5, marginTop: 6, paddingHorizontal: 7, paddingVertical: 5 },
    repositoryDisclosureBranch: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 10, lineHeight: 14 },
    repositoryDisclosureMeta: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9, lineHeight: 13, marginTop: 2 },
    createModalContent: { alignSelf: "center", flexGrow: 0, flexShrink: 1, maxWidth: 560, minHeight: 0, width: "100%" },
    createModalBody: { gap: 8, minHeight: 0, padding: 12 },
    createRepositoryList: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    createResizeHandle: { alignItems: "center", backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 3, borderWidth: 1, height: 6, justifyContent: "center", marginVertical: 1, width: "100%" },
    sectionViewportFrame: { flexShrink: 1, marginTop: 4, minHeight: 0, position: "relative" },
    sectionViewport: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
    sectionViewportContent: { paddingBottom: 6 },
    sectionViewportContentNoResize: { paddingBottom: 0 },
    sectionResizeHandle: { alignItems: "center", backgroundColor: theme.colors.surface2, borderTopColor: theme.colors.border, borderTopWidth: 1, bottom: 0, elevation: 4, height: 6, justifyContent: "center", left: 0, position: "absolute", right: 0, zIndex: 3 },
    sectionResizeGrip: { alignItems: "center", height: 6, justifyContent: "center", width: 40 },
    statusPill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3 },
    statusPillText: { fontSize: 10, fontWeight: "700" },
    graphSection: { marginTop: 10, position: "relative" },
    graphHeaderActions: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: 5 },
    changeScopeRow: { alignItems: "center", flexDirection: "row", gap: 2 },
    graphScope: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9 },
    scopeButton: { borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 3 },
    scopeButtonActive: { backgroundColor: theme.colors.surface2, borderColor: accent },
    scopeButtonText: { color: theme.colors.foregroundMuted, fontSize: 10 },
    scopeButtonTextActive: { color: accent, fontWeight: "700" },
    graphSurface: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, marginTop: 6, overflow: "hidden", position: "relative" },
    graphRows: { position: "relative" },
    graphCanvas: { left: 0, position: "absolute", top: 0 },
    graphRow: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", height: GRAPH_ROW_HEIGHT },
    graphRowHover: { backgroundColor: theme.colors.surface2 },
    graphRowActive: { backgroundColor: `${accent}18` },
    graphWorktreeRow: { backgroundColor: `${theme.colors.statusWarning}0b` },
    graphRowCopy: { alignItems: "center", flex: 1, flexDirection: "row", gap: 5, minWidth: 0, paddingRight: 6 },
    graphSubject: { color: theme.colors.foreground, flex: 1, fontSize: 12 },
    graphSha: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11 },
    graphWorktreeLabel: { color: theme.colors.statusWarning, fontFamily: "monospace", fontSize: 11, fontWeight: "700" },
    graphVertical: { position: "absolute", width: 1 },
    graphHorizontal: { height: 1, position: "absolute" },
    graphDot: { borderRadius: 5, borderWidth: 2, height: 10, position: "absolute", width: 10 },
    graphDotBase: { borderWidth: 1 },
    graphCommitDetail: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 6, borderWidth: 1, gap: 2, marginBottom: 6, padding: 8 },
    graphCommitDetailCompact: { marginBottom: 0 },
    graphDetailsPanel: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 6, borderWidth: 1, marginTop: 6, maxHeight: 176, overflow: "hidden" },
    graphDetailsHeader: { alignItems: "center", backgroundColor: theme.colors.surface2, borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 6, justifyContent: "space-between", minHeight: 28, paddingHorizontal: 8, paddingVertical: 4 },
    graphDetailsHeaderTitle: { color: theme.colors.foreground, flex: 1, fontSize: 10, fontWeight: "700", minWidth: 0 },
    graphDetailsHeaderMeta: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9, flexShrink: 0 },
    graphDetailsScroll: { flexShrink: 1, maxHeight: 146, minHeight: 0 },
    graphDetailsContent: { padding: 6 },
    graphCommitDetailTitleRow: { alignItems: "flex-start", flexDirection: "row", gap: 6 },
    graphCommitDetailTitle: { color: theme.colors.foreground, flex: 1, fontSize: 12, fontWeight: "600", lineHeight: 16 },
    graphCommitDetailRole: { color: accent, flexShrink: 0, fontSize: 9, fontWeight: "700", marginTop: 2 },
    graphCommitDetailSha: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9, marginTop: 3 },
    graphCommitDetailMeta: { gap: 2, marginTop: 5 },
    graphCommitDetailMetaBlock: { gap: 4, marginTop: 5 },
    graphCommitDetailMetaText: { color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 },
    graphCommitDetailMetaLabel: { color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600", lineHeight: 14 },
    graphCommitDetailTagRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 4 },
    historyButton: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, flexDirection: "row", gap: 5, justifyContent: "center", marginTop: 6, paddingHorizontal: 8, paddingVertical: 5 },
    historyButtonDisabled: { opacity: 0.6 },
    historyButtonText: { color: accent, fontSize: 10, fontWeight: "500" },
    historyEndText: { color: theme.colors.foregroundMuted, fontSize: 10, marginTop: 6, textAlign: "center" },
    treeSection: { marginTop: 10 },
    treeHeaderRight: { alignItems: "center", flexDirection: "row", gap: 4 },
    smallToggle: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 4, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 3 },
    smallToggleText: { color: theme.colors.foregroundMuted, fontSize: 10 },
    directoryRow: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", minHeight: 29, paddingRight: 4 },
    folderChevron: { alignItems: "center", height: 16, justifyContent: "center", width: 16 },
    folderText: { color: theme.colors.foreground, flex: 1, fontFamily: "monospace", fontSize: 11, fontWeight: "500" },
    directoryStats: { alignItems: "center", flexDirection: "row", gap: 4 },
    directoryFileCount: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    directoryStat: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    fileRow: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 4, minHeight: 30, paddingRight: 4 },
    fileRowActive: { backgroundColor: theme.colors.surface2 },
    fileBadge: { fontFamily: "monospace", fontSize: 12, fontWeight: "700", width: 14 },
    filePath: { color: theme.colors.foreground, flex: 1, fontFamily: "monospace", fontSize: 11, minWidth: 0 },
    fileStat: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10, minWidth: 67, textAlign: "right" },
    emptyText: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, paddingVertical: 8 },
    miniTag: { borderRadius: 4, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1 },
    miniTagText: { fontFamily: "monospace", fontSize: 8, fontWeight: "700" },
    footer: { alignItems: "center", backgroundColor: theme.colors.surface1, borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 43, paddingHorizontal: compact ? 13 : 15 },
    footerButton: { backgroundColor: theme.colors.surface2, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 5 },
    footerButtonContent: { alignItems: "center", flexDirection: "row", gap: 5 },
    footerButtonText: { color: accent, fontSize: 10 },
    footerTime: { color: theme.colors.foregroundMuted, fontSize: 10 },
    footerStaleTime: { color: theme.colors.statusWarning },
    reviewPanel: { gap: 8 },
    reviewOverviewHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
    reviewOverviewTitle: { alignItems: "center", flexDirection: "row", gap: 8, minWidth: 0 },
    reviewRoundText: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 },
    reviewProgressScroll: { minWidth: "100%" },
    reviewProgress: { alignItems: "flex-start", flexDirection: "row", minWidth: compact ? 330 : 410, paddingHorizontal: 3, paddingVertical: 8 },
    reviewProgressStep: { alignItems: "center", minWidth: compact ? 70 : 88 },
    reviewProgressNode: { alignItems: "center", borderRadius: 999, borderWidth: 2, height: compact ? 23 : 26, justifyContent: "center", width: compact ? 23 : 26 },
    reviewProgressNodeText: { fontSize: compact ? 10 : 11, fontWeight: "800" },
    reviewProgressLabel: { fontSize: compact ? 8 : 9, marginTop: 5, maxWidth: compact ? 76 : 94, textAlign: "center" },
    reviewProgressLine: { flex: 1, height: 1, marginTop: compact ? 11 : 12, minWidth: compact ? 12 : 18 },
    reviewHistoryRow: { gap: 4 },
    reviewResultBanner: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 6, borderWidth: 1, gap: 5, padding: 8 },
    reviewResultTitle: { color: theme.colors.foreground, flex: 1, fontSize: 11, fontWeight: "700" },
    reviewErrorBanner: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.statusDanger, borderRadius: 6, borderWidth: 1, gap: 3, padding: 8 },
    reviewTagRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 5 },
    reviewMessage: { alignItems: "flex-start", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 8, paddingBottom: 9, paddingTop: 4 },
    reviewMessageSystem: { opacity: 0.85 },
    reviewMessageAvatar: { alignItems: "center", borderRadius: 999, height: 23, justifyContent: "center", marginTop: 1, width: 23 },
    reviewMessageAvatarText: { fontSize: 10, fontWeight: "800" },
    reviewMessageContent: { flex: 1, minWidth: 0 },
    reviewMessageHeader: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 24 },
    reviewMessageRole: { color: theme.colors.foreground, flexShrink: 1, fontSize: 11, fontWeight: "700" },
    reviewMessageBody: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 6, borderWidth: 1, marginTop: 3, padding: 7 },
    reviewMessageText: { color: theme.colors.foreground, fontSize: 11, lineHeight: 16 },
    reviewExpandButton: { alignSelf: "flex-start", marginTop: 5 },
    reviewExpandText: { color: accent, fontSize: 10, fontWeight: "600" },
    reviewDetails: { borderTopColor: theme.colors.border, borderTopWidth: 1, gap: 6, marginTop: 7, paddingTop: 6 },
    reviewDetailSection: { gap: 4 },
    reviewDetailMeta: { color: theme.colors.foregroundMuted, fontSize: 9, lineHeight: 13 },
    reviewFindingList: { gap: 5 },
    reviewFindingRow: { alignItems: "flex-start", flexDirection: "row", gap: 5 },
    reviewFindingCopy: { flex: 1, gap: 2, minWidth: 0 },
    reviewFindingPath: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9 },
    reviewFindingMessage: { color: theme.colors.foreground, fontSize: 10, lineHeight: 14 },
    reviewFindingFooter: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 5 },
    reviewFindingSuggestion: { color: theme.colors.foregroundMuted, flexShrink: 1, fontSize: 9, lineHeight: 13 },
    reviewCheckList: { gap: 4 },
    reviewCheckRow: { alignItems: "flex-start", flexDirection: "row", gap: 5 },
    reviewActionBar: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 3 },
    primaryReviewButton: { backgroundColor: accent, borderColor: accent, borderRadius: 5, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
    primaryReviewButtonText: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" },
    reviewConversationButton: { marginLeft: "auto", paddingHorizontal: 3, paddingVertical: 5 },
    reviewConversationButtonText: { color: accent, fontSize: 10, fontWeight: "600" },
    reviewWorkspaceList: { gap: 3, marginTop: 4 },
    reviewWorkspaceRow: { alignItems: "center", borderBottomColor: theme.colors.border, borderBottomWidth: 1, flexDirection: "row", gap: 7, minHeight: 39, paddingVertical: 5 },
    reviewWorkspaceRowActive: { backgroundColor: theme.colors.surface2 },
    checkbox: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 3, borderWidth: 1, height: 15, justifyContent: "center", width: 15 },
    checkboxActive: { backgroundColor: accent, borderColor: accent },
    checkboxTick: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "800" },
    reviewWorkspaceCopy: { flex: 1, minWidth: 0 },
    reviewWorkspaceName: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 10 },
    reviewWorkspaceMeta: { color: theme.colors.foregroundMuted, fontSize: 9, marginTop: 2 },
    reviewRepo: { borderTopColor: theme.colors.border, borderTopWidth: 1, marginTop: 8, paddingTop: 8 },
    reviewRepoCopy: { flex: 1, minWidth: 0 },
    targetRow: { alignItems: "center", flexDirection: "row", gap: 6, marginTop: 5 },
    targetInput: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 4, borderWidth: 1, color: theme.colors.foreground, flex: 1, fontFamily: "monospace", fontSize: 10, paddingHorizontal: 6, paddingVertical: 4 },
    reviewEntry: { alignItems: "center", borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", gap: 5, marginTop: 6, paddingTop: 6 },
    reviewEntryCopy: { flex: 1, minWidth: 0 },
    reviewBranch: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 9 },
    reviewEntryMeta: { color: theme.colors.foregroundMuted, fontSize: 9, marginTop: 2 },
    reviewTimeline: { marginTop: 2, paddingLeft: 4 },
    reviewTimelineNode: { borderLeftColor: theme.colors.border, borderLeftWidth: 1, flexDirection: "row", gap: 8, minHeight: 45, paddingBottom: 7, paddingLeft: 9, position: "relative" },
    reviewTimelineDot: { backgroundColor: accent, borderRadius: 4, height: 7, left: -4, position: "absolute", top: 4, width: 7 },
    reviewDetailText: { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderRadius: 4, borderWidth: 1, color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 9, lineHeight: 13, marginTop: 4, maxHeight: 180, padding: 6 },
    arrowText: { color: theme.colors.foregroundMuted, fontSize: 13 },
    reviewTarget: { flex: 1, minWidth: 0 },
    relationText: { fontFamily: "monospace", fontSize: 9, marginTop: 2 },
    briefPanel: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 7, borderWidth: 1, marginTop: 8, padding: 8 },
    briefActions: { alignItems: "center", flexDirection: "row", gap: 4 },
    copyButton: { backgroundColor: accent, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 4 },
    copyButtonText: { color: theme.colors.accentForeground, fontSize: 10, fontWeight: "700" },
    briefText: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 9, lineHeight: 14, marginTop: 7 },
    copyByRepo: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 7 },
    secondaryButton: { borderColor: theme.colors.border, borderRadius: 4, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 4 },
    secondaryButtonText: { color: theme.colors.foregroundMuted, fontSize: 9 },
  });
}
