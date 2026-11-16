import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Icon, ScrollView } from '../../native-components';
import type { CommunicationsClient } from '../../use-communications';
import { categoryLabels, type Candidate, type Message, type Requirement } from '../../../shared/extensions/project-communications/shared';
import { Badge, Button, Card, Count, Label, Row, Search, capabilityText, dateText, ignoreFailure, shortTime, tint, useColors, useTouch } from './ui';
import { MessageCard, RequirementReader } from './readers';
import { CandidateReader } from './candidate';

export function CommunicationsPanel({ client, width, onSettings, workspaceNames }: {
  client: CommunicationsClient; width: number; onSettings: () => void; workspaceNames: Record<string, string>;
}) {
  const c = useColors(), narrow = width > 0 && width < 640, compactToolbar = width > 0 && width < 760, touch = useTouch();
  const [tab, setTab] = useState<'pending' | 'ledger' | 'messages'>('pending'), [selected, setSelected] = useState(''), [query, setQuery] = useState(''), [groupId, setGroupId] = useState('');
  const [showSnoozed, setShowSnoozed] = useState(false), [statusOpen, setStatusOpen] = useState(false);
  const snapshot = client.snapshot;
  const messages = useInfiniteQuery({ queryKey: ['communications-messages', client.scopeKey, query, groupId], initialPageParam: undefined as { before: number; beforeId: string } | undefined,
    queryFn: ({ pageParam }) => client.call<{ messages: Message[]; nextCursor?: { before: number; beforeId: string } }>({ action: 'messages.list', query, ...(groupId ? { groupId } : {}), ...pageParam, limit: 50 }),
    getNextPageParam: page => page.nextCursor, enabled: tab === 'messages', retry: false, refetchInterval: tab === 'messages' ? 10000 : false });
  const messageItems = [...new Map((messages.data?.pages.flatMap(page => page.messages) || []).map(item => [item.id, item])).values()];
  const analysisTask = snapshot?.tasks.find(item => item.kind === 'analysis');
  const candidatePages = useInfiniteQuery({ queryKey: ['communications-candidates', client.scopeKey, query, showSnoozed], initialPageParam: undefined as { time: number; id: string } | undefined,
    queryFn: ({ pageParam }) => client.call<{ items: Candidate[]; nextCursor?: { time: number; id: string } }>({ action: 'candidate.list', query, includeSnoozed: showSnoozed, before: pageParam, limit: 50 }),
    getNextPageParam: page => page.nextCursor, enabled: tab === 'pending', retry: false, refetchInterval: tab === 'pending' ? 10000 : false });
  const requirementPages = useInfiniteQuery({ queryKey: ['communications-requirements', client.scopeKey, query], initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => client.call<{ items: Requirement[]; nextCursor?: number }>({ action: 'requirement.list', query, before: pageParam, limit: 50 }),
    getNextPageParam: page => page.nextCursor, enabled: tab === 'ledger', retry: false, refetchInterval: tab === 'ledger' ? 10000 : false });
  const latestCandidates = new Map(snapshot?.candidates.map(item => [item.id, item]) || []), latestRequirements = new Map(snapshot?.requirements.map(item => [item.id, item]) || []);
  const candidates = (candidatePages.data?.pages.flatMap(page => page.items) || snapshot?.candidates || []).map(item => latestCandidates.get(item.id) || item)
    .filter(item => item.status === 'pending' || showSnoozed && item.status === 'snoozed').filter(item => !query || (item.title + '\n' + item.body).toLowerCase().includes(query.toLowerCase()));
  const requirements = (requirementPages.data?.pages.flatMap(page => page.items) || snapshot?.requirements || []).map(item => latestRequirements.get(item.id) || item)
    .filter(item => !query || (item.title + '\n' + item.body).toLowerCase().includes(query.toLowerCase()));
  const selectedCandidate = [...candidates, ...(snapshot?.candidates || [])].find(item => item.id === selected), selectedRequirement = [...requirements, ...(snapshot?.requirements || [])].find(item => item.id === selected);
  const selectedInMessages = messageItems.find(item => item.id === selected);
  const contextMessage = useQuery({ queryKey: ['communications-context-message', client.scopeKey, selected],
    queryFn: () => client.call<{ messages: Message[] }>({ action: 'messages.read', ids: [selected] }), enabled: tab === 'messages' && Boolean(selected) && !selectedInMessages, retry: false });
  const selectedMessage = selectedInMessages || contextMessage.data?.messages[0];
  const firstId = tab === 'pending' ? candidates[0]?.id : tab === 'ledger' ? requirements[0]?.id : messageItems[0]?.id;
  useEffect(() => { if (!narrow && !selected && firstId) setSelected(firstId); }, [narrow, selected, firstId]);
  const changeTab = (next: typeof tab) => { if (tab !== next) { setTab(next); setSelected(''); setQuery(''); } };
  const openContext = (ids: string[], group: string) => { setTab('messages'); setQuery(''); setGroupId(group); setSelected(ids[0] || ''); };
  const groups = snapshot?.groups.filter(item => item.enabled) || [];
  const verified = snapshot?.source.capabilities.messages.state === 'verified' && snapshot.source.capabilities.history.state === 'verified'
    && groups.length > 0 && groups.every(item => !item.error && item.membership.state === 'verified' && item.stream.state === 'verified' && item.history.state === 'verified');
  const sourceReady = Boolean(snapshot?.source.authenticated), paused = snapshot?.background === 'paused';
  const syncing = groups.some(item => item.status === 'syncing');
  const status = paused ? '项目后台已暂停' : !sourceReady ? (snapshot?.source.installed ? '钉钉待授权 · 采集已暂停' : 'DWS 未就绪 · 采集已暂停')
    : verified ? '钉钉已连接' + (syncing ? ' · 正在补读遗漏' : ' · 实时接收中') : '钉钉已授权 · 采集待验证';
  const statusColor = sourceReady && verified && !paused ? c.statusSuccess : c.statusWarning;
  const tabButton = (value: typeof tab, label: string, count?: number) => <Pressable accessibilityRole="button" accessibilityState={{ selected: tab === value }} onPress={() => changeTab(value)}
    style={{ minHeight: touch ? 44 : 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: narrow ? 10 : 12, borderBottomWidth: 2, borderBottomColor: tab === value ? c.accent : 'transparent' }}>
    <Text style={{ color: tab === value ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: tab === value ? '600' : '400' }}>{label}</Text>
    {count ? value === 'pending' ? <Count value={count} /> : <Label muted>{count}</Label> : null}
  </Pressable>;
  const item = ({ id, title, body, group, time, category, unread, meta }: {
    id: string; title: string; body: string; group?: string; time?: number; category?: Candidate['category']; unread?: boolean; meta?: string;
  }) => <Pressable key={id} testID={'communications-item-' + id} accessibilityRole="button" accessibilityState={{ selected: selected === id }} onPress={() => setSelected(id)}
    style={({ hovered }: any) => ({ marginHorizontal: 7, marginTop: 5, paddingHorizontal: 11, paddingVertical: 12, gap: 6, borderRadius: 6,
      backgroundColor: selected === id ? tint(c.accent, '15') : hovered ? c.surface2 : undefined, borderBottomWidth: 1, borderBottomColor: selected === id ? 'transparent' : c.border })}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      {category ? <Badge tone={category}>{categoryLabels[category]}</Badge> : null}
      <View style={{ flex: 1, minWidth: 0 }}><Label muted lines={1}>{group || meta}</Label></View>{time ? <Label muted>{shortTime(time)}</Label> : null}
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>{unread ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c.accent }} /> : null}
      <Text numberOfLines={2} style={{ flex: 1, color: c.foreground, fontSize: 14, fontWeight: '600', lineHeight: 21 }}>{title}</Text>
    </View><Label muted lines={2}>{body}</Label>
  </Pressable>;
  const search = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flex: compactToolbar ? 1 : undefined, width: compactToolbar ? undefined : 285 }}>
    <Search value={query} onChange={setQuery} placeholder={tab === 'messages' ? '搜索群内原文' : '搜索需求或讨论内容'} />
    {tab === 'pending' ? <Button icon="Clock" variant="ghost" active={showSnoozed} label="包含稍后处理" onPress={() => setShowSnoozed(value => !value)} /> : null}
  </View>;
  return <View testID="communications-panel" style={{ flex: 1, minHeight: 0, backgroundColor: c.surface1 }}>
    <View style={{ paddingHorizontal: 14, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="同步状态" accessibilityState={{ expanded: statusOpen }} onPress={() => setStatusOpen(value => !value)}
          style={{ flex: 1, minHeight: touch ? 44 : 28, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: statusColor }} /><Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, color: c.foregroundMuted }}>{status}</Text>
          <Icon name={statusOpen ? 'ChevronUp' : 'ChevronDown'} size={12} color={c.foregroundMuted} />
        </Pressable>
        {!narrow ? <Label muted>{groups.length + ' 个群 · ' + (snapshot?.messageCount || 0) + ' 条消息'}</Label> : null}
        <Button icon="Ellipsis" variant="ghost" label="项目沟通设置" id="communications-settings" onPress={onSettings} />
      </View>
      {statusOpen ? <View testID="communications-sync-details" style={{ paddingVertical: 10, gap: 9 }}>
        <Label warning={!sourceReady}>{snapshot?.source.detail || status}</Label>
        {groups.map(group => <Card key={group.id}><Label strong>{group.name}</Label><Label muted>{'入群 ' + capabilityText[group.membership.state] + ' · 普通消息 ' + capabilityText[group.stream.state] + ' · 遗漏补读 ' + capabilityText[group.history.state]}</Label>
          <Label muted>{'成功断点 ' + dateText(group.checkpoint)}</Label>{group.error ? <Label warning>{group.error}</Label> : null}</Card>)}
        <Row><Label muted>{(snapshot?.analysisPending || 0) + ' 条待分析' + (client.refreshing ? ' · 正在更新状态' : '')}</Label><Button variant="link" onPress={onSettings}>配置连接与权限</Button></Row>
      </View> : null}
    </View>
    {client.error ? <View style={{ paddingHorizontal: 14, paddingVertical: 5 }}><Label warning>{client.error}</Label></View> : null}
    {analysisTask?.state === 'failed' ? <View style={{ paddingHorizontal: 14, paddingVertical: 7, backgroundColor: tint(c.statusWarning, '0c') }}><Row><View style={{ flex: 1 }}><Label warning>{'分析暂停：' + analysisTask.error + ' · 消息继续保存'}</Label></View><Button variant="link" onPress={() => ignoreFailure(client.call({ action: 'analysis.retry' }))}>恢复分析</Button></Row></View> : null}
    <View style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingHorizontal: 8, flexDirection: compactToolbar ? 'column' : 'row', alignItems: compactToolbar ? 'stretch' : 'center', gap: compactToolbar ? 6 : 12, paddingBottom: compactToolbar ? 8 : 0 }}>
      <View style={{ flexDirection: 'row', flex: compactToolbar ? undefined : 1 }}>{tabButton('pending', '待确认', snapshot?.pending)}{tabButton('ledger', '需求台账', snapshot?.requirementCount)}{tabButton('messages', '消息')}</View>
      {search}
    </View>
    {tab === 'messages' ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 8, gap: 7 }}><Button variant="ghost" active={!groupId} onPress={() => setGroupId('')}>全部群</Button>{snapshot?.groups.map(group => <Button key={group.id} variant="ghost" active={groupId === group.id} onPress={() => setGroupId(group.id)}>{group.name}</Button>)}</ScrollView> : null}
    <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
      {!narrow || !selected ? <View style={{ flex: narrow ? 1 : undefined, width: narrow ? undefined : '33%', maxWidth: narrow ? undefined : 440, minWidth: narrow ? undefined : 224, borderRightWidth: narrow ? 0 : 1, borderRightColor: c.border }}>
        <ScrollView testID="communications-list" style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 4, paddingBottom: 14 }}>
          {tab === 'pending' ? candidates.map(candidate => item({ ...candidate, time: candidate.createdAt, group: snapshot?.groups.find(group => group.id === candidate.groupId)?.name }))
            : tab === 'ledger' ? requirements.map(requirement => item({ ...requirement, time: requirement.updatedAt, meta: 'REQ-' + String(requirement.number).padStart(3, '0') + ' · v' + requirement.version }))
              : messageItems.map(message => item({ id: message.id, title: message.sender, body: message.text || '附件消息', time: message.createdAt, group: snapshot?.groups.find(group => group.id === message.groupId)?.name }))}
          {tab === 'pending' && !candidates.length || tab === 'ledger' && !requirements.length || tab === 'messages' && !messageItems.length ? <View style={{ padding: 18, gap: 8 }}>
            <Label muted>{query ? '没有匹配的记录。' : tab === 'pending' ? '暂无待确认事项。完整讨论分析后会出现在这里。' : tab === 'ledger' ? '确认候选后会生成正式需求。' : '暂无消息。绑定、授权并核对入群后开始采集。'}</Label>{query ? <Button onPress={() => setQuery('')}>清除搜索</Button> : null}
          </View> : null}
          {tab === 'pending' && candidatePages.hasNextPage ? <Button disabled={candidatePages.isFetchingNextPage} onPress={() => ignoreFailure(candidatePages.fetchNextPage())}>加载更早候选</Button> : null}
          {tab === 'ledger' && requirementPages.hasNextPage ? <Button disabled={requirementPages.isFetchingNextPage} onPress={() => ignoreFailure(requirementPages.fetchNextPage())}>加载更早需求</Button> : null}
          {tab === 'pending' && candidatePages.error ? <Label warning>{candidatePages.error.message}</Label> : tab === 'ledger' && requirementPages.error ? <Label warning>{requirementPages.error.message}</Label> : null}
          {messages.error && tab === 'messages' ? <Label warning>{messages.error.message}</Label> : null}
          {tab === 'messages' && messages.hasNextPage ? <Button disabled={messages.isFetchingNextPage} onPress={() => ignoreFailure(messages.fetchNextPage())}>加载更早消息</Button> : null}
        </ScrollView>
      </View> : null}
      {!narrow || selected ? <View testID="communications-detail" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {narrow ? <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border, alignItems: 'flex-start' }}><Button variant="ghost" icon="ArrowLeft" onPress={() => setSelected('')}>返回列表</Button></View> : null}
        {tab === 'pending' && selectedCandidate ? <CandidateReader key={selectedCandidate.id} candidate={selectedCandidate} client={client} onContext={openContext} />
          : tab === 'ledger' && selectedRequirement ? <RequirementReader key={selectedRequirement.id} requirement={selectedRequirement} client={client} workspaceNames={workspaceNames} />
            : tab === 'messages' && selectedMessage ? <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18 }}><MessageCard message={selectedMessage} client={client} /></ScrollView>
              : <View style={{ padding: 24, gap: 8 }}><Label large>{tab === 'pending' ? '待确认事项' : tab === 'ledger' ? '需求台账' : '群内消息'}</Label><Label muted>{contextMessage.error?.message || '选择一条记录查看详情和原始依据。'}</Label></View>}
      </View> : null}
    </View>
  </View>;
}
