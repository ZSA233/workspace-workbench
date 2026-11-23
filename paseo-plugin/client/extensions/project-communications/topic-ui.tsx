import { useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, ScrollView, useToast } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import type { ArchiveAsset, ArchiveMessage } from '../../../shared/extensions/project-communications/topics';
import { assetIsImage, assetIsVideo, messageText, senderName, topicTime } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Label, tint, useColors, useTouch } from './ui';
import { supportedArtifact } from '../../../shared/artifact-limits.ts';
import {TopicVideoPlayer,TopicVideoFrames} from '../../topic-video';
import {videoTime,type TopicVideoPreview} from '../../../shared/topic-video';
import { pendingTopicAssets, TOPIC_ASSET_REFRESH_MS } from '../../topic-asset-state';

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
    agent_revision_conflict: '配置有更新，请刷新', settings_revision_conflict: '配置有更新，请刷新',
    topic_material_limit: '材料数量超限', topic_material_bytes_limit: '附件合计超过 24 MB',
    service_response_too_large: '单个附件超过 8 MB', topic_material_text_limit: '原文过长，请分次带入',
    artifact_size_exceeded: '单个附件超过 8 MB', artifact_type_not_allowed: '附件格式暂不支持交接',
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
export function TopicAsset({ client, topicId, message, asset, contextOf, checked, onToggle, disabled, small = false, removable = false, tileWidth = 132 }: {
  client: TopicsClient; topicId: string; message: ArchiveMessage; asset: ArchiveAsset; contextOf?: string; checked: boolean; onToggle: () => void; disabled?: boolean; small?: boolean; removable?: boolean; tileWidth?: number;
}) {
  const c = useColors(), [open, setOpen] = useState(false), image = assetIsImage(asset), video = assetIsVideo(asset);
  const canSelect = supportedArtifact(asset.mimeType || '', asset.size), ready = client.active && asset.state === 'ready' && canSelect;
  const data = useQuery({ queryKey: ['archive-image', client.scopeKey, topicId, message.id, message.version, asset.id],
    queryFn: () => client.call<{ mimeType: string; base64: string }>({ action: 'asset', topicId, messageId: message.id, assetId: asset.id, contextOf }),
    enabled: ready && (image || video && open), retry: false, staleTime: Infinity, gcTime: 60000, refetchOnWindowFocus: false });
  const frames = useQuery({queryKey:['archive-video',client.scopeKey,topicId,message.id,message.version,asset.id],
    queryFn:()=>client.call<TopicVideoPreview>({action:'asset',part:'video-preview',topicId,messageId:message.id,assetId:asset.id,contextOf}),
    enabled:ready && video,retry:false,staleTime:Infinity,gcTime:60000,refetchOnWindowFocus:false});
  const uri = data.data ? 'data:' + data.data.mimeType + ';base64,' + data.data.base64 : undefined;
  const poster = frames.data?.frames[0], thumbnail = image ? uri : poster ? 'data:'+poster.mimeType+';base64,'+poster.base64 : undefined;
  const width = small ? 54 : tileWidth, height = small ? 42 : Math.round(tileWidth * 0.64);
  const error = data.error || frames.error;
  const state = asset.state !== 'ready' ? asset.state === 'pending' ? '等待原件' : '原件不可用' : !canSelect ? '原件已保存，暂不支持交接此格式或大小' : error ? topicError(error.message) : asset.name;
  return <View style={{ position: 'relative', width, height }}>
    <Pressable accessibilityRole="button" accessibilityLabel={'查看 ' + asset.name} {...(Platform.OS === 'web' ? { title: state } : {})} onPress={() => setOpen(true)}
      style={{ width, height, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: checked ? c.accent : c.border, borderRadius: 5, overflow: 'hidden', backgroundColor: c.surface2 }}>
      {thumbnail ? <Image source={{ uri:thumbnail }} accessibilityLabel={asset.name} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        : data.isFetching || frames.isFetching ? <ActivityIndicator size="small" color={c.foregroundMuted} /> : <Icon name={error ? 'CircleAlert' : asset.state === 'pending' ? 'Clock' : image ? 'Image' : video ? 'Video' : 'FileText'} size={small ? 17 : 24} color={asset.state === 'ready' && !error ? c.foregroundMuted : c.statusWarning} />}
      {video && thumbnail ? <View style={{position:'absolute',padding:5,borderRadius:20,backgroundColor:'#0009'}}><Icon name="Play" size={small?16:24} color="#fff"/></View> : null}
      {video && frames.data && !small ? <Text style={{position:'absolute',right:4,bottom:3,color:'#fff',backgroundColor:'#0009',fontSize:10,borderRadius:3,paddingHorizontal:3}}>{videoTime(frames.data.duration)}</Text>:null}
      {!small && !thumbnail && (!image || asset.state !== 'ready') ? <Text numberOfLines={1} style={{ fontSize: 10, color: c.foregroundMuted, paddingHorizontal: 4 }}>{asset.state === 'ready' ? video?'视频':asset.name : state}</Text> : null}
    </Pressable>
    <View style={{ position: 'absolute', top: small ? -8 : 0, right: small ? -8 : undefined, left: small ? undefined : 0, backgroundColor: tint(c.surface1, 'cc'), borderRadius: 4 }}>
      {removable ? <TopicIcon compact icon="X" label={'移除 ' + asset.name} onPress={onToggle} disabled={disabled} /> : <Check checked={checked} label={'选择 ' + asset.name} onPress={onToggle} disabled={disabled || asset.state !== 'ready' || !canSelect} />}
    </View>
    <Dialog open={open} id="topics-asset-preview" title={asset.name || '附件'} onClose={() => setOpen(false)} width={800} height={700}>
      <ScrollView contentContainerStyle={{ flexGrow:1, padding:16, gap:12 }}>
        {video && uri ? <TopicVideoPlayer uri={uri} poster={thumbnail}/> : image && uri ? <Image source={{ uri }} accessibilityLabel={asset.name} style={{ minHeight:320,flex:1,width:'100%' }} resizeMode="contain" />
          : data.isFetching || frames.isFetching ? <ActivityIndicator/> : <><Icon name={video?'Video':image?'Image':'FileText'} size={36} color={c.foregroundMuted}/><Label>{state}</Label></>}
        {video && frames.data ? <TopicVideoFrames video={frames.data}/> : null}
        {error ? <><Label warning>{topicError(error.message)}</Label><Button onPress={() => { if(data.error)void data.refetch();if(frames.error)void frames.refetch(); }}>重试</Button></> : null}
      </ScrollView>
    </Dialog>
  </View>;
}

