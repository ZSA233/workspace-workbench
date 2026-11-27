import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileBrowserSettings } from '../shared/file-browser';
import { openDocument } from './document-store';
import FilesManager from './files-manager';
import { FileDirectorySettings } from './file-directory-settings';
import type { FileTransferStore } from './files-store';
import type { WorkspaceSummary } from './model';
import { Modal } from './native-components';
import { useWorkbenchLocale } from './i18n';

export default function FilesWorkspacePanel({ project, scope, workspace, selectedWorkspace, mainWorkspace, onSelect, store, theme, foreground, sortedListing, decorationsEnabled, documentPreview, hostWorkspaceId, agentId, sessionDirectory }: {
  project: string; scope: string; workspace: WorkspaceSummary; selectedWorkspace: WorkspaceSummary; mainWorkspace?: WorkspaceSummary;
  onSelect(id: string): void; store: FileTransferStore; theme: any; foreground: boolean; sortedListing: boolean; decorationsEnabled: boolean;
  documentPreview: boolean; hostWorkspaceId: string; agentId?: string; sessionDirectory?: string;
}) {
  const zh = useWorkbenchLocale() === 'zh-CN', c = theme.colors, client = useQueryClient();
  const [menu, setMenu] = useState(false), [settings, setSettings] = useState(false);
  const directory = useQuery({ queryKey: ['workspace-workbench', project, 'file-browser-settings'],
    queryFn: () => store.call({ action: 'browser-settings' }) as Promise<FileBrowserSettings>, enabled: foreground, retry: false });
  const display = workspace.id === 'main' && directory.data ? { ...workspace, fileRoot: directory.data.effectiveDirectory } : workspace;
  const main = workspace.id === 'main';
  const choose = (id: string) => { onSelect(id); setMenu(false); };
  const label = main ? (zh ? '主工作区' : 'Main workspace') : (zh ? '当前 Workspace' : 'Selected Workspace');
  const toolbar = <Pressable accessibilityRole="button" accessibilityLabel={zh ? '切换文件浏览工作区' : 'Switch file workspace'} accessibilityState={{ expanded: menu }} onPress={() => setMenu(true)} style={{ paddingHorizontal: 7, paddingVertical: 5, maxWidth: 140 }}><Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12 }}>{label} ▾</Text></Pressable>;
  const button = (text: string, onPress: () => void, selected = false) => <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ paddingVertical: 10, paddingHorizontal: 8 }}><Text style={{ color: c.foreground, fontSize: 12 }}>{selected ? '✓ ' : ''}{text}</Text></Pressable>;
  return <View style={{ flex: 1, minHeight: 0 }}>
    <FilesManager key={`${scope}:${workspace.id}:${display.fileRoot || ''}`} scope={scope} workspace={display} store={store} theme={theme} toolbarStart={toolbar} foreground={foreground} sortedListing={sortedListing} decorationsEnabled={decorationsEnabled}
      onOpenDocument={documentPreview ? (path, instance) => openDocument({ hostWorkspaceId, agentId, projectConfig: project, scope, workspaceId: display.id, workspaceName: display.displayName || display.id, instance, directory: display.fileRoot || display.treePath || display.sourceRoot || '', path }) : undefined} />
    <Modal open={menu} title={zh ? '文件浏览位置' : 'File workspace'} onOpenChange={setMenu}><Modal.Content contentContainerStyle={{ padding: 10, gap: 4 }}>
      {selectedWorkspace.id !== 'main' ? button(`${zh ? '当前 Workspace' : 'Selected Workspace'} · ${selectedWorkspace.displayName || selectedWorkspace.id}`, () => choose(selectedWorkspace.id), !main) : null}
      {mainWorkspace ? button(zh ? '主工作区' : 'Main workspace', () => choose('main'), main) : null}
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 11, paddingHorizontal: 8 }}>{display.fileRoot || display.treePath || display.sourceRoot}</Text>
      {button(zh ? '文件目录设置…' : 'File directory settings…', () => { setMenu(false); setSettings(true); })}
    </Modal.Content></Modal>
    {settings ? <FileDirectorySettings project={project} store={store} theme={theme} sessionDirectory={sessionDirectory} onClose={() => setSettings(false)} onSaved={result => { client.setQueryData(['workspace-workbench', project, 'file-browser-settings'], result); }} /> : null}
  </View>;
}
