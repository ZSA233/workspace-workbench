import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ObserverMethod, ObserverResponse } from "../../shared/observer";
import type { DetailResult } from "../model";
import { copy } from "../../shared/copy";
import { makeStyles } from "./ui";

export function CreateWorkspace({ projectKey, currentRepo, rpc, onCreated, onClose, styles }: {
  projectKey: string; currentRepo: string;
  rpc(input: { method: ObserverMethod; params: Record<string, unknown> }): Promise<ObserverResponse>;
  onCreated(id: string): Promise<void>; onClose(): void; styles: ReturnType<typeof makeStyles>;
}) {
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>(currentRepo ? [currentRepo] : []);
  const [bases, setBases] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const catalog = useQuery({ queryKey: ["workbench-create-catalog", projectKey], queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: "main", summary: true } }), retry: false });
  const repositories = catalog.data?.ok ? (catalog.data.result as DetailResult).repositories : [];
  const valid = repositories.filter((repo) => repo.status !== "missing" && Boolean(repo.head));
  const canCreate = name.trim() && selected.length && selected.every((path) => valid.some((repo) => repo.repoPath === path));
  const inputStyle = [styles.targetInput, { flex: undefined, flexGrow: 0, flexShrink: 0, height: 36, minHeight: 36, fontSize: 13 }];
  async function create() {
    if (lock.current || !canCreate) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await rpc({ method: "workspace.create", params: { name: name.trim(), repositories: [...selected].sort(), baseRefs: Object.fromEntries(selected.map((path) => [path, bases[path]?.trim() || "HEAD"])) } });
      if (!response.ok) throw new Error(response.error?.message || copy.text_deb3990191);
      await onCreated((response.result as { id: string }).id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : copy.text_deb3990191); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={copy.text_1623afda9e}>
    <Modal.Content scrollable={false} contentContainerStyle={{ padding: 16, gap: 12 }}>
      <TextInput accessibilityLabel={copy.text_76848596cb} placeholder={copy.text_76848596cb} value={name} onChangeText={setName} editable={!busy} style={inputStyle} />
      <TextInput accessibilityLabel={copy.createSearch} placeholder={copy.createSearch} value={search} onChangeText={setSearch} style={inputStyle} />
      <ScrollView style={{ maxHeight: 220, flexGrow: 0 }}>
        {repositories.filter((repo) => `${repo.name} ${repo.repoPath}`.toLowerCase().includes(search.toLowerCase())).map((repo) => {
          const checked = selected.includes(repo.repoPath);
          const disabled = busy || !valid.includes(repo);
          return <View key={repo.repoPath}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} {...(Platform.OS === "web" ? { "aria-checked": checked } : {})} disabled={disabled} onPress={() => setSelected((current) => checked ? current.filter((path) => path !== repo.repoPath) : [...current, repo.repoPath])} style={{ paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}>
              <Text style={styles.repositoryLine}>{checked ? "☑" : "☐"} {repo.name}</Text>
              <Text style={styles.repositoryMeta}>{repo.branch || "HEAD"} · {repo.headShort || copy.createMissing}</Text>
            </Pressable>
            {expanded && checked ? <TextInput accessibilityLabel={`${repo.name} ${copy.createBase}`} placeholder="HEAD" value={bases[repo.repoPath] || ""} onChangeText={(value) => setBases((current) => ({ ...current, [repo.repoPath]: value }))} editable={!busy} style={inputStyle} /> : null}
          </View>;
        })}
      </ScrollView>
      {catalog.isPending ? <Text style={styles.emptyText}>{copy.text_96c3e67563}</Text> : null}
      {catalog.isError || catalog.data && !catalog.data.ok ? <Text style={styles.warningText}>{copy.createCatalogFailed}</Text> : null}
      <Pressable onPress={() => setExpanded((value) => !value)}><Text style={styles.secondaryButtonText}>{copy.createBase}</Text></Pressable>
      {error ? <Text style={styles.warningText}>{error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!canCreate || busy} onPress={() => { void create(); }} style={[styles.copyButton, (!canCreate || busy) && { opacity: 0.5 }]}><Text style={styles.copyButtonText}>{busy ? copy.text_1680b04bf6 : copy.text_fcbd093292}</Text></Pressable>
    </Modal.Content>
  </Modal>;
}
