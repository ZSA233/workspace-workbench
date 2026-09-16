import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useEffect, useState, type ReactNode } from "react";
import { projectSetupSave, projectSetupScan, type ProjectBackendStatus, type ProjectSetupScan, type ProjectSetupSave } from "../../shared/setup.ts";
import { observerAccent } from "../theme.ts";
import { useWorkbenchCopy } from "../i18n";

type Theme = PluginWorkspacePanelProps["theme"];

export function ProjectSetup({ directory, theme, onSaved }: {
  directory: string;
  theme: Theme;
  onSaved: (project: ProjectSetupSave["project"], backend: ProjectBackendStatus) => void;
}) {
  const copy = useWorkbenchCopy();
  const scan = useRpc(projectSetupScan);
  const save = useRpc(projectSetupSave);
  const scanQuery = useQuery({
    queryKey: ["workspace-workbench", "project-setup", directory],
    queryFn: () => scan({ directory }),
    enabled: Boolean(directory),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [selectedPaths, setSelectedPaths] = useSetupSelection(scanQuery.data);
  const [shareConfig, setShareConfig] = useStateWithInitial(false);
  const [showNested, setShowNested] = useStateWithInitial(false);
  const [showAdvanced, setShowAdvanced] = useStateWithInitial(false);
  const [saving, setSaving] = useStateWithInitial(false);
  const [error, setError] = useStateWithInitial("");
  const [backendStatus, setBackendStatus] = useStateWithInitial<ProjectBackendStatus | null>(null);
  const data = scanQuery.data;
  const nested = data?.repositories.filter((repository) => repository.kind === "nested") || [];
  const canSave = Boolean(data && selectedPaths.length && selectedPaths.every((path) => data.repositories.some((repository) => repository.repoPath === path && repository.valid)));
  const accent = observerAccent(theme);

  async function saveProject(): Promise<void> {
    if (!canSave || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await save({ directory, repositories: selectedPaths, shareConfig });
      setBackendStatus(result.backend);
      if (result.backend.state === "ready") onSaved(result.project, result.backend);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.setupSaveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 15, gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "700" }}>{copy.setupTitle}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
          {copy.setupDescription}
        </Text>
      </View>

      {scanQuery.isPending ? (
        <View style={{ alignItems: "center", gap: 8, paddingVertical: 26 }}>
          <ActivityIndicator color={accent} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{copy.setupScanning}</Text>
        </View>
      ) : null}

      {scanQuery.isError ? (
        <SetupCard theme={theme} borderColor={theme.colors.statusWarning}>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13, fontWeight: "700" }}>{copy.setupScanFailed}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{scanQuery.error instanceof Error ? scanQuery.error.message : copy.setupScanFailed}</Text>
          <ActionButton label={copy.setupRetry} onPress={() => { void scanQuery.refetch(); }} theme={theme} />
        </SetupCard>
      ) : null}
      {data?.scan?.incomplete ? <SetupCard theme={theme} borderColor={theme.colors.statusWarning}>
        <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{copy.repositoryScanIncomplete}</Text>
      </SetupCard> : null}

      {!scanQuery.isPending && data && !data.repositories.length ? (
        <SetupCard theme={theme} borderColor={theme.colors.statusWarning}>
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13, fontWeight: "700" }}>{copy.setupNoGit}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>{copy.setupGitHint}</Text>
        </SetupCard>
      ) : null}

      {data && data.repositories.length ? (
        <>
          <SetupCard theme={theme}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>{copy.setupProjectRoot}</Text>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{data.displayName}</Text>
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>{data.projectRoot}</Text>
          </SetupCard>

          <SetupCard theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "700" }}>{copy.setupRepositories}</Text>
            {data.repositories.filter((repository) => repository.kind === "root").map((repository) => (
              <RepositoryOption
                key={repository.repoPath}
                repository={repository}
                selected={selectedPaths.includes(repository.repoPath)}
                label={copy.setupParentRepository}
                onPress={() => togglePath(repository.repoPath, selectedPaths, setSelectedPaths)}
                theme={theme}
              />
            ))}
            {nested.length ? (
              <Pressable accessibilityRole="button" onPress={() => setShowNested((current) => !current)} style={{ paddingVertical: 7 }}>
                <Text style={{ color: accent, fontSize: 11, fontWeight: "600" }}>{showNested ? "⌄" : "›"} {copy.setupNestedRepositories} ({nested.length})</Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 }}>{copy.setupNestedHint}</Text>
              </Pressable>
            ) : null}
            {(showNested || !data.gitRoot) ? nested.map((repository) => (
              <RepositoryOption
                key={repository.repoPath}
                repository={repository}
                selected={selectedPaths.includes(repository.repoPath)}
                onPress={() => togglePath(repository.repoPath, selectedPaths, setSelectedPaths)}
                theme={theme}
              />
            )) : null}
            {!nested.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{copy.setupNoNested}</Text> : null}
          </SetupCard>

          <SetupCard theme={theme}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", textTransform: "uppercase" }}>{copy.setupStorage}</Text>
            <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11 }}>{data.configRelativePath}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{copy.setupSideEffect}</Text>
          </SetupCard>

          <SetupCard theme={theme}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: showAdvanced }} onPress={() => setShowAdvanced((current) => !current)} style={{ paddingVertical: 2 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{showAdvanced ? "⌄" : "›"} {copy.setupAdvanced}</Text>
            </Pressable>
            {showAdvanced ? (
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: shareConfig }} onPress={() => setShareConfig((current) => !current)} style={{ flexDirection: "row", gap: 9, paddingTop: 6 }}>
                <Text style={{ color: shareConfig ? accent : theme.colors.foregroundMuted, fontSize: 16, lineHeight: 18 }}>{shareConfig ? "☑" : "☐"}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{copy.setupShareConfig}</Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 }}>{shareConfig ? copy.setupShareHint : copy.setupLocalOnly}</Text>
                </View>
              </Pressable>
            ) : null}
          </SetupCard>

          {backendStatus && backendStatus.state !== "ready" ? (
            <SetupCard theme={theme} borderColor={theme.colors.statusWarning}>
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12, fontWeight: "700" }}>{backendStatus.state === "missing" ? copy.setupBackendMissing : copy.setupBackendFailed}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, lineHeight: 14 }}>{backendStatus.message || copy.setupBackendRetryHint}</Text>
            </SetupCard>
          ) : null}

          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11, lineHeight: 15 }}>{error}</Text> : null}
          <ActionButton label={saving ? copy.setupSaving : backendStatus ? copy.setupRetry : copy.setupSave} onPress={() => { void saveProject(); }} disabled={!canSave || saving} primary theme={theme} />
        </>
      ) : null}
    </ScrollView>
  );
}

