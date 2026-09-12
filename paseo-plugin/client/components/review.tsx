import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy } from "../../shared/copy";

import {
type ReviewResult,
type WorkspaceSummary
} from "../model";
import { ChangeCounts,InlineRefresh,StatusPill,makeStyles,relationLabel,repositoryCountLabel,statusColor,workspaceSignals } from "./ui";

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

export function ReviewView({
  workspaces,
  review,
  refreshing,
  error,
  reviewIds,
  onToggle,
  targetOverrides,
  onTargetOverride,
  onCopy,
  theme,
  styles,
}: {
  workspaces: WorkspaceSummary[];
  review: ReviewResult | null;
  refreshing: boolean;
  error: string | null;
  reviewIds: string[];
  onToggle: (id: string) => void;
  targetOverrides: Record<string, string>;
  onTargetOverride: (repoPath: string, value: string) => void;
  onCopy: (text: string) => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  const [briefOpen, setBriefOpen] = useState(false);

  return (
    <View style={styles.reviewPanel}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleRow}>
          <Text style={styles.sectionTitle}>{copy.text_5200400653}</Text>
          <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
        </View>
        <Text style={styles.sectionCount}>{reviewIds.length}</Text>
      </View>
      {error ? <Text style={styles.warningText}>{error}</Text> : null}
      <View style={styles.reviewWorkspaceList}>
        {workspaces.map((workspace) => {
          const selected = reviewIds.includes(workspace.id);
          const signals = workspaceSignals(workspace);
          return (
            <Pressable
              key={workspace.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              onPress={() => onToggle(workspace.id)}
              style={[styles.reviewWorkspaceRow, selected && styles.reviewWorkspaceRowActive]}
            >
              <View style={[styles.checkbox, selected && styles.checkboxActive]}>{selected ? <Text style={styles.checkboxTick}>✓</Text> : null}</View>
              <View style={styles.reviewWorkspaceCopy}>
                <Text numberOfLines={1} style={styles.reviewWorkspaceName}>{workspace.id}</Text>
                <Text numberOfLines={1} style={styles.reviewWorkspaceMeta}>{repositoryCountLabel(workspace.repositoryCount)}{signals.length ? ` · ${signals.join(" · ")}` : ""}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {review ? (
        <>
          {(review.repositories || []).map((repository) => (
            <View key={repository.repoPath} style={styles.reviewRepo}>
              <View style={styles.sectionHeader}>
                <View style={styles.reviewRepoCopy}>
                  <Text style={styles.sectionTitle}>{repository.repoPath}</Text>
                  <Text style={styles.sectionCount}>
                    {repository.aggregate.commits} {copy.text_91a9479226}<ChangeCounts additions={repository.aggregate.additions} deletions={repository.aggregate.deletions} styles={styles} />
                  </Text>
                </View>
                <StatusPill status={repository.status} label={relationLabel(repository.status)} theme={theme} styles={styles} />
              </View>
              <View style={styles.targetRow}>
                <TextInput
                  editable
                  accessibilityLabel={`${repository.repoPath} target branch`}
                  onChangeText={(value: string) => onTargetOverride(repository.repoPath, value)}
                  placeholder={copy.text_e50d9d028a}
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={styles.targetInput}
                  value={targetOverrides[repository.repoPath] || ""}
                />
              </View>
              {repository.entries.map((entry) => (
                <View key={entry.workspaceId} style={styles.reviewEntry}>
                <View style={styles.reviewEntryCopy}>
                  <Text numberOfLines={1} style={styles.reviewBranch}>{entry.branch || "detached"}</Text>
                    {entry.dirty || entry.unpushed ? <Text numberOfLines={1} style={styles.reviewEntryMeta}>{[entry.dirty ? "dirty" : "", entry.unpushed ? "unpushed" : ""].filter(Boolean).join(" · ")}</Text> : null}
                  </View>
                  <Text style={styles.arrowText}>→</Text>
                  <View style={styles.reviewTarget}>
                    <Text numberOfLines={1} style={styles.reviewBranch}>{entry.targetBranch || copy.text_a5b4c3b08d}</Text>
                    <Text style={[styles.relationText, { color: statusColor(entry.relation, theme) }]}>{relationLabel(entry.relation)}</Text>
                  </View>
                </View>
              ))}
              {repository.overlaps.map((overlap) => <Text key={overlap.path} style={styles.warningText}>{copy.text_9de8dab0bd}{overlap.path}</Text>)}
            </View>
          ))}
          {review.brief ? (
            <View style={styles.briefPanel}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>{copy.text_be8ffa22c8}</Text>
                <View style={styles.briefActions}>
                  <Pressable accessibilityRole="button" onPress={() => onCopy(review.brief?.text || "")} style={styles.copyButton}><Text style={styles.copyButtonText}>{copy.text_55f59bc2f0}</Text></Pressable>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: briefOpen }} onPress={() => setBriefOpen((current) => !current)} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>{briefOpen ? copy.text_5d5815647c : copy.text_b0e24833f7}</Text>
                  </Pressable>
                </View>
              </View>
              <View style={styles.copyByRepo}>
                {Object.entries(review.brief.byRepository).filter(([repo]) => repo !== "all").map(([repo, text]) => <Pressable key={repo} onPress={() => onCopy(text)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{repo}</Text></Pressable>)}
              </View>
              {briefOpen ? <Text selectable style={styles.briefText}>{review.brief.text}</Text> : null}
            </View>
          ) : null}
        </>
      ) : <Text style={styles.emptyText}>{copy.text_5e509c6853}</Text>}
    </View>
  );
}
