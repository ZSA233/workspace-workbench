import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon, ScrollView } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import { basketCounts, basketSelections, changeAsset, changeMessage, compact, selectTopic, type TopicBasket } from '../../topic-selection';
import { groupKey, type ArchiveTopic, type ArchiveTopicDetail, type TopicMaterialPreview, type TopicPage, type TopicTarget, type WatchedGroup } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Label, Search, ignoreFailure, useColors } from './ui';
import { Check, MediaCount, TopicAsset, TopicIcon, TopicStatus, topicError } from './topic-ui';
import { selectedAssets } from '../../topic-selection';
import { TopicRow } from './topic-row';
import { TopicMaterialBasket } from './topic-basket';

type TopicsPanelProps = {
  client: TopicsClient; width: number; onSettings(): void; workspaceNames: Record<string, string>; currentWorkspaceId?: string;
};

export function TopicsPanel(props: TopicsPanelProps) {
  const c = useColors(), { client, onSettings } = props;
  const [error, setError] = useState(''), [statusOpen, setStatusOpen] = useState(false);
  // Navigation stays available in every project; activation only gates data and delivery.
  if (client.enabled) return <ActiveTopicsPanel {...props} />;
  const failure = error || client.error;
  return <View testID="workbench-topics-panel" style={{ flex: 1, minHeight: 0, backgroundColor: c.surface1 }}>
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }}>
      {!client.state && !failure ? <ActivityIndicator color={c.accent} /> : <>
        <Icon name="Layers" size={28} color={c.foregroundMuted} />
        <Label muted>此项目尚未启用话题</Label>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Button id="topics-enable" variant="primary" icon={client.connection?.hasToken ? 'Power' : 'Link'}
            disabled={client.changing} onPress={() => {
              if (!client.connection?.hasToken) { onSettings(); return; }
              setError('');
              void client.setEnabled(true).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
            }}>{client.connection?.hasToken ? '启用话题' : '连接 AI 助手'}</Button>
          {client.connection?.hasToken ? <TopicIcon icon="Settings" label="关注设置" onPress={onSettings} /> : null}
        </View>
      </>}
    </View>
    <TopicStatus error={failure} state="" onDetails={() => { if (failure) setStatusOpen(true); }} />
    {statusOpen ? <Dialog title="话题状态" onClose={() => setStatusOpen(false)} width={600} height={360}>
      <ScrollView contentContainerStyle={{ padding: 18 }}><Label>{failure}</Label></ScrollView>
    </Dialog> : null}
  </View>;
}

