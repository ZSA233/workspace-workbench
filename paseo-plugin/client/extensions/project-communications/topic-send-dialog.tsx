import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, ScrollView, TextInput } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import { materialCounts, materialLimitExceeded, type TopicBasket } from '../../topic-selection';
import type { IssueBasket } from '../../issue-selection';
import { TOPIC_NOTE_LIMIT,
  type ArchiveMessage,type TopicMaterialPreview, type TopicModel, type TopicNewSession, type TopicTarget, type WatchedGroup } from '../../../shared/extensions/project-communications/topics';
import { Button, Choice, Dialog, Label, Search, useColors } from './ui';
import { MediaCount, TopicIcon, TopicStatus, topicError } from './topic-ui';
import { TopicSessionControls } from './topic-session-controls';
import { topicChoiceAvailable,topicEffortLabel,topicModelChoice,topicModelKey } from '../../topic-session-choice';
import {TopicMaterialActions,TopicMaterialRows,type useTopicMaterialDraft} from './topic-material-editor';
import type {TopicMaterialSettings} from '../../../shared/extensions/project-communications/topic-content';

type TargetDirectory = { data?: TopicTarget[]; isLoading: boolean; isFetching: boolean; error: Error | null; refetch(): Promise<unknown> };
const targetKey = (target: TopicTarget) => target.id || 'workspace:' + target.workspaceId;
const modelName = (target?: TopicTarget) => target?.provider ? [target.provider, target.model || '当前模型'].join(' · ') : '沿用会话模型';

