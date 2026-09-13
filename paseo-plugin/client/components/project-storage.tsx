import { Pressable, Text, View } from "react-native";
import type { PluginAgentPanelProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";

import type { WorkbenchCopy } from "../../shared/copy";
import type { ProjectStorageInfo } from "../../shared/setup";
import { AnchoredMenu } from "./navigation";
import { useWorkbenchCopy } from "../i18n";

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
  const copy = useWorkbenchCopy();
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
            <StorageRow copy={copy} label={copy.storageConfig} value={storage.config} theme={theme} />
            <StorageRow copy={copy} label={copy.storageWorktrees} value={storage.worktrees} theme={theme} />
            <StorageRow copy={copy} label={copy.storageState} value={storage.state} theme={theme} />
            <StorageRow copy={copy} label={copy.storageSocket} value={storage.socket} theme={theme} />
            <StorageRow copy={copy} label={copy.gitLabel} text={gitIgnoreLabel(storage.ignoreMode, copy)} theme={theme} />
          </>
        ) : null}
      </View>
    </AnchoredMenu>
  );
}

function StorageRow({ copy, label, value, text, theme }: {
  copy: WorkbenchCopy;
  label: string;
  value?: ProjectStorageInfo["config"];
  text?: string;
  theme: Theme;
}) {
  return (
    <View style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, gap: 2, paddingTop: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "700", textTransform: "uppercase" }}>{label}</Text>
      <Text selectable ellipsizeMode="middle" numberOfLines={1} style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 10 }}>
        {text || (value ? pathLabel(value, copy) : "—")}
      </Text>
    </View>
  );
}

function pathLabel(value: ProjectStorageInfo["config"], copy: WorkbenchCopy): string {
  if (value.relativePath) return value.relativePath;
  if (value.location === "user") return copy.localStorageLabel.replace("{0}", value.path);
  return copy.externalStorageLabel.replace("{0}", value.path);
}

function gitIgnoreLabel(mode: ProjectStorageInfo["ignoreMode"], copy: ReturnType<typeof useWorkbenchCopy>): string {
  if (mode === "local") return copy.storageGitLocal;
  if (mode === "shared") return copy.storageGitShared;
  if (mode === "ignored") return copy.storageGitIgnored;
  if (mode === "external") return copy.storageGitExternal;
  return copy.storageGitUnavailable;
}
