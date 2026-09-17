import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Icon, Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { PanResponder, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { ObserverMethod, ObserverResponse } from "../../shared/observer";
import type { DetailResult, WorkspaceSummary } from "../model";
import { clampCreateWorkspaceHeight, CREATE_WORKSPACE_MAX_HEIGHT, CREATE_WORKSPACE_MIN_HEIGHT, CREATE_WORKSPACE_MIN_LIST_HEIGHT, createWorkspaceNaturalHeight } from "../create-workspace-layout";
import { makeStyles } from "./ui";
import { useWorkbenchCopy } from "../i18n";

export function CreateWorkspace({ addTo, projectKey, currentRepo, linkedSources = [], preferredSourceId = "", rpc, onCreated, onClose, styles }: {
  addTo?: { id: string; repositoryPaths: string[] };
  linkedSources?: WorkspaceSummary[];
  preferredSourceId?: string;
  projectKey: string; currentRepo: string;
  rpc(input: { method: ObserverMethod; params: Record<string, unknown> }): Promise<ObserverResponse>;
  onCreated(id: string): Promise<void>; onClose(): void; styles: ReturnType<typeof makeStyles>;
}) {
  const copy = useWorkbenchCopy();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>(!addTo && currentRepo ? [currentRepo] : []);
  const [bases, setBases] = useState<Record<string, string>>({});
  const [linkedSource, setLinkedSource] = useState(preferredSourceId);
  const [branchName, setBranchName] = useState("");
  const [rootBaseRef, setRootBaseRef] = useState("");
  const [previewRef, setPreviewRef] = useState("HEAD");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const resized = useRef(false);
  const resizeSession = useRef<{ start: number } | null>(null);
  const frame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const pendingHeight = useRef<number | null>(null);
  const window = useWindowDimensions();
  useEffect(() => {
    const timer = setTimeout(() => setPreviewRef(rootBaseRef.trim() || "HEAD"), 300);
    return () => clearTimeout(timer);
  }, [rootBaseRef]);
  const catalog = useQuery({ queryKey: ["workbench-create-catalog", projectKey], queryFn: () => rpc({ method: "workspace.detail", params: { workspaceId: "main", summary: true } }), enabled: !linkedSource, retry: false });
  const linkedCatalog = useQuery({ queryKey: ["workbench-linked-create", projectKey, linkedSource, previewRef], queryFn: () => rpc({ method: "linked.workspace.preview", params: { sourceWorkspaceId: linkedSource, rootBaseRef: previewRef } }), enabled: Boolean(linkedSource), retry: false });
  const linkedPreview = linkedCatalog.data?.ok ? linkedCatalog.data.result as { rootSha: string; links: Array<{ path: string; pinnedSha: string; issue?: string }> } : null;
  const repositories = (catalog.data?.ok ? (catalog.data.result as DetailResult).repositories : []).filter((repo) => !addTo?.repositoryPaths.includes(repo.repoPath));
  const valid = repositories.filter((repo) => repo.status !== "missing" && Boolean(repo.head));
  const canCreate = linkedSource && !addTo
    ? Boolean(name.trim() && previewRef === (rootBaseRef.trim() || "HEAD") && linkedPreview?.links.length && !linkedPreview.links.some(link => link.issue))
    : Boolean((addTo || name.trim()) && selected.length && selected.every((path) => valid.some((repo) => repo.repoPath === path)));
  const filteredRepositories = useMemo(
    () => repositories.filter((repo) => `${repo.name} ${repo.repoPath}`.toLowerCase().includes(search.toLowerCase())),
    [repositories, search],
  );
  const maxHeight = Math.max(CREATE_WORKSPACE_MIN_HEIGHT, Math.min(CREATE_WORKSPACE_MAX_HEIGHT, Math.max(CREATE_WORKSPACE_MIN_HEIGHT, window.height - 120)));
  const naturalHeight = createWorkspaceNaturalHeight({
    repositoryCount: linkedSource ? linkedPreview?.links.length || 0 : filteredRepositories.length,
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
      const params = linkedSource && !addTo
        ? { name: name.trim(), sourceWorkspaceId: linkedSource,
            branchName: branchName.trim() || `feature/${name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`,
            rootBaseRef: rootBaseRef.trim() || "HEAD",
            baseRefs: Object.fromEntries((linkedPreview?.links || []).filter(link => bases[link.path]?.trim()).map(link => [link.path, bases[link.path].trim()])) }
        : { ...(addTo ? { workspaceId: addTo.id } : { name: name.trim() }), repositories: [...selected].sort(), baseRefs: Object.fromEntries(selected.map((path) => [path, bases[path]?.trim() || "HEAD"])) };
      const response = await rpc({ method: addTo ? "workspace.addRepositories" : "workspace.create", params });
      if (!response.ok) throw new Error(response.error?.message || copy.text_deb3990191);
      const result = response.result as { id: string; preparations?: Array<{ status?: string }> };
      if (result.preparations?.some((item) => item.status === "prepare_failed")) throw new Error("仓库已添加，运行时准备失败。修复运行时后重试；不会重复创建仓库。");
      await onCreated(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : copy.text_deb3990191); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={addTo ? "添加仓库" : copy.text_1623afda9e}>
    {/* Web can size a non-scrolling modal to its content. Native sheets keep
        their host-controlled detent and use only the bounded list to scroll. */}
    <Modal.Content
      scrollable={Platform.OS === "web"}
      style={[styles.createModalContent, { height: dialogHeight, maxHeight }]}
      contentContainerStyle={styles.createModalBody}
    >
      {!addTo ? <TextInput accessibilityLabel={copy.text_76848596cb} placeholder={copy.text_76848596cb} value={name} onChangeText={setName} editable={!busy} style={inputStyle} /> : null}
      {!addTo && linkedSources.length ? <View style={{ gap: 5 }}>
        <Text style={styles.repositoryMeta}>{copy.linkedCreateSource}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: !linkedSource }} onPress={() => setLinkedSource("")} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{!linkedSource ? "✓ " : "○ "}{copy.linkedCreateFlat}</Text></Pressable>
        {linkedSources.map(source => <Pressable key={source.id} accessibilityRole="button" accessibilityState={{ selected: linkedSource === source.id }} onPress={() => setLinkedSource(source.id)} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>{linkedSource === source.id ? "✓ " : "○ "}{source.displayName}</Text></Pressable>)}
      </View> : null}
      {linkedSource && !addTo ? <View style={{ gap: 6 }}>
        <TextInput accessibilityLabel={copy.linkedBranchName} placeholder={`${copy.linkedBranchName}: feature/${name.trim() || "workspace"}`} value={branchName} onChangeText={setBranchName} style={inputStyle} />
        <TextInput accessibilityLabel={copy.linkedOuterBaseRef} placeholder={`${copy.linkedOuterBaseRef}: HEAD`} value={rootBaseRef} onChangeText={setRootBaseRef} style={inputStyle} />
        <Text style={styles.layoutMenuHint}>{copy.linkedBaseHint}</Text>
        {linkedCatalog.isFetching ? <Text style={styles.emptyText}>{copy.mainRepositoryScanning}</Text> : null}
        {linkedCatalog.data && !linkedCatalog.data.ok ? <Text style={styles.warningText}>{linkedCatalog.data.error?.message}</Text> : null}
        {linkedPreview?.links.map(link => <View key={link.path} style={{ gap: 2 }}>
          <Text style={styles.repositoryMeta}>{link.path} · {link.pinnedSha.slice(0, 8)}{link.issue ? ` · ${copy.linkedMissing}` : ""}</Text>
          <TextInput accessibilityLabel={`${link.path} ${copy.createBase}`} placeholder={link.pinnedSha} value={bases[link.path] || ""} onChangeText={value => setBases(current => ({ ...current, [link.path]: value }))} style={inputStyle} />
        </View>)}
      </View> : <>
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
      </>}
      {error ? <Text style={styles.warningText}>{error}</Text> : null}
      <Pressable accessibilityRole="button" disabled={!canCreate || busy} onPress={() => { void create(); }} style={[styles.copyButton, (!canCreate || busy) && { opacity: 0.5 }]}><Text style={styles.copyButtonText}>{busy ? copy.text_1680b04bf6 : addTo ? "添加仓库" : copy.text_fcbd093292}</Text></Pressable>
    </Modal.Content>
  </Modal>;
}
