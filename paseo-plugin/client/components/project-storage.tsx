import { Pressable, Text, View } from "react-native";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

import type { ProjectStorageInfo } from "../../shared/setup";
import { copy } from "../../shared/copy";
import { AnchoredMenu } from "./navigation";

type PanelProps = PluginWorkspacePanelProps | PluginAgentPanelProps;
type Theme = PanelProps["theme"];

export function ProjectStorageMenu({
  open,
  onClose,
  storage,
  loading,
  error,
  onRetry,
  compact,
  theme,
}: {
  open: boolean;
  onClose: () => void;
  storage?: ProjectStorageInfo;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  compact: boolean;
  theme: Theme;
}) {
  return (
    <AnchoredMenu open={open} onClose={onClose} theme={theme} width={compact ? 240 : 290}>
      <View style={{ gap: 8, padding: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{copy.storageMenu}</Text>
        {loading ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{copy.storageLoading}</Text> : null}
        {error ? (
          <View style={{ gap: 7 }}>
            <Text style={{ color: theme.colors.statusWarning, fontSize: 10 }}>{copy.storageUnavailable}</Text>
            <Pressable accessibilityRole="button" onPress={onRetry} style={{ alignSelf: "flex-start", backgroundColor: theme.colors.surface2, borderColor: theme.colors.border, borderRadius: 5, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 10, fontWeight: "600" }}>{copy.setupRetry}</Text>
            </Pressable>
          </View>
        ) : null}
        {storage ? (
          <>
            <StorageRow label={copy.storageConfig} value={storage.config} theme={theme} />
            <StorageRow label={copy.storageWorktrees} value={storage.worktrees} theme={theme} />
            <StorageRow label={copy.storageState} value={storage.state} theme={theme} />
            <StorageRow label={copy.storageSocket} value={storage.socket} theme={theme} />
            <StorageRow label="Git" text={gitIgnoreLabel(storage.ignoreMode)} theme={theme} />
          </>
        ) : null}
      </View>
    </AnchoredMenu>
  );
}

function StorageRow({ label, value, text, theme }: {
  label: string;
  value?: ProjectStorageInfo["config"];
  text?: string;
  theme: Theme;
}) {
  return (
    <View style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, gap: 2, paddingTop: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>{label}</Text>
      <Text selectable ellipsizeMode="middle" numberOfLines={1} style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 10 }}>
        {text || (value ? pathLabel(value) : "—")}
      </Text>
    </View>
  );
}

function pathLabel(value: ProjectStorageInfo["config"]): string {
  if (value.relativePath) return value.relativePath;
  if (value.location === "user") return `本机 · ${value.path}`;
  return `项目外 · ${value.path}`;
}

function gitIgnoreLabel(mode: ProjectStorageInfo["ignoreMode"]): string {
  if (mode === "local") return copy.storageGitLocal;
  if (mode === "shared") return copy.storageGitShared;
  if (mode === "ignored") return copy.storageGitIgnored;
  if (mode === "external") return copy.storageGitExternal;
  return copy.storageGitUnavailable;
}