function ActiveTopicsPanel({ client, width, onSettings, workspaceNames, currentWorkspaceId }: TopicsPanelProps) {
  const c = useColors(), cache = useQueryClient(), narrow = width > 0 && width < 580;
  const [query, setQuery] = useState(''), [group, setGroup] = useState<WatchedGroup>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set()), [basket, setBasket] = useState<TopicBasket>({});
  const [loading, setLoading] = useState<Set<string>>(new Set()), [target, setTarget] = useState('');
  const [picker, setPicker] = useState<'group' | 'target' | ''>('');
  const [preview, setPreview] = useState<TopicMaterialPreview>(), [previewOpen, setPreviewOpen] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [statusOpen, setStatusOpen] = useState(false);
  const list = useInfiniteQuery({
    queryKey: ['archive-topics', client.scopeKey, query, group ? groupKey(group) : 'all'],
    initialPageParam: undefined as { beforeUpdated: number; beforeId: string } | undefined,
    queryFn: ({ pageParam }) => client.call<TopicPage>({ action: 'list', query, group, limit: 30, ...pageParam }),
    getNextPageParam: page => page.hasMore ? page.next : undefined,
    enabled: client.enabled && client.active && Boolean(client.connection?.hasToken),
    retry: false, refetchOnWindowFocus: false, refetchInterval: client.active ? 20000 : false,
  });
  const targets = useQuery({
    queryKey: ['archive-targets', client.scopeKey],
    queryFn: () => client.call<TopicTarget[]>({ action: 'targets' }),
    enabled: client.enabled && client.active, retry: false, staleTime: 10000, refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (target || !targets.data) return;
    const current = targets.data.find(item => item.workspaceId === currentWorkspaceId);
    if (current) setTarget(current.workspaceId);
    else if (targets.data.length === 1) setTarget(targets.data[0].workspaceId);
  }, [targets.data, currentWorkspaceId, target]);
  const indexed = new Map<string, ArchiveTopic>();
  for (const item of list.data?.pages.flatMap(page => page.items) || []) if (!indexed.has(item.id)) indexed.set(item.id, item);
  const items = [...indexed.values()], counts = basketCounts(basket);
  const watched = client.connection?.connection.watchedGroups || [];
  const channels = (client.directory?.channels || []).filter(channel => watched.some(value => groupKey(value) === groupKey(channel)));
  const groupName = (value: WatchedGroup) => client.directory?.channels.find(channel => groupKey(channel) === groupKey(value))?.name
    || client.directory?.groups.find(item => groupKey(item) === groupKey(value))?.name || value.channelId;
  const edit = (change: (current: TopicBasket) => TopicBasket) => {
    if (busy) return;
    setBasket(change); setPreview(undefined); setError('');
  };
  const select = async (topic: ArchiveTopic) => {
    if (basket[topic.id]) { edit(current => selectTopic(current, current[topic.id].topic)); return; }
    setLoading(current => new Set(current).add(topic.id));
    try {
      const detail = await cache.fetchQuery({
        queryKey: ['archive-topic', client.scopeKey, topic.id],
        queryFn: () => client.call<ArchiveTopicDetail>({ action: 'read', topicId: topic.id }),
        staleTime: 0,
      });
      edit(current => selectTopic(current, detail));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(current => { const next = new Set(current); next.delete(topic.id); return next; }); }
  };
  const perform = async (send: boolean) => {
    setBusy(true); setError('');
    try {
      if (preview?.state === 'sending' || preview?.state === 'uncertain') {
        setPreview(await client.call<TopicMaterialPreview>({ action: 'receipt', id: preview.id })); return;
      }
      const prepared = preview || await client.call<TopicMaterialPreview>({
        action: 'preview', workspaceId: target, selections: basketSelections(basket),
      });
      setPreview(prepared);
      if (send) setPreview(await client.call<TopicMaterialPreview>({ action: 'send', id: prepared.id }));
      else setPreviewOpen(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const overLimit = counts.topics > 20 || counts.messages > 100 || counts.assets > 20;
  const shownError = error || client.error || list.error?.message || (overLimit ? 'topic_material_limit' : '');
  const state = preview?.state === 'accepted' ? '已交接' : preview?.state === 'uncertain' || preview?.state === 'sending' ? '回执待确认' : '';
  const removeTopic = (id: string) => edit(current => { const next = { ...current }; delete next[id]; return next; });
  const selectPage = async () => {
    if (items.every(item => basket[item.id])) { edit(current => Object.fromEntries(Object.entries(current).filter(([id]) => !indexed.has(id)))); return; }
    for (const topic of items.filter(item => !basket[item.id]).slice(0, 20 - counts.topics)) await select(topic);
  };
  return <View testID="workbench-topics-panel" style={{ flex: 1, minHeight: 0, backgroundColor: c.surface1 }}>
    <View style={{ padding: 10, gap: 6, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flex: 1, minWidth: 80 }}><Search value={query} onChange={setQuery} placeholder="搜索话题" /></View>
      <Button icon="Users" label={!watched.length ? '选择关注群' : group ? groupName(group) : '全部关注群'}
        onPress={() => watched.length ? setPicker('group') : onSettings()}>{width > 0 && width < 430 ? undefined : !watched.length ? '选择关注群' : group ? groupName(group).slice(0, 12) : '全部关注群'}</Button>
      <TopicIcon id="topics-refresh" icon="RefreshCw" label="刷新话题" busy={list.isFetching} onPress={() => ignoreFailure(client.refresh())} />
      <TopicIcon id="topics-settings" icon="Settings" label="关注设置" onPress={onSettings} />
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 33, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Check checked={items.length > 0 && items.every(item => Boolean(basket[item.id]))}
        disabled={busy || loading.size > 0 || !items.length} label="选择当前页话题" onPress={() => ignoreFailure(selectPage())} />
      <View style={{ flex: 1 }}><Label muted>话题</Label></View>
      <MediaCount icon="MessageSquare" count={counts.messages} label="已选原文" /><MediaCount icon="Image" count={counts.assets} label="已选附件" />
    </View>
    <ScrollView testID="topics-list" style={{ flex: 1, minHeight: 70 }}>
      {list.isLoading ? <ActivityIndicator style={{ padding: 20 }} /> : null}
      {!list.isLoading && !items.length ? <View style={{ alignItems: 'center', padding: 30, gap: 10 }}>
        <Icon name="Layers" size={28} color={c.foregroundMuted} /><Label muted>{query ? '没有匹配话题' : !watched.length ? '此项目尚未关注群' : '暂无话题'}</Label>
        {!client.connection?.hasToken ? <Button onPress={onSettings}>连接 AI 助手</Button> : null}
        {client.connection?.hasToken && !watched.length ? <Button onPress={onSettings}>选择关注群</Button> : null}
      </View> : null}
      {items.map(topic => <TopicRow key={topic.id} {...{ topic, client, narrow, busy }} groupName={groupName(topic)}
        selected={basket[topic.id]} expanded={expanded.has(topic.id)} loading={loading.has(topic.id)}
        onExpand={() => setExpanded(current => { const next = new Set(current); if (next.has(topic.id)) next.delete(topic.id); else next.add(topic.id); return next; })}
        onSelect={() => ignoreFailure(select(topic))} onReload={() => removeTopic(topic.id)}
        onMessage={(detail, message, anchor) => edit(current => changeMessage(current, detail, message, anchor))}
        onAsset={(detail, message, asset, anchor) => edit(current => changeAsset(current, detail, message, asset, anchor))}
        onAnalysis={detail => edit(current => {
          const selected = current[detail.id] || { topic: detail, messages: [], assetIds: [], contexts: {}, includeAnalysis: false };
          return compact({ ...current, [detail.id]: { ...selected, includeAnalysis: !selected.includeAnalysis } });
        })} />)}
      {list.hasNextPage ? <View style={{ padding: 10 }}><Button disabled={list.isFetchingNextPage} onPress={() => ignoreFailure(list.fetchNextPage())}>更多话题</Button></View> : null}
    </ScrollView>
    <TopicMaterialBasket {...{ client, basket, edit, busy, narrow, target, preview }}
      targetName={workspaceNames[target] || target} onTarget={() => { setPicker('target'); void targets.refetch(); }}
      onPreview={() => ignoreFailure(perform(false))} onSend={() => ignoreFailure(perform(true))} />
    <TopicStatus error={shownError} state={state} onDetails={() => { if (shownError || state) setStatusOpen(true); }} />
    {picker ? <Dialog title={picker === 'group' ? '关注群' : '目标会话'} onClose={() => setPicker('')} width={540} height={450}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        {picker === 'group' ? <>
          <Button active={!group} onPress={() => { setGroup(undefined); setPicker(''); }}>全部关注群</Button>
          {channels.map(channel => <Button key={groupKey(channel)} active={Boolean(group && groupKey(group) === groupKey(channel))}
            onPress={() => { setGroup(channel); setPicker(''); }}>{channel.name}</Button>)}
        </> : targets.data?.length ? targets.data.map(item => <Button key={item.workspaceId} active={target === item.workspaceId}
          onPress={() => { setTarget(item.workspaceId); setPreview(undefined); setPicker(''); }}>{workspaceNames[item.workspaceId] || item.workspaceId}</Button>)
          : <Label muted>{targets.error ? topicError(targets.error.message) : '先在 Workspace 打开开发会话'}</Label>}
      </ScrollView>
    </Dialog> : null}
    {previewOpen && preview ? <Dialog title="所选材料" onClose={() => setPreviewOpen(false)} width={800} height={750}
      footer={<><Button onPress={() => setPreviewOpen(false)}>返回</Button><Button variant="primary" disabled={busy || preview.state === 'accepted'}
        onPress={() => ignoreFailure(perform(true))}>带入会话</Button></>}>
      <ScrollView contentContainerStyle={{ padding: 18, gap: 16 }}>
        {Object.values(basket).map(selected => <View key={selected.topic.id} style={{ gap: 8 }}>
          <Label large>{selected.topic.title}</Label><Label muted>{groupName(selected.topic)}</Label>
          {selected.messages.map(message => <View key={message.id} style={{ borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 12 }}>
            <Label>{message.text || '附件消息'}</Label>
          </View>)}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {selectedAssets(selected).map(({ message, asset }) => <TopicAsset key={asset.id} {...{ client, message, asset }}
              topicId={selected.topic.id} contextOf={selected.contexts[message.id]} checked disabled onToggle={() => undefined} />)}
          </View>
          {selected.includeAnalysis ? <Label>{selected.topic.lastAnswer || selected.topic.summary}</Label> : null}
        </View>)}
      </ScrollView>
    </Dialog> : null}
    {statusOpen ? <Dialog title={state || '连接状态'} onClose={() => setStatusOpen(false)} width={520} height={260}>
      <View style={{ padding: 18, gap: 8 }}><Label>{shownError ? topicError(shownError) : state}</Label>
        {shownError && topicError(shownError) !== shownError ? <Label muted>{shownError}</Label> : null}
        {preview ? <Label muted>{preview.id}</Label> : null}
      </View>
    </Dialog> : null}
  </View>;
}
