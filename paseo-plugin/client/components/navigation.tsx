import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { FlatList, Icon, ScrollView, TextInput } from "../native-components";
import { useEffect, useState, type ReactNode } from "react";
import { BackHandler,Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { formatCopyFrom } from "../../shared/copy";

import {
countWorkspaceFilter,
formatCompactRelativeAge,
matchesWorkspaceSearch,
type WorkspaceSummary,
type WorkspaceFilter,
} from "../model";
import { observerAccent } from "../theme";
import { useWorkbenchCopy } from "../i18n";
import { InlineRefresh,LayoutMenuItem,isMainWorkspace,makeStyles,repositoryCountLabel,workspaceDisplayName,workspaceMeta } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type ObserverPanelContentProps = PanelProps & {
  hostWorkspaceId: string;
  paseoWorkspace: { directory: string; name: string } | null;
};
type ChangeTreeMode = "tree" | "files";
const WORKSPACE_OPTION_HEIGHT = 42;

const PREFERENCE_SCOPE_FALLBACK = "global";

// React Native's shared cursor type only exposes `auto` and `pointer`, while
// the web renderer forwards the full CSS cursor value. Keep the native style
// portable and add the vertical resize affordance only where it is supported.
const verticalResizeCursorStyle: ViewStyle | null = Platform.OS === "web"
  ? ({ cursor: "ns-resize" } as unknown as ViewStyle)
  : null;

export function PanelHeader({
  onOpenLayoutMenu,
  agentEnabled = false,
  theme,
  styles,
}: {
  onOpenLayoutMenu: () => void;
  agentEnabled?: boolean;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const localizedCopy = useWorkbenchCopy();
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelTitleGroup}>
        <View style={styles.pluginIcon}><Icon name="GitBranch" size={14} color={observerAccent(theme)} /></View>
        <Text style={styles.panelTitle}>{localizedCopy.text_6cea90adcf}</Text>
      </View>
      <View style={styles.panelHeaderActions}>
        <Text style={styles.readOnlyText}>{agentEnabled ? localizedCopy.text_ca42ecd50e : localizedCopy.readOnlyObservation}</Text>
        <Pressable
          accessibilityLabel={localizedCopy.text_1744b62533}
          accessibilityRole="button"
          onLongPress={onOpenLayoutMenu}
          onPress={onOpenLayoutMenu}
          style={styles.layoutMenuButton}
        >
          <Text style={styles.layoutMenuButtonText}>⋯</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function LayoutMenu({
  open,
  onClose,
  onCollapseAll,
  onExpandAll,
  onReset,
  onCreate,
  onSwitchProject,
  onOpenStorage,
  onOpenRuntimeSettings,
  onOpenReviewSettings,
  selectedWorkspace,
  onAddRepositories,
  onSelectMainRepositories,
  onSelectLinkedWorkspaces,
  theme,
  styles,
}: {
  open: boolean;
  onClose: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onReset: () => void;
  onCreate?: () => void;
  onSwitchProject?: () => void;
  onOpenStorage?: () => void;
  onOpenRuntimeSettings?: () => void;
  onOpenReviewSettings?: () => void;
  selectedWorkspace?: WorkspaceSummary;
  onAddRepositories?: () => void;
  onSelectMainRepositories?: () => void;
  onSelectLinkedWorkspaces?: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const localizedCopy = useWorkbenchCopy();
  const timestamp = (value: string | null | undefined) => {
    if (!value) return localizedCopy.text_6478dde454;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : localizedCopy.text_6478dde454;
  };
  return <AnchoredMenu open={open} onClose={onClose} theme={theme} width={selectedWorkspace ? 285 : 190}>
    <ScrollView style={{ maxHeight: 480 }} keyboardShouldPersistTaps="handled">
    {selectedWorkspace ? <View style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 8 }}>
      <Text numberOfLines={1} style={[styles.layoutMenuItemText, { fontWeight: "700" }]}>{workspaceDisplayName(selectedWorkspace, localizedCopy)}</Text>
      <Text style={styles.layoutMenuHint}>{localizedCopy.workspaceCreatedAt}: {timestamp(selectedWorkspace.createdAt)}</Text>
      <Text style={styles.layoutMenuHint}>{localizedCopy.workspaceRecordUpdatedAt}: {timestamp(selectedWorkspace.updatedAt)}</Text>
      <Text style={styles.layoutMenuHint}>{localizedCopy.workspaceLatestCommitAt}: {selectedWorkspace.latestCommitAt ? timestamp(selectedWorkspace.latestCommitAt) : localizedCopy.workspaceCommitUnavailable}</Text>
      {selectedWorkspace.latestCommitObservedAt ? <Text style={styles.layoutMenuHint}>{localizedCopy.workspaceCommitObservedAt}: {timestamp(selectedWorkspace.latestCommitObservedAt)}</Text> : null}
    </View> : null}
    {onAddRepositories ? <LayoutMenuItem label={localizedCopy.addRepositoriesMenu} onPress={onAddRepositories} styles={styles} /> : null}
    {onSelectMainRepositories ? <LayoutMenuItem label={localizedCopy.mainSelectRepositories} onPress={onSelectMainRepositories} styles={styles} /> : null}
    {onSelectLinkedWorkspaces ? <LayoutMenuItem label={localizedCopy.linkedSelectWorkspaces} onPress={onSelectLinkedWorkspaces} styles={styles} /> : null}
    {onCreate ? <LayoutMenuItem label={localizedCopy.text_1623afda9e} onPress={onCreate} styles={styles} /> : null}
    {onSwitchProject ? <LayoutMenuItem label={localizedCopy.switchProject} onPress={onSwitchProject} styles={styles} /> : null}
    {onOpenStorage ? <LayoutMenuItem label={localizedCopy.storageMenu} onPress={onOpenStorage} styles={styles} /> : null}
    {onOpenRuntimeSettings ? <LayoutMenuItem label={localizedCopy.runtimeSettingsMenu} onPress={onOpenRuntimeSettings} styles={styles} /> : null}
    {onOpenReviewSettings ? <LayoutMenuItem label={localizedCopy.reviewSettingsMenu} onPress={onOpenReviewSettings} styles={styles} /> : null}
    <LayoutMenuItem label={localizedCopy.text_5f6a1bf190} onPress={onCollapseAll} styles={styles} />
    <LayoutMenuItem label={localizedCopy.text_66c98ab6d8} onPress={onExpandAll} styles={styles} />
    <LayoutMenuItem label={localizedCopy.text_e003f209ca} onPress={onReset} styles={styles} />
    </ScrollView>
  </AnchoredMenu>;
}

export function AnchoredMenu({ open, onClose, theme, children, width = 190 }: { open: boolean; onClose(): void; theme: PanelProps["theme"]; children: ReactNode; width?: number }) {
  const localizedCopy = useWorkbenchCopy();
  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler?.addEventListener?.("hardwareBackPress", () => { onClose(); return true; });
    const web = globalThis as unknown as { document?: { addEventListener(type: string, fn: (e: { key: string }) => void): void; removeEventListener(type: string, fn: (e: { key: string }) => void): void } };
    const keydown = (event: { key: string }) => { if (event.key === "Escape") onClose(); };
    if (Platform.OS === "web") web.document?.addEventListener("keydown", keydown);
    return () => {
      subscription?.remove();
      if (Platform.OS === "web") web.document?.removeEventListener("keydown", keydown);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, elevation: 20 }}>
      <Pressable accessibilityLabel={localizedCopy.text_4d0b4688c7} onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View accessibilityRole="menu" style={{ position: "absolute", top: 40, right: 12, width, padding: 6, borderRadius: 6, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1 }}>
        {children}
      </View>
    </View>
  );
}