export function TopicSendDialog({ client, basket, issues, note, destination, newSession, targets, target, workspaceNames, currentAgentId, groupName,
  busy, preview, error, preferencesReady,preferencesError,onRetryPreferences,materialSettings,materialDraft,onMaterialSettings,onEditText,onClose, onOpenSession, onNote, onDestination, onTarget, onModel, onConfirm }: {
  client: TopicsClient; basket: TopicBasket; issues: IssueBasket; note: string; destination: 'existing' | 'new'; newSession?: TopicNewSession;
  targets: TargetDirectory; target?: TopicTarget; workspaceNames: Record<string, string>; currentAgentId?: string;
  groupName(group: WatchedGroup): string; busy: boolean; preview?: TopicMaterialPreview; error: string; preferencesReady:boolean;preferencesError:boolean;onRetryPreferences():void;
  materialSettings:TopicMaterialSettings;materialDraft:ReturnType<typeof useTopicMaterialDraft>['draft'];onMaterialSettings(value:TopicMaterialSettings):void;onEditText(message:ArchiveMessage,text:string|undefined):void;
  onClose(): void; onOpenSession?(): void; onNote(value: string): void; onDestination(value: 'existing' | 'new'): void;
  onTarget(target: TopicTarget): void; onModel(model: TopicNewSession): void; onConfirm(): void;
}) {
  const c = useColors(), counts = materialCounts(basket, issues);
  const [picker, setPicker] = useState(false), [query, setQuery] = useState('');
  const pending = preview?.state === 'sending' || preview?.state === 'uncertain', accepted = preview?.state === 'accepted';
  const locked = busy || pending || accepted || !preferencesReady;
  const models = useQuery({ queryKey: ['archive-topic-models', client.scopeKey], queryFn: () => client.call<TopicModel[]>({ action: 'models' }),
    enabled: destination === 'new' && !locked, retry: false, staleTime: 60000, refetchOnWindowFocus: false });
  useEffect(() => {
    if (destination !== 'new' || newSession || !models.data?.length || locked) return;
    const preferred = models.data.filter(item => item.provider === target?.provider);
    onModel(topicModelChoice(preferred.find(item => item.model === target?.model) || preferred.find(item => item.isDefault)
      || models.data.find(item => item.isDefault) || models.data[0]));
  }, [destination, newSession, models.data, target?.provider, target?.model, locked, onModel]);
  const selectedModel = models.data?.find(item => newSession && topicModelKey(item) === topicModelKey(newSession));
  const validChoice=Boolean(selectedModel&&newSession&&topicChoiceAvailable(selectedModel,newSession));
  const overLimit = materialLimitExceeded(counts) || note.length > TOPIC_NOTE_LIMIT;
  const missing = !preferencesReady || (destination === 'new' ? !validChoice : !target);
  const state = accepted ? '已交接' : pending ? '回执待确认' : '';
  const failure = error || (destination === 'new' && models.error ? topicError(models.error.message)
    :destination==='new'&&selectedModel&&!validChoice?'模型选项已变化，请重新选择推理强度或权限':'');
  return <Dialog id="topics-send-dialog" title="发送到会话" onClose={onClose} width={800} height={790}
    footer={<><Button onPress={onClose}>{accepted ? '完成' : '返回'}</Button>
      <Button id="topics-confirm" icon={accepted ? 'ArrowUpRight' : pending ? 'CircleHelp' : 'Send'} variant="primary"
        disabled={busy || !counts.records || overLimit || (!pending&&!accepted&&(Boolean(materialDraft.error)||!materialDraft.text.trim()&&!counts.assets)) || (accepted ? !onOpenSession : !pending && missing)}
        onPress={accepted && onOpenSession ? onOpenSession : onConfirm}>
        {busy ? destination === 'new' ? '创建并发送中' : '发送中' : accepted ? '打开会话' : pending ? '查回执' : destination === 'new' ? '创建并发送' : '确认发送'}
      </Button></>}>
    <ScrollView testID="topics-send-content" contentContainerStyle={{ padding: 18, gap: 18 }}>
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button icon="MessagesSquare" active={destination === 'existing'} disabled={locked} onPress={() => onDestination('existing')}>已有会话</Button>
          <Button icon="MessageSquarePlus" active={destination === 'new'} disabled={locked} onPress={() => onDestination('new')}>新建会话</Button>
          {preferencesError?<TopicIcon icon="RefreshCw" label="重新保存选择" onPress={onRetryPreferences}/>:null}
        </View>
        {destination === 'existing' ? <View style={{ gap: 6 }}>
          <Choice id="topics-target" icon="MessageSquare" disabled={locked} onPress={() => { setQuery('');setPicker(true); void targets.refetch(); }}
            label={target?.title || workspaceNames[target?.workspaceId || ''] || '选择目标会话'} />
          <View style={{ flexDirection: 'row',flexWrap:'wrap', alignItems: 'center', gap: 6 }}><Icon name="Cpu" size={13} color={c.foregroundMuted} /><Label muted>{modelName(target)}</Label>
            {target?.thinkingOptionId?<><Icon name="Brain" size={13} color={c.foregroundMuted}/><Label muted>{topicEffortLabel({id:target.thinkingOptionId})}</Label></>:null}
            {target?.permissionLabel?<><Icon name="Shield" size={13} color={c.foregroundMuted}/><Label muted>{target.permissionLabel}</Label></>:null}
          </View>
        </View> : <TopicSessionControls models={models.data||[]} choice={newSession} locked={locked} loading={models.isLoading}
          refreshing={models.isFetching} unavailable={Boolean(models.error)} onRefresh={()=>{void models.refetch();}} onChange={onModel}/>}
      </View>
      <View style={{ gap: 7 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name="PenLine" size={14} color={c.accent} /><Label strong>本次说明</Label><Label muted>可选</Label></View>
        <TextInput testID="topics-send-note" accessibilityLabel="本次说明" value={note} onChangeText={onNote} editable={!locked}
          multiline maxLength={TOPIC_NOTE_LIMIT} placeholder="希望如何处理这些材料？" autoCapitalize="none" autoCorrect={false}
          style={{ color: c.foreground, backgroundColor: c.surface2, borderColor: c.border, borderWidth: 1, borderRadius: 6,
            fontSize: 13, lineHeight: 21, padding: 10, minHeight: 100, maxHeight: 170, textAlignVertical: 'top' }} />
      </View>
      <View style={{ flexDirection: 'row',flexWrap:'wrap', alignItems: 'center', gap: 8 }}>
        <Label strong>所选材料</Label>{counts.topics ? <MediaCount icon="Layers" count={counts.topics} label="话题" /> : null}
        {counts.issues ? <MediaCount icon="Bug" count={counts.issues} label="缺陷" /> : null}
        <MediaCount icon="MessageSquare" count={counts.messages} label="原文" /><MediaCount icon="Image" count={counts.assets} label="附件" />
        <TopicMaterialActions {...{client,basket,issues,note,locked}} settings={materialSettings} draft={materialDraft} onSettings={onMaterialSettings} onEdit={onEditText}/>
      </View>
      <TopicMaterialRows {...{client,basket,issues,note,locked}} settings={materialSettings} draft={materialDraft} onSettings={onMaterialSettings} onEdit={onEditText}/>
    </ScrollView>
    <TopicStatus id="topics-send-status" error={failure} state={state} onDetails={() => undefined} />
    {picker ? <Dialog title="目标会话" onClose={() => setPicker(false)} width={560} height={500}>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}><Search value={query} onChange={setQuery} placeholder="搜索此项目会话" /></View>
        <TopicIcon icon="RefreshCw" label="刷新会话" busy={targets.isFetching} onPress={() => { void targets.refetch(); }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {targets.isLoading ? <ActivityIndicator /> : targets.data?.length ? targets.data
          .filter(item => !query || [item.title, item.provider, item.model, workspaceNames[item.workspaceId]].some(text => text?.toLowerCase().includes(query.toLowerCase())))
          .map(item => <View key={targetKey(item)} style={{ gap: 3 }}>
            <Button icon="MessageSquare" active={Boolean(target && targetKey(target) === targetKey(item))} onPress={() => { onTarget(item); setPicker(false); }}>
              {(item.agentId === currentAgentId ? '当前 · ' : '') + (item.title || workspaceNames[item.workspaceId] || item.agentId)}
            </Button><Label muted>{modelName(item) + (item.status === 'running' ? ' · 进行中' : '')}</Label>
          </View>) : <View style={{ gap: 10, alignItems: 'center', padding: 20 }}>
            <Icon name="MessagesSquare" size={28} color={c.foregroundMuted} /><Label muted>{targets.error ? topicError(targets.error.message) : '此项目暂无会话'}</Label>
            <Button icon="MessageSquarePlus" onPress={() => { onDestination('new'); setPicker(false); }}>新建会话</Button>
          </View>}
      </ScrollView>
    </Dialog> : null}
  </Dialog>;
}
