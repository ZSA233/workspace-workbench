import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, ScrollView, TextInput } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import { basketCounts, selectedAssets, type TopicBasket } from '../../topic-selection';
import { messageText, senderName, topicTime, topicTitle, TOPIC_NOTE_LIMIT,
  type TopicMaterialPreview, type TopicModel, type TopicNewSession, type TopicTarget, type WatchedGroup } from '../../../shared/extensions/project-communications/topics';
import { Button, Dialog, Label, Search, useColors, useTouch } from './ui';
import { MediaCount, TopicAsset, TopicIcon, TopicStatus, topicError } from './topic-ui';

type TargetDirectory = { data?: TopicTarget[]; isLoading: boolean; isFetching: boolean; error: Error | null; refetch(): Promise<unknown> };
const targetKey = (target: TopicTarget) => target.id || 'workspace:' + target.workspaceId;
const modelKey = (model: TopicNewSession) => JSON.stringify([model.provider, model.model]);
const modelName = (target?: TopicTarget) => target?.provider ? [target.provider, target.model || '当前模型'].join(' · ') : '沿用会话模型';

function Choice({id,icon,label,disabled,onPress}:{id:string;icon:string;label:string;disabled:boolean;onPress():void}) {
  const c = useColors(), touch = useTouch();
  return <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={{minHeight:touch?44:36,flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:10,paddingVertical:6,
      borderWidth:1,borderColor:c.border,borderRadius:5,backgroundColor:c.surface1,opacity:disabled?0.45:1}}>
    <Icon name={icon} size={15} color={c.foregroundMuted}/><Text numberOfLines={1} style={{flex:1,minWidth:0,color:c.foreground,fontSize:12}}>{label}</Text>
    <Icon name="ChevronDown" size={13} color={c.foregroundMuted}/>
  </Pressable>;
}

