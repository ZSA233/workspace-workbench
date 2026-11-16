import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Icon, ScrollView } from '../../native-components';
import type { CommunicationsClient } from '../../use-communications';
import { type Message, type Attachment, type Requirement, type Delivery } from '../../../shared/extensions/project-communications/shared';
import { Badge, Button, Card, Dialog, Footer, Label, Row, Section, dateText, ignoreFailure, shortTime, tint, useColors, useTouch } from './ui';

export function Evidence({ ids, client }: { ids: string[]; client: CommunicationsClient }) {
  const c = useColors();
  const query = useQuery({ queryKey: ['communication-evidence', client.scopeKey, ...ids], queryFn: () => client.call<{ messages: Message[] }>({ action: 'messages.read', ids }), retry: false });
  return <View style={{ gap: 8 }}>{query.error ? <Label warning>{query.error.message}</Label> : null}
    {query.data?.messages.length ? <Card style={{ paddingVertical: 2 }}>{query.data.messages.map((message, index) => <View key={message.id} style={{ borderTopWidth: index ? 1 : 0, borderTopColor: c.border }}><MessageCard message={message} client={client} compact /></View>)}</Card> : null}
    {!query.data && !query.error ? <Label muted>正在读取原始依据…</Label> : null}
  </View>;
}
export function MessageCard({ message, client, compact = false }: { message: Message; client: CommunicationsClient; compact?: boolean }) {
  const c = useColors();
  return <View style={{ padding: compact ? 0 : 14, paddingVertical: compact ? 12 : 14, gap: 10, borderWidth: compact ? 0 : 1, borderColor: c.border, borderRadius: 6, backgroundColor: compact ? undefined : c.surface2 }}>
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: tint(c.foregroundMuted, '14'), alignItems: 'center', justifyContent: 'center' }}><Icon name="UserRound" size={17} color={c.foregroundMuted} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Row><Label strong>{message.sender}</Label><Label muted>{compact ? shortTime(message.createdAt) : dateText(message.createdAt)}</Label></Row><Label>{message.text || '附件消息'}</Label>
        {message.replyTo ? <Label muted>{'回复消息：' + message.replyTo}</Label> : null}{message.mentions.length ? <Label muted>{'@ ' + message.mentions.join('、')}</Label> : null}
      </View>
    </View>
    {message.attachments.map(attachment => <AttachmentView key={attachment.id} attachment={attachment} client={client} />)}
    {!compact ? <Label muted>{'原始消息 ' + message.sourceId + ' · ' + (client.snapshot?.groups.find(group => group.id === message.groupId)?.name || message.groupId)}</Label> : null}
  </View>;
}
function decodeText(base64: string) {
  // Works in Hermes as well as browsers; no frontend Node Buffer dependency.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of base64) { const digit = alphabet.indexOf(char); if (digit < 0) continue; value = (value << 6) | digit; bits += 6; if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); } }
  try { return decodeURIComponent(bytes.map(byte => '%' + byte.toString(16).padStart(2, '0')).join('')); } catch { return '附件不是受支持的 UTF-8 文本，已保留原件。'; }
}
function AttachmentView({ attachment, client }: { attachment: Attachment; client: CommunicationsClient }) {
  const c = useColors(), [open, setOpen] = useState(false), [data, setData] = useState<{ base64?: string; mimeType: string }>(), [error, setError] = useState('');
  const view = async () => {
    setOpen(true); setError('');
    try { setData(await client.call<{ base64?: string; mimeType: string }>({ action: 'attachment.read', id: attachment.id })); }
    catch (failure) { setError(String(failure)); }
  };
  const labels = { ready: '已保存原件', pending: '等待下载', failed: '下载失败', unsupported: '无法读取或超限' };
  return <View style={{ gap: 4 }}><Row><Icon name={attachment.mimeType.startsWith('image/') ? 'Image' : 'FileText'} size={15} color={c.foregroundMuted} /><Label>{attachment.name}</Label>
    <Label muted>{labels[attachment.state] + (attachment.size ? ' · ' + Math.ceil(attachment.size / 1024) + ' KB' : '')}</Label><Button variant="link" disabled={attachment.state !== 'ready'} onPress={() => ignoreFailure(view())}>查看附件</Button></Row>
    {attachment.error ? <Label warning>{attachment.error}</Label> : null}{attachment.analysisNote ? <Label muted>{attachment.analysisNote}</Label> : null}
    <Dialog open={open} id="communications-attachment-preview" title={attachment.name} onClose={() => setOpen(false)} width={680} height={600} footer={<Button onPress={() => setOpen(false)}>关闭</Button>}><ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
      {error ? <Label warning>{error}</Label> : data?.base64 ? data.mimeType.startsWith('image/') ? <Image accessibilityLabel={attachment.name} source={{ uri: 'data:' + data.mimeType + ';base64,' + data.base64 }} style={{ width: '100%', height: 320 }} resizeMode="contain" />
        : /^text\/|application\/(json|xml)/.test(data.mimeType) ? <Label>{decodeText(data.base64)}</Label> : <Label>已保留原件，可在安排开发时选择作为会话材料。此格式暂不参与自动分析。</Label> : <Label muted>正在读取附件…</Label>}
    </ScrollView></Dialog>
  </View>;
}
function MaterialChoice({ title, selected, onPress, disabled = false, icon = 'MessageSquare' }: { title: string; selected: boolean; onPress: () => void; disabled?: boolean; icon?: string }) {
  const c = useColors(), touch = useTouch();
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={title} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: touch ? 44 : 40, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9, borderBottomWidth: 1, borderBottomColor: c.border, opacity: disabled ? 0.5 : 1 }}>
    <View style={{ width: 16, height: 16, borderRadius: 3, borderWidth: 1, borderColor: selected ? c.accent : c.foregroundMuted, backgroundColor: selected ? c.accent : c.surface1 }}>{selected ? <Icon name="Check" size={14} color={c.accentForeground} /> : null}</View>
    <Icon name={icon} size={16} color={c.foregroundMuted} /><View style={{ flex: 1 }}><Label>{title}</Label></View>
  </Pressable>;
}
export function DeliveryDialog({ requirement, client, workspaceNames, onClose }: { requirement: Requirement; client: CommunicationsClient; workspaceNames: Record<string, string>; onClose: () => void }) {
  const c = useColors();
  const [workspace, setWorkspace] = useState(''), [messageIds, setMessageIds] = useState<string[]>([]), [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Delivery>(), [busy, setBusy] = useState(false);
  const targets = useQuery({ queryKey: ['communications-targets', client.scopeKey], queryFn: () => client.call<Array<{ workspaceId: string; agentId: string }>>({ action: 'delivery.targets' }), retry: false });
  const evidence = useQuery({ queryKey: ['communication-evidence', client.scopeKey, ...requirement.evidenceIds], queryFn: () => client.call<{ messages: Message[] }>({ action: 'messages.read', ids: requirement.evidenceIds }), retry: false });
  const toggle = (value: string, list: string[], set: (next: string[]) => void) => { set(list.includes(value) ? list.filter(item => item !== value) : [...list, value]); setPreview(undefined); };
  const perform = async (action: 'preview' | 'send' | 'status') => {
    setBusy(true);
    try { setPreview(await client.call<Delivery>(action === 'preview' ? { action: 'delivery.preview', requirementId: requirement.id, version: requirement.version, workspaceId: workspace, messageIds, attachmentIds }
      : { action: action === 'send' ? 'delivery.send' : 'delivery.status', id: preview!.id })); } finally { setBusy(false); }
  };
  return <Dialog title="发送至开发会话" onClose={() => { if (!busy) onClose(); }} width={820} height={740}
    footer={<><Button disabled={busy} onPress={onClose}>{preview ? '返回需求' : '取消'}</Button>
      {!preview ? <Button variant="primary" id="communications-delivery-preview" disabled={!workspace || busy} onPress={() => ignoreFailure(perform('preview'))}>预览所选上下文</Button>
        : preview.state === 'preview' ? <><Button disabled={busy} onPress={() => setPreview(undefined)}>返回选择</Button><Button variant="primary" id="communications-delivery-send" disabled={busy} onPress={() => ignoreFailure(perform('send'))}>发送所选上下文</Button></>
          : <Button disabled={busy} onPress={() => ignoreFailure(perform('status'))}>查询原投递回执</Button>}</>}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 4 }}>
      <Row><Label large>{requirement.title}</Label><Badge tone="info">{'REQ-' + String(requirement.number).padStart(3, '0') + ' · v' + requirement.version}</Badge></Row>
      {client.error ? <Label warning>{client.error}</Label> : null}
      {!preview ? <>
        <Section title="选择投递材料"><Card style={{ padding: 0 }}>
          <MaterialChoice title={'需求正文 · v' + requirement.version + '（始终包含）'} selected disabled icon="FileText" onPress={() => undefined} />
          {evidence.error ? <Label warning>{evidence.error.message}</Label> : null}
          {evidence.data?.messages.map(message => <View key={message.id}>
            <MaterialChoice title={message.sender + ' · ' + (message.text.slice(0, 70) || '附件消息')} selected={messageIds.includes(message.id)} onPress={() => toggle(message.id, messageIds, setMessageIds)} />
            {message.attachments.map(item => <MaterialChoice key={item.id} title={item.name + (item.state !== 'ready' ? ' · 尚不可用' : '')} icon={item.mimeType.startsWith('image/') ? 'Image' : 'FileText'} disabled={item.state !== 'ready'} selected={attachmentIds.includes(item.id)} onPress={() => toggle(item.id, attachmentIds, setAttachmentIds)} />)}
          </View>)}
        </Card></Section>
        <Section title="目标会话"><Label muted>仅列出当前项目已绑定的开发会话。</Label>
          {targets.error ? <Label warning>{targets.error.message}</Label> : null}
          {targets.data?.map(target => <Button key={target.workspaceId} icon="MessageSquare" active={workspace === target.workspaceId} onPress={() => setWorkspace(target.workspaceId)}>{(workspaceNames[target.workspaceId] || target.workspaceId) + ' · ' + target.agentId.slice(0, 12)}</Button>)}
          {targets.data?.length === 0 ? <Card><Label muted>此项目还没有已绑定的开发会话。请先在 Workspace 中打开开发会话。</Label></Card> : null}
        </Section>
        <Card><Label muted>{'仅发送所选内容：需求正文、' + messageIds.length + ' 条原文、' + attachmentIds.length + ' 个附件。预览后再次确认才会发送。'}</Label></Card>
      </> : <>
        <Section title={preview.state === 'accepted' ? '投递信息' : '预览内容'}><Card><Label>{preview.text}</Label></Card></Section>
        <Section title="目标会话"><Card style={{ backgroundColor: c.surface1 }}><Row><Icon name="MessageSquare" size={16} color={c.foregroundMuted} /><Label>{workspaceNames[preview.workspaceId] || preview.workspaceId}</Label><Badge>{preview.attachmentIds.length + ' 个附件'}</Badge></Row></Card></Section>
        <Card style={{ backgroundColor: tint(preview.state === 'accepted' ? c.statusSuccess : c.statusWarning, '12') }}>
          <Label warning={preview.state === 'uncertain'}>{preview.state === 'accepted' ? '宿主已接收；不代表模型已阅读。' : preview.state === 'uncertain' || preview.state === 'sending' ? '送达状态不确定，请查询回执；不会自动重发。' : '确认后才会发送到所选开发会话。'}</Label>
        </Card>
      </>}
    </ScrollView>
  </Dialog>;
}
export function RequirementReader({ requirement, client, workspaceNames }: { requirement: Requirement; client: CommunicationsClient; workspaceNames: Record<string, string> }) {
  const c = useColors(), touch = useTouch(), [tab, setTab] = useState<'body' | 'sources' | 'history'>('body'), [deliveryOpen, setDeliveryOpen] = useState(false);
  const history = useQuery({ queryKey: ['communications-history', client.scopeKey, requirement.id, requirement.version], queryFn: () => client.call<Requirement[]>({ action: 'requirement.history', id: requirement.id }), enabled: tab === 'history', retry: false });
  return <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 14 }}>
      <Label muted>{'REQ-' + String(requirement.number).padStart(3, '0') + ' · v' + requirement.version + ' · 更新 ' + dateText(requirement.updatedAt)}</Label>
      <Row><Label large>{requirement.title}</Label><Badge tone="info">{'正式需求 · v' + requirement.version}</Badge></Row>
      <View style={{ flexDirection: 'row', gap: 16, borderBottomWidth: 1, borderBottomColor: c.border }}>
        {([['body', '正文'], ['sources', '来源'], ['history', '修订历史']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: tab === value }} onPress={() => setTab(value)}
          style={{ minHeight: touch ? 44 : 36, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: tab === value ? c.accent : 'transparent' }}><Text style={{ fontSize: 12, color: tab === value ? c.foreground : c.foregroundMuted, fontWeight: tab === value ? '600' : '400' }}>{label}</Text></Pressable>)}
      </View>
      {tab === 'body' ? <Card><Label>{requirement.body}</Label></Card> : tab === 'sources' ? <Section title="来源材料"><Evidence ids={requirement.evidenceIds} client={client} /></Section>
        : <Section title="需求版本">{history.error ? <Label warning>{history.error.message}</Label> : null}{history.data?.map(item => <Card key={item.version} style={{ backgroundColor: item.version === requirement.version ? tint(c.accent, '0c') : c.surface2 }}>
          <Label strong>{'v' + item.version + ' · ' + item.title}</Label><Label>{item.body}</Label><Label muted>{dateText(item.updatedAt)}</Label>
        </Card>)}</Section>}
    </ScrollView>
    <Footer><Button variant="primary" icon="MessageSquare" id="communications-open-delivery" onPress={() => setDeliveryOpen(true)}>带入会话</Button></Footer>
    {deliveryOpen ? <DeliveryDialog requirement={requirement} client={client} workspaceNames={workspaceNames} onClose={() => setDeliveryOpen(false)} /> : null}
  </View>;
}
