import {
type PluginAgentPanelProps,
type PluginWorkspacePanelProps
} from "@getpaseo/plugin/client";
import { ActivityIndicator,Platform,Pressable,Text,View,type ViewStyle } from "react-native";
import { copy, formatCopyFrom, type WorkbenchCopy } from "../../shared/copy";

import {
type WorkspaceBindingResponse
} from "../../shared/handoff";
import { InlineRefresh,makeStyles } from "./ui";
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

export function executionStatusLabel(status: string | undefined | null, strings: WorkbenchCopy = copy): string {
  const labels: Record<string, string> = {
    pending: strings.text_15c5640f77,
    initializing: strings.text_fb0309dda4,
    running: strings.text_1f425b6bf0,
    idle: strings.text_837e7a109a,
    permission: strings.text_4c5958e011,
    completed: strings.text_e99b48a29b,
    blocked: strings.text_059c4d4016,
    error: strings.text_9746cfc7d2,
    closed: strings.text_f628761bf5,
    archived: strings.text_5cfbea2b76,
    "not-started": strings.text_87f8d08d81,
  };
  return labels[status || "not-started"] || status || strings.text_87f8d08d81;
}

export function executionStatusColor(status: string | undefined | null, theme: PanelProps["theme"]): string {
  if (["running", "initializing", "completed", "idle"].includes(status || "")) return theme.colors.statusSuccess;
  if (["permission", "blocked", "pending"].includes(status || "")) return theme.colors.statusWarning;
  if (["error", "closed", "archived"].includes(status || "")) return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export function ExecutionBindingCard({
  workspaceId,
  binding,
  agent,
  loading,
  refreshing,
  error,
  canDelegate,
  agentContextState,
  delegating,
  onDelegate,
  onOpenAgent,
  theme,
  styles,
}: {
  workspaceId: string;
  binding: WorkspaceBindingResponse["binding"];
  agent: WorkspaceBindingResponse["agent"];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  canDelegate: boolean;
  agentContextState?: "ready" | "loading" | "unavailable" | "missing";
  delegating: boolean;
  onDelegate: () => void;
  onOpenAgent?: () => void;
  theme: PanelProps["theme"];
  styles: ReturnType<typeof makeStyles>;
}) {
  if (!workspaceId) return null;
  const localizedCopy = useWorkbenchCopy();
  const bindingStatus = binding?.status;
  const relationshipLabel = binding?.relationship === "child" ? localizedCopy.reviewSettingsChildAgent : binding?.relationship === "independent" ? localizedCopy.reviewSettingsIndependent : localizedCopy.reviewSettingsFollowExecution;
  const status = bindingStatus && ["completed", "blocked", "permission", "error", "archived"].includes(bindingStatus)
    ? bindingStatus
    : agent?.status || bindingStatus || "not-started";
  const statusColor = error && !loading || agentContextState === "unavailable" ? theme.colors.statusWarning : executionStatusColor(status, theme);
  const statusText = loading
    ? localizedCopy.text_b21b631cd5
    : agentContextState === "loading"
      ? localizedCopy.agentContextLoading
      : agentContextState === "unavailable" && !binding
        ? localizedCopy.agentContextUnavailable
        : error && !binding && !agent
          ? localizedCopy.text_95abdc4ebd
          : !canDelegate && !binding
            ? localizedCopy.agentCoordinatorRequired
            : executionStatusLabel(status, localizedCopy);
  const recoverable = canDelegate && ["error", "blocked", "closed"].includes(status);
  return (
    <View style={styles.executionBar} accessibilityLabel={formatCopyFrom(localizedCopy, "text_f41a05dfe8", [statusText])}>
      <View style={styles.executionSummary}>
        <View style={[styles.executionStatusDot, { backgroundColor: statusColor }]} />
        <Text style={styles.executionLabel}>{relationshipLabel}</Text>
        <View style={[styles.executionStatus, { borderColor: statusColor }]}>
          <Text style={[styles.executionStatusText, { color: statusColor }]}>{statusText}</Text>
        </View>
        <Text style={styles.executionStatusText}>{agent?.planningState === "plan" ? "计划" : agent?.planningState === "execute" ? "执行" : "模式未知"} · 权限：{agent?.permissionModeId || "未知"}</Text>
        <InlineRefresh visible={refreshing} theme={theme} styles={styles} />
      </View>
      {recoverable || onOpenAgent ? (
        <View style={styles.executionActions}>
          {onOpenAgent ? (
            <Pressable accessibilityRole="button" disabled={delegating} onPress={onOpenAgent} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{localizedCopy.text_f7acefd2d4}</Text>
            </Pressable>
          ) : null}
          {recoverable ? (
            <Pressable accessibilityRole="button" disabled={delegating} onPress={onDelegate} style={[styles.secondaryButton, delegating && styles.executionButtonDisabled]}>
              {delegating ? <ActivityIndicator color={theme.colors.foregroundMuted} size="small" /> : null}
              <Text style={styles.secondaryButtonText}>{localizedCopy.text_2b6021df2f}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
