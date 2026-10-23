import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { View, Text, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Modal, FlatList, TextInput, ScrollView } from './native-components';
import { useWorkbenchLocale } from './i18n';
import { filesTreeState, type TreeRow } from './files-tree-store';
import { droppedFiles, pickFiles, newFileId, decode, type LocalFile } from './files-platform';
import type { FileTransferStore } from './files-store';
import type { FileEntry } from '../shared/files';
import { getFileClipboard, setFileClipboard, subscribeFileClipboard } from './files-clipboard';
import { fileBytes } from './files-transfer-panel';
import { GeometricIcon } from './geometric-icon';
import { fileGitColor, fileGitDescription, fileGitPalette, fileTreeIcon } from './files-decoration-display';
import { destinationInsideSource, unchangedFileMove, type FileLocation } from '../shared/file-operations';

const noSubscription = () => () => {};
const parent = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export default function FilesManager({ scope, workspace, store, theme, decorationsEnabled = false, foreground = true, sortedListing = false, onOpenDocument }: { scope: string; workspace: any; store: FileTransferStore; theme: any; decorationsEnabled?: boolean; foreground?: boolean; sortedListing?: boolean; onOpenDocument?:(path:string,instance:string)=>void }) {
  const zh = useWorkbenchLocale() === 'zh-CN', c = theme.colors;
  const { fontScale } = useWindowDimensions();
  const dense = Platform.OS === 'web' && !(globalThis as any).matchMedia?.('(pointer: coarse)').matches;
  const rowHeight = Math.max(dense ? 22 : 30, Math.ceil(16 * fontScale) + 6), indent = dense ? 12 : 15;
  const clipboard = useSyncExternalStore(subscribeFileClipboard, getFileClipboard);
  const tree = useMemo(() => filesTreeState(scope, workspace.id), [scope, workspace.id]);
  const revision = useSyncExternalStore(foreground ? tree.subscribe : noSubscription, tree.snapshot);
  const filter = tree.filter;
  const [menu, setMenu] = useState<string | null>(null), [dialog, setDialog] = useState<'mkdir' | 'rename' | 'delete' | null>(null), [name, setName] = useState(''), [error, setError] = useState(''), [drop, setDrop] = useState<string | null>(null), [preview, setPreview] = useState<{ name: string; text: string; size: number } | null>(null);
  const [dialogEntries, setDialogEntries] = useState<FileEntry[]>([]), [dialogPath, setDialogPath] = useState('');
  const [visibleStart, setVisibleStart] = useState(0), [listHeight, setListHeight] = useState(800);
  const touching = useRef(false), pointerPressed=useRef(false), interaction=useRef(false);
  const dragged = useRef<FileLocation[]>([]);
  const pointer = useRef({ id: -1, x: 0, y: 0 });
  const longPressClick = useRef<{ id: number; x: number; y: number; until: number } | null>(null);
  const rootRef = useRef<any>(null), listRef = useRef<any>(null), hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), busy = useRef(false), anchor = useRef('');
  const rows = useMemo(() => tree.rows(filter), [tree, tree.structureRevision, tree.navigationRevision, filter]);
  const decorationPaths = [...new Set(['', ...rows.slice(Math.max(0, visibleStart-8), visibleStart + Math.ceil(listHeight/rowHeight)+16).filter(row => !row.more).map(row => row.path)])];
  const decorationPathsKey = JSON.stringify(decorationPaths), decorationPathsRef = useRef(decorationPaths);
  decorationPathsRef.current = decorationPaths;
  const palette = fileGitPalette(theme);
  const gitPending = decorationsEnabled && decorationPaths.some(path => tree.decorations.entries.get(path)?.freshness !== 'fresh');
  const entries = useMemo(() => new Map([...tree.pages.values()].flatMap(p => p.entries).map(e => [e.path, e])), [tree, tree.structureRevision]);
  const selected = [...tree.selected].map(p => entries.get(p)).filter(Boolean) as FileEntry[];
  const topLevel = (values: FileEntry[]) => { const paths = new Set(values.map(entry => entry.path)); return values.filter(entry => { for (let value = parent(entry.path); value; value = parent(value)) if (paths.has(value)) return false; return true; }); };
  const targetPath = menu !== null ? menu !== tree.root && entries.get(menu)?.kind !== 'directory' ? parent(menu) : menu : selected.length === 1 && selected[0].kind === 'directory' ? selected[0].path : selected.length ? parent(selected[0].path) : tree.root;
  const readOnly = workspace.kind === 'linked-live';
  const call = (input: Record<string, any>) => store.call(input);
  const run = (work: () => Promise<unknown>) => { setError(''); void work().catch(e => setError(String(e.message || e))); };
  useEffect(() => {
    tree.foreground=foreground;tree.sortedListing=sortedListing;
    if(!foreground)return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const update = async () => { await tree.validate(call); if (!disposed && decorationsEnabled) await tree.decorations.refresh(decorationPathsRef.current, call); if (!disposed) timer = setTimeout(update, 3000); };
    void update();
    void (async () => { if(!tree.pages.has(tree.root))await tree.load(tree.root, call); for (const path of tree.expanded) if (!disposed && !tree.pages.has(path)) await tree.load(path, call); })();
    return () => { disposed = true; clearTimeout(timer); clearTimeout(hover.current); tree.foreground=false; tree.save(); };
  }, [tree, store, decorationsEnabled, foreground, sortedListing]);
  useEffect(() => {
    if (foreground && decorationsEnabled && tree.instance) void tree.decorations.refresh(decorationPathsRef.current, call);
  }, [tree, store, decorationsEnabled, foreground, tree.instance, decorationPathsKey]);
  interaction.current=menu!==null || dialog!==null || drop!==null || dragged.current.length>0 || busy.current || !!filter;
  useEffect(()=>{tree.interacting=pointerPressed.current || interaction.current;if(foreground)void tree.applySorted(call);},[tree,foreground,visibleStart,tree.selected.size,menu,dialog,drop,filter]);
  useLayoutEffect(() => {
    setVisibleStart(Math.floor(tree.scroll / rowHeight));
    listRef.current?.scrollToOffset?.({ offset: tree.scroll, animated: false });
  }, [tree, tree.navigationRevision, Boolean(tree.pages.has(tree.root)), rowHeight]);
  useEffect(() => {
    const document = (globalThis as any).document;
    if (Platform.OS !== 'web' || !document) return;
    // A touch release can generate a click at the newly opened portal menu.
    // Consume only the originating gesture, leaving subsequent menu taps usable.
    const release = () => { pointerPressed.current=false;tree.interacting=interaction.current;if(tree.foreground&&!tree.interacting)void tree.applySorted(call);if (longPressClick.current) longPressClick.current.until = Date.now() + 500; };
    const click = (event: any) => {
      const press = longPressClick.current;
      if (!press) return;
      if (Date.now() > press.until) { longPressClick.current = null; return; }
      const origin = typeof event.pointerId === 'number' && event.pointerId >= 0 ? event.pointerId === press.id : Math.abs(event.clientX - press.x) < 12 && Math.abs(event.clientY - press.y) < 12;
      if (origin) { longPressClick.current = null; event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const cancel = () => { longPressClick.current = null; release(); };
    document.addEventListener('click', click, true); document.addEventListener('pointerup', release, true); document.addEventListener('touchend', release, true); document.addEventListener('pointercancel', cancel, true);
    return () => { document.removeEventListener('click', click, true); document.removeEventListener('pointerup', release, true); document.removeEventListener('touchend', release, true); document.removeEventListener('pointercancel', cancel, true); };
  }, []);
  const selection = (path: string, event?: any) => {
    const e = event?.nativeEvent || event || {};
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex(r => r.path === anchor.current), b = rows.findIndex(r => r.path === path);
      if (!e.ctrlKey && !e.metaKey) tree.selected.clear();
      if (a >= 0 && b >= 0) for (const row of rows.slice(Math.min(a,b), Math.max(a,b)+1)) if (row.entry) tree.selected.add(row.path);
    } else if (e.ctrlKey || e.metaKey) { if (tree.selected.has(path)) tree.selected.delete(path); else if (path !== tree.root) tree.selected.add(path); anchor.current = path; }
    else { tree.selected = new Set(path !== tree.root ? [path] : []); anchor.current = path; }
    tree.save(); tree.emit('view');
  };
  const copy = (operation: 'copy' | 'move') => {
    if (!selected.length || selected.some(e => e.protected && !(operation === 'copy' && e.repository))) return;
    setFileClipboard({ operation, scope, entries: topLevel(selected).map(e => ({ workspaceId: workspace.id, instance: tree.instance, path: e.path, version: e.version })) }); setMenu(null);
  };
  const destination = (path: string) => ({ workspaceId: workspace.id, instance: tree.instance, path });
  const paste = (path: string) => {
    if (!clipboard || clipboard.scope !== scope || readOnly || !tree.instance) return;
    const captured = clipboard;
    run(async () => { await store.operation({ operation: captured.operation, entries: captured.entries, destination: destination(path), policy: 'ask', confirm: false }); if (captured.operation === 'move' && getFileClipboard() === captured) setFileClipboard(undefined); }); setMenu(null);
  };
  const upload = async (files: Iterable<LocalFile> | AsyncIterable<{ file?: LocalFile; path: string; directory?: boolean }>, directory: string, dropInput = false) => {
    if (readOnly) return;
    const id = workspace.id, batchId = newFileId();
    if (!tree.instance) await tree.load('', call);
    const instance = tree.instance; if (!instance) throw new Error(tree.error || (zh ? '文件目录尚未就绪，请稍后重试' : 'Directory is not ready; retry after reconnecting'));
    const skipped = new Set<string>();
    for await (const input of files as any) {
      const file: LocalFile | undefined = dropInput ? input.file : input;
      const path = dropInput ? input.path : file?.webkitRelativePath || file?.name;
      if (!path) continue;
      const parts = path.split('/'); const protectedIndex = parts.findIndex((part: string) => ['.git', '.workspace', '.workspace-workbench'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.workbench-transfer-'));
      if (protectedIndex >= 0) { skipped.add(parts.slice(0, protectedIndex+1).join('/')); continue; }
      const relativeParent = parent(path), dest = [directory, relativeParent].filter(Boolean).join('/');
      if (input.directory) {
        // Empty directories are real upload entries too; create each level in order.
        const parts = [directory, path].filter(Boolean).join('/').split('/'); let current = '';
        for (const part of parts) { try { const task = await call({ action: 'mkdir', ...destination(current), workspaceId: id, instance, name: part, existOk: true, id: newFileId() }); if (task.state === 'failed') throw new Error(task.error); } catch (e) { throw e; } current = current ? current + '/' + part : part; }
      } else if (file) await store.upload(file, id, instance, dest, 'ask', batchId);
    }
    await tree.load(directory, call, false, true);
    if (skipped.size) setError(zh ? `已跳过 ${skipped.size} 个内部元数据入口` : `Skipped ${skipped.size} internal metadata entries`);
  };
  const showDialog = (kind: 'mkdir' | 'rename' | 'delete') => { setDialogEntries(selected.map(e => ({ ...e }))); setDialogPath(targetPath); setName(kind === 'rename' ? selected[0]?.name || '' : ''); setDialog(kind); };
  const apply = () => {
    if (dialog !== 'delete' && !name.trim()) return;
    const kind = dialog, path = dialogPath, captured = topLevel(dialogEntries).map(e => ({ workspaceId: workspace.id, instance: tree.instance, path: e.path, version: e.version }));
    run(async () => {
      if (busy.current) return; busy.current = true;
      try {
        if (kind === 'rename' && name === dialogEntries[0]?.name) { setDialog(null); setMenu(null); return; }
        if (kind === 'mkdir') { const task = await call({ action: 'mkdir', ...destination(path), name, id: newFileId() }); if (task.state === 'failed') throw new Error(task.error); await tree.load(path, call, false, true); }
        else { const task = await store.operation({ operation: kind, entries: captured, ...(kind === 'rename' ? { name } : {}), policy: 'ask', confirm: kind === 'delete' }); if (task?.state === 'failed') throw new Error(task.error); }
        setDialog(null); setMenu(null);
      } finally { busy.current = false; }
    });
  };
  const download = () => {
    const values = topLevel(selected), entry = values[0];
    const suggestedName = values.length === 1 ? entry.kind === 'file' ? entry.name : entry.name.replace(/\.zip$/i, '') + '.zip' : 'files.zip';
    run(() => store.download(workspace.id, tree.instance, values.map(e => e.path), suggestedName)); setMenu(null);
  };
  const navigate = (path?: string) => {
    clearTimeout(hover.current); setDrop(null); setMenu(null); setError('');
    if (path === undefined) tree.back(call); else tree.enter(path, call);
    anchor.current = [...tree.selected].at(-1) || tree.root;
  };
  const open = (row: TreeRow) => {
    if (!row.entry || row.entry.kind === 'directory') { if (!row.entry?.protected || row.entry.repository || !row.path) tree.toggle(row.path, call, row.expanded); }
    else if(onOpenDocument){setMenu(null);onOpenDocument(row.path,tree.instance);}
    else run(async () => { const data = await call({ action: 'preview', ...destination(row.path), offset: 0 }); const bytes = decode(data.data); const text = bytes.includes(0) ? (zh ? '二进制文件，请使用下载。' : 'Binary file. Use Download.') : new TextDecoder().decode(bytes); setPreview({ name: row.path, text, size: data.size }); });
  };
  const button = (label: string, press: () => void, disabled = false, toolbar = false, accessibilityLabel = label) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={accessibilityLabel} disabled={disabled} onPress={press} style={{ paddingVertical: toolbar && dense ? 4 : 7, paddingHorizontal: toolbar && dense ? 7 : 9, opacity: disabled ? 0.4 : 1 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text></Pressable>;
  const menuItems = <>
    {onOpenDocument&&selected.length===1&&selected[0].kind==='file'?button(zh?'打开':'Open',()=>{setMenu(null);onOpenDocument(selected[0].path,tree.instance);}):null}
    {selected.length===1&&selected[0].kind==='directory'&&(!selected[0].protected||selected[0].repository)?button(zh?'进入目录浏览':'Browse this folder',()=>navigate(selected[0].path)):null}
    {button(zh ? '上传文件到此目录' : 'Upload here', () => { const path = targetPath; pickFiles(false, files => run(() => upload(files, path))); setMenu(null); }, readOnly)}
    {button(zh ? '新建文件夹' : 'New folder', () => showDialog('mkdir'), readOnly)}
    {button(zh ? '下载 / ZIP' : 'Download / ZIP', download, !selected.length || selected.some(e => e.protected && !e.repository))}
    {button(zh ? '复制' : 'Copy', () => copy('copy'), !selected.length || selected.some(e => e.protected && !e.repository))}
    {button(zh ? '剪切' : 'Cut', () => copy('move'), readOnly || !selected.length || selected.some(e => e.protected))}
    {button(zh ? '粘贴到此目录' : 'Paste here', () => paste(targetPath), readOnly || !clipboard || clipboard.scope !== scope)}
    {button(zh ? '重命名' : 'Rename', () => showDialog('rename'), readOnly || selected.length !== 1 || selected.some(e => e.protected))}
    {button(zh ? '永久删除…' : 'Delete permanently…', () => showDialog('delete'), readOnly || !selected.length || selected.some(e => e.protected))}
  </>;
  const keyDown = (event: any) => {
    if (/input|textarea/i.test(event.target?.tagName || '')) return;
    if ((event.ctrlKey || event.metaKey) && ['c','x','v','a'].includes(event.key.toLowerCase())) {
      event.preventDefault(); const key = event.key.toLowerCase();
      if (key === 'c') copy('copy'); else if (key === 'x' && !readOnly) copy('move'); else if (key === 'v') paste(targetPath); else if (key === 'a') { tree.selected = new Set(rows.filter(r => r.entry && (!r.entry.protected || r.entry.repository)).map(r => r.path)); tree.emit('view'); }
    } else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const visible = rows.filter(row => !row.more), current = visible.findIndex(row => row.path === anchor.current);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length-1 : Math.min(visible.length-1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
      const row = visible[index]; if (row) { selection(row.path, event); listRef.current?.scrollToIndex?.({ index: rows.indexOf(row), animated: false }); }
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Enter') {
      event.preventDefault(); const row = rows.find(item => item.path === anchor.current) || rows[0];
      if (event.key === 'Enter') open(row);
      else if (event.key === 'ArrowRight' && (!row.entry || row.entry.kind === 'directory') && !row.expanded) open(row);
      else if (event.key === 'ArrowLeft') { if (row.expanded) tree.toggle(row.path, call, row.expanded); else if (row.path !== tree.root) selection(parent(row.path)); }
    } else if (event.key === 'Delete' && selected.length && !readOnly && !selected.some(e => e.protected)) { event.preventDefault(); showDialog('delete'); }
    else if (event.key === 'F2' && selected.length === 1 && !selected[0].protected && !readOnly) { event.preventDefault(); showDialog('rename'); }
    else if (event.key === 'Escape') { setMenu(null); tree.selected.clear(); tree.emit('view'); }
  };
  const dragOver = (event: any, row: TreeRow) => {
    event.preventDefault(); event.stopPropagation(); if (readOnly) return;
    const path = !row.entry || row.entry.kind === 'directory' ? row.path : parent(row.path);
    if (row.entry?.protected && !row.entry.repository) return;
    const target = destination(path);
    if (dragged.current.length && (dragged.current.some(source => destinationInsideSource(source, target)) || !event.ctrlKey && dragged.current.every(source => unchangedFileMove(source, target)))) {
      event.dataTransfer.dropEffect = 'none'; setDrop(null); clearTimeout(hover.current); return;
    }
    event.dataTransfer.dropEffect = event.dataTransfer.types?.includes('application/x-workbench-files') ? event.ctrlKey ? 'copy' : 'move' : 'copy';
    if (drop !== path) { setDrop(path); clearTimeout(hover.current); if (!rows.find(row => !row.more && row.path === path)?.expanded) hover.current = setTimeout(() => tree.toggle(path, call, false), 650); }
  };
  const onDrop = (event: any, row: TreeRow) => {
    event.preventDefault(); event.stopPropagation(); clearTimeout(hover.current); setDrop(null);
    if (readOnly || row.entry?.protected && !row.entry.repository) return;
    const path = !row.entry || row.entry.kind === 'directory' ? row.path : parent(row.path), data = event.dataTransfer.getData('application/x-workbench-files');
    if (data) run(async () => { const parsed = JSON.parse(data); if (parsed.scope !== scope) throw new Error('Use Copy and Paste within this project'); const target = destination(path); if (parsed.entries.some((source: FileLocation) => destinationInsideSource(source, target))) return; await store.operation({ operation: event.ctrlKey ? 'copy' : 'move', entries: parsed.entries, destination: target, policy: 'ask', confirm: false }); });
    else { const items = droppedFiles(event.dataTransfer); run(() => upload(items, path, true)); }
  };
  const renderRow = ({ item: row }: { item: TreeRow }) => {
    if (row.more) return <Pressable onPress={() => run(() => tree.load(row.path, call, true))} style={{ height: rowHeight, justifyContent: 'center', paddingHorizontal: 8, paddingLeft: 8+row.depth*indent }}><Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{zh ? '加载更多…' : 'Load more…'}</Text></Pressable>;
    const entry = row.entry, directory = !entry || entry.kind === 'directory', selectedRow = tree.selected.has(row.path), landing = drop !== null && drop === (directory ? row.path : null);
    const record = decorationsEnabled ? tree.decorations.entries.get(row.path) : undefined, decoration = record?.entry;
    const details = [decorationsEnabled ? fileGitDescription(decoration, zh, record?.freshness !== 'fresh') : '', directory && entry && filter ? zh ? '原地展开或收起目录，保留筛选' : 'Expand or collapse in place; keep the filter' : ''].filter(Boolean).join('\n');
    const label = entry?.name || (tree.root ? tree.root.slice(tree.root.lastIndexOf('/')+1) : workspace.displayName || workspace.id);
    const color = fileGitColor(decoration, palette, c.foreground), iconColor = decoration?.ignored ? palette.ignored : c.foregroundMuted;
    const content = <Pressable accessibilityRole="button" accessibilityLabel={row.path || workspace.displayName || workspace.id} accessibilityHint={details} accessibilityState={{ selected: selectedRow, ...(directory ? { expanded: !!row.expanded } : {}) }} onPress={Platform.OS === "web" ? undefined : e => { selection(row.path, e); open(row); }} onLongPress={() => { if (Platform.OS === 'web' && !touching.current) return; if (Platform.OS === 'web') longPressClick.current = { ...pointer.current, until: Infinity }; if (!tree.selected.has(row.path)) selection(row.path); setMenu(row.path); }} style={{ height: rowHeight, width: '100%', paddingRight: 8, paddingLeft: 8+row.depth*indent, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: landing ? '#3269a655' : selectedRow ? c.surface2 || '#ffffff14' : 'transparent' }}>
      <View style={{ width: 11 }}>{directory ? <GeometricIcon name={row.expanded ? 'ChevronDown' : 'ChevronRight'} size={11} color={iconColor}/> : null}</View>
      <GeometricIcon name={fileTreeIcon(entry?.name || '', directory ? 'directory' : entry!.kind, !!row.expanded)} size={14} color={iconColor}/>
      <Text style={{ color, fontSize: 12, flex: 1 }} numberOfLines={1}>{label}</Text>
      <View style={{ width: 14, alignItems: 'center', justifyContent: 'center' }}>{decoration?.mark ? directory ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }}/> : <Text style={{ color, fontSize: 10, fontWeight: '600', lineHeight: 14 }}>{decoration.mark}</Text> : null}</View>
      <View style={{ width: 53, alignItems: 'flex-end' }}>{tree.refreshing.has(row.path) ? <GeometricIcon name="RefreshCw" size={10} color={c.foregroundMuted}/> : entry && !directory ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{fileBytes(entry.size)}</Text> : null}</View>
      {landing ? <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderWidth: 1, borderColor: '#78a9ff' }}/> : null}
    </Pressable>;
    return Platform.OS === 'web' ? createElement('div', { key: row.key, 'data-file-path': row.path, 'data-git-mark': decoration?.mark || '', 'data-git-ignored': Boolean(decoration?.ignored), title: [row.path || workspace.displayName || workspace.id, details].filter(Boolean).join('\n'), onPointerDownCapture: (event: any) => { touching.current = event.pointerType === 'touch';pointerPressed.current=true;tree.interacting=true; pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; }, tabIndex: 0, style: { display: 'flex', width: '100%', userSelect: 'none', outline: 'none' }, onClickCapture: (event: any) => { selection(row.path, event); if ((directory||touching.current) && !event.ctrlKey && !event.metaKey && !event.shiftKey) open(row); }, draggable: Boolean(entry && !entry.protected && !readOnly), onDoubleClick: () => { if (!directory) open(row); }, onContextMenu: (e: any) => { e.preventDefault(); e.stopPropagation(); if (!tree.selected.has(row.path)) selection(row.path); setMenu(row.path); }, onDragStart: (e: any) => { tree.interacting=true;const paths = tree.selected.has(row.path) ? [...tree.selected] : [row.path]; const values = paths.map(p => entries.get(p)).filter((x): x is FileEntry => Boolean(x && !x.protected)); dragged.current = values.map(x => ({ ...destination(x.path), version: x.version })); e.dataTransfer.setData('application/x-workbench-files', JSON.stringify({ scope, entries: dragged.current })); e.dataTransfer.effectAllowed = 'copyMove'; }, onDragOver: (e: any) => dragOver(e, row), onDrop: (e: any) => onDrop(e, row) } as any, content) : content;
  };
  const body = <View style={{ flex: 1, minHeight: 0 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: 3, borderBottomWidth: 1, borderBottomColor: c.border || '#ffffff18' }}>
      {button(zh ? '↑ 上传' : '↑ Upload', () => pickFiles(false, files => run(() => upload(files, targetPath))), readOnly || !tree.instance, true)}
      {Platform.OS === 'web' ? button(zh ? '上传目录' : 'Upload folder', () => pickFiles(true, files => run(() => upload(files, targetPath))), readOnly || !tree.instance, true) : null}
      {button(zh ? '+ 文件夹' : '+ Folder', () => showDialog('mkdir'), readOnly || !tree.instance, true)}
      {button(zh ? '↻ 刷新' : '↻ Refresh', () => run(async () => { for (const path of tree.expanded) await tree.load(path, call, false, true); if (decorationsEnabled) await tree.decorations.refresh(decorationPathsRef.current, call, true); }), false, true)}
      {button('⋯', () => setMenu(targetPath), false, true, zh ? '更多文件操作' : 'More file actions')}
      <TextInput value={filter} onChangeText={value => tree.setFilter(value)} placeholder={zh ? '筛选文件或目录' : 'Filter files or folders'} accessibilityLabel={zh ? '筛选已加载的文件或目录' : 'Filter loaded files or folders'} style={{ flex: 1, minWidth: 130, height: Math.max(dense ? 23 : 29, Math.ceil(16 * fontScale) + 6), marginHorizontal: 4, marginVertical: 3, paddingHorizontal: 6, paddingVertical: 2, fontSize: 12, color: c.foreground, borderWidth: 1, borderColor: c.border || '#ffffff22', borderRadius: 3 }} />
    </View>
    {tree.root || tree.canGoBack ? <View testID="files-navigation" style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 3, borderBottomWidth: 1, borderBottomColor: c.border || '#ffffff18' }}>
      {button(zh ? tree.backFilter ? '← 搜索结果' : '← 返回' : tree.backFilter ? '← Results' : '← Back', () => navigate(), !tree.canGoBack, true, zh ? tree.backFilter ? '返回搜索结果' : '返回上一次浏览' : tree.backFilter ? 'Back to search results' : 'Back to previous view')}
      {button('↑', () => navigate(parent(tree.root)), !tree.root, true, zh ? '上一级目录' : 'Parent folder')}
      <Pressable accessibilityRole="button" accessibilityLabel={zh ? '工作区根目录' : 'Workspace root'} disabled={!tree.root} onPress={() => navigate('')} style={{ maxWidth: 140, paddingVertical: dense ? 4 : 7, paddingHorizontal: 5 }}><Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11 }}>{workspace.displayName || workspace.id}</Text></Pressable>
      <Text numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={tree.root || '/'} style={{ flex: 1, minWidth: 0, color: c.foreground, fontSize: 11 }}>/{tree.root}</Text>
    </View> : null}
    {error || tree.error ? <Text style={{ color: c.statusWarning || '#eabf6c', padding: 8, fontSize: 11 }}>{error || tree.error}</Text> : null}
    <FlatList ref={listRef} style={{ flex: 1, minHeight: 160 }} data={rows} renderItem={renderRow} keyExtractor={row => row.key} getItemLayout={(_, i) => ({ length: rowHeight, offset: rowHeight*i, index: i })} initialNumToRender={45} maxToRenderPerBatch={30} windowSize={7} onLayout={event => setListHeight(event.nativeEvent.layout.height)} onScroll={event => { tree.scroll = event.nativeEvent.contentOffset.y; setVisibleStart(Math.floor(tree.scroll / rowHeight)); }} scrollEventThrottle={100} ListEmptyComponent={<Text style={{ color: c.foregroundMuted, padding: 10 }}>{zh ? '目录为空' : 'Empty directory'}</Text>} ListFooterComponent={!rows.some(row => row.entry) && (filter || tree.expanded.has(tree.root) && tree.pages.has(tree.root) && !tree.pages.get(tree.root)?.entries.length) ? <Text style={{ color: c.foregroundMuted, padding: 10, fontSize: 12 }}>{filter ? zh ? '未找到匹配的文件或目录（仅筛选已加载内容）' : 'No matching files or folders (loaded entries only)' : zh ? '目录为空' : 'Empty directory'}</Text> : null} />
    {/* Reuse the existing single-line status area so drag feedback cannot move the drop targets. */}
    <Text numberOfLines={1} style={{ paddingHorizontal: 7, paddingVertical: 3, lineHeight: 14, color: c.foregroundMuted, fontSize: 10 }}>{drop !== null ? `${zh ? '放到' : 'Drop into'} ${workspace.displayName || workspace.id}:/${drop}` : <>{readOnly ? zh ? '聚合工作区只读' : 'Aggregate workspace · read only' : zh ? `${entries.size} 项 · 拖入上传 · 右键操作` : `${entries.size} loaded · Drop to upload · Right click for actions`}{gitPending ? zh ? ' · Git 状态待更新' : ' · Git status pending update' : ''}{selected.length ? ` · ${selected.length} ${zh ? '项已选' : 'selected'}` : ''}{clipboard?.scope === scope ? ` · ${clipboard.entries.length} ${clipboard.operation === 'copy' ? zh ? '项已复制' : 'copied' : zh ? '项已剪切' : 'cut'}` : ''}</>}</Text>
    <Modal open={menu !== null && dialog === null} title={zh ? '文件操作' : 'File actions'} onOpenChange={open => { if (!open) setMenu(null); }}><Modal.Content contentContainerStyle={{ padding: 10 }}>
      <View testID="files-menu-selection" style={{ padding: 9, gap: 5 }}>
        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: '600' }}>{workspace.displayName || workspace.id} · {selected.length ? zh ? `已选 ${selected.length} 项` : `${selected.length} selected` : zh ? '未选择文件' : 'No files selected'}</Text>
        {selected.length ? <ScrollView style={{ maxHeight: 150 }} contentContainerStyle={{ gap: 4 }}>{selected.map(entry => <View key={entry.path} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
          <GeometricIcon name={fileTreeIcon(entry.name, entry.kind, false)} size={14} color={c.foregroundMuted}/>
          <Text selectable style={{ color: c.foreground, fontSize: 12, flex: 1, minWidth: 0 }}>{entry.path}</Text>
        </View>)}</ScrollView> : null}
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 11 }}>{zh ? '上传／新建／粘贴到：' : 'Upload / new folder / paste into: '}/{targetPath}</Text>
      </View>
      {decorationsEnabled && selected.length <= 1 && menu !== null ? (() => { const path = selected[0]?.path ?? menu, record = tree.decorations.entries.get(path); return <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, lineHeight: 16, paddingHorizontal: 9, paddingBottom: 9 }}>{fileGitDescription(record?.entry, zh, record?.freshness !== 'fresh')}</Text>; })() : null}
      {menuItems}
    </Modal.Content></Modal>
    <Modal open={dialog !== null} title={dialog === 'delete' ? zh ? '确认永久删除' : 'Confirm permanent deletion' : dialog === 'rename' ? zh ? '重命名' : 'Rename' : zh ? '新建文件夹' : 'New folder'} onOpenChange={open => { if (!open) setDialog(null); }}><Modal.Content contentContainerStyle={{ padding: 14, gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 12 }}>{workspace.displayName || workspace.id}:/{dialogPath}</Text>
      {dialog === 'delete' ? <><Text style={{ color: c.statusWarning || '#eabf6c', fontSize: 12 }}>{zh ? '这些文件将被永久删除；所选目录及其全部内容也会删除。' : 'Selected files and all contents of selected directories will be permanently deleted.'}</Text><ScrollView style={{ maxHeight: 180 }}>{dialogEntries.map(e => <Text key={e.path} style={{ color: c.foreground, fontSize: 12, paddingVertical: 3 }}>{e.kind === 'directory' ? '▸ ' : ''}{e.path}</Text>)}</ScrollView></> : <TextInput value={name} onChangeText={setName} onSubmitEditing={apply} autoFocus style={{ color: c.foreground, borderWidth: 1, borderColor: c.border || '#ffffff44', padding: 9 }} />}
      {error ? <Text style={{ color: c.statusWarning || '#eabf6c' }}>{error}</Text> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>{button(zh ? '取消' : 'Cancel', () => setDialog(null))}{button(dialog === 'delete' ? zh ? '永久删除' : 'Delete permanently' : zh ? '确定' : 'Confirm', apply, dialog !== 'delete' && !name.trim())}</View>
    </Modal.Content></Modal>
    <Modal open={Boolean(preview)} title={preview?.name || ''} onOpenChange={open => { if (!open) setPreview(null); }}><Modal.Content scrollable contentContainerStyle={{ padding: 12, gap: 8 }}><Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{zh ? '预览前 64 KiB' : 'Preview first 64 KiB'} · {fileBytes(preview?.size || 0)}</Text><Text selectable style={{ color: c.foreground, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>{preview?.text}</Text></Modal.Content></Modal>
  </View>;
  return Platform.OS === 'web' ? createElement('div', { ref: rootRef, tabIndex: 0, onKeyDownCapture: keyDown, onDragOver: (event: any) => { if (event.currentTarget.contains(event.target)) dragOver(event, rows[0]); }, onDrop: (event: any) => { if (event.currentTarget.contains(event.target)) onDrop(event, rows[0]); }, onContextMenu: (event: any) => { if (!event.currentTarget.contains(event.target) || /input|textarea/i.test(event.target?.tagName || '')) return; event.preventDefault(); selection(tree.root); setMenu(tree.root); }, onDragEnd: () => { dragged.current = [];pointerPressed.current=false;tree.interacting=menu!==null || dialog!==null || busy.current || !!filter; setDrop(null); clearTimeout(hover.current); }, onDragLeave: (event: any) => { if (!event.currentTarget.contains(event.relatedTarget)) { setDrop(null); clearTimeout(hover.current); } }, style: { display: 'flex', flexDirection: 'column', width: '100%', flex: 1, minHeight: 0, outline: 'none' } } as any, body) : body;
}
