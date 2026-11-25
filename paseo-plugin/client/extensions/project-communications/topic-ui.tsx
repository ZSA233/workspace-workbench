import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, ScrollView, useToast } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import type { ArchiveAsset, ArchiveMessage } from '../../../shared/extensions/project-communications/topics';
import type { IssueSummary } from '../../../shared/extensions/project-communications/issues';
import { assetIsImage, assetIsVideo, messageText, senderName, topicTime, recordAttention, type RecordAttention } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Label, tint, useColors, useTouch } from './ui';
import { MAX_VIDEO_BYTES, supportedArtifact } from '../../../shared/artifact-limits.ts';
import {TopicVideoPlayer,TopicVideoFrames,TopicVideoFile} from '../../topic-video';
import {videoTime,inlineVideo,videoFileSize,type TopicVideoPreview} from '../../../shared/topic-video';
import { pendingTopicAssets, TOPIC_ASSET_REFRESH_MS } from '../../topic-asset-state';

export const topicTypography = StyleSheet.create({
  title: { fontSize: 12, lineHeight: 18, fontWeight: '600' },
  metadata: { fontSize: 10, lineHeight: 15 },
  detailLabel: { fontSize: 10, lineHeight: 15, fontWeight: '500' },
  body: { fontSize: 11.5, lineHeight: 18 },
});

export function TopicRowStatus({ label, attention }: { label: string; attention: RecordAttention }) {
  const c = useColors(), color = attention === 'active' ? c.accent : c.foregroundMuted;
  return <Text numberOfLines={1} {...(Platform.OS === 'web' ? { title: label } : {})} style={[topicTypography.metadata, {
    color, backgroundColor: tint(color, '14'), borderRadius: 4, maxWidth: 86, paddingHorizontal: 5, paddingVertical: 1,
  }]}>{label}</Text>;
}

export function TopicIcon({ icon, label, onPress, disabled = false, active = false, busy = false, id, compact = false }: {
  icon: string; label: string; onPress: () => void; disabled?: boolean; active?: boolean; busy?: boolean; id?: string; compact?: boolean;
}) {
  const c = useColors(), touch = useTouch(), toast = useToast();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active, busy }}
    {...(Platform.OS === 'web' ? { title: label } : {})} disabled={disabled} onPress={onPress} onLongPress={() => toast.show(label)}
    style={({ hovered }: any) => ({ width: touch ? 44 : compact ? 22 : 32, height: touch ? 44 : compact ? 22 : 32, alignItems: 'center', justifyContent: 'center', borderRadius: 5, opacity: disabled ? 0.4 : 1, backgroundColor: active ? tint(c.accent) : hovered ? c.surface2 : undefined })}>
    {busy ? <ActivityIndicator size="small" color={c.accent} /> : <Icon name={icon} size={compact ? 13 : 17} color={active ? c.accent : c.foregroundMuted} />}
  </Pressable>;
}
export function Check({ checked, onPress, label, disabled = false, id }: { checked: boolean; onPress: () => void; label: string; disabled?: boolean; id?: string }) {
  const c = useColors(), touch = useTouch();
  return <Pressable testID={id} accessibilityRole="checkbox" accessibilityLabel={label} aria-checked={checked} accessibilityState={{ checked, disabled }}
    disabled={disabled} onPress={onPress} style={{ minWidth: touch ? 44 : 32, minHeight: touch ? 44 : 32, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.45 : 1 }}>
    <View style={{ width: 17, height: 17, borderRadius: 4, borderWidth: 1, borderColor: checked ? c.accent : c.foregroundMuted, alignItems: 'center', justifyContent: 'center', backgroundColor: checked ? c.accent : undefined }}>
      {checked ? <Icon name="Check" size={14} color={c.accentForeground} /> : null}
    </View>
  </Pressable>;
}

