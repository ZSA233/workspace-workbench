import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TopicsClient } from '../../use-topics';
import { uniqueMessages } from '../../topic-selection';
import { topicTime, topicTitle } from '../../../shared/extensions/project-communications/topics';
import type { ArchiveAsset, ArchiveMessage, ArchiveTopic, ArchiveTopicDetail, SelectedTopic } from '../../../shared/extensions/project-communications/topics';
import { Button, Label, ignoreFailure, shortTime, tint, useColors } from './ui';
import { Check, ContextDialog, MediaCount, OriginalMessage, TopicIcon, topicError } from './topic-ui';
import { pendingTopicAssets, topicDisplayMessages, TOPIC_ASSET_REFRESH_MS } from '../../topic-asset-state';

export type TopicRowProps = {
  topic: ArchiveTopic; client: TopicsClient; groupName: string; selected?: SelectedTopic;
  expanded: boolean; busy: boolean; loading: boolean; narrow: boolean;
  onExpand(): void; onSelect(): void; onReload(): void;
  onMessage(detail: ArchiveTopicDetail, message: ArchiveMessage, anchor?: string): void;
  onAsset(detail: ArchiveTopicDetail, message: ArchiveMessage, asset: ArchiveAsset, anchor?: string): void;
  onAnalysis(detail: ArchiveTopicDetail): void;
};
export function TopicRow(p: TopicRowProps) {
  const c = useColors(), cache = useQueryClient();
  const [context, setContext] = useState(''), [analysis, setAnalysis] = useState(false);
  const detailKey = ['archive-topic', p.client.scopeKey, p.topic.id];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => p.client.call<ArchiveTopicDetail>({ action: 'read', topicId: p.topic.id }),
    enabled: p.expanded && p.client.active, retry: false, refetchOnWindowFocus: false,
    staleTime: query => pendingTopicAssets(query.state.data) ? TOPIC_ASSET_REFRESH_MS : Infinity,
    refetchInterval: query => p.expanded && p.client.active && pendingTopicAssets(query.state.data) ? TOPIC_ASSET_REFRESH_MS : false,
    refetchIntervalInBackground: false,
  });
  const data = p.selected?.topic || detail.data;
  const changed = Boolean(data && (data.inputRevision !== p.topic.inputRevision || data.revision !== p.topic.revision));
  const more = async () => {
    const page = await p.client.call<{ items: ArchiveMessage[]; hasMore: boolean }>({
      action: 'messages', topicId: p.topic.id, offset: detail.data?.messages.length || 0,
    });
    cache.setQueryData<ArchiveTopicDetail>(detailKey, current => current ? {
      ...current, messages: uniqueMessages([...current.messages, ...page.items]), hasMoreMessages: page.hasMore,
    } : current);
  };
  const messages = topicDisplayMessages(detail.data?.messages || [], data?.messages);
  return <View testID={'topic-row-' + p.topic.id} style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 5, gap: 5, alignItems: 'center', backgroundColor: p.selected ? tint(c.accent, '18') : undefined }}>
      <Check id={'topic-select-' + p.topic.id} checked={Boolean(p.selected)} disabled={p.busy || p.loading}
        label={'选择话题 ' + topicTitle(p.topic)} onPress={p.onSelect} />
      <View {...(Platform.OS === 'web' ? { title: changed ? '有新材料，已选范围保持原样' : p.topic.status === 'closed' ? '已关闭' : '跟进中' } : {})}
        style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: changed ? c.statusWarning : p.selected ? c.accent : c.foregroundMuted }} />
      <Pressable testID={'topic-expand-' + p.topic.id} accessibilityRole="button" accessibilityLabel={topicTitle(p.topic)}
        accessibilityState={{ expanded: p.expanded }} onPress={p.onExpand}
        style={{ flex: 1, minWidth: 0, paddingHorizontal: 5, paddingVertical: 5, gap: 2 }}>
        <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 13, lineHeight: 20, fontWeight: '600' }}>{topicTitle(p.topic)}</Text>
        <Text numberOfLines={1} style={{ fontSize: 10, color: c.foregroundMuted }}>{p.groupName}</Text>
      </Pressable>
      {!p.narrow ? <>
        <MediaCount icon="MessageSquare" count={data?.messageCount || p.topic.messageCount} label="原文" />
        <MediaCount icon="Image" count={data ? data.messages.reduce((n, m) => n + m.assets.length, 0) : undefined} label="附件" />
      </> : null}
      {changed ? <TopicIcon icon="RefreshCw" label="重新读取并清除此话题选择" disabled={p.busy}
        onPress={() => { p.onReload(); void detail.refetch(); }} />
        : <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{topicTime(p.topic.updatedAt)}</Text>}
      <TopicIcon icon={p.expanded ? 'ChevronUp' : 'ChevronDown'} label={p.expanded ? '收起话题' : '展开话题'}
        onPress={p.onExpand} busy={p.loading} />
    </View>
    {p.expanded ? <View testID={'topic-detail-' + p.topic.id}
      style={{ paddingLeft: p.narrow ? 12 : 43, paddingRight: 12, backgroundColor: tint(c.foregroundMuted, '05') }}>
      {detail.isLoading && !data ? <ActivityIndicator style={{ padding: 15 }} /> : null}
      {detail.error ? <Label warning>{topicError(detail.error.message)}</Label> : null}
      {data ? <>
        {messages.map(message => <OriginalMessage key={message.id} client={p.client} topicId={data.id} message={message} mediaWidth={p.narrow ? 144 : 200}
          disabled={p.busy || changed} selected={p.selected?.messages.some(item => item.id === message.id) || false}
          selectedAssets={p.selected?.assetIds || []}
          onMessage={() => p.onMessage(data, message, p.selected?.contexts[message.id])}
          onAsset={asset => p.onAsset(data, message, asset, p.selected?.contexts[message.id])}
          onContext={() => setContext(p.selected?.contexts[message.id] || message.id)} />)}
        {detail.data?.hasMoreMessages ? <Button variant="link" disabled={changed} onPress={() => ignoreFailure(more())}>更多原文</Button> : null}
        {data.lastAnswer || data.summary ? <View style={{ paddingVertical: 8, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TopicIcon icon={analysis ? 'ChevronDown' : 'ChevronRight'} label="查看已有分析" onPress={() => setAnalysis(value => !value)} />
            <Label muted>分析</Label>
          </View>
          {analysis ? <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Check checked={p.selected?.includeAnalysis || false} disabled={p.busy || changed}
                label="选择已有分析" onPress={() => p.onAnalysis(data)} /><Label muted>带入分析</Label>
            </View>
            <Label>{data.lastAnswer || data.summary}</Label>
          </View> : null}
        </View> : null}
      </> : null}
      {context && data ? <ContextDialog client={p.client} topicId={data.id} anchor={context} disabled={p.busy || changed}
        selected={p.selected?.messages.map(message => message.id) || []} selectedAssets={p.selected?.assetIds || []}
        onClose={() => setContext('')} onMessage={message => p.onMessage(data, message, context)}
        onAsset={(message, asset) => p.onAsset(data, message, asset, context)} /> : null}
    </View> : null}
  </View>;
}
