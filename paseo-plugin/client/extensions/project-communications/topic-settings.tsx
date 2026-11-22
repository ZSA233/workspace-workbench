import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { Icon, ScrollView } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import type { ArchiveChannel, ArchiveGroup, WatchedGroup } from '../../../shared/extensions/project-communications/topics';
import { groupKey } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Field, Label, Search, Toggle, ignoreFailure, useColors } from './ui';
import { Check, MediaCount, TopicIcon, TopicStatus, topicError } from './topic-ui';

type ToolDraft = { channel: ArchiveChannel; group?: ArchiveGroup; ids: string[] };
export function TopicSettings({ client, open, onClose, initialPage }: {
  client: TopicsClient; open: boolean; onClose(): void; initialPage?: string;
}) {
  const c = useColors();
  const [page, setPage] = useState<'connection' | 'groups'>(initialPage === '连接与来源' ? 'groups' : 'connection');
  const [endpoint, setEndpoint] = useState(''), [libraryId, setLibraryId] = useState('default'), [token, setToken] = useState<string>();
  const [watched, setWatched] = useState<WatchedGroup[]>([]), [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [connected, setConnected] = useState(false);
  const [tools, setTools] = useState<ToolDraft>(), [toolQuery, setToolQuery] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => {
    if (!client.connection) return;
    setEndpoint(client.connection.connection.endpoint);
    setLibraryId(client.connection.connection.libraryId || 'default');
    setWatched(client.connection.connection.watchedGroups || []);
    setToken(undefined);
  }, [client.connection?.revision]);
  useEffect(() => {
    if (open) setPage(client.connection?.hasToken && initialPage === '连接与来源' ? 'groups' : 'connection');
  }, [open, initialPage]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); return true; } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return false; }
    finally { setBusy(false); }
  };
  const save = (connection: boolean) => run(async () => {
    if (!client.connection) return;
    await client.updateConnection({
      ...client.connection.connection, endpoint: connection ? endpoint : client.connection.connection.endpoint,
      libraryId: connection ? libraryId : client.connection.connection.libraryId || 'default',
      watchedGroups: connection && libraryId !== (client.connection.connection.libraryId || 'default') ? [] : watched,
    }, client.connection.revision, connection ? token : undefined);
  });
  const configure = (channel: ArchiveChannel, group: ArchiveGroup | undefined, collect?: boolean, ids = group?.allowedTools || []) => run(async () => {
    await client.call({ action: 'group.configure', sourceId: channel.sourceId, channelId: channel.channelId,
      revision: group?.revision || 0, collect, allowedTools: ids, requestId: 'group-' + Date.now() + '-' + Math.random().toString(36).slice(2) });
  });
  const selected = new Set(watched.map(groupKey));
  const channels = (client.directory?.channels || []).filter(channel => !filter || channel.name.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (channel: ArchiveChannel) => setWatched(current => selected.has(groupKey(channel))
    ? current.filter(item => groupKey(item) !== groupKey(channel)) : [...current, { sourceId: channel.sourceId, channelId: channel.channelId }]);
  const draftIds = new Set(tools?.ids);
  const availableTools = (client.directory?.tools || []).filter(tool => !toolQuery || (tool.name || tool.id).toLowerCase().includes(toolQuery.toLowerCase()));
  const dirty = JSON.stringify(watched) !== JSON.stringify(client.connection?.connection.watchedGroups || []);
  const connectionDirty = endpoint !== client.connection?.connection.endpoint || libraryId !== (client.connection?.connection.libraryId || 'default') || token !== undefined;
  return <Dialog open={open} id="communications-settings-dialog" title="话题设置" onClose={onClose} width={900} height={690}
    footer={<>
      <View style={{ flex: 1 }}><Button icon={client.enabled ? 'Pause' : 'Power'} disabled={busy || client.changing || !client.connection?.hasToken}
        onPress={() => ignoreFailure(run(() => client.setEnabled(!client.enabled)))}>{client.enabled ? '停用话题' : '启用话题'}</Button></View>
      <Button onPress={onClose}>完成</Button>
      <Button variant="primary" disabled={busy || !client.connection || (page === 'groups' ? !dirty : !connectionDirty && !dirty)}
        onPress={() => ignoreFailure(save(page === 'connection'))}>保存</Button>
    </>}>
    <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Button icon="Link" active={page === 'connection'} variant="ghost" onPress={() => setPage('connection')}>连接</Button>
      <Button icon="Users" active={page === 'groups'} variant="ghost" onPress={() => setPage('groups')}>关注群</Button>
      <TopicIcon icon="RefreshCw" label="刷新设置" busy={busy} onPress={() => ignoreFailure(client.refresh())} />
      <View style={{ flex: 1 }} />{busy ? <ActivityIndicator size="small" /> : null}
    </View>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 18 }}>
      {page === 'connection' ? <>
        <Field id="communications-service-endpoint" label="服务地址" value={endpoint} onChange={setEndpoint} />
        <Field id="communications-service-token" label="API Token" value={token || ''} secret placeholder={client.connection?.hasToken ? '已保存' : '服务端 Token'} onChange={setToken} />
        <Field id="topics-library" label="资料库" value={libraryId} onChange={value => { setLibraryId(value); setWatched([]); }} />
        {client.directory?.libraries.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
          {client.directory.libraries.map(library => <Button key={library.id} active={libraryId === library.id}
            onPress={() => { setLibraryId(library.id); if (library.id !== client.connection?.connection.libraryId) setWatched([]); }}>{library.name}</Button>)}
        </View> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Button icon="Plug" disabled={busy || connectionDirty} onPress={() => ignoreFailure(run(async () => {
            const status = await client.checkConnection(); setConnected(Boolean(status.connected));
            if (!status.connected) throw Error(status.detail || '连接失败');
          }))}>检测连接</Button>
          {connected ? <Icon name="CircleCheck" size={17} color={c.statusSuccess} /> : null}
        </View>
      </> : <>
        <Search value={filter} onChange={setFilter} placeholder="搜索群" />
        {channels.map(channel => {
          const group = client.directory?.groups.find(item => groupKey(item) === groupKey(channel));
          const collecting = Boolean(group?.autoDiscover && group.discoveryAction === 'collect' && group.replyMode === 'off');
          return <View key={groupKey(channel)} style={{ gap: 5, borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 7 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Check checked={selected.has(groupKey(channel))} disabled={busy} label={'关注 ' + channel.name} onPress={() => toggle(channel)} />
              <View style={{ flex: 1 }}><Text style={{ color: c.foreground, fontSize: 13 }}>{channel.name}</Text></View>
              <TopicIcon icon="Wrench" label={'工具授权 ' + channel.name} disabled={busy || !client.enabled}
                onPress={() => { setTools({ channel, group, ids: [...(group?.allowedTools || client.directory?.tools.filter(item => item.builtin).map(item => item.id) || [])] }); setToolQuery(''); }} />
              <MediaCount icon="Wrench" count={group?.allowedTools.length || 0} label="工具" />
            </View>
            {channel.provider === 'dingtalk' || channel.sourceId.startsWith('dingtalk:') ? <View style={{ paddingLeft: 39, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
              <Toggle label="自动建题" checked={collecting} disabled={busy || !client.enabled} onChange={value => ignoreFailure(configure(channel, group, value, group?.allowedTools || client.directory?.tools.filter(item => item.builtin).map(item => item.id) || []))} />
              <View {...(Platform.OS === 'web' ? { title: collecting ? '仅建题，群回复关闭' : '在 AI 助手服务处理' } : {})}>
                <Icon name={collecting ? 'MessageCircleOff' : 'Circle'} size={14} color={collecting ? c.statusSuccess : c.foregroundMuted} />
              </View>
            </View> : null}
          </View>;
        })}
        {!channels.length ? <Label muted>{client.connection?.hasToken ? '暂无群' : '先连接 AI 助手'}</Label> : null}
      </>}
    </ScrollView>
    <TopicStatus error={error || client.error} state={connected ? '已连接' : ''} onDetails={() => { if (error || client.error) setStatusOpen(true); }} />
    {tools ? <Dialog title="工具授权" id="topics-tool-settings" onClose={() => setTools(undefined)} width={700} height={600}
      footer={<><Button onPress={() => setTools(undefined)}>取消</Button><Button variant="primary" disabled={busy} onPress={() => ignoreFailure((async () => {
        if (await configure(tools.channel, tools.group, undefined, tools.ids)) setTools(undefined);
      })())}>保存</Button></>}>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 6 }}>
        <Search value={toolQuery} onChange={setToolQuery} placeholder="搜索工具" />
        {availableTools.map(tool => <Pressable key={tool.id} accessibilityRole="checkbox" accessibilityLabel={tool.name || tool.id}
          aria-checked={draftIds.has(tool.id)} disabled={!tool.enabled || busy} {...(Platform.OS === 'web' ? { title: tool.description || tool.id } : {})}
          onPress={() => setTools(current => current ? { ...current, ids: draftIds.has(tool.id) ? current.ids.filter(id => id !== tool.id) : [...current.ids, tool.id] } : current)}
          style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border, opacity: tool.enabled ? 1 : 0.45 }}>
          <Icon name={draftIds.has(tool.id) ? 'SquareCheck' : 'Square'} size={17} color={draftIds.has(tool.id) ? c.accent : c.foregroundMuted} />
          <View style={{ flex: 1 }}><Label lines={1}>{tool.name || tool.id}</Label></View>
          <Icon name={tool.readOnly ? 'Eye' : 'Wrench'} size={14} color={c.foregroundMuted} />
        </Pressable>)}
      </ScrollView>
      <TopicStatus error={error} onDetails={() => { if (error) setStatusOpen(true); }} />
    </Dialog> : null}
    {statusOpen ? <Dialog title="连接状态" onClose={() => setStatusOpen(false)} width={540} height={280}>
      <View style={{ padding: 18, gap: 10 }}><Label>{topicError(error || client.error)}</Label><Label muted>{error || client.error}</Label></View>
    </Dialog> : null}
  </Dialog>;
}