export function TopicRecord({ id, selectId, expandId, detailId, title, metadata, updatedAt, status, selected, expanded,
  disabled, loading, onSelect, onExpand, onReload, extra, warning, recordLabel, children }: {
  id: string; selectId: string; expandId: string; detailId: string; title: string; metadata: string; updatedAt: number;
  status: string; selected: boolean; expanded: boolean;
  disabled: boolean; loading?: boolean; onSelect(): void; onExpand(): void; onReload?(): void;
  extra?: ReactNode; warning?: string; recordLabel: string; children: ReactNode;
}) {
  const c = useColors(), changed = Boolean(onReload), updated = topicTime(updatedAt);
  const attention = recordAttention(status), settled = attention === 'settled';
  return <View testID={id} style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 4, gap: 5, alignItems: 'center', backgroundColor: selected ? tint(c.accent, '18') : undefined }}>
      <Check id={selectId} checked={selected} disabled={disabled || loading} label={'选择' + recordLabel + ' ' + title} onPress={onSelect} />
      <Pressable testID={expandId} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} onPress={onExpand}
        style={{ flex: 1, minWidth: 0, paddingVertical: 4, gap: 2 }}>
        <Text numberOfLines={2} style={[topicTypography.title, { color: settled ? c.foregroundMuted : c.foreground, fontWeight: settled ? '400' : '600' }]}>{title}</Text>
        <Text numberOfLines={1} style={[topicTypography.metadata, { color: c.foregroundMuted }]}>{metadata}</Text>
      </Pressable>
      {extra}
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        {status ? <TopicRowStatus label={status} attention={attention} /> : null}
        {changed || updated ? <Text style={[topicTypography.metadata, { color: changed && !settled ? c.statusWarning : c.foregroundMuted }]}>
          {changed ? '有更新' : '更新于 ' + updated}
        </Text> : null}
      </View>
      {onReload ? <TopicIcon icon="RefreshCw" label={'重新读取并清除此' + recordLabel + '选择'} disabled={disabled} onPress={onReload} /> : null}
      <TopicIcon icon={expanded ? 'ChevronUp' : 'ChevronDown'} label={(expanded ? '收起' : '展开') + recordLabel} onPress={onExpand} busy={loading} />
    </View>
    {warning ? <View style={{ paddingLeft: 37, paddingRight: 12, paddingVertical: 4 }}><Label warning>{warning}</Label></View> : null}
    {expanded ? <View testID={detailId} style={{ paddingLeft: 24, paddingRight: 12, paddingVertical: 7, backgroundColor: tint(c.foregroundMuted, '05') }}>
      <View testID="topic-detail-content" style={{ borderLeftWidth: 1, borderColor: c.border, paddingLeft: 10, gap: 5 }}>{children}</View>
    </View> : null}
  </View>;
}

