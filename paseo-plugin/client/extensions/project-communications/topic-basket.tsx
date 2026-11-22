import { useState } from 'react';
import { View } from 'react-native';
import { Icon, ScrollView } from '../../native-components';
import type { TopicsClient } from '../../use-topics';
import { basketCounts, changeAsset, changeMessage, selectedAssets, type TopicBasket } from '../../topic-selection';
import type { TopicMaterialPreview } from '../../../shared/extensions/project-communications/topics';
import { messageText, senderName, topicTitle } from '../../../shared/extensions/project-communications/topics';
import { Button, Label, useColors } from './ui';
import { MediaCount, TopicAsset, TopicIcon } from './topic-ui';

export function TopicMaterialBasket({ client, basket, edit, busy, narrow, preview, hasNote, onSend, onOpenSession,onEdit }: {
  client: TopicsClient; basket: TopicBasket; edit(change: (current: TopicBasket) => TopicBasket): void;
  busy: boolean; narrow: boolean; preview?: TopicMaterialPreview; hasNote: boolean;
  onSend(): void; onOpenSession?(): void;onEdit():void;
}) {
  const c = useColors(), counts = basketCounts(basket), [collapsed, setCollapsed] = useState(false);
  const overLimit = counts.topics > 20 || counts.messages > 100 || counts.assets > 20;
  const uncertain = preview?.state === 'sending' || preview?.state === 'uncertain';
  return <View testID="topics-basket" style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface2, maxHeight: 310 }}>
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Label strong>已选</Label><MediaCount icon="Layers" count={counts.topics} label="话题" />
      <MediaCount icon="MessageSquare" count={counts.messages} label="原文" /><MediaCount icon="Image" count={counts.assets} label="附件" />
      <View style={{ flex: 1 }} /><TopicIcon icon={collapsed ? 'ChevronUp' : 'ChevronDown'} label={collapsed ? '展开材料' : '收起材料'} disabled={!counts.topics} onPress={() => setCollapsed(value => !value)} />
      <TopicIcon icon="X" label="清空材料" disabled={busy || !counts.topics} onPress={() => edit(() => ({}))} />
    </View>
    {!collapsed ? <ScrollView testID="topics-basket-items" style={{ maxHeight: 190 }} contentContainerStyle={{ paddingHorizontal: 12 }}>
      {Object.values(basket).map(selected => <View key={selected.topic.id} testID={'topic-basket-' + selected.topic.id}
        style={{ paddingVertical: 7, gap: 8, flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? undefined : 'center', borderTopWidth: 1, borderTopColor: c.border }}>
        <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center', flexBasis: narrow ? undefined : '30%', maxWidth: narrow ? undefined : 300 }}>
          <Icon name="Layers" size={13} color={c.accent} />
          <View style={{ flex: 1 }}><Label lines={1} strong>{topicTitle(selected.topic)}</Label></View>
          <TopicIcon compact icon="X" label={'移除话题 ' + topicTitle(selected.topic)} disabled={busy}
            onPress={() => edit(current => { const next = { ...current }; delete next[selected.topic.id]; return next; })} />
        </View>
        <View style={{ flexDirection: 'row', gap: 9, alignItems: 'center', flex: narrow ? undefined : 1 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {selected.messages.map(message => <View key={message.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ flex: 1 }}><Label muted lines={1}>{senderName(message) + ((selected.editedTexts?.[message.id]??messageText(message)) ? '：' + (selected.editedTexts?.[message.id]??messageText(message)) : '')}</Label></View>
              <TopicIcon compact icon="PenLine" label="编辑所选材料" disabled={busy||uncertain} onPress={onEdit}/>
              <TopicIcon compact id={'topic-remove-message-' + message.id} icon="X" label={'移除原文：' + (messageText(message).slice(0,24) || '附件消息')} disabled={busy}
                onPress={() => edit(current => changeMessage(current, selected.topic, message, selected.contexts[message.id]))} />
            </View>)}
            {selected.includeAnalysis ? <MediaCount icon="Sparkles" label="已选分析" /> : null}
          </View>
          <ScrollView horizontal style={{ flexGrow: 0, maxWidth: narrow ? 120 : 190 }} contentContainerStyle={{ gap: 8, padding: 7 }}>
            {selectedAssets(selected).map(({ message, asset }) => <TopicAsset key={asset.id} {...{ client, message, asset }}
              topicId={selected.topic.id} contextOf={selected.contexts[message.id]} small removable checked disabled={busy}
              onToggle={() => edit(current => changeAsset(current, selected.topic, message, asset, selected.contexts[message.id]))} />)}
          </ScrollView>
        </View>
      </View>)}
    </ScrollView> : null}
    <View style={{ flexDirection: 'row', gap: 6, padding: 10, alignItems: 'center', borderTopWidth: 1, borderTopColor: c.border }}>
      {hasNote ? <MediaCount icon="PenLine" label="含本次说明" /> : null}
      <View style={{ flex: 1 }} />
      <Button id="topics-send" icon={preview?.state === 'accepted' ? 'Check' : uncertain ? 'CircleHelp' : 'Send'} variant="primary"
        disabled={busy || !counts.topics || overLimit || preview?.state === 'accepted' && !onOpenSession} onPress={preview?.state === 'accepted' ? onOpenSession || onSend : onSend}>
        {busy ? '发送中' : preview?.state === 'accepted' ? onOpenSession ? '打开会话' : '已发送' : uncertain ? '查回执' : '发送到会话'}
      </Button>
    </View>
  </View>;
}
