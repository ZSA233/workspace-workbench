import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { Icon,Modal } from "@getpaseo/plugin/client/react-native";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
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
  theme,
  styles,
}: {
  open: boolean;
  onClose: () => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onReset: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Modal
      icon={<Icon name="GitBranch" size={15} color={observerAccent(theme)} />}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={copy.text_88b31c6b96}
    >
      <Modal.Content contentContainerStyle={styles.layoutMenuContent} scrollable={false}>
        <Text style={styles.layoutMenuHint}>{copy.text_07333899fd}</Text>
        <LayoutMenuItem label={copy.text_5f6a1bf190} onPress={onCollapseAll} styles={styles} />
        <LayoutMenuItem label={copy.text_66c98ab6d8} onPress={onExpandAll} styles={styles} />
        <LayoutMenuItem label={copy.text_e003f209ca} onPress={onReset} styles={styles} />
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.layoutMenuCancel}>
          <Text style={styles.layoutMenuCancelText}>{copy.text_4d0b4688c7}</Text>
        </Pressable>
      </Modal.Content>
    </Modal>
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
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onOpen} style={styles.selectorButton}>
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
                  <Text numberOfLines={1} style={styles.workspaceOptionMeta}>{isMainWorkspace(workspace) ? copy.text_4f91d2c9ad : repositoryCountLabel(workspace.repositoryCount)}</Text>
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