export function TopicSendDialog({ client, basket, note, destination, newSession, targets, target, workspaceNames, currentAgentId, groupName,
  busy, preview, error, onClose, onOpenSession, onNote, onDestination, onTarget, onModel, onConfirm }: {
  client: TopicsClient; basket: TopicBasket; note: string; destination: 'existing' | 'new'; newSession?: TopicNewSession;
  targets: TargetDirectory; target?: TopicTarget; workspaceNames: Record<string, string>; currentAgentId?: string;
  groupName(group: WatchedGroup): string; busy: boolean; preview?: TopicMaterialPreview; error: string;
  onClose(): void; onOpenSession?(): void; onNote(value: string): void; onDestination(value: 'existing' | 'new'): void;
  onTarget(target: TopicTarget): void; onModel(model: TopicNewSession): void; onConfirm(): void;
}) {
  const c = useColors(), counts = basketCounts(basket);
  const [picker, setPicker] = useState<'target' | 'model' | ''>(''), [query, setQuery] = useState('');
  const pending = preview?.state === 'sending' || preview?.state === 'uncertain', accepted = preview?.state === 'accepted';
  const locked = busy || pending || accepted;
  const models = useQuery({ queryKey: ['archive-topic-models', client.scopeKey], queryFn: () => client.call<TopicModel[]>({ action: 'models' }),
    enabled: destination === 'new' && !locked, retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  useEffect(() => {
    if (destination !== 'new' || newSession || !models.data?.length || locked) return;
    const preferred = models.data.filter(item => item.provider === target?.provider);
    onModel(preferred.find(item => item.model === target?.model) || preferred.find(item => item.isDefault)
      || models.data.find(item => item.isDefault) || models.data[0]);
  }, [destination, newSession, models.data, target?.provider, target?.model, locked, onModel]);
  const selectedModel = models.data?.find(item => newSession && modelKey(item) === modelKey(newSession));
  const overLimit = counts.topics > 20 || counts.messages > 100 || counts.assets > 20 || note.length > TOPIC_NOTE_LIMIT;
  const missing = destination === 'new' ? !selectedModel : !target;
  const state = accepted ? '已交接' : pending ? '回执待确认' : '';
  const failure = error || (destination === 'new' && models.error ? topicError(models.error.message) : '');
  const showPicker = (value: 'target' | 'model') => { setQuery(''); setPicker(value); };
  return <Dialog id="topics-send-dialog" title="发送到会话" onClose={onClose} width={800} height={790}
    footer={<><Button onPress={onClose}>{accepted ? '完成' : '返回'}</Button>
      <Button id="topics-confirm" icon={accepted ? 'ArrowUpRight' : pending ? 'CircleHelp' : 'Send'} variant="primary"
        disabled={busy || !counts.topics || overLimit || (accepted ? !onOpenSession : !pending && missing)}
        onPress={accepted && onOpenSession ? onOpenSession : onConfirm}>
        {busy ? destination === 'new' ? '创建并发送中' : '发送中' : accepted ? '打开会话' : pending ? '查回执' : destination === 'new' ? '创建并发送' : '确认发送'}
      </Button></>}>
    <ScrollView testID="topics-send-content" contentContainerStyle={{ padding: 18, gap: 18 }}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button icon="MessagesSquare" active={destination === 'existing'} disabled={locked} onPress={() => onDestination('existing')}>已有会话</Button>
          <Button icon="MessageSquarePlus" active={destination === 'new'} disabled={locked} onPress={() => onDestination('new')}>新建会话</Button>
        </View>
        {destination === 'existing' ? <View style={{ gap: 6 }}>
          <Choice id="topics-target" icon="MessageSquare" disabled={locked} onPress={() => { showPicker('target'); void targets.refetch(); }}
            label={target?.title || workspaceNames[target?.workspaceId || ''] || '选择目标会话'} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name="Cpu" size={13} color={c.foregroundMuted} /><Label muted>{modelName(target)}</Label></View>
        </View> : <View style={{ gap: 6 }}>
          <Choice id="topics-model" icon="Cpu" disabled={locked || models.isLoading} onPress={() => showPicker('model')}
            label={models.isLoading ? '加载模型' : selectedModel ? selectedModel.provider + ' · ' + selectedModel.label : '选择模型'} />
          {models.error || models.data && !models.data.length ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Label muted>{models.error ? '模型列表暂不可用' : '此主机暂无可用模型'}</Label>
            <TopicIcon icon="RefreshCw" label="刷新模型" busy={models.isFetching} onPress={() => { void models.refetch(); }} />
          </View> : null}
        </View>}
      </View>
      <View style={{ gap: 7 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name="PenLine" size={14} color={c.accent} /><Label strong>本次说明</Label><Label muted>可选</Label></View>
        <TextInput testID="topics-send-note" accessibilityLabel="本次说明" value={note} onChangeText={onNote} editable={!locked}
          multiline maxLength={TOPIC_NOTE_LIMIT} placeholder="希望如何处理这些材料？" autoCapitalize="none" autoCorrect={false}
          style={{ color: c.foreground, backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, borderRadius: 6,
            fontSize: 13, lineHeight: 21, padding: 10, minHeight: 100, maxHeight: 170, textAlignVertical: 'top' }} />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Label strong>所选材料</Label><MediaCount icon="Layers" count={counts.topics} label="话题" />
        <MediaCount icon="MessageSquare" count={counts.messages} label="原文" /><MediaCount icon="Image" count={counts.assets} label="附件" />
      </View>
      {Object.values(basket).map(selected => <View key={selected.topic.id} style={{ gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border }}>
        <Label strong lines={2}>{topicTitle(selected.topic)}</Label><Label muted>{groupName(selected.topic)}</Label>
        {selected.messages.map(message => <View key={message.id} style={{ borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 12 }}>
          <Label muted>{senderName(message) + ' · ' + topicTime(message.createdAt)}</Label>
          {messageText(message) ? <Label>{messageText(message)}</Label> : null}
        </View>)}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {selectedAssets(selected).map(({ message, asset }) => <TopicAsset key={asset.id} {...{ client, message, asset }} topicId={selected.topic.id}
            contextOf={selected.contexts[message.id]} checked disabled onToggle={() => undefined} />)}
        </View>
        {selected.includeAnalysis ? <Label>{selected.topic.lastAnswer || selected.topic.summary}</Label> : null}
      </View>)}
    </ScrollView>
    <TopicStatus id="topics-send-status" error={failure} state={state} onDetails={() => undefined} />
    {picker ? <Dialog title={picker === 'target' ? '目标会话' : '选择模型'} onClose={() => setPicker('')} width={560} height={500}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Search value={query} onChange={setQuery} placeholder={picker === 'target' ? '搜索此项目会话' : '搜索模型'} /></View>
        <TopicIcon icon="RefreshCw" label={picker === 'target' ? '刷新会话' : '刷新模型'} busy={picker === 'target' ? targets.isFetching : models.isFetching}
          onPress={() => { void (picker === 'target' ? targets.refetch() : models.refetch()); }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {picker === 'target' ? targets.isLoading ? <ActivityIndicator /> : targets.data?.length ? targets.data
          .filter(item => !query || [item.title, item.provider, item.model, workspaceNames[item.workspaceId]].some(text => text?.toLowerCase().includes(query.toLowerCase())))
          .map(item => <View key={targetKey(item)} style={{ gap: 3 }}>
            <Button icon="MessageSquare" active={Boolean(target && targetKey(target) === targetKey(item))} onPress={() => { onTarget(item); setPicker(''); }}>
              {(item.agentId === currentAgentId ? '当前 · ' : '') + (item.title || workspaceNames[item.workspaceId] || item.agentId)}
            </Button><Label muted>{modelName(item) + (item.status === 'running' ? ' · 进行中' : '')}</Label>
          </View>) : <View style={{ gap: 10, alignItems: 'center', padding: 20 }}>
            <Icon name="MessagesSquare" size={28} color={c.foregroundMuted} /><Label muted>{targets.error ? topicError(targets.error.message) : '此项目暂无会话'}</Label>
            <Button icon="MessageSquarePlus" onPress={() => { onDestination('new'); setPicker(''); }}>新建会话</Button>
          </View>
          : models.isLoading ? <ActivityIndicator /> : models.data?.filter(item => !query || [item.provider, item.label, item.model].some(value => value.toLowerCase().includes(query.toLowerCase())))
            .map(item => <Button key={modelKey(item)} icon="Cpu" active={Boolean(newSession && modelKey(item) === modelKey(newSession))}
              onPress={() => { onModel(item); setPicker(''); }}>{item.provider + ' · ' + item.label}</Button>)}
      </ScrollView>
    </Dialog> : null}
  </Dialog>;
}
