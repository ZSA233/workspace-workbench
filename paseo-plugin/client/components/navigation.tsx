import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, type ReactNode } from "react";
import { BackHandler,Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy, formatCopy } from "../../shared/copy";

import {
countWorkspaceFilter,
type WorkspaceFilter,
type WorkspaceSummary
} from "../model";
import { observerAccent } from "../theme";
import { InlineRefresh,LayoutMenuItem,isMainWorkspace,makeStyles,repositoryCountLabel,workspaceDisplayName,workspaceMeta } from "./ui";

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
  return (
    <View style={styles.panelHeader}>
      <View style={styles.panelTitleGroup}>
        <View style={styles.pluginIcon}><Icon name="GitBranch" size={14} color={observerAccent(theme)} /></View>
        <Text style={styles.panelTitle}>{copy.text_6cea90adcf}</Text>
      </View>
      <View style={styles.panelHeaderActions}>
        <Text style={styles.readOnlyText}>{agentEnabled ? copy.text_ca42ecd50e : copy.readOnlyObservation}</Text>
        <Pressable
          accessibilityLabel={copy.text_1744b62533}
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
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return <AnchoredMenu open={open} onClose={onClose} theme={theme}>
    {onCreate ? <LayoutMenuItem label={copy.text_1623afda9e} onPress={onCreate} styles={styles} /> : null}
    {onSwitchProject ? <LayoutMenuItem label={copy.switchProject} onPress={onSwitchProject} styles={styles} /> : null}
    <LayoutMenuItem label={copy.text_5f6a1bf190} onPress={onCollapseAll} styles={styles} />
    <LayoutMenuItem label={copy.text_66c98ab6d8} onPress={onExpandAll} styles={styles} />
    <LayoutMenuItem label={copy.text_e003f209ca} onPress={onReset} styles={styles} />
  </AnchoredMenu>;
}

export function AnchoredMenu({ open, onClose, theme, children }: { open: boolean; onClose(): void; theme: PanelProps["theme"]; children: ReactNode }) {
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
      <Pressable accessibilityLabel={copy.text_4d0b4688c7} onPress={onClose} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} />
      <View accessibilityRole="menu" style={{ position: "absolute", top: 40, right: 12, width: 190, padding: 6, borderRadius: 6, backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1 }}>
        {children}
      </View>
    </View>
  );
}

export function WorkspaceSelector({
  workspaces,
  historyWorkspaces,
  visibleWorkspaces,
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
  onOpenLayoutMenu,
  statusControl,
  theme,
  styles,
}: {
  workspaces: WorkspaceSummary[];
  historyWorkspaces: WorkspaceSummary[];
  visibleWorkspaces: WorkspaceSummary[];
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
  onOpenLayoutMenu?: () => void;
  statusControl?: ReactNode;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const attention = countWorkspaceFilter(workspaces, "attention");
  const filters: { id: WorkspaceFilter; label: string; count: number }[] = [
    { id: "all", label: copy.text_778fc8f994, count: workspaces.length },
    { id: "attention", label: copy.text_284b34e15f, count: attention },
    { id: "dirty", label: "dirty", count: workspaces.filter((workspace) => workspace.dirty).length },
    { id: "unpushed", label: copy.text_05162ec10a, count: workspaces.filter((workspace) => workspace.unpushed).length },
    { id: "history", label: copy.text_be78b20585, count: historyWorkspaces.length },
  ];
  return (
    <View style={styles.selector}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onOpen} style={[styles.selectorButton, { flex: 1 }]}>
        <View style={styles.selectorCopy}>
          <View style={styles.selectorValueRow}>
            <Text numberOfLines={1} style={styles.selectorValue}>{workspaceDisplayName(selectedWorkspace)}</Text>
            <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
          </View>
          {loading ? <Text numberOfLines={1} style={styles.selectorMeta}>{copy.text_80bf719ff7}</Text> : null}
          {!loading && !selectedWorkspace && failure ? <Text numberOfLines={2} style={styles.selectorFailure}>{failure}</Text> : null}
          {!loading && selectedWorkspace && workspaceMeta(selectedWorkspace) ? (
            <Text numberOfLines={1} style={styles.selectorMeta}>{workspaceMeta(selectedWorkspace)}</Text>
          ) : null}
          {!loading && !selectedWorkspace ? <Text numberOfLines={1} style={styles.selectorMeta}>{formatCopy("text_2e046dd497", [workspaces.length])}</Text> : null}
        </View>
        <View style={styles.selectorChevron}>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={theme.colors.foregroundMuted} />
        </View>
      </Pressable>
      {statusControl}
      {onOpenLayoutMenu ? <Pressable accessibilityRole="button" accessibilityLabel={copy.text_1744b62533} onPress={onOpenLayoutMenu} style={[styles.layoutMenuButton, { width: 36, height: 36 }]}><Icon name="Ellipsis" size={18} color={theme.colors.foregroundMuted} /></Pressable> : null}
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
          <View style={styles.selectorListHeader}>
            <Text style={styles.selectorListLabel}>{copy.text_205b4561ed}</Text>
            <Text style={styles.selectorListCount}>{visibleWorkspaces.length}{copy.text_42099b4af0}{workspaces.length}</Text>
          </View>
          {visibleWorkspaces.map((workspace) => {
            const selected = workspace.id === selectedWorkspaceId;
            const status = isMainWorkspace(workspace)
              ? ""
              : workspace.dirty
              ? "dirty"
              : workspace.unpushed
                ? "unpushed"
                : workspace.blockerCount > 0
                  ? "needs review"
                  : workspace.state !== "active"
                    ? workspace.state
                    : "";
            const statusTone = isMainWorkspace(workspace)
              ? observerAccent(theme)
              : workspace.dirty || workspace.unpushed || workspace.blockerCount > 0
              ? theme.colors.statusWarning
              : workspace.observationStale || workspace.dirty === null
              ? theme.colors.foregroundMuted
              : theme.colors.statusSuccess;
            return (
              <Pressable
                key={workspace.id}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onSelect(workspace.id)}
                style={[styles.workspaceOption, selected && styles.workspaceOptionActive]}
              >
                <View style={[styles.workspaceStatusDot, { backgroundColor: statusTone }]} />
                <View style={styles.workspaceOptionCopy}>
                  <Text numberOfLines={1} style={styles.workspaceOptionTitle}>{workspaceDisplayName(workspace)}</Text>
                  <Text numberOfLines={1} style={styles.workspaceOptionMeta}>{repositoryCountLabel(workspace.repositoryCount)}</Text>
                </View>
                {status && status !== "active" ? <Text style={[styles.workspaceOptionState, { color: statusTone }]}>{status}</Text> : null}
              </Pressable>
            );
          })}
          {!loading && visibleWorkspaces.length === 0 ? <Text style={styles.emptyText}>{copy.text_daa32fe25c}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}
