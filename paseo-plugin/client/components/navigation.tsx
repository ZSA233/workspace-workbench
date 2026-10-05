import { createdInSession, workspaceCreators } from '../../shared/workspace-creator';
import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { useEffect,useState,useRef,useLayoutEffect,useMemo,type ReactNode } from "react";
import { ActivityIndicator,BackHandler,Platform,Pressable,Text,View } from "react-native";
import { formatCopyFrom } from "../../shared/copy";
import { FlatList,Icon,ScrollView,TextInput } from "../native-components";

import { readWorkspaceLineage } from '../../shared/workspace-lineage';
import { workspaceForest, workspaceTreeRows, type WorkspaceTreeRow } from '../workspace-tree';
import { anchoredOffset } from '../graph/continuity';
import { batchEligible, type BatchAction } from '../workspace-batch';
import { useWorkbenchCopy } from "../i18n";
import {
countWorkspaceFilter,
formatCompactRelativeAge,
matchesWorkspaceSearch,
type WorkspaceFilter,
type WorkspaceSummary,
} from "../model";
import { observerAccent } from "../theme";
import { InlineRefresh,LayoutMenuItem,isMainWorkspace,makeStyles,repositoryCountLabel,workspaceDisplayName,workspaceMeta } from "./ui";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;


const WORKSPACE_OPTION_HEIGHT = 42;




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
          <Icon name="Ellipsis" size={18} color={theme.colors.foregroundMuted}/>
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
  onOpenExecution,
  runtimeNotice,
  onOpenReviewSettings,
  selectedWorkspace,
  sourceAvailable,
  onOpenCreator,
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
  runtimeNotice?: ReactNode;
  onOpenExecution?: ()=>void;
  onOpenReviewSettings?: () => void;
  selectedWorkspace?: WorkspaceSummary;
  sourceAvailable?: boolean;
  onOpenCreator?: (agentId: string) => void;
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
      {selectedWorkspace.creator ? <View><Text selectable style={styles.layoutMenuHint}>{localizedCopy.creatorSession}: {selectedWorkspace.creator.name || selectedWorkspace.creator.agentId}</Text>{onOpenCreator ? <LayoutMenuItem label={localizedCopy.openCreatorSession} onPress={() => onOpenCreator(selectedWorkspace.creator!.agentId)} styles={styles} /> : null}</View> : null}
      {readWorkspaceLineage(selectedWorkspace.lineage)?.parent ? <Text selectable style={styles.layoutMenuHint}>{localizedCopy.sourceLabel}: {readWorkspaceLineage(selectedWorkspace.lineage)!.parent!.displayName}</Text> : null}
      {sourceAvailable === false ? <Text style={styles.layoutMenuHint}>{localizedCopy.sourceRemoved}</Text> : null}
      {selectedWorkspace.latestCommitObservedAt ? <Text style={styles.layoutMenuHint}>{localizedCopy.workspaceCommitObservedAt}: {timestamp(selectedWorkspace.latestCommitObservedAt)}</Text> : null}
    </View> : null}
    {onAddRepositories ? <LayoutMenuItem label={localizedCopy.addRepositoriesMenu} onPress={onAddRepositories} styles={styles} /> : null}
    {onSelectMainRepositories ? <LayoutMenuItem label={localizedCopy.mainSelectRepositories} onPress={onSelectMainRepositories} styles={styles} /> : null}
    {onSelectLinkedWorkspaces ? <LayoutMenuItem label={localizedCopy.linkedSelectWorkspaces} onPress={onSelectLinkedWorkspaces} styles={styles} /> : null}
    {onCreate ? <LayoutMenuItem label={localizedCopy.text_1623afda9e} onPress={onCreate} styles={styles} /> : null}
    {onSwitchProject ? <LayoutMenuItem label={localizedCopy.switchProject} onPress={onSwitchProject} styles={styles} /> : null}
    {onOpenStorage ? <LayoutMenuItem label={localizedCopy.storageMenu} onPress={onOpenStorage} styles={styles} /> : null}
    {onOpenExecution?<LayoutMenuItem label={localizedCopy.executionMenu} onPress={onOpenExecution} styles={styles}/>:null}
    {runtimeNotice}
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
  agentId,
  workspaces,
  historyWorkspaces,
  visibleWorkspaces,
  orphanCandidates,
  selectedWorkspace,
  selectedWorkspaceId,
  filter,
  open,
  loading,
  ready = true,
  refreshing,
  failure,
  onRetry,
  retrying = false,
  onOpen,
  onFilter,
  onSelect,
  onOpenOrphan,
  onRemoveWorkspace,
  onRestoreWorkspace,
  onPermanentDeleteWorkspace,
  onInspectWorkspace,
  lifecycleBusyWorkspaceIds,
  onBatch, batchBusy = false, batchAvailable = false, onBatchResults,
  onOpenLayoutMenu,
  latestCommitProgress,
  statusControl,
  executionControl,
  theme,
  styles,
}: {
  agentId?: string;
  workspaces: WorkspaceSummary[];
  historyWorkspaces: WorkspaceSummary[];
  visibleWorkspaces: WorkspaceSummary[];
  orphanCandidates?: Array<{ id: string; name: string; repositoryCount: number; resume?: boolean }>;
  selectedWorkspace?: WorkspaceSummary;
  selectedWorkspaceId: string;
  filter: WorkspaceFilter;
  open: boolean;
  loading: boolean;
  ready?: boolean;
  refreshing: boolean;
  failure: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  onOpen: () => void;
  onFilter: (filter: WorkspaceFilter) => void;
  onSelect: (id: string) => void;
  onOpenOrphan?: (id: string) => void;
  onRemoveWorkspace?: (workspace: WorkspaceSummary) => void;
  onRestoreWorkspace?: (workspace: WorkspaceSummary) => void;
  onPermanentDeleteWorkspace?: (workspace: WorkspaceSummary) => void;
  onInspectWorkspace?: (workspace: WorkspaceSummary) => void;
  lifecycleBusyWorkspaceIds?: readonly string[];
  onBatch?: (targets: WorkspaceSummary[], action: BatchAction) => void;
  batchBusy?: boolean; batchAvailable?: boolean; onBatchResults?: () => void;
  onOpenLayoutMenu?: () => void;
  latestCommitProgress?: { completed: number; total: number } | null;
  statusControl?: ReactNode;
  executionControl?: ReactNode;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const localizedCopy = useWorkbenchCopy();
  const [search, setSearch] = useState("");
  const [creatorFilter, setCreatorFilter] = useState<string | null>(null);
  const [creatorPickerOpen, setCreatorPickerOpen] = useState(false);
  const creators = useMemo(() => workspaceCreators([...workspaces,...historyWorkspaces]),[workspaces,historyWorkspaces]);
  const creatorLabel = (id: string) => { const name = creators.find(creator => creator.agentId === id)?.name; return name ? `${name} · ${id.slice(0,8)}` : id.slice(0,8); };
  const selectedCreator = creatorFilter;
  const creatorOptions = agentId && !creators.some(creator => creator.agentId === agentId)
    ? [{agentId,count:0},...creators] : creators;

  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useLayoutEffect(() => { setChecked(new Set()); }, [search, filter, batchMode, selectedCreator, agentId]);
  useEffect(() => { if (!open) { setBatchMode(false); setChecked(new Set()); setCreatorPickerOpen(false); } }, [open]);
  const listRef = useRef<import('react-native').FlatList<WorkspaceTreeRow>>(null);
  const scrollY = useRef(0);
  const previousRows = useRef<string[]>([]);
  const previousScope = useRef('');
  useEffect(() => { if (!open) setSearch(""); }, [open]);
  const searchedWorkspaces = useMemo(() => visibleWorkspaces.filter((workspace) => matchesWorkspaceSearch(workspace, search) && (!selectedCreator || createdInSession(workspace, selectedCreator))), [visibleWorkspaces, search, selectedCreator]);
  const forest = useMemo(() => workspaceForest([...workspaces, ...historyWorkspaces], searchedWorkspaces), [workspaces, historyWorkspaces, searchedWorkspaces]);
  const treeRows = useMemo(() => workspaceTreeRows(forest, collapsedSources, Boolean(search.trim())), [forest, collapsedSources, search]);
  const selectable = searchedWorkspaces.filter(workspace => batchEligible(workspace, filter === 'history' ? 'delete' : 'remove') && !lifecycleBusyWorkspaceIds?.includes(workspace.id));
  const selectedTargets = selectable.filter(workspace => checked.has(workspace.id));
  const selectedCount = searchedWorkspaces.filter(workspace => checked.has(workspace.id)).length;
  const toggleChecked = (id: string) => setChecked(prior => { const next = new Set(prior); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const scope = `${filter}:${search}:${selectedCreator || ""}`;
  const rowIdentity = JSON.stringify(treeRows.map(row => row.node.key));
  useLayoutEffect(() => {
    const ids: string[] = JSON.parse(rowIdentity), old = previousRows.current;
    if (previousScope.current === scope && old.length && open) {
      const offset = anchoredOffset(old, ids, scrollY.current, WORKSPACE_OPTION_HEIGHT);
      if (offset !== scrollY.current) { scrollY.current = offset; listRef.current?.scrollToOffset({ offset, animated: false }); }
    } else if (previousScope.current !== scope) { scrollY.current = 0; listRef.current?.scrollToOffset({ offset: 0, animated: false }); }
    previousRows.current = ids; previousScope.current = scope;
  }, [rowIdentity, scope, open]);
  const scopedWorkspaces = selectedCreator ? workspaces.filter(workspace => createdInSession(workspace, selectedCreator)) : workspaces;
  const scopedHistory = selectedCreator ? historyWorkspaces.filter(workspace => createdInSession(workspace, selectedCreator)) : historyWorkspaces;
  const scopedVisible = selectedCreator ? visibleWorkspaces.filter(workspace => createdInSession(workspace, selectedCreator)) : visibleWorkspaces;
  const attention = countWorkspaceFilter(scopedWorkspaces, "attention");
  const filters: { id: WorkspaceFilter; label: string; count: number }[] = [
    { id: "all", label: localizedCopy.text_778fc8f994, count: scopedWorkspaces.length },
    { id: "attention", label: localizedCopy.text_284b34e15f, count: attention },
    { id: "dirty", label: localizedCopy.workspaceStatusDirty, count: scopedWorkspaces.filter((workspace) => workspace.dirty).length },
    { id: "unpushed", label: localizedCopy.text_05162ec10a, count: scopedWorkspaces.filter((workspace) => workspace.unpushed).length },
    { id: "history", label: localizedCopy.text_be78b20585, count: scopedHistory.length },
  ];
  const workspaceTotal = filter === "history" ? scopedHistory.length : scopedWorkspaces.length;
  return (
    <View style={styles.selector}>
      <View testID="workbench-workspace-header" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable testID="workbench-workspace-selector-toggle" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onOpen} style={[styles.selectorButton, { flex: 1 }]}>
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
          {ready && !loading && !selectedWorkspace ? <Text numberOfLines={1} style={styles.selectorMeta}>{formatCopyFrom(localizedCopy, "text_2e046dd497", [workspaces.length])}</Text> : null}
        </View>
        <View style={styles.selectorChevron}>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {!ready && failure && onRetry ? <Pressable accessibilityRole="button" disabled={retrying} accessibilityState={{disabled:retrying,busy:retrying}} onPress={onRetry} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{retrying ? localizedCopy.observationRefreshing : localizedCopy.setupRetry}</Text></Pressable> : null}
      {executionControl}
      {statusControl}
      {onOpenLayoutMenu ? <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.text_1744b62533} onPress={onOpenLayoutMenu} style={[styles.layoutMenuButton, { width: 36, height: 36 }]}><Icon name="Ellipsis" size={18} color={theme.colors.foregroundMuted} /></Pressable> : null}
      </View>
      {open ? (
        <View style={styles.selectorExpanded}>
          <View style={styles.filterRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={localizedCopy.creatorFilter} accessibilityState={{ selected: Boolean(selectedCreator), expanded: creatorPickerOpen }} onPress={() => { if (!creatorPickerOpen && !selectedCreator && agentId) setCreatorFilter(agentId); setCreatorPickerOpen(value => !value); }} style={[styles.filterButton, selectedCreator && styles.filterButtonActive, {maxWidth:220,flexDirection:"row",alignItems:"center",gap:4}]}><Text numberOfLines={1} style={[styles.filterButtonText, selectedCreator && styles.filterButtonTextActive]}>{localizedCopy.creatorFilter}{selectedCreator ? `: ${creatorLabel(selectedCreator)}` : ''}</Text><Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted}/></Pressable>
            {filters.map((item) => (
              <Pressable
                key={item.id}
                accessibilityRole="button"
                accessibilityState={{ selected: filter === item.id }}
                onPress={() => onFilter(item.id)}
                style={[styles.filterButton, filter === item.id && styles.filterButtonActive]}
              >
                <Text style={[styles.filterButtonText, filter === item.id && styles.filterButtonTextActive]}>{item.label}</Text>
                {ready ? <Text style={[styles.filterCount, filter === item.id && styles.filterCountActive]}>{item.count}</Text> : null}
              </Pressable>
            ))}
          </View>
          {creatorPickerOpen ? <View style={{marginTop:6, borderWidth:1, borderColor:theme.colors.border, borderRadius:6}}>
            <Pressable accessibilityRole="button" onPress={() => {setCreatorFilter(null);setCreatorPickerOpen(false);}} style={styles.layoutMenuItem}><Text style={styles.filterButtonText}>{localizedCopy.allCreatorSessions}</Text></Pressable>
            <FlatList style={{maxHeight:160}} data={creatorOptions} keyExtractor={item=>item.agentId} keyboardShouldPersistTaps="handled" renderItem={({item})=><Pressable accessibilityRole="button" accessibilityState={{selected:item.agentId===selectedCreator}} onPress={()=>{setCreatorFilter(item.agentId);setCreatorPickerOpen(false);}} style={styles.layoutMenuItem}><Text numberOfLines={2} style={styles.filterButtonText}>{item.agentId===agentId ? `${localizedCopy.createdInSession} · ` : ''}{creatorLabel(item.agentId)} ({item.count})</Text></Pressable>} ListEmptyComponent={<Text style={styles.layoutMenuHint}>{localizedCopy.noCreatorSessions}</Text>} />
          </View> : null}
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
          {onBatch ? <View style={[styles.filterRow, { flexWrap: 'wrap', marginTop: 6 }]}>
            <Pressable accessibilityRole="button" onPress={() => setBatchMode(value => !value)} style={styles.filterButton}><Text style={styles.filterButtonText}>{batchMode ? localizedCopy.batchExit : localizedCopy.batchManage}</Text></Pressable>
            {batchAvailable ? <Pressable accessibilityRole="button" onPress={onBatchResults} style={styles.filterButton}><Text style={styles.filterButtonText}>{localizedCopy.batchResults}</Text></Pressable> : null}
            {batchMode ? <>
              <Pressable accessibilityRole="button" disabled={batchBusy} onPress={() => setChecked(selectedTargets.length === selectable.length ? new Set() : new Set(selectable.map(workspace => workspace.id)))} style={styles.filterButton}><Text style={styles.filterButtonText}>{selectedTargets.length > 0 && selectedTargets.length === selectable.length ? localizedCopy.batchClear : localizedCopy.batchSelectAll}</Text></Pressable>
              <Text style={styles.filterButtonText}>{localizedCopy.batchSelected} {selectedCount}</Text>
              {(filter === 'history' ? (['restore', 'delete'] as const) : (['remove'] as const)).filter(action => action === 'remove' ? !!onRemoveWorkspace : action === 'restore' ? !!onRestoreWorkspace : !!onPermanentDeleteWorkspace).map(action => <Pressable key={action} accessibilityRole="button" disabled={batchBusy || !selectedTargets.length} onPress={() => { onBatch(selectedTargets, action); }} style={[styles.filterButton, (batchBusy || !selectedTargets.length) && { opacity: 0.45 }]}><Text style={styles.filterButtonText}>{action === 'remove' ? localizedCopy.batchRemove : action === 'restore' ? localizedCopy.batchRestore : localizedCopy.batchDelete}</Text></Pressable>)}
            </> : null}
          </View> : null}
          <View style={styles.selectorListHeader}>
            <Text style={styles.selectorListLabel}>{localizedCopy.text_205b4561ed}</Text>
            {ready ? <Text style={styles.selectorListCount}>{search ? `${searchedWorkspaces.length}${localizedCopy.text_42099b4af0}${scopedVisible.length}` : `${scopedVisible.length}${localizedCopy.text_42099b4af0}${workspaceTotal}`}</Text> : null}
          </View>
          <FlatList
            testID="workbench-workspace-list"
            ref={listRef}
            onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y; }}
            scrollEventThrottle={16}
            extraData={[batchMode, checked, batchBusy, lifecycleBusyWorkspaceIds]}
            data={treeRows}
            getItemLayout={(_, index) => ({ length: WORKSPACE_OPTION_HEIGHT, offset: WORKSPACE_OPTION_HEIGHT * index, index })}
            keyExtractor={(row) => row.node.key}
            initialNumToRender={12}
            keyboardShouldPersistTaps="handled"
            maxToRenderPerBatch={20}
            nestedScrollEnabled
            removeClippedSubviews
            renderItem={({ item: { node, depth } }) => <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: WORKSPACE_OPTION_HEIGHT, paddingLeft: Math.min(depth, 6) * 12 }}>
              {node.children.length ? <Pressable accessibilityRole="button" accessibilityLabel={`${localizedCopy.sourceExpand} ${node.source.displayName}`} accessibilityState={{ expanded: Boolean(search.trim()) || !collapsedSources.has(node.key) }} disabled={Boolean(search.trim())} onPress={() => setCollapsedSources(prior => { const next = new Set(prior); next.has(node.key) ? next.delete(node.key) : next.add(node.key); return next; })} style={{ width: 21, paddingHorizontal: 4, paddingVertical: 10 }}><Icon name={search.trim() || !collapsedSources.has(node.key) ? 'ChevronDown' : 'ChevronRight'} size={13} color={theme.colors.foregroundMuted} /></Pressable> : depth > 0 ? <View style={{ width: 21 }} /> : null}
              {node.match && node.workspace ? <View style={{ flex: 1, minWidth: 0 }}><WorkspaceOption
                onSelect={batchMode ? toggleChecked : onSelect}
                checkbox={batchMode}
                checked={checked.has(node.workspace.id)}
                selectionDisabled={batchMode && (batchBusy || !selectable.some(item => item.id === node.workspace!.id))}
                selected={node.workspace.id === selectedWorkspaceId}
                styles={styles} theme={theme} workspace={node.workspace}
                onRemove={onRemoveWorkspace} onRestore={onRestoreWorkspace}
                onPermanentDelete={onPermanentDeleteWorkspace} onInspect={onInspectWorkspace}
                groupCount={node.children.length ? node.members.length : undefined}
                busy={Boolean(lifecycleBusyWorkspaceIds?.includes(node.workspace.id))}
              /></View> : <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 }}><Text numberOfLines={1} style={[styles.workspaceOptionMeta, { flexShrink: 1 }]}>{node.source.displayName}</Text><Text style={styles.selectorListCount}>{node.members.length}</Text></View>}
              {batchMode && node.children.length ? <Pressable accessibilityRole="button" accessibilityLabel={`${localizedCopy.sourceSelectGroup} ${node.source.displayName}`} disabled={batchBusy} onPress={() => setChecked(prior => new Set([...prior, ...node.members.filter(member => selectable.some(item => item.id === member.id)).map(member => member.id)]))} style={styles.workspaceOptionAction}><Text style={styles.workspaceOptionActionText}>{localizedCopy.sourceSelectGroup}</Text></Pressable> : null}
            </View>}
            showsVerticalScrollIndicator={treeRows.length > 7}
            style={styles.workspaceOptionList}
            windowSize={7}
            ListEmptyComponent={ready && !loading ? <Text style={styles.emptyText}>{search ? localizedCopy.workspaceSearchEmpty : localizedCopy.text_daa32fe25c}</Text> : null}
          />
          {!selectedCreator && filter === "all" && orphanCandidates?.length ? <View style={{ maxHeight: 170 }}>
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

function WorkspaceOption({ workspace, selected, onSelect, onRemove, onRestore, onPermanentDelete, onInspect, busy, groupCount, checkbox = false, checked = false, selectionDisabled = false, theme, styles }: {
  workspace: WorkspaceSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove?: (workspace: WorkspaceSummary) => void;
  onRestore?: (workspace: WorkspaceSummary) => void;
  onPermanentDelete?: (workspace: WorkspaceSummary) => void;
  onInspect?: (workspace: WorkspaceSummary) => void;
  busy: boolean;
  groupCount?: number;
  checkbox?: boolean; checked?: boolean; selectionDisabled?: boolean;
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
    <View testID={`workspace-option-${workspace.id}`} style={[styles.workspaceOption, selected && styles.workspaceOptionActive]}>
      <Pressable
        accessibilityRole={checkbox ? "checkbox" : "button"}
        accessibilityState={checkbox ? { checked, disabled: selectionDisabled } : { selected }}
        disabled={selectionDisabled}
        onPress={() => onSelect(workspace.id)}
        style={{ alignItems: "center", flex: 1, flexDirection: "row", gap: 7, minWidth: 0 }}
      >
        {checkbox ? <Text style={styles.workspaceOptionActionText}>{checked ? "☑" : "☐"}</Text> : null}
        <View style={[styles.workspaceStatusDot, { backgroundColor: statusTone }]} />
        <View style={styles.workspaceOptionCopy}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}><Text numberOfLines={1} style={[styles.workspaceOptionTitle, { flexShrink: 1 }]}>{workspaceDisplayName(workspace, localizedCopy)}</Text>{groupCount ? <Text style={styles.selectorListCount}>{groupCount}</Text> : null}</View>
          <Text numberOfLines={1} style={styles.workspaceOptionMeta}>{meta}</Text>
        </View>
        {status && status !== "active" ? <Text numberOfLines={1} style={[styles.workspaceOptionState, { color: statusTone }]}>{status}</Text> : null}
      </Pressable>
      {!checkbox && !isMainWorkspace(workspace) ? <View accessibilityState={{ busy }} style={styles.workspaceOptionActions}>
        {busy ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {onInspect ? <Pressable accessibilityLabel={localizedCopy.workspaceDeleteImpact} accessibilityRole="button" disabled={busy} onPress={() => onInspect(workspace)} style={styles.workspaceOptionAction}><Text style={styles.workspaceOptionActionText}>i</Text></Pressable> : null}
        {pending && onRestore ? <Pressable accessibilityLabel={localizedCopy.workspaceRestore} accessibilityRole="button" disabled={busy} onPress={() => onRestore(workspace)} style={styles.workspaceOptionAction}><Text style={[styles.workspaceOptionActionText, { color: observerAccent(theme) }]}>↩</Text></Pressable> : null}
        {!removed && !pending && onRemove ? <Pressable accessibilityLabel={localizedCopy.workspaceDelete} accessibilityRole="button" disabled={busy} onPress={() => onRemove(workspace)} style={styles.workspaceOptionAction}><Icon name="CircleX" size={15} color={observerAccent(theme)} /></Pressable> : null}
        {removed && onRestore ? <Pressable accessibilityLabel={localizedCopy.workspaceRestore} accessibilityRole="button" disabled={busy} onPress={() => onRestore(workspace)} style={styles.workspaceOptionAction}><Text style={[styles.workspaceOptionActionText, { color: observerAccent(theme) }]}>↩</Text></Pressable> : null}
        {removed && onPermanentDelete ? <Pressable accessibilityLabel={localizedCopy.workspacePermanentDelete} accessibilityRole="button" disabled={busy} onPress={() => onPermanentDelete(workspace)} style={styles.workspaceOptionAction}><Icon name="CircleX" size={15} color={theme.colors.statusDanger} /></Pressable> : null}
      </View> : null}
    </View>
  );
}
