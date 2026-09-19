import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "../native-components";
import { useQuery } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import { useEffect, useState } from "react";
import { projectRuntimeSettingsGet, projectRuntimeSettingsUpdate, type ProjectRuntimeSettings } from "../../shared/setup";
import { useWorkbenchCopy } from "../i18n";
import { AnchoredMenu } from "./navigation";
import type { makeStyles } from "./ui";

type Theme = Parameters<typeof makeStyles>[0];
type Styles = ReturnType<typeof makeStyles>;

const modes: Array<ProjectRuntimeSettings["mode"]> = ["auto", "system", "mise"];

export function ProjectRuntimeMenu({
  open,
  onClose,
  projectConfig,
  compact,
  theme,
  styles,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectConfig: string;
  compact: boolean;
  theme: Theme;
  styles: Styles;
  onSaved?: () => void | Promise<void>;
}) {
  const copy = useWorkbenchCopy();
  const read = useRpc(projectRuntimeSettingsGet);
  const update = useRpc(projectRuntimeSettingsUpdate);
  const query = useQuery({
    queryKey: ["workspace-workbench", projectConfig, "project-runtime-settings"],
    queryFn: () => read({ projectConfig }),
    enabled: Boolean(projectConfig),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [mode, setMode] = useState<ProjectRuntimeSettings["mode"]>("auto");
  const [managerPath, setManagerPath] = useState("");
  const [runtimePaths, setRuntimePaths] = useState("");
  const [requirements, setRequirements] = useState("{}");
  const [cacheEnabled, setCacheEnabled] = useState(true);
  const [cacheRoot, setCacheRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    setMode(data.mode);
    setManagerPath(data.managerPath || "");
    setRuntimePaths(data.runtimePaths.join("\n"));
    setRequirements(JSON.stringify(data.requirements, null, 2));
    setCacheEnabled(data.cache.enabled);
    setCacheRoot(data.cache.root || "");
    setError(data.ok ? "" : data.error?.message || copy.runtimeSettingsReadFailed);
  }, [copy.runtimeSettingsReadFailed, query.data]);

  async function saveSettings(): Promise<void> {
    if (saving) return;
    let parsedRequirements: Record<string, Record<string, string>>;
    try {
      const value: unknown = JSON.parse(requirements.trim() || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(copy.runtimeSettingsInvalidRequirements);
      parsedRequirements = {};
      for (const [repository, configured] of Object.entries(value as Record<string, unknown>)) {
        if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error(copy.runtimeSettingsInvalidRequirements);
        const tools: Record<string, string> = {};
        for (const [tool, version] of Object.entries(configured as Record<string, unknown>)) {
          if (typeof version !== "string" || !version.trim()) throw new Error(copy.runtimeSettingsInvalidRequirements);
          tools[tool] = version.trim();
        }
        parsedRequirements[repository] = tools;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.runtimeSettingsInvalidRequirements);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await update({
        projectConfig,
        mode,
        managerPath: managerPath.trim() || null,
        runtimePaths: runtimePaths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
        requirements: parsedRequirements,
        cacheEnabled,
        cacheRoot: cacheRoot.trim() || null,
      });
      if (!result.ok) {
        setError(result.error?.message || copy.runtimeSettingsSaveFailed);
        return;
      }
      await query.refetch();
      await onSaved?.();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.runtimeSettingsSaveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnchoredMenu open={open} onClose={onClose} theme={theme} width={compact ? 280 : 360}>
      <ScrollView style={{ maxHeight: compact ? 460 : 620 }} contentContainerStyle={{ gap: 7 }}>
        <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsTitle}</Text>
        {query.isPending ? <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsLoading}</Text> : null}
        {query.isError ? <Text style={styles.warningText}>{copy.runtimeSettingsReadFailed}</Text> : null}
        {query.data ? (
          <>
            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsMode}</Text>
            <View style={styles.briefActions}>
              {modes.map((value) => (
                <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: mode === value }} onPress={() => setMode(value)} style={[styles.secondaryButton, mode === value && styles.scopeButtonActive]}>
                  <Text style={styles.secondaryButtonText}>{value === "auto" ? copy.runtimeSettingsAuto : value === "system" ? copy.runtimeSettingsSystem : copy.runtimeSettingsMise}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsModeHint}</Text>

            <TextInput accessibilityLabel={copy.runtimeSettingsManagerPath} onChangeText={setManagerPath} placeholder={copy.runtimeSettingsManagerPath} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={managerPath} />
            <TextInput accessibilityLabel={copy.runtimeSettingsRuntimePaths} multiline onChangeText={setRuntimePaths} placeholder={copy.runtimeSettingsRuntimePaths} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { minHeight: 48 }]} value={runtimePaths} />
            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsRuntimePathsHint}</Text>

            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsCache}</Text>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: cacheEnabled }} onPress={() => setCacheEnabled((value) => !value)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>{cacheEnabled ? "✓" : "○"} {copy.runtimeSettingsCacheEnabled}</Text>
            </Pressable>
            <TextInput accessibilityLabel={copy.runtimeSettingsCacheRoot} onChangeText={setCacheRoot} placeholder={copy.runtimeSettingsCacheRoot} placeholderTextColor={theme.colors.foregroundMuted} style={styles.targetInput} value={cacheRoot} />

            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsRequirements}</Text>
            <TextInput accessibilityLabel={copy.runtimeSettingsRequirements} multiline onChangeText={setRequirements} placeholder={copy.runtimeSettingsRequirementsHint} placeholderTextColor={theme.colors.foregroundMuted} style={[styles.targetInput, { fontFamily: "monospace", minHeight: 120 }]} value={requirements} />
            <Text style={styles.layoutMenuHint}>{copy.runtimeSettingsRequirementsHint}</Text>
          </>
        ) : null}
        {error ? <Text style={styles.warningText}>{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={saving || query.isPending} onPress={() => { void saveSettings(); }} style={[styles.secondaryButton, (saving || query.isPending) && { opacity: 0.5 }]}>
          <Text style={styles.secondaryButtonText}>{saving ? copy.runtimeSettingsSaving : copy.runtimeSettingsSave}</Text>
        </Pressable>
      </ScrollView>
    </AnchoredMenu>
  );
}
