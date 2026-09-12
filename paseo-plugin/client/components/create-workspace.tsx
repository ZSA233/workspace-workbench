import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { PanResponder, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { ObserverMethod, ObserverResponse } from "../../shared/observer";
import type { DetailResult } from "../model";
import { copy } from "../../shared/copy";
import { clampCreateWorkspaceHeight, CREATE_WORKSPACE_MAX_HEIGHT, CREATE_WORKSPACE_MIN_HEIGHT, CREATE_WORKSPACE_MIN_LIST_HEIGHT, createWorkspaceNaturalHeight } from "../create-workspace-layout";
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
  const resized = useRef(false);
  const resizeSession = useRef<{ start: number } | null>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const pendingHeight = useRef<number | null>(null);
  const window = useWindowDimensions();
  const catalog = useQuery({ queryKey: ["workbench-create-catalog", projectKey], queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: "main", summary: true } }), retry: false });
  const repositories = catalog.data?.ok ? (catalog.data.result as DetailResult).repositories : [];
  const valid = repositories.filter((repo) => repo.status !== "missing" && Boolean(repo.head));
  const canCreate = name.trim() && selected.length && selected.every((path) => valid.some((repo) => repo.repoPath === path));
  const filteredRepositories = useMemo(
    () => repositories.filter((repo) => `${repo.name} ${repo.repoPath}`.toLowerCase().includes(search.toLowerCase())),
    [repositories, search],
  );
  const maxHeight = Math.max(CREATE_WORKSPACE_MIN_HEIGHT, Math.min(CREATE_WORKSPACE_MAX_HEIGHT, Math.max(CREATE_WORKSPACE_MIN_HEIGHT, window.height - 120)));
  const naturalHeight = createWorkspaceNaturalHeight({
    repositoryCount: filteredRepositories.length,
    selectedCount: selected.length,
    basesExpanded: expanded,
    hasStatusMessage: Boolean(error) || catalog.isPending || catalog.isError || Boolean(catalog.data && !catalog.data.ok),
    maxHeight,
  });
  const [requestedHeight, setRequestedHeight] = useState(naturalHeight);
  const dialogHeight = clampCreateWorkspaceHeight(requestedHeight, maxHeight);
  const listContentHeight = Math.max(CREATE_WORKSPACE_MIN_LIST_HEIGHT, filteredRepositories.length * 48 + (filteredRepositories.length > 8 ? 12 : 0));
  const statusHeight = Boolean(error) || catalog.isPending || catalog.isError || Boolean(catalog.data && !catalog.data.ok) ? 28 : 0;
  const listHeight = Math.min(listContentHeight, Math.max(CREATE_WORKSPACE_MIN_LIST_HEIGHT, dialogHeight - 142 - (expanded ? selected.length * 42 + 28 : 0) - statusHeight));
  const latest = useRef({ dialogHeight, maxHeight });
  latest.current = { dialogHeight, maxHeight };
  const inputStyle = [styles.targetInput, { flex: undefined, flexGrow: 0, flexShrink: 0, height: 36, minHeight: 36, fontSize: 13 }];

  useEffect(() => {
    if (!resized.current) setRequestedHeight(naturalHeight);
    else setRequestedHeight((current) => clampCreateWorkspaceHeight(current, maxHeight));
  }, [maxHeight, naturalHeight]);

  const scheduleHeight = (height: number) => {
    pendingHeight.current = clampCreateWorkspaceHeight(height, latest.current.maxHeight);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pendingHeight.current !== null) setRequestedHeight(pendingHeight.current);
    });
  };
  const responder = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (!responder.current) responder.current = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { resizeSession.current = { start: latest.current.dialogHeight }; },
    onPanResponderMove: (_, gesture) => { if (resizeSession.current) scheduleHeight(resizeSession.current.start + gesture.dy); },
    onPanResponderRelease: (_, gesture) => {
      if (resizeSession.current) {
        resized.current = true;
        scheduleHeight(resizeSession.current.start + gesture.dy);
      }
      resizeSession.current = null;
    },
    onPanResponderTerminate: () => {
      if (resizeSession.current) setRequestedHeight(resizeSession.current.start);
      resizeSession.current = null;
      pendingHeight.current = null;
    },
  });
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    resizeSession.current = null;
  }, []);
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
    {/* Web can size a non-scrolling modal to its content. Native sheets keep
        their host-controlled detent and use only the bounded list to scroll. */}
    <Modal.Content
      scrollable={Platform.OS === "web"}
      style={[styles.createModalContent, { height: dialogHeight, maxHeight }]}
      contentContainerStyle={styles.createModalBody}
    >
      <TextInput accessibilityLabel={copy.text_76848596cb} placeholder={copy.text_76848596cb} value={name} onChangeText={setName} editable={!busy} style={inputStyle} />
      <TextInput accessibilityLabel={copy.createSearch} placeholder={copy.createSearch} value={search} onChangeText={setSearch} style={inputStyle} />
      <FlatList
        data={filteredRepositories}
        keyExtractor={(repo) => repo.repoPath}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        removeClippedSubviews
        showsVerticalScrollIndicator={filteredRepositories.length > 6}
        style={[styles.createRepositoryList, { height: listHeight }]}
        renderItem={({ item: repo }) => {
          const checked = selected.includes(repo.repoPath);
          const disabled = busy || !valid.includes(repo);
          return <View>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked, disabled }} {...(Platform.OS === "web" ? { "aria-checked": checked } : {})} disabled={disabled} onPress={() => setSelected((current) => checked ? current.filter((path) => path !== repo.repoPath) : [...current, repo.repoPath])} style={{ paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}>
              <Text style={styles.repositoryLine}>{checked ? "☑" : "☐"} {repo.name}</Text>
              <Text style={styles.repositoryMeta}>{repo.branch || "HEAD"} · {repo.headShort || copy.createMissing}</Text>
            </Pressable>
            {expanded && checked ? <TextInput accessibilityLabel={`${repo.name} ${copy.createBase}`} placeholder="HEAD" value={bases[repo.repoPath] || ""} onChangeText={(value) => setBases((current) => ({ ...current, [repo.repoPath]: value }))} editable={!busy} style={inputStyle} /> : null}
          </View>;
        }}
        ListEmptyComponent={!catalog.isPending ? <Text style={styles.emptyText}>{copy.text_daa32fe25c}</Text> : null}
      />
      <View {...responder.current.panHandlers} accessibilityLabel={copy.createResize} accessibilityRole="button" hitSlop={{ bottom: 8, top: 8 }} style={styles.createResizeHandle}>
        <Icon name="ChevronsUpDown" size={11} color={styles.secondaryButtonText.color as string} />
      </View>
      {catalog.isPending ? <Text style={styles.emptyText}>{copy.text_96c3e67563}</Text> : null}
      {catalog.isError || catalog.data && !catalog.data.ok ? <Text style={styles.warningText}>{copy.createCatalogFailed}</Text> : null}
      <Pressable onPress={() => setExpanded((value) => !value)}><Text style={styles.secondaryButtonText}>{copy.createBase}</Text></Pressable>
      {error ? <Text style={styles.warningText}>{error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!canCreate || busy} onPress={() => { void create(); }} style={[styles.copyButton, (!canCreate || busy) && { opacity: 0.5 }]}><Text style={styles.copyButtonText}>{busy ? copy.text_1680b04bf6 : copy.text_fcbd093292}</Text></Pressable>
    </Modal.Content>
  </Modal>;
}
