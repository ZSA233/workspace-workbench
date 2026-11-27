import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { DirectoryChoices, FileBrowserSettings } from '../shared/file-browser';
import type { FileTransferStore } from './files-store';
import { Modal, ScrollView, TextInput } from './native-components';
import { useWorkbenchLocale } from './i18n';

export function FileDirectorySettings({ project, store, theme, onClose, onSaved, sessionDirectory }: {
  project: string; store: FileTransferStore; theme: any; onClose(): void; onSaved(settings: FileBrowserSettings): void;
  sessionDirectory?: string;
}) {
  const zh = useWorkbenchLocale() === 'zh-CN', c = theme.colors, client = useQueryClient();
  const query = useQuery({ queryKey: ['workspace-workbench', project, 'file-browser-settings'],
    queryFn: () => store.call({ action: 'browser-settings' }) as Promise<FileBrowserSettings>, staleTime: 0, retry: false });
  const [directory, setDirectory] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const value = editing ? directory : query.data?.mainDirectory ?? null;
  const button = (label: string, onPress: () => void, disabled = false, selected = false) => <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={{ paddingHorizontal: 9, paddingVertical: 7, borderRadius: 4, borderWidth: 1, borderColor: selected ? c.accent : c.border, opacity: disabled ? .5 : 1 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text></Pressable>;
  async function save() {
    if (!query.data || saving) return;
    setSaving(true); setError('');
    try {
      const result = await store.call({ action: 'browser-configure', revision: query.data.revision, mainDirectory: value }) as FileBrowserSettings;
      client.setQueryData(['workspace-workbench', project, 'file-browser-settings'], result);
      await client.invalidateQueries({ queryKey: ['workspace-workbench', project, 'workspace-list'] });
      onSaved(result); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  return <Modal open title={zh ? '文件目录设置' : 'File directory settings'} onOpenChange={open => { if (!open && !saving) onClose(); }}><Modal.Content contentContainerStyle={{ padding: 16, gap: 12 }}>
    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{zh ? '默认跟随选中的 Workspace。查看主工作区时，自动使用当前会话所属项目的主目录，无需手填路径。' : 'Files follow the selected Workspace. Main workspace uses the current session’s project directory automatically.'}</Text>
    {query.isPending ? <Text style={{ color: c.foregroundMuted }}>{zh ? '读取目录…' : 'Loading directories…'}</Text> : null}
    {query.isError ? <>{button(zh ? '重试' : 'Retry', () => { void query.refetch(); })}<Text style={{ color: c.statusWarning }}>{String(query.error.message)}</Text></> : null}
    {query.data ? <>
      {button(zh ? '自动识别主目录' : 'Automatic main directory', () => { setEditing(true); setDirectory(null); }, saving, value === null)}
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{query.data.automaticDirectory}</Text>
      {button(zh ? '选择其他目录…' : 'Choose another directory…', () => setBrowsing(true), saving, value !== null)}
      {value ? <Text selectable style={{ color: c.foreground, fontSize: 12 }}>{value}</Text> : null}
      {sessionDirectory ? button(zh ? '使用当前会话目录' : 'Use current session directory', () => { setEditing(true); setDirectory(sessionDirectory); }, saving) : null}
      <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{zh ? '仅改变主工作区的文件浏览目录；Git、多仓库配置及执行目标保持独立。目录来自连接的主机。' : 'This changes the main file view. Git repository scope and execution targets remain independent. Directories are on the connected host.'}</Text>
    </> : null}
    {error ? <Text selectable style={{ color: c.statusWarning, fontSize: 12 }}>{error}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 8 }}>{button(saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save'), () => { void save(); }, saving || !query.data)}{button(zh ? '取消' : 'Cancel', onClose, saving)}</View>
    {browsing && query.data ? <HostDirectoryPicker project={project} store={store} theme={theme} initial={value || query.data.effectiveDirectory} onClose={() => setBrowsing(false)} onSelect={path => { setEditing(true); setDirectory(path); setBrowsing(false); }} /> : null}
  </Modal.Content></Modal>;
}

function HostDirectoryPicker({ project, store, theme, initial, onClose, onSelect }: { project: string; store: FileTransferStore; theme: any; initial: string; onClose(): void; onSelect(path: string): void }) {
  const zh = useWorkbenchLocale() === 'zh-CN', c = theme.colors;
  const [directory, setDirectory] = useState(initial), [path, setPath] = useState(initial), [more, setMore] = useState<DirectoryChoices>();
  const [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState('');
  const query = useQuery({ queryKey: ['workspace-workbench', project, 'file-directory-picker', directory], queryFn: () => store.call({ action: 'browse-directories', directory }) as Promise<DirectoryChoices>, staleTime: 0, retry: false });
  const listing = more?.directory === query.data?.directory ? more : query.data;
  const navigate = (next: string) => { next = next.trim(); setMore(undefined); setError(''); setDirectory(next); setPath(next); if (next === directory) void query.refetch(); };
  async function loadMore() {
    if (!listing?.cursor || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const page = await store.call({ action: 'browse-directories', directory: listing.directory, cursor: listing.cursor }) as DirectoryChoices;
      setMore({ ...page, entries: [...listing.entries, ...page.entries] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoadingMore(false); }
  }
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable key={label} accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ padding: 8, opacity: disabled ? .5 : 1 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{label}</Text></Pressable>;
  return <Modal open title={zh ? '选择主机上的目录' : 'Choose a host directory'} onOpenChange={open => { if (!open) onClose(); }}><Modal.Content contentContainerStyle={{ padding: 12, gap: 8 }}>
    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
      <TextInput accessibilityLabel={zh ? '主机目录路径' : 'Host directory path'} value={path} onChangeText={setPath} onSubmitEditing={() => navigate(path)} style={{ flex: 1, minWidth: 0, color: c.foreground, borderWidth: 1, borderColor: c.border, padding: 8, fontSize: 12 }} />
      {button(zh ? '打开' : 'Open', () => navigate(path), !path.trim() || query.isFetching)}
    </View>
    {button(zh ? '↑ 上一级' : '↑ Parent directory', () => navigate(listing!.parent!), !listing?.parent || query.isFetching)}
    <ScrollView style={{ maxHeight: 300, minHeight: 120 }}>
      {query.isFetching ? <Text style={{ color: c.foregroundMuted }}>{zh ? '读取目录…' : 'Loading directories…'}</Text> : null}
      {listing?.entries.map(entry => <View key={entry.directory}>{button('▸ ' + entry.name, () => navigate(entry.directory))}</View>)}
      {listing && !listing.entries.length && !query.isFetching ? <Text style={{ color: c.foregroundMuted }}>{zh ? '没有子目录' : 'No subdirectories'}</Text> : null}
      {listing?.cursor ? button(zh ? '加载更多目录' : 'More directories', () => { void loadMore(); }, loadingMore) : null}
    </ScrollView>
    {error || query.error ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>{error || query.error?.message}</Text> : null}
    <View style={{ flexDirection: 'row', gap: 8 }}>{button(zh ? '选择此目录' : 'Choose this directory', () => onSelect(listing!.directory), !listing || path.trim() !== directory || query.isFetching || query.isError)}{button(zh ? '取消' : 'Cancel', onClose)}</View>
  </Modal.Content></Modal>;
}
