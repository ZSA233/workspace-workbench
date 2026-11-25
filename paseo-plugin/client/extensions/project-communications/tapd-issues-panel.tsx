import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { openExternalUrl } from '@getpaseo/plugin/client';
import { Icon, ScrollView } from '../../native-components';
import { changeIssuePart, issueAttachmentSelectable, removeIssue, selectIssue, type IssueBasket, type IssuePart } from '../../issue-selection';
import type { TopicsClient } from '../../use-topics';
import { type IssueConnection, type IssueDetail, type IssuePage, type IssueSource, type IssueSummary } from '../../../shared/extensions/project-communications/issues';
import { topicTime } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Label, Search, ignoreFailure, tint, useColors } from './ui';
import { Check, TopicAsset, TopicIcon, topicError } from './topic-ui';

type EditIssues = (change: (current: IssueBasket) => IssueBasket) => void;
const detailKey = (scope: string, issue: IssueSummary) => ['archive-issue', scope, issue.id, issue.version];
const statusLabels: Record<string, string> = { pending: '同步中', unavailable: '没有读取权限', stale: '等待更新', 'too-large': '原件超过大小上限' };

export function TapdIssuesPanel({ client, basket, edit, locked, onSettings }: {
  client: TopicsClient; basket: IssueBasket; edit: EditIssues; locked: boolean; onSettings(): void;
}) {
  const c = useColors(), cache = useQueryClient();
  const [query, setQuery] = useState(''), [project, setProject] = useState(''), [picker, setPicker] = useState(false);
  const [expandedId, setExpandedId] = useState(''), [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const trimmed = query.trim(), tooLong = trimmed.length > 256;
  useEffect(() => {
    const timer = setTimeout(() => setSearch(trimmed), 200);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const connected = client.enabled && client.active && Boolean(client.connection?.hasToken);
  const status = useQuery({ queryKey: ['archive-issues-status', client.scopeKey], queryFn: () => client.call<IssueConnection>({ action: 'issues.status' }),
    enabled: connected, retry: false, refetchOnWindowFocus: false, refetchInterval: connected ? 20000 : false });
  const info = status.data, source = info?.state === 'ready' ? info.source : undefined;
  const projects = source?.projects.filter(item => item.authorization === 'authorized') || [];
  const currentProject = projects.find(item => item.id === project);
  const ready = Boolean(source?.authorization === 'authorized' && projects.length && (!project || currentProject));
  const list = useInfiniteQuery({
    queryKey: ['archive-issues', client.scopeKey, source?.account, projects.map(item => item.id), project, search],
    queryFn: ({ pageParam }) => client.call<IssuePage>({ action: 'issues.list', query: search, projectId: project || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined, getNextPageParam: (page, pages) => page.next && !pages.slice(0, -1).some(item => item.next === page.next) ? page.next : undefined,
    enabled: connected && status.isSuccess && ready && !tooLong, retry: false, refetchOnWindowFocus: false,
    refetchInterval: connected && ready && !tooLong ? 20000 : false,
  });
  const items = [...new Map((list.data?.pages.flatMap(page => page.items) || []).map(issue => [issue.id, issue])).values()];
  const manage = () => {
    if (info?.manageUrl) void openExternalUrl(info.manageUrl).catch(() => setError('档案服务暂未打开，请重试'));
  };
  const refresh = () => {
    setError('');
    ignoreFailure(Promise.all([status.refetch(), cache.invalidateQueries({ queryKey: ['archive-issues', client.scopeKey] }),
      cache.invalidateQueries({ queryKey: ['archive-issue', client.scopeKey] })]));
  };
  const lastSync = currentProject?.lastSuccessAt || Math.max(0, ...projects.map(item => item.lastSuccessAt || 0));
  const syncNote = issueSyncLabel(source, currentProject, lastSync);
  const message = !client.connection?.hasToken ? '请先连接档案服务'
    : info?.state === 'missing' ? '此资料库尚未添加 TAPD 来源'
    : info?.state === 'unavailable' ? '档案服务尚未开放 TAPD 读取'
    : source?.plugin === 'unconfigured' ? '档案服务尚未配置 TAPD 应用'
    : source?.authorization !== 'authorized' ? '请在档案服务授权 TAPD'
    : '此 TAPD 项目需要重新授权';
  return <View testID="tapd-issues-panel" style={{ flex: 1, minHeight: 0 }}>
    <View style={{ padding: 10, gap: 6, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border }}>
      <View style={{ flex: 1, minWidth: 112 }}><Search value={query} onChange={setQuery} placeholder="搜索缺陷标题或编号" /></View>
      {projects.length > 1 || project ? <Button label={currentProject?.label || '全部授权项目'} icon="ListFilter" onPress={() => setPicker(true)} /> : null}
      <TopicIcon id="tapd-refresh" icon="RefreshCw" label="刷新缺陷列表" busy={status.isFetching || list.isFetching} onPress={refresh} />
      <TopicIcon id="tapd-settings" icon="Settings" label="TAPD 来源设置" onPress={info ? manage : onSettings} />
    </View>
    {ready ? <View style={{ paddingHorizontal: 12, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
      <View style={{ flex: 1 }}><Label muted lines={1}>{['分配给我', currentProject?.label || source?.account].filter(Boolean).join(' · ')}</Label></View>
      {syncNote ? <Label muted lines={1}>{syncNote}</Label> : null}
    </View> : null}
    <ScrollView testID="tapd-issues-list" style={{ flex: 1, minHeight: 70 }}>
      {status.isLoading || ready && list.isLoading ? <ActivityIndicator style={{ padding: 20 }} color={c.accent} />
        : status.error ? <View style={{ alignItems: 'center', padding: 24, gap: 8 }}><Label warning>{topicError(status.error.message)}</Label><Button onPress={refresh}>重试</Button></View>
        : !ready ? <View style={{ alignItems: 'center', padding: 24, gap: 8 }}><Label muted>{message}</Label>
          <Button icon={info ? 'ArrowUpRight' : 'Link'} onPress={info ? manage : onSettings}>{info ? '打开档案服务' : '连接档案服务'}</Button>
        </View> : tooLong || list.error ? <View style={{ padding: 14 }}><Label warning>{tooLong ? '搜索文字过长' : topicError(list.error!.message)}</Label></View>
        : !items.length ? <View style={{ alignItems: 'center', padding: 26 }}><Label muted>{search ? '没有匹配的缺陷' : '暂无分配给你的缺陷'}</Label></View>
        : items.map(issue => <TapdIssueRow key={issue.id} {...{ client, issue, edit, locked }} selected={basket[issue.id]} projectLabel={projects.find(item => item.id === issue.projectId)?.label || issue.projectId}
          expanded={expandedId === issue.id} onExpand={() => setExpandedId(current => current === issue.id ? '' : issue.id)} onSelect={() => setExpandedId(issue.id)} />)}
      {list.hasNextPage && ready && !list.error && !tooLong ? <View style={{ padding: 10 }}><Button disabled={list.isFetchingNextPage} onPress={() => ignoreFailure(list.fetchNextPage())}>更多缺陷</Button></View> : null}
      {error ? <View style={{ padding: 12 }}><Label warning>{error}</Label></View> : null}
    </ScrollView>
    {picker ? <Dialog title="TAPD 项目" onClose={() => setPicker(false)} width={480} height={430}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <Button active={!project} onPress={() => { setProject(''); setPicker(false); }}>全部授权项目</Button>
        {projects.map(item => <Button key={item.id} active={project === item.id} onPress={() => { setProject(item.id); setPicker(false); }}>{item.label || item.id}</Button>)}
      </ScrollView>
    </Dialog> : null}
  </View>;
}

function issueSyncLabel(source: IssueSource | undefined, project: IssueSource['projects'][number] | undefined, lastSync: number) {
  if (!source?.enabled || source.plugin === 'paused') return '同步已暂停';
  if (source.plugin === 'offline') return '来源暂离线';
  const projects = project ? [project] : source.projects;
  if (projects.some(item => item.authorization !== 'authorized')) return '部分项目需重新授权';
  if (projects.some(item => item.error)) return '最近同步有异常';
  return lastSync ? '同步于 ' + topicTime(lastSync) : '';
}

function TapdIssueRow({ client, issue, selected, projectLabel, locked, edit, expanded, onExpand, onSelect }: {
  client: TopicsClient; issue: IssueSummary; selected?: IssueBasket[string]; projectLabel: string; locked: boolean;
  edit: EditIssues; expanded: boolean; onExpand(): void; onSelect(): void;
}) {
  const c = useColors(), cache = useQueryClient(), [selecting, setSelecting] = useState(false), [error, setError] = useState('');
  const changed = Boolean(selected && selected.issue.version !== issue.version);
  const input = { queryKey: detailKey(client.scopeKey, issue), queryFn: () => client.call<IssueDetail>({ action: 'issues.read', issueId: issue.id, version: issue.version }) };
  const detail = useQuery({ ...input, enabled: expanded && client.active, retry: false, staleTime: 20000, refetchOnWindowFocus: false });
  const toggle = async () => {
    setError('');
    if (selected) { edit(current => removeIssue(current, issue.id)); return; }
    setSelecting(true);
    try {
      const value = await cache.fetchQuery({ ...input, retry: false });
      edit(current => selectIssue(current, value));
      onSelect();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSelecting(false); }
  };
  const value = selected?.issue || detail.data;
  const disabled = locked || selecting || changed;
  return <View testID={'tapd-issue-' + issue.id} style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 8, paddingVertical: 5, backgroundColor: selected ? tint(c.accent, '18') : undefined }}>
      <Check id={'tapd-select-' + issue.id} checked={Boolean(selected)} disabled={locked || selecting} label={'选择缺陷 ' + issue.title} onPress={() => ignoreFailure(toggle())} />
      <Pressable testID={'tapd-expand-' + issue.id} accessibilityRole="button" accessibilityLabel={issue.title} accessibilityState={{ expanded }} onPress={onExpand}
        style={{ flex: 1, minWidth: 0, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Label strong lines={2}>{issue.title}</Label><Label muted lines={1}>{[issue.number, projectLabel, issue.updatedAt ? topicTime(issue.updatedAt) : ''].filter(Boolean).join(' · ')}</Label></View>
        {issue.status ? <Label muted lines={1}>{issue.status}</Label> : null}
        <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14} color={c.foregroundMuted} />
      </Pressable>
    </View>
    {error || changed ? <View style={{ paddingHorizontal: 16, paddingVertical: 5 }}><Label warning>{changed ? '缺陷有更新，请重新选材' : topicError(error)}</Label></View> : null}
    {expanded ? <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>
      {detail.error ? <Label warning>{topicError(detail.error.message)}</Label> : value ? <>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
          <View style={{ flex: 1, minWidth: 110 }}><Label muted>{[value.assignee ? '处理人 ' + value.assignee : '', value.priority].filter(Boolean).join(' · ')}</Label></View>
          {value.sourceUrl ? <Button variant="link" icon="ArrowUpRight" onPress={() => { void openExternalUrl(value.sourceUrl!).catch(() => setError('TAPD 原记录暂未打开')); }}>在 TAPD 查看</Button> : null}
        </View>
        <IssueParts {...{ client, disabled }} issue={value} selection={selected?.selection} onToggle={part => edit(current => changeIssuePart(current, value, part))} />
      </> : <ActivityIndicator color={c.accent} />}
    </View> : null}
  </View>;
}

function IssueParts({ client, issue, selection, disabled, onToggle }: {
  client: TopicsClient; issue: IssueDetail; selection?: IssueBasket[string]['selection']; disabled: boolean; onToggle(part: IssuePart): void;
}) {
  const c = useColors();
  return <>
    {issue.body.trim() ? <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
      <Check checked={Boolean(selection?.body)} disabled={disabled || issue.bodyState !== 'ready'} label="选择缺陷描述" onPress={() => onToggle({ kind: 'body' })} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}><Label strong>缺陷描述</Label><Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 21 }}>{issue.body}</Text></View>
    </View> : issue.bodyState === 'empty' ? <Label muted>暂无缺陷描述</Label> : null}
    {statusLabels[issue.bodyState] ? <Label muted>{'描述 · ' + statusLabels[issue.bodyState]}</Label> : null}
    {issue.comments.map(comment => <View key={comment.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 4 }}>
      <Check checked={Boolean(selection?.comments.some(item => item.id === comment.id))} disabled={disabled || issue.commentsState !== 'ready' || !comment.text.trim()}
        label={'选择评论 ' + (comment.author || '') + ' ' + comment.text.slice(0, 24)} onPress={() => onToggle({ kind: 'comments', id: comment.id, version: comment.version })} />
      <View style={{ flex: 1, minWidth: 0 }}><Label muted>{['评论', comment.author, comment.createdAt ? topicTime(comment.createdAt) : ''].filter(Boolean).join(' · ')}</Label><Label>{comment.text}</Label></View>
    </View>)}
    {statusLabels[issue.commentsState] ? <Label muted>{'评论 · ' + statusLabels[issue.commentsState]}</Label> : null}
    {issue.attachments.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9, paddingLeft: 12 }}>
      {issue.attachments.map(asset => <TopicAsset key={asset.id} {...{ client, issue, asset }} checked={Boolean(selection?.attachments.some(item => item.id === asset.id))}
        disabled={disabled || !issueAttachmentSelectable(issue, asset)} onToggle={() => onToggle({ kind: 'attachments', id: asset.id, version: asset.version })} />)}
    </View> : null}
    {statusLabels[issue.attachmentsState] ? <Label muted>{'附件 · ' + statusLabels[issue.attachmentsState]}</Label> : null}
  </>;
}