export function OriginalMessage({ client, topicId, message, contextOf, selected, selectedAssets, onMessage, onAsset, onContext, disabled, mediaWidth = 132 }: {
  client: TopicsClient; topicId: string; message: ArchiveMessage; contextOf?: string; selected: boolean; selectedAssets: string[]; onMessage: () => void; onAsset: (asset: ArchiveAsset) => void; onContext?: () => void; disabled?: boolean; mediaWidth?: number;
}) {
  const c = useColors(), text = messageText(message);
  return <View testID={'topic-original-message-' + message.id} style={{ paddingVertical: 9, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
    <View style={{ flexDirection: 'row', gap: 5, alignItems: 'flex-start' }}>
      <Check checked={selected} label={'选择消息：' + (text.slice(0,24) || '附件消息')} id={'topic-message-' + message.id} onPress={onMessage} disabled={disabled} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', gap: 9, alignItems: 'center' }}><Text style={{ color: c.foreground, fontSize: 12, fontWeight: '600' }}>{senderName(message)}</Text><Text style={{ fontSize: 10, color: c.foregroundMuted }}>{topicTime(message.createdAt)}</Text></View>
        {text ? <Text selectable style={{ color: c.foreground, fontSize: 13, lineHeight: 21 }}>{text}</Text> : null}
      </View>
      {onContext ? <TopicIcon icon="MessagesSquare" label="查看上下文" onPress={onContext} /> : null}
    </View>
    {message.assets.length ? <View style={{ paddingLeft: 37, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {message.assets.map(asset => <TopicAsset key={asset.id} {...{ client, topicId, message, asset, contextOf }} tileWidth={mediaWidth} checked={selectedAssets.includes(asset.id)} disabled={disabled} onToggle={() => onAsset(asset)} />)}
    </View> : null}
  </View>;
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