function SetupCard({ theme, borderColor, children }: { theme: Theme; borderColor?: string; children: ReactNode }) {
  return <View style={{ backgroundColor: theme.colors.surface1, borderColor: borderColor || theme.colors.border, borderRadius: 8, borderWidth: 1, gap: 7, padding: 12 }}>{children}</View>;
}

function ActionButton({ label, onPress, theme, disabled = false, primary = false }: { label: string; onPress: () => void; theme: Theme; disabled?: boolean; primary?: boolean }) {
  const color = primary ? observerAccent(theme) : theme.colors.surface2;
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ alignItems: "center", backgroundColor: color, borderColor: primary ? color : theme.colors.border, borderRadius: 6, borderWidth: 1, minHeight: 36, justifyContent: "center", opacity: disabled ? 0.5 : 1, paddingHorizontal: 12 }}><Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{label}</Text></Pressable>;
}

function RepositoryOption({ repository, selected, label, onPress, theme }: { repository: ProjectSetupScan["repositories"][number]; selected: boolean; label?: string; onPress: () => void; theme: Theme }) {
  const copy = useWorkbenchCopy();
  const accent = observerAccent(theme);
  const branch = repository.branch || (repository.head ? copy.setupDetached : copy.setupNoCommits);
  const state = !repository.valid
    ? copy.setupInvalidRepository
    : repository.dirty === true
      ? copy.setupDirty
      : repository.dirty === false
        ? copy.setupClean
        : "";
  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected, disabled: !repository.valid }} disabled={!repository.valid} onPress={onPress} style={{ borderTopColor: theme.colors.border, borderTopWidth: 1, flexDirection: "row", gap: 8, opacity: repository.valid ? 1 : 0.5, paddingVertical: 9 }}>
    <Text style={{ color: selected ? accent : theme.colors.foregroundMuted, fontSize: 16, lineHeight: 18 }}>{selected ? "☑" : "☐"}</Text>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11, fontWeight: "600" }}>{label || repository.name}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{repository.repoPath} · {branch}{state ? ` · ${state}` : ""}</Text>
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 10 }}>{repository.changedFiles === null ? "—" : `${repository.changedFiles}`}</Text>
  </Pressable>;
}

function togglePath(path: string, selected: string[], setSelected: (value: string[] | ((current: string[]) => string[])) => void): void {
  setSelected((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
}

function useSetupSelection(data: ProjectSetupScan | undefined): [string[], (value: string[] | ((current: string[]) => string[])) => void] {
  const [selected, setSelected] = useState<string[]>([]);
  const [root, setRoot] = useState("");
  useEffect(() => {
    if (!data || data.projectRoot === root) return;
    setRoot(data.projectRoot);
    setSelected(data.defaultRepositoryPaths);
  }, [data, root]);
  return [selected, setSelected];
}

function useStateWithInitial<T>(initial: T): [T, (value: T | ((current: T) => T)) => void] {
  return useState(initial);
}