export function TopicAssetGrid({ children, inset = true }: { children: ReactNode; inset?: boolean }) {
  return <View style={{ paddingLeft: inset ? 37 : 0, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{children}</View>;
}

export function TopicMaterial({ id, selectId, label, selected, disabled, onSelect, header, actions, assets, children }: {
  id?: string; selectId?: string; label: string; selected: boolean; disabled?: boolean; onSelect(): void;
  header: ReactNode; actions?: ReactNode; assets?: ReactNode; children?: ReactNode;
}) {
  const c = useColors();
  return <View testID={id} style={{ paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
      <Check id={selectId} checked={selected} disabled={disabled} label={label} onPress={onSelect} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>{header}{children}</View>
      {actions}
    </View>
    {assets ? <TopicAssetGrid>{assets}</TopicAssetGrid> : null}
  </View>;
}
export function MediaCount({ icon, count, label }: { icon: string; count?: number; label: string }) {
  const c = useColors();
  return <View accessibilityLabel={label + (count === undefined ? '' : ' ' + count)} {...(Platform.OS === 'web' ? { title: label } : {})}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><Icon name={icon} size={14} color={c.foregroundMuted} />
    {count === undefined ? null : <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{count}</Text>}
  </View>;
}
export function topicError(error: string) {
  const messages: Record<string, string> = {
    topic_material_version_changed: '话题有更新，请重新选材', topic_message_version_changed: '原文有更新，请重新选材',
    topic_asset_version_changed: '原件有更新，请重新选材', topic_asset_not_ready: '附件尚未就绪',
    topic_target_unavailable: '请选择目标会话', topic_target_changed: '目标会话已变化', topic_targets_incomplete: '会话列表未完整加载，请重试',
    topic_models_unavailable: '模型列表暂不可用', topic_model_unavailable: '所选模型暂不可用，请重新选择', topic_session_ambiguous: '新会话状态待核对，请勿重复发送',
    topic_material_scope_changed: '连接已变化，请重新预览', project_connection_changed: '连接已变化',
    issue_selection_changed: '缺陷有更新，请重新选材', issue_outside_todo: '缺陷已移出我的待办，请重新选材',
    issue_material_unavailable: '该缺陷材料暂不可用', issue_login_required: '请在档案服务重新授权 TAPD',
    issue_project_not_authorized: 'TAPD 项目授权已变化，请重新选材', issue_record_missing: '缺陷已不可读取，请重新选材',
    issue_query_too_long: '搜索文字过长',
    agent_revision_conflict: '配置有更新，请刷新', settings_revision_conflict: '配置有更新，请刷新',
    topic_material_limit: '材料数量超限', topic_material_bytes_limit: '附件合计超过 24 MB',
    service_response_too_large: '附件超过当前读取上限', topic_material_text_limit: '原文过长，请分次带入',
    artifact_size_exceeded: '附件超过大小上限', artifact_type_not_allowed: '附件格式暂不支持交接',
    topic_video_inline_unavailable: '可查看视频画面，原视频按文件交接',
    topic_material_empty: '请选择原文或附件', topic_outside_project_scope: '话题不在关注范围',
    topic_message_outside_scope: '原文来源不符', topic_context_outside_scope: '上下文不在本话题范围',
    topic_message_not_associated: '原文已移出话题', extension_disabled: '话题未启用',
    service_unavailable: 'AI 助手暂不可用', unauthorized: '服务授权已失效',
    workspace_session_missing: '目标会话暂不可用',
    topic_effort_unavailable:'此模型的推理强度已变化，请重新选择',topic_permission_unavailable:'此权限预设已变化，请重新选择',
    topic_video_tools_unavailable:'此主机缺少 FFmpeg，暂时无法提取视频画面',topic_video_decode_failed:'视频画面暂时无法读取，可重试或更换视频',
    topic_video_decode_timeout:'视频处理超时，请重试',topic_video_frame_too_large:'视频画面过大，暂时无法处理',
    topic_video_frame_limit:'视频画面较多，请分次发送',topic_video_busy:'正在处理其他视频，请稍后重试',
  };
  const known = Object.entries(messages).find(([key]) => error.includes(key));
  return known?.[1] || (error.includes('API Token') ? '请配置服务连接' : error.includes('不可达') ? 'AI 助手暂不可达' : error);
}
export function TopicStatus({ error, state, onDetails, id = 'topics-status' }: { error?: string; state?: string; onDetails: () => void; id?: string }) {
  const c = useColors();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={error ? topicError(error) : state || '已连接'} onPress={onDetails}
    {...(Platform.OS === 'web' ? { title: error || state || '已连接' } : {})}
    style={{ height: 27, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6, borderTopWidth: 1, borderTopColor: c.border }}>
    <Icon name={error ? 'CircleAlert' : state === '已交接' ? 'CircleCheck' : 'Circle'} size={12} color={error ? c.statusWarning : c.foregroundMuted} />
    <Text numberOfLines={1} style={{ flex: 1, color: error ? c.statusWarning : c.foregroundMuted, fontSize: 10 }}>{error ? topicError(error) : state || ''}</Text>
  </Pressable>;
}
type TopicAssetSource = { topicId: string; message: ArchiveMessage; contextOf?: string; issue?: undefined }
  | { issue: Pick<IssueSummary, 'id' | 'version'>; topicId?: undefined; message?: undefined; contextOf?: undefined };
export function TopicAsset({ client, topicId, message, issue, asset, contextOf, checked, onToggle, disabled, small = false, removable = false, tileWidth = 132 }: TopicAssetSource & {
  client: TopicsClient; asset: ArchiveAsset; checked: boolean; onToggle: () => void; disabled?: boolean; small?: boolean; removable?: boolean; tileWidth?: number;
}) {
  const c = useColors(), [open, setOpen] = useState(false), image = assetIsImage(asset), video = assetIsVideo(asset);
  // Inline archive images declare their kind; the versioned preview validates the returned raster type.
  const canSelect = supportedArtifact(asset.mimeType || '', asset.size) || image && !asset.mimeType;
  const ready = client.active && asset.state === 'ready' && canSelect;
  const source = issue ? [issue.id, issue.version] : [topicId, message.id, message.version];
  const read = <T,>(part: 'original' | 'video-preview') => issue
    ? client.call<T>({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: asset.id, part })
    : client.call<T>({ action: 'asset', topicId, messageId: message.id, assetId: asset.id, contextOf, part });
  const frames = useQuery({
    queryKey: [issue ? 'archive-issue-video' : 'archive-video', client.scopeKey, ...source, asset.id],
    queryFn: () => read<TopicVideoPreview>('video-preview'), enabled: ready && video,
    retry: false, staleTime: Infinity, gcTime: 60000, refetchOnWindowFocus: false,
  });
  const playable = inlineVideo(asset.size ?? frames.data?.size);
  const data = useQuery({
    queryKey: [issue ? 'archive-issue-image' : 'archive-image', client.scopeKey, ...source, asset.id],
    queryFn: () => read<{ mimeType: string; base64: string }>('original'),
    enabled: ready && (image || video && open && playable), retry: false, staleTime: Infinity, gcTime: 60000, refetchOnWindowFocus: false,
  });
  const uri = data.data ? 'data:' + data.data.mimeType + ';base64,' + data.data.base64 : undefined;
  const poster = frames.data?.frames[0], thumbnail = image ? uri : poster ? 'data:' + poster.mimeType + ';base64,' + poster.base64 : undefined;
  const width = small ? 54 : tileWidth, height = small ? 42 : Math.round(tileWidth * 0.64);
  const error = data.error || frames.error;
  const state = asset.state !== 'ready' ? asset.state === 'pending' ? '等待原件' : '原件不可用'
    : !canSelect ? video && asset.size !== undefined && asset.size > MAX_VIDEO_BYTES ? '视频超过 24 MiB' : '原件格式或大小暂不支持交接'
      : video ? '可选择并发送原视频' : error ? topicError(error.message) : asset.name;
  const videoInfo = [asset.name, videoFileSize(asset.size ?? frames.data?.size)].filter(Boolean).join(' · ');
  return <View style={{ position: 'relative', width, gap: 3 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={'查看 ' + asset.name} {...(Platform.OS === 'web' ? { title: video ? videoInfo + ' · ' + state : state } : {})}
      onPress={() => setOpen(true)}
      style={{ width, height, alignItems: 'center', justifyContent: 'center', gap: 3, borderWidth: 1, borderColor: checked ? c.accent : c.border, borderRadius: 5, overflow: 'hidden', backgroundColor: c.surface2 }}>
      {thumbnail ? <Image source={{ uri: thumbnail }} accessibilityLabel={asset.name} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        : data.isFetching || frames.isFetching ? <ActivityIndicator size="small" color={c.foregroundMuted} />
          : <Icon name={asset.state === 'pending' ? 'Clock' : video ? 'Video' : image ? 'Image' : 'FileText'} size={small ? 17 : 24} color={asset.state === 'ready' ? c.foregroundMuted : c.statusWarning} />}
      {video && thumbnail ? <View style={{ position: 'absolute', padding: 5, borderRadius: 20, backgroundColor: '#0009' }}><Icon name="Play" size={small ? 16 : 24} color="#fff" /></View> : null}
      {video && frames.data?.duration && !small ? <Text style={{ position: 'absolute', right: 4, bottom: 3, color: '#fff', backgroundColor: '#0009', fontSize: 10, borderRadius: 3, paddingHorizontal: 3 }}>{videoTime(frames.data.duration)}</Text> : null}
      {!small && !thumbnail && !video ? <Text numberOfLines={1} style={[topicTypography.metadata, { color: c.foregroundMuted, paddingHorizontal: 4 }]}>{state}</Text> : null}
      {!small && video && !thumbnail && !frames.isFetching ? <View style={{ alignItems: 'center', gap: 2, paddingHorizontal: 6 }}>
        <Text numberOfLines={1} style={[topicTypography.metadata, { color: c.foreground }]}>{asset.name}</Text>
        <Text numberOfLines={1} style={[topicTypography.metadata, { color: c.foregroundMuted }]}>{state}</Text>
      </View> : null}
    </Pressable>
    {video && !small ? <Text numberOfLines={2} style={[topicTypography.metadata, { color: c.foregroundMuted }]}>{videoInfo}</Text> : null}
    <View style={{ position: 'absolute', top: small ? -8 : 0, right: small ? -8 : undefined, left: small ? undefined : 0, backgroundColor: tint(c.surface1, 'cc'), borderRadius: 4 }}>
      {removable ? <TopicIcon compact icon="X" label={'移除 ' + asset.name} onPress={onToggle} disabled={disabled} />
        : <Check checked={checked} label={'选择 ' + asset.name} onPress={onToggle} disabled={disabled || asset.state !== 'ready' || !canSelect} />}
    </View>
    <Dialog open={open} id="topics-asset-preview" title={asset.name || '附件'} onClose={() => setOpen(false)} width={800} height={700}
      footer={!disabled ? <Button variant="primary" disabled={asset.state !== 'ready' || !canSelect} onPress={() => { onToggle(); setOpen(false); }}>
        {checked ? '取消选择' : video ? '选择原视频' : '选择附件'}
      </Button> : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 16, gap: 12 }}>
        {video ? uri ? <TopicVideoPlayer uri={uri} poster={thumbnail} />
          : data.isFetching ? <ActivityIndicator /> : <TopicVideoFile name={asset.name} size={asset.size ?? frames.data?.size} message={state} />
          : image && uri ? <Image source={{ uri }} accessibilityLabel={asset.name} style={{ minHeight: 320, flex: 1, width: '100%' }} resizeMode="contain" />
            : data.isFetching ? <ActivityIndicator /> : <Label>{state}</Label>}
        {video && frames.data ? <TopicVideoFrames video={frames.data} /> : null}
        {error ? <><Label warning>{topicError(error.message)}</Label><Button onPress={() => { if (data.error) void data.refetch(); if (frames.error) void frames.refetch(); }}>重试预览</Button></> : null}
      </ScrollView>
    </Dialog>
  </View>;
}

export function OriginalMessage({ client, topicId, message, contextOf, selected, selectedAssets, onMessage, onAsset, onContext, disabled, mediaWidth = 132 }: {
  client: TopicsClient; topicId: string; message: ArchiveMessage; contextOf?: string; selected: boolean; selectedAssets: string[]; onMessage: () => void; onAsset: (asset: ArchiveAsset) => void; onContext?: () => void; disabled?: boolean; mediaWidth?: number;
}) {
  const c = useColors(), text = messageText(message);
  return <TopicMaterial id={'topic-original-message-' + message.id} selectId={'topic-message-' + message.id}
    label={'选择消息：' + (text.slice(0,24) || '附件消息')} {...{ selected, disabled }} onSelect={onMessage}
    header={<View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Text style={[topicTypography.detailLabel, { color: c.foregroundMuted }]}>{senderName(message)}</Text>
      <Text style={[topicTypography.metadata, { color: c.foregroundMuted }]}>{topicTime(message.createdAt)}</Text>
    </View>}
    actions={onContext ? <TopicIcon icon="MessagesSquare" label="查看上下文" onPress={onContext} /> : null}
    assets={message.assets.length ? message.assets.map(asset => <TopicAsset key={asset.id} {...{ client, topicId, message, asset, contextOf }}
      tileWidth={mediaWidth} checked={selectedAssets.includes(asset.id)} disabled={disabled} onToggle={() => onAsset(asset)} />) : undefined}>
    {text ? <Text selectable style={[topicTypography.body, { color: c.foreground }]}>{text}</Text> : null}
  </TopicMaterial>;
}
export function ContextDialog({ client, topicId, anchor, selected, selectedAssets, onMessage, onAsset, onClose, disabled }: {
  client: TopicsClient; topicId: string; anchor: string; selected: string[]; selectedAssets: string[]; onMessage: (message: ArchiveMessage) => void; onAsset: (message: ArchiveMessage, asset: ArchiveAsset) => void; onClose: () => void; disabled?: boolean;
}) {
  const query = useQuery({ queryKey: ['archive-context', client.scopeKey, topicId, anchor], queryFn: () => client.call<{ items: ArchiveMessage[] }>({ action: 'context', topicId, messageId: anchor }),
    enabled: client.active, retry: false, refetchOnWindowFocus: false,
    staleTime: query => pendingTopicAssets(query.state.data) ? TOPIC_ASSET_REFRESH_MS : 0,
    refetchInterval: query => client.active && pendingTopicAssets(query.state.data) ? TOPIC_ASSET_REFRESH_MS : false,
    refetchIntervalInBackground: false });
  return <Dialog title="上下文" onClose={onClose} width={780} height={700} footer={<Button onPress={onClose}>完成</Button>}>
    <ScrollView contentContainerStyle={{ padding: 14 }}>
      {query.isLoading ? <ActivityIndicator /> : null}{query.error ? <Label warning>{topicError(query.error.message)}</Label> : null}
      {query.data?.items.map(message => <OriginalMessage key={message.id} {...{ client, topicId, message, disabled }} contextOf={anchor} selected={selected.includes(message.id)} selectedAssets={selectedAssets}
        onMessage={() => onMessage(message)} onAsset={asset => onAsset(message, asset)} />)}
    </ScrollView>
  </Dialog>;
}