export function WorkspaceSelector({
  workspaces,
  historyWorkspaces,
  visibleWorkspaces,
  orphanCandidates,
  selectedWorkspace,
  selectedWorkspaceId,
  filter,
  open,
  loading,
  refreshing,
  failure,
  onOpen,
  onFilter,
  onSelect,
  onOpenOrphan,
  onRemoveWorkspace,
  onRestoreWorkspace,
  onPermanentDeleteWorkspace,
  onInspectWorkspace,
  lifecycleBusyWorkspaceId,
  onOpenLayoutMenu,
  latestCommitProgress,
  statusControl,
  theme,
  styles,
}: {
  workspaces: WorkspaceSummary[];
  historyWorkspaces: WorkspaceSummary[];
  visibleWorkspaces: WorkspaceSummary[];
  orphanCandidates?: Array<{ id: string; name: string; repositoryCount: number; resume?: boolean }>;
  selectedWorkspace?: WorkspaceSummary;
  selectedWorkspaceId: string;
  filter: WorkspaceFilter;
  open: boolean;
  loading: boolean;
  refreshing: boolean;
  failure: string | null;
  onOpen: () => void;
  onFilter: (filter: WorkspaceFilter) => void;
  onSelect: (id: string) => void;
  onOpenOrphan?: (id: string) => void;
  onRemoveWorkspace?: (workspace: WorkspaceSummary) => void;
  onRestoreWorkspace?: (workspace: WorkspaceSummary) => void;
  onPermanentDeleteWorkspace?: (workspace: WorkspaceSummary) => void;
  onInspectWorkspace?: (workspace: WorkspaceSummary) => void;
  lifecycleBusyWorkspaceId?: string;
  onOpenLayoutMenu?: () => void;
  latestCommitProgress?: { completed: number; total: number } | null;
  statusControl?: ReactNode;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const localizedCopy = useWorkbenchCopy();
  const [search, setSearch] = useState("");
  useEffect(() => { if (!open) setSearch(""); }, [open]);
  const searchedWorkspaces = visibleWorkspaces.filter((workspace) => matchesWorkspaceSearch(workspace, search));
  const attention = countWorkspaceFilter(workspaces, "attention");
  const filters: { id: WorkspaceFilter; label: string; count: number }[] = [
    { id: "all", label: localizedCopy.text_778fc8f994, count: workspaces.length },
    { id: "attention", label: localizedCopy.text_284b34e15f, count: attention },
    { id: "dirty", label: localizedCopy.workspaceStatusDirty, count: workspaces.filter((workspace) => workspace.dirty).length },
    { id: "unpushed", label: localizedCopy.text_05162ec10a, count: workspaces.filter((workspace) => workspace.unpushed).length },
    { id: "history", label: localizedCopy.text_be78b20585, count: historyWorkspaces.length },
  ];
  const workspaceTotal = filter === "history" ? historyWorkspaces.length : workspaces.length;
  return (
    <View style={styles.selector}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onOpen} style={[styles.selectorButton, { flex: 1 }]}>
        <View style={styles.selectorCopy}>
          <View style={styles.selectorValueRow}>
            <Text numberOfLines={1} style={styles.selectorValue}>{workspaceDisplayName(selectedWorkspace, localizedCopy)}</Text>
            <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
          </View>
          {loading ? <Text numberOfLines={1} style={styles.selectorMeta}>{localizedCopy.text_80bf719ff7}</Text> : null}
          {!loading && !selectedWorkspace && failure ? <Text numberOfLines={2} style={styles.selectorFailure}>{failure}</Text> : null}
          {!loading && selectedWorkspace && workspaceMeta(selectedWorkspace, localizedCopy) ? (
            <Text numberOfLines={1} style={styles.selectorMeta}>{workspaceMeta(selectedWorkspace, localizedCopy)}</Text>
          ) : null}
          {!loading && !selectedWorkspace ? <Text numberOfLines={1} style={styles.selectorMeta}>{formatCopyFrom(localizedCopy, "text_2e046dd497", [workspaces.length])}</Text> : null}
        </View>
        <View style={styles.selectorChevron}>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {statusControl}
      {onOpenLayoutMenu ? <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.text_1744b62533} onPress={onOpenLayoutMenu} style={[styles.layoutMenuButton, { width: 36, height: 36 }]}><Icon name="Ellipsis" size={18} color={theme.colors.foregroundMuted} /></Pressable> : null}
      </View>
      {open ? (
        <View style={styles.selectorExpanded}>
          <View style={styles.filterRow}>
            {filters.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === item.id }}
                onPress={() => onFilter(item.id)}
                style={[styles.filterButton, filter === item.id && styles.filterButtonActive]}
              >
                <Text style={[styles.filterButtonText, filter === item.id && styles.filterButtonTextActive]}>{item.label}</Text>
                <Text style={[styles.filterCount, filter === item.id && styles.filterCountActive]}>{item.count}</Text>
              </Pressable>
            ))}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7 }}>
            <TextInput
              accessibilityLabel={localizedCopy.workspaceSearchPlaceholder}
              onChangeText={setSearch}
              placeholder={localizedCopy.workspaceSearchPlaceholder}
              placeholderTextColor={theme.colors.foregroundMuted}
              returnKeyType="search"
              style={[styles.targetInput, { flex: 1, fontSize: 11, minHeight: 30, paddingVertical: 4 }]}
              value={search}
            />
            {search ? <Pressable accessibilityLabel={localizedCopy.workspaceSearchClear} accessibilityRole="button" onPress={() => setSearch("")} style={{ paddingHorizontal: 7, paddingVertical: 5 }}><Text style={styles.workspaceOptionActionText}>×</Text></Pressable> : null}
          </View>
          {latestCommitProgress && latestCommitProgress.total > latestCommitProgress.completed ? <Text style={[styles.selectorListLabel, { marginTop: 5 }]}>{formatCopyFrom(localizedCopy, "workspaceActivityProgress", [latestCommitProgress.completed, latestCommitProgress.total])}</Text> : null}
          <View style={styles.selectorListHeader}>
            <Text style={styles.selectorListLabel}>{localizedCopy.text_205b4561ed}</Text>
            <Text style={styles.selectorListCount}>{search ? `${searchedWorkspaces.length}${localizedCopy.text_42099b4af0}${visibleWorkspaces.length}` : `${visibleWorkspaces.length}${localizedCopy.text_42099b4af0}${workspaceTotal}`}</Text>
          </View>
          <FlatList
            data={searchedWorkspaces}
            getItemLayout={(_, index) => ({ length: WORKSPACE_OPTION_HEIGHT, offset: WORKSPACE_OPTION_HEIGHT * index, index })}
            keyExtractor={(workspace) => workspace.id}
            initialNumToRender={12}
            keyboardShouldPersistTaps="handled"
            maxToRenderPerBatch={20}
            nestedScrollEnabled
            removeClippedSubviews
            renderItem={({ item: workspace }) => (
              <WorkspaceOption
                onSelect={onSelect}
                selected={workspace.id === selectedWorkspaceId}
                styles={styles}
                theme={theme}
                workspace={workspace}
                onRemove={onRemoveWorkspace}
                onRestore={onRestoreWorkspace}
                onPermanentDelete={onPermanentDeleteWorkspace}
                onInspect={onInspectWorkspace}
                busy={lifecycleBusyWorkspaceId === workspace.id}
              />
            )}
            showsVerticalScrollIndicator={visibleWorkspaces.length > 7}
            style={styles.workspaceOptionList}
            windowSize={7}
            ListEmptyComponent={!loading ? <Text style={styles.emptyText}>{search ? localizedCopy.workspaceSearchEmpty : localizedCopy.text_daa32fe25c}</Text> : null}
          />
          {filter === "all" && orphanCandidates?.length ? <View style={{ maxHeight: 170 }}>
            <Text style={styles.selectorListLabel}>{localizedCopy.orphanHeading} · {orphanCandidates.length}</Text>
            <FlatList data={orphanCandidates} keyExtractor={(item) => item.id} nestedScrollEnabled
              renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.resume ? localizedCopy.orphanResume : localizedCopy.orphanCandidate} ${item.name}`} onPress={() => onOpenOrphan?.(item.id)} style={styles.workspaceOption}>
                <View style={styles.workspaceOptionCopy}>
                  <Text numberOfLines={1} style={styles.workspaceOptionTitle}>{item.name}</Text>
                  <Text numberOfLines={1} style={styles.workspaceOptionMeta}>{item.resume ? localizedCopy.orphanResume : localizedCopy.orphanCandidate} · {repositoryCountLabel(item.repositoryCount, localizedCopy)}</Text>
                </View>
              </Pressable>} />
          </View> : null}
        </View>
      ) : null}
    </View>
  );
}

function WorkspaceOption({ workspace, selected, onSelect, onRemove, onRestore, onPermanentDelete, onInspect, busy, theme, styles }: {
  workspace: WorkspaceSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove?: (workspace: WorkspaceSummary) => void;
  onRestore?: (workspace: WorkspaceSummary) => void;
  onPermanentDelete?: (workspace: WorkspaceSummary) => void;
  onInspect?: (workspace: WorkspaceSummary) => void;
  busy: boolean;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const localizedCopy = useWorkbenchCopy();
  const removed = workspace.state === "removed";
  const pending = workspace.state === "deletion_pending";
  const status = isMainWorkspace(workspace)
    ? ""
    : pending
        ? localizedCopy.workspaceStateDeletionPending
      : removed
        ? localizedCopy.workspaceStateRemoved
        : workspace.state === "create_failed"
          ? localizedCopy.workspaceStateCreateFailed
    : workspace.dirty
    ? localizedCopy.workspaceStatusDirty
    : workspace.unpushed
      ? localizedCopy.workspaceStatusUnpushed
      : workspace.blockerCount > 0
        ? localizedCopy.workspaceStatusNeedsReview
        : workspace.state !== "active"
          ? workspace.state === "removed" ? localizedCopy.workspaceStateRemoved : workspace.state
          : "";
  const statusTone = isMainWorkspace(workspace)
    ? observerAccent(theme)
    : pending
    ? theme.colors.statusWarning
    : removed
    ? theme.colors.foregroundMuted
    : workspace.state === "create_failed"
    ? theme.colors.statusDanger
    : workspace.dirty || workspace.unpushed || workspace.blockerCount > 0
    ? theme.colors.statusWarning
    : workspace.observationStale || workspace.dirty === null
    ? theme.colors.foregroundMuted
    : theme.colors.statusSuccess;
  const workspaceDates = [
    workspace.createdAt ? formatCopyFrom(localizedCopy, "workspaceCreatedShort", [formatCompactRelativeAge(workspace.createdAt, localizedCopy)]) : null,
    workspace.latestCommitAt ? formatCopyFrom(localizedCopy, "workspaceCommitShort", [formatCompactRelativeAge(workspace.latestCommitAt, localizedCopy)]) : null,
  ].filter(Boolean);
  const meta = [repositoryCountLabel(workspace.repositoryCount, localizedCopy), ...workspaceDates].join(" · ");
  return (
    <View style={[styles.workspaceOption, selected && styles.workspaceOptionActive]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => onSelect(workspace.id)}
        style={{ alignItems: "center", flex: 1, flexDirection: "row", gap: 7, minWidth: 0 }}
      >
        <View style={[styles.workspaceStatusDot, { backgroundColor: statusTone }]} />
        <View style={styles.workspaceOptionCopy}>
          <Text numberOfLines={1} style={styles.workspaceOptionTitle}>{workspaceDisplayName(workspace, localizedCopy)}</Text>
          <Text numberOfLines={1} style={styles.workspaceOptionMeta}>{meta}</Text>
        </View>
        {status && status !== "active" ? <Text numberOfLines={1} style={[styles.workspaceOptionState, { color: statusTone }]}>{status}</Text> : null}
      </Pressable>
      {!isMainWorkspace(workspace) ? <View style={styles.workspaceOptionActions}>
        {onInspect ? <Pressable accessibilityLabel={localizedCopy.workspaceDeleteImpact} accessibilityRole="button" disabled={busy} onPress={() => onInspect(workspace)} style={styles.workspaceOptionAction}><Text style={styles.workspaceOptionActionText}>i</Text></Pressable> : null}
        {pending && onRestore ? <Pressable accessibilityLabel={localizedCopy.workspaceRestore} accessibilityRole="button" disabled={busy} onPress={() => onRestore(workspace)} style={styles.workspaceOptionAction}><Text style={[styles.workspaceOptionActionText, { color: observerAccent(theme) }]}>↩</Text></Pressable> : null}
        {!removed && !pending && onRemove ? <Pressable accessibilityLabel={localizedCopy.workspaceDelete} accessibilityRole="button" disabled={busy} onPress={() => onRemove(workspace)} style={styles.workspaceOptionAction}><Icon name="CircleX" size={15} color={observerAccent(theme)} /></Pressable> : null}
        {removed && onRestore ? <Pressable accessibilityLabel={localizedCopy.workspaceRestore} accessibilityRole="button" disabled={busy} onPress={() => onRestore(workspace)} style={styles.workspaceOptionAction}><Text style={[styles.workspaceOptionActionText, { color: observerAccent(theme) }]}>↩</Text></Pressable> : null}
        {removed && onPermanentDelete ? <Pressable accessibilityLabel={localizedCopy.workspacePermanentDelete} accessibilityRole="button" disabled={busy} onPress={() => onPermanentDelete(workspace)} style={styles.workspaceOptionAction}><Icon name="CircleX" size={15} color={theme.colors.statusDanger} /></Pressable> : null}
      </View> : null}
    </View>
  );
}
