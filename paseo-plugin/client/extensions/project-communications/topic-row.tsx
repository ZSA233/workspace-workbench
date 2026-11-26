import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TopicsClient } from '../../use-topics';
import { uniqueMessages } from '../../topic-selection';
import { assetIsMessageAttachment, topicTitle } from '../../../shared/extensions/project-communications/topics';
import type { ArchiveAsset, ArchiveMessage, ArchiveTopic, ArchiveTopicDetail, SelectedTopic } from '../../../shared/extensions/project-communications/topics';
import { Button, Label, ignoreFailure, useColors } from './ui';
import { Check, ContextDialog, MediaCount, OriginalMessage, TopicIcon, TopicRecord, topicError, topicTypography } from './topic-ui';
import { pendingTopicAssets, topicDisplayMessages, TOPIC_ASSET_REFRESH_MS } from '../../topic-asset-state';

const topicStates = new Map([['open', '跟进中'], ['closed', '已关闭'], ['paused', '已暂停'], ['resolved', '已解决'], ['completed', '已完成'], ['done', '已完成']]);

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
  const status = topicStates.get(p.topic.status) || p.topic.status;
  const more = async () => {
    const page = await p.client.call<{ items: ArchiveMessage[]; hasMore: boolean }>({
      action: 'messages', topicId: p.topic.id, offset: detail.data?.messages.length || 0,
    });
    cache.setQueryData<ArchiveTopicDetail>(detailKey, current => current ? {
      ...current, messages: uniqueMessages([...current.messages, ...page.items]), hasMoreMessages: page.hasMore,
    } : current);
  };
  const messages = topicDisplayMessages(detail.data?.messages || [], data?.messages);
  return <TopicRecord id={'topic-row-' + p.topic.id} selectId={'topic-select-' + p.topic.id}
    expandId={'topic-expand-' + p.topic.id} detailId={'topic-detail-' + p.topic.id}
    title={topicTitle(p.topic)} metadata={p.groupName} updatedAt={p.topic.updatedAt} recordLabel="话题"
    status={status}
    selected={Boolean(p.selected)} expanded={p.expanded} disabled={p.busy} loading={p.loading}
    onSelect={p.onSelect} onExpand={p.onExpand}
    onReload={changed ? () => { p.onReload(); void detail.refetch(); } : undefined}
    extra={!p.narrow ? <>
      <MediaCount icon="MessageSquare" count={data?.messageCount || p.topic.messageCount} label="原文" />
      <MediaCount icon="Image" count={data ? messages.reduce((n, m) => n + m.assets.filter(assetIsMessageAttachment).length, 0) : undefined} label="附件" />
    </> : undefined}>
      {detail.isLoading && !data ? <ActivityIndicator style={{ padding: 15 }} /> : null}
      {detail.error ? <Label warning>{topicError(detail.error.message)}</Label> : null}
      {data ? <>
        {messages.map(message => <OriginalMessage key={message.id} client={p.client} topicId={data.id} message={message}
          disabled={p.busy || changed} selected={p.selected?.messages.some(item => item.id === message.id) || false}
          selectedAssets={p.selected?.assetIds || []}
          onMessage={() => p.onMessage(data, message, p.selected?.contexts[message.id])}
          onAsset={asset => p.onAsset(data, message, asset, p.selected?.contexts[message.id])}
          onContext={() => setContext(p.selected?.contexts[message.id] || message.id)} />)}
        {detail.data?.hasMoreMessages ? <Button variant="link" disabled={changed} onPress={() => ignoreFailure(more())}>更多原文</Button> : null}
        {data.lastAnswer || data.summary ? <View style={{ paddingVertical: 8, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TopicIcon icon={analysis ? 'ChevronDown' : 'ChevronRight'} label="查看已有分析" onPress={() => setAnalysis(value => !value)} />
            <Text style={[topicTypography.detailLabel, { color: c.foregroundMuted }]}>分析</Text>
          </View>
          {analysis ? <View style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Check checked={p.selected?.includeAnalysis || false} disabled={p.busy || changed}
                label="选择已有分析" onPress={() => p.onAnalysis(data)} /><Label muted>带入分析</Label>
            </View>
            <Text selectable style={[topicTypography.body, { color: c.foreground }]}>{data.lastAnswer || data.summary}</Text>
          </View> : null}
        </View> : null}
      </> : null}
      {context && data ? <ContextDialog client={p.client} topicId={data.id} anchor={context} disabled={p.busy || changed}
        selected={p.selected?.messages.map(message => message.id) || []} selectedAssets={p.selected?.assetIds || []}
        onClose={() => setContext('')} onMessage={message => p.onMessage(data, message, context)}
        onAsset={(message, asset) => p.onAsset(data, message, asset, context)} /> : null}
  </TopicRecord>;
}
