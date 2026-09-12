import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect,useState } from "react";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy } from "../../shared/copy";
import { IconButton } from "./icon-button";
import { observerAccent } from "../theme";

import {
ancestorPaths,
buildTreeRows,
defaultExpandedPaths,
type ChangeScope,
type ChangesResult,
type FileChange,
type SectionLayoutPreference,
type TreeRow
} from "../model";
import { ChangeCounts,fileColor,InlineRefresh,issueLabel,makeStyles,MiniTag,SectionDisclosureButton,SectionViewport,SmallToggle,visibleIssues } from "./ui";

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

export function ChangedTree({
  changes,
  loading,
  refreshing,
  error,
  stale,
  mode,
  onMode,
  scope,
  selectedCommit,
  selectedFile,
  onSelectFile,
  onLayout,
  sectionLayout,
  availableHeight,
  onSectionToggle,
  onHeightCommit,
  onOpenLayoutMenu,
  theme,
  styles,
}: {
  changes: ChangesResult | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  stale: boolean;
  mode: ChangeTreeMode;
  onMode: (mode: ChangeTreeMode) => void;
  scope: Exclude<ChangeScope, "commit">;
  selectedCommit: string;
  selectedFile: string;
  onSelectFile: (file: FileChange) => void;
  onLayout: (offset: number) => void;
  sectionLayout: SectionLayoutPreference;
  availableHeight: number;
  onSectionToggle: (collapsed: boolean) => void;
  onHeightCommit: (height: number | null) => void;
  onOpenLayoutMenu: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const files = changes?.files || [];
  const fileKey = files.map((file) => `${file.path}:${file.status}:${file.additions}:${file.deletions}`).join("|");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(defaultExpandedPaths(files, selectedFile));
  useEffect(() => {
    setExpandedPaths((current) => new Set([...current, ...ancestorPaths(selectedFile)]));
  }, [selectedFile]);
  const rows = mode === "tree"
    ? buildTreeRows(files, expandedPaths, selectedFile)
    : files.slice().sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ kind: "file" as const, file, depth: 0 }));

  function toggleDirectory(path: string): void {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <View
      onLayout={(event) => onLayout(event.nativeEvent.layout.y)}
      style={styles.treeSection}
    >
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <SectionDisclosureButton
            expanded={!sectionLayout.collapsed}
            label={selectedCommit ? copy.text_b5d0217a47 : scope === "working" ? copy.text_b6a933155a : copy.text_f30d1e7faf}
            onLongPress={onOpenLayoutMenu}
            onPress={() => onSectionToggle(!sectionLayout.collapsed)}
            theme={theme}
            styles={styles}
          />
          <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
          {stale ? <View accessibilityLabel={copy.observationStale} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.statusWarning }} /> : null}
        </View>
        <View style={styles.treeHeaderRight}>
          <Text style={styles.sectionCount}>{loading ? "…" : `${files.length} files`}</Text>
          <IconButton label={copy.text_41e5243e2d} icon="FolderTree" active={mode === "tree"} color={mode === "tree" ? theme.colors.accentForeground : theme.colors.foregroundMuted} background={mode === "tree" ? observerAccent(theme) : undefined} onPress={() => onMode("tree")} />
          <IconButton label={copy.text_49deaf7da2} icon="List" active={mode === "files"} color={mode === "files" ? theme.colors.accentForeground : theme.colors.foregroundMuted} background={mode === "files" ? observerAccent(theme) : undefined} onPress={() => onMode("files")} />
        </View>
      </View>
      {!sectionLayout.collapsed ? (
        <SectionViewport
          id="changes"
          layout={sectionLayout}
          availableHeight={availableHeight}
          resizable={false}
          onHeightCommit={onHeightCommit}
          theme={theme}
          styles={styles}
        >
          {error ? <Text style={styles.warningText}>{error}</Text> : null}
          {rows.map((row) => row.kind === "directory" ? (
            <DirectoryRow
              key={row.path}
              row={row}
              expanded={expandedPaths.has(row.path) || ancestorPaths(selectedFile).includes(row.path)}
              onPress={() => toggleDirectory(row.path)}
              theme={theme}
              styles={styles}
            />
          ) : (
            <FileChangeRow
              key={`${row.file.path}-${row.file.status}`}
              file={row.file}
              depth={row.depth}
              selected={selectedFile === row.file.path}
              onPress={() => onSelectFile(row.file)}
              theme={theme}
              styles={styles}
            />
          ))}
          {!loading && !files.length && !stale ? <Text style={styles.emptyText}>{copy.text_5ee36e41d4}</Text> : null}
          {visibleIssues(changes?.issues || []).map((issue) => <Text key={`${issue.code}-${issue.path || ""}`} style={styles.warningText}>{issueLabel(issue)}</Text>)}
        </SectionViewport>
      ) : null}
    </View>
  );
}

export function DirectoryRow({
  row,
  expanded,
  onPress,
  theme,
  styles,
}: {
  row: Extract<TreeRow, { kind: "directory" }>;
  expanded: boolean;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.directoryRow, { paddingLeft: 4 + row.depth * 14 }]}>
      <View style={styles.folderChevron}>
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
      </View>
      <Text numberOfLines={1} style={styles.folderText}>{row.label}</Text>
      <View style={styles.directoryStats}>
        <Text style={styles.directoryFileCount}>{row.fileCount} ·</Text>
        <ChangeCounts additions={row.additions} deletions={row.deletions} styles={styles} />
      </View>
    </Pressable>
  );
}

export function FileChangeRow({
  file,
  depth,
  selected,
  onPress,
  theme,
  styles,
}: {
  file: FileChange;
  depth: number;
  selected: boolean;
  onPress: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const label = file.oldPath ? `${file.path} ← ${file.oldPath}` : file.path;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.fileRow, selected && styles.fileRowActive, { paddingLeft: 4 + depth * 14 }]}>
      <Text style={[styles.fileBadge, { color: fileColor(file.status, theme) }]}>{file.status || "M"}</Text>
      <Text numberOfLines={1} style={styles.filePath}>{label}</Text>
      {file.binary ? <MiniTag label="BIN" color={theme.colors.foregroundMuted} styles={styles} /> : null}
      <ChangeCounts additions={file.additions} deletions={file.deletions} styles={styles} />
    </Pressable>
  );
}
