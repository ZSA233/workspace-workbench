import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { Icon, ScrollView } from '../../native-components';
import type { CommunicationsClient } from '../../use-communications';
import { categoryLabels, configSchema, type CommunicationsConfig, type Category, type Capability } from '../../../shared/extensions/project-communications/shared';
import { Badge, Button, Card, Dialog, Field, Label, Row, Section, Toggle, capabilityText, dateText, ignoreFailure, taskText, tint, useColors, useTouch } from './ui';

const pages = ['连接与来源', '模型与预算', '分析重点', '扩展管理'] as const;
const pageIcons = ['Link2', 'SlidersHorizontal', 'Target', 'Puzzle'];
function CapabilityRow({ title, value }: { title: string; value?: Capability }) {
  return <Row><View style={{ flex: 1 }}><Label>{title}</Label></View><Badge tone={value?.state === 'verified' ? 'success' : value?.state === 'failed' || value?.state === 'unavailable' ? 'warning' : 'neutral'}>{capabilityText[value?.state || 'pending']}</Badge></Row>;
}
function BudgetSlider({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
  const c = useColors(), touch = useTouch(), [width, setWidth] = useState(1), [focused, setFocused] = useState(false), origin = useRef(0), limit = Math.max(8192, max || 8192);
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(1, (value - 4096) / (limit - 4096))) : 0;
  const update = (number: number) => onChange(Math.max(4096, Math.min(limit, Math.round(number / 4096) * 4096)));
  const at = (x: number) => update(4096 + ((x - 9) / Math.max(1, width - 18)) * (limit - 4096));
  const paint = <View pointerEvents="none" style={{ height: 5, marginHorizontal: 9, backgroundColor: c.border, borderRadius: 3 }}>
    <View style={{ width: String(progress * 100) + '%' as any, height: 5, backgroundColor: c.accent, borderRadius: 3 }} />
    <View style={{ position: 'absolute', left: String(progress * 100) + '%' as any, top: -6, marginLeft: -8, width: 17, height: 17, borderRadius: 9, borderWidth: 1, borderColor: c.accent, backgroundColor: c.surface1 }} />
  </View>;
  return <View><View style={{ height: touch ? 44 : 34, justifyContent: 'center', marginHorizontal: 1, borderWidth: 1, borderColor: focused ? c.accent : 'transparent', borderRadius: 5 }}>
    {Platform.OS === 'web' ? <>{paint}<input type="range" aria-label="总上下文预算滑块" min={4096} max={limit} step={4096} value={Number.isFinite(value) ? value : 4096}
      onChange={event => update(Number((event.currentTarget as any).value))} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={{ position: 'absolute', inset: 0, margin: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }} /></>
      : <View accessible accessibilityRole="adjustable" accessibilityLabel="总上下文预算滑块" accessibilityValue={{ min: 4096, max: limit, now: value, text: String(value / 1024) + 'K tokens' }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={event => update(value + (event.nativeEvent.actionName === 'increment' ? 4096 : -4096))}
        onLayout={event => setWidth(event.nativeEvent.layout.width)} onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
        onResponderGrant={event => { origin.current = event.nativeEvent.pageX - event.nativeEvent.locationX; at(event.nativeEvent.locationX); }}
        onResponderMove={event => at(event.nativeEvent.pageX - origin.current)} onResponderRelease={event => at(event.nativeEvent.pageX - origin.current)}
        style={{ flex: 1, justifyContent: 'center' }}>{paint}</View>}
  </View><Row><Label muted>4K</Label><View style={{ flex: 1 }} /><Label muted>{limit / 1024 + 'K'}</Label></Row></View>;
}
export function CommunicationsSettings({ client, open, onClose, initialPage = '扩展管理' }: { client: CommunicationsClient; open: boolean; onClose: () => void; initialPage?: typeof pages[number] }) {
  const c = useColors(), window = useWindowDimensions(), touch = useTouch(), wide = window.width >= 960, sidebar = window.width >= 720;
  const [page, setPage] = useState<typeof pages[number]>(initialPage);
  const [draft, setDraft] = useState<CommunicationsConfig | null>(null), [revision, setRevision] = useState(0);
  const [modelRevision,setModelRevision]=useState(0);
  const modelDirty=useRef(false),projectDirty=useRef(false);
  const dirty = useRef(false), [changed, setChanged] = useState(false), [saving, setSaving] = useState(false), [validation, setValidation] = useState('');
  const [modelKey, setModelKey] = useState<string | undefined>(), [appSecret, setAppSecret] = useState<string | undefined>();
  const [groupQuery, setGroupQuery] = useState(''), [groups, setGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [groupId, setGroupId] = useState(''), [groupName, setGroupName] = useState('');
  const [endpoint, setEndpoint] = useState(''), [serviceProject, setServiceProject] = useState(''), [serviceToken, setServiceToken] = useState<string>(), [connectionDetail, setConnectionDetail] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0), [connectionDirty, setConnectionDirty] = useState(false), [modelPicker, setModelPicker] = useState(false);
  useEffect(() => { if (client.connection && !connectionDirty) { setEndpoint(client.connection.connection.endpoint); setServiceProject(client.connection.connection.projectId); setConnectionRevision(client.connection.revision); } }, [client.connection, connectionDirty]);
  const saveConnection = async () => { setSaving(true); try { await client.updateConnection({ endpoint, projectId: serviceProject }, connectionRevision, serviceToken); setConnectionDirty(false); setServiceToken(undefined); setConnectionDetail('连接配置已保存'); } catch (error) { setConnectionDetail(String(error)); } finally { setSaving(false); } };
  const snapshot = client.snapshot;
  useEffect(() => { if (open) setPage(initialPage); }, [open, initialPage]);
  useEffect(() => { if (snapshot && !dirty.current) { setDraft(snapshot.config); setRevision(snapshot.revision); setModelRevision(snapshot.modelRevision || 0); } }, [snapshot?.revision, snapshot?.modelRevision,snapshot?.config]);
  const mark = (kind: 'model'|'project'='project') => { dirty.current = true; if(kind==='model')modelDirty.current=true;else projectDirty.current=true;setChanged(true); setValidation(''); };
  const edit = <K extends keyof CommunicationsConfig,>(section: K, patch: Partial<CommunicationsConfig[K]>) => { mark(section==='model'?'model':'project'); setDraft(old => old ? { ...old, [section]: { ...old[section], ...patch } } : old); };
  const save = async () => {
    if (!draft || saving) return false;
    const valid = configSchema.safeParse(draft);
    if (!valid.success) { setValidation(valid.error.issues.map(item => item.message).join('；')); return false; }
    setSaving(true);
    try {
      const shared=snapshot?.modelScope==='service';
      if(shared && modelDirty.current){
        const saved=await client.call<{revision:number}>({action:'model.settings.configure',revision:modelRevision,model:valid.data.model,...(modelKey!==undefined?{modelKey}:{})});
        setModelRevision(saved.revision);modelDirty.current=false;setModelKey(undefined);
      }
      const result = projectDirty.current || !shared ? await client.call<{ revision: number; config: CommunicationsConfig }>({ action: 'configure', revision, config: valid.data, modelScope:shared?'service':'project', ...(!shared && modelKey !== undefined ? { modelKey } : {}), ...(appSecret !== undefined ? { appSecret } : {}) }) : {revision,config:valid.data};
      modelDirty.current=false;projectDirty.current=false;
      dirty.current = false; setChanged(false); setDraft(result.config); setRevision(result.revision); setModelKey(undefined); setAppSecret(undefined); setValidation(''); return true;
    } catch (error) {
      setValidation(String(error).includes('settings_revision_conflict') ? '配置已在另一页面更新。保留了你的草稿，请重新载入后再修改。' : String(error)); return false;
    } finally { setSaving(false); }
  };
  const reload = () => { if (snapshot) { dirty.current = false;modelDirty.current=false;projectDirty.current=false;setModelRevision(snapshot.modelRevision || 0); setChanged(false); setDraft(snapshot.config); setRevision(snapshot.revision); setModelKey(undefined); setAppSecret(undefined); setValidation(''); } };
  const action = async (name: 'connection.check' | 'auth.start' | 'models.check' | 'generation.check') => { if (!dirty.current || await save()) await client.call({ action: name }); };
  const latest = (kind: string) => snapshot?.tasks.find(item => item.kind === kind);
  const models = latest('models')?.result as Array<{ id: string; contextTokens?: number; loaded?: boolean; vision?: boolean }> | undefined;
  const pendingAuth = latest('auth');
  const tasks = snapshot?.tasks.filter(item => ['auth', 'connection', 'models', 'generation'].includes(item.kind)).filter((item, index, list) => list.findIndex(other => other.kind === item.kind) === index) || [];
  const modelStatus = (kind: 'models' | 'generation', title: string) => <Row><View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: latest(kind)?.state === 'complete' ? c.statusSuccess : latest(kind)?.state === 'failed' ? c.statusWarning : c.foregroundMuted }} /><Label muted>{title + '：' + (latest(kind) ? taskText[latest(kind)!.state] : '未检测')}</Label></Row>;
  const serviceConnection = <Section title="Workbench 服务连接" collapsible initiallyOpen={page === '扩展管理'}>
    {!client.connection ? <Label muted>正在读取服务连接配置…</Label> : <>
    <Label muted>此扩展连接独立常驻服务。Workbench 关闭、重载或停用后，采集和分析继续运行。</Label>
    <Field label="服务 API 地址" id="communications-service-endpoint" value={endpoint} onChange={value => { setEndpoint(value); setConnectionDirty(true); }} />
    <View style={{ flexDirection: wide ? 'row' : 'column', gap: 12 }}><View style={{ flex: 1 }}><Field label="服务项目 ID" id="communications-service-project" value={serviceProject} onChange={value => { setServiceProject(value); setConnectionDirty(true); }} /></View>
      <View style={{ flex: 1 }}><Field label="服务 API Token" id="communications-service-token" secret value={serviceToken ?? ''} placeholder={client.connection?.hasToken ? '已配置；留空不变' : '本机默认地址读取本地 Token'} onChange={value => { setServiceToken(value); setConnectionDirty(true); }} /></View></View>
    <Row><Button variant="primary" id="communications-service-save" disabled={saving || !connectionDirty} onPress={() => ignoreFailure(saveConnection())}>保存服务连接</Button><Button disabled={connectionDirty} onPress={() => ignoreFailure(client.checkConnection().then(value => setConnectionDetail(value.detail || '')))}>检测服务 API</Button>{connectionDetail ? <Label muted>{connectionDetail}</Label> : null}</Row>
    <Section title="独立服务部署" collapsible initiallyOpen={false}><Label muted>执行 project-communications serve 启动独立 Go 服务。默认监听 127.0.0.1:47191；远程连接使用服务 API 地址和 Token。</Label></Section>
    </>}
  </Section>;
  return <Dialog open={open} title={'项目沟通与需求 / 设置 / ' + page} id="communications-settings-dialog" onClose={onClose} width={1560} height={window.width >= 1400 ? 860 : 760}
    footer={<><View style={{ flex: 1, minWidth: 110 }}><Label muted>{page === '扩展管理' ? 'Workbench 仅提供服务接入界面' : changed ? '有未保存修改' : '已保存 · r' + revision}</Label></View>
      {page !== '扩展管理' && client.enabled ? <>{sidebar ? <Button variant="ghost" disabled={saving} onPress={reload}>重新载入配置</Button> : null}<Button disabled={saving} onPress={onClose}>取消</Button><Button variant="primary" id="communications-save-settings" disabled={!changed || saving} onPress={() => ignoreFailure(save())}>{saving ? '保存中…' : '保存配置'}</Button></>
        : <Button onPress={onClose}>关闭</Button>}</>}>
    <View style={{ flex: 1, minHeight: 0, flexDirection: sidebar ? 'row' : 'column' }}>
      <ScrollView horizontal={!sidebar} showsHorizontalScrollIndicator={false} style={sidebar ? { width: window.width >= 1400 ? 282 : 176, flexGrow: 0, backgroundColor: c.surface2, borderRightWidth: 1, borderRightColor: c.border } : { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: c.border }}
        contentContainerStyle={{ padding: sidebar ? 12 : 6, gap: 5 }}>
        {pages.map((item, index) => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: page === item }} onPress={() => setPage(item)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: touch ? 44 : 40, paddingHorizontal: 10, borderRadius: 5, backgroundColor: page === item ? tint(c.accent, '14') : undefined }}>
          {sidebar ? <Icon name={pageIcons[index]} size={16} color={page === item ? c.accent : c.foregroundMuted} /> : null}<Text style={{ fontSize: 12, color: page === item ? c.foreground : c.foregroundMuted, fontWeight: page === item ? '600' : '400' }}>{item}</Text>
        </Pressable>)}
      </ScrollView>
      <ScrollView testID="communications-settings-body" style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ padding: sidebar ? 22 : 16, paddingTop: 10, gap: 8 }} keyboardShouldPersistTaps="handled">
        {client.error ? <Label warning>{client.error}</Label> : null}
        {page === '扩展管理' ? <>
          <Section title="项目沟通与需求"><Card><Row><Icon name="Puzzle" size={22} color={c.accent} /><View style={{ flex: 1 }}><Label strong>项目沟通与需求</Label><Label muted>v0.1.0 · 按项目启用 · 各 Workspace 共用资料</Label></View><Badge tone={client.enabled ? 'success' : 'neutral'}>{client.enabled ? '已启用' : '默认停用'}</Badge></Row>
            <Label>收集已绑定项目群的完整讨论，整理待确认事项和需求台账。确认后可将所选上下文带入开发会话。</Label>
            <Row><Button variant={client.enabled ? 'secondary' : 'primary'} id="communications-enable" disabled={client.changing || saving || !client.enabled && connectionDirty} onPress={() => ignoreFailure(client.setEnabled(!client.enabled))}>{client.changing ? '正在切换…' : client.enabled ? '停用扩展' : '启用扩展'}</Button><Label muted>{connectionDirty && !client.enabled ? '请先保存服务连接。' : '停用仅断开界面，服务继续运行并保留资料。'}</Label></Row>
          </Card></Section>
          {serviceConnection}
        </> : !client.enabled ? <Card><Label>请先在“扩展管理”中启用此项目的扩展。</Label></Card> : !draft ? <Label>正在读取配置…</Label> : page === '模型与预算' ? <View testID="communications-model-columns" style={{ flexDirection: wide ? 'row' : 'column', gap: 24 }}>
          <View style={{ flex: wide ? 1 : undefined, minWidth: 0, gap: 4, paddingRight: wide ? 24 : 0, borderRightWidth: wide ? 1 : 0, borderRightColor: c.border }}>
            <Section title="模型连接">
              <Row><Badge tone={snapshot?.modelScope==='service'?'success':'neutral'}>{snapshot?.modelScope==='service'?'服务统一模型':'项目单独配置'}</Badge>
              <Button disabled={changed || saving} onPress={()=>ignoreFailure(client.call({action:'model.binding',scope:snapshot?.modelScope==='service'?'project':'service'}))}>{snapshot?.modelScope==='service'?'使用项目配置':'继承服务配置'}</Button></Row>
              <View style={{ flexDirection: wide ? 'row' : 'column', gap: 8, alignItems: wide ? 'center' : undefined }}><View style={wide ? { width: 100 } : undefined}><Label muted={!wide}>接口类型</Label></View><Card style={{ backgroundColor: c.surface1, padding: 8, flex: wide ? 1 : undefined }}><Label>Chat Completions 兼容</Label></Card></View>
              <Field inline={wide} label="服务地址" id="communications-model-url" value={draft.model.baseUrl} onChange={baseUrl => edit('model', { baseUrl })} />
              <Field inline={wide} label="模型" value={draft.model.model} placeholder="先检测列表，或输入模型 ID" onChange={model => edit('model', { model })} />
              {Array.isArray(models) && models.length ? <>
                <Button icon="ChevronDown" onPress={() => setModelPicker(value => !value)}>选择可用模型</Button>
                {modelPicker ? models.map(model => <Button key={model.id} active={draft.model.model === model.id} onPress={() => { edit('model', { model: model.id, ...(model.contextTokens ? { modelLimit: model.contextTokens } : {}) }); setModelPicker(false); }}>{model.id + (model.loaded === false ? ' · 未加载' : '') + (model.contextTokens ? ' · ' + Math.round(model.contextTokens / 1024) + 'K' : '')}</Button>) : null}
              </> : null}
              <Field inline={wide} label="API Key（可选）" value={modelKey ?? ''} secret placeholder={snapshot?.credentials.modelKey ? '已配置；留空不变' : '本地服务可留空'} onChange={value => { mark('model'); setModelKey(value); }} />
              {snapshot?.credentials.modelKey || modelKey !== undefined ? <Button variant="link" onPress={() => { mark('model'); setModelKey(''); }}>清除已保存的 API Key</Button> : null}
            </Section>
            <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 14, gap: 10 }}><Row><Button onPress={() => ignoreFailure(action('models.check'))}>检测模型列表</Button><Button disabled={!draft.model.model} onPress={() => ignoreFailure(action('generation.check'))}>测试实际生成</Button></Row>
              {modelStatus('models', '模型列表')}{modelStatus('generation', '生成测试')}
              <Field inline={wide} label="生成超时" value={String(draft.model.timeoutMs / 1000)} unit="秒" onChange={value => edit('model', { timeoutMs: Number(value) * 1000 })} />
              <Label muted>请求由独立服务发出，浏览器无需连接模型的局域网地址。</Label>
            </View>
          </View>
          <View style={{ flex: wide ? 1 : undefined, minWidth: 0, gap: 10 }}>
            <Section title="上下文与输出预算">
              <Card style={{ backgroundColor: tint(c.accent, '12') }}><Row><Icon name="Info" size={16} color={c.accent} /><View style={{ flex: 1 }}><Label>{'配置上限 ' + draft.model.modelLimit / 1024 + 'K tokens'}</Label></View></Row><Label muted>检测模型列表后可同步已报告的上限。</Label></Card>
              <Field inline={wide} label="单次总预算" id="communications-context-budget" value={String(draft.model.contextTokens / 1024)} unit="K tokens" onChange={value => edit('model', { contextTokens: Number(value) * 1024 })} />
              <Row>{[65536, 131072, 262144, 524288].map(value => <Button key={value} active={draft.model.contextTokens === value} onPress={() => edit('model', { contextTokens: value })}>{value / 1024 + 'K'}</Button>)}</Row>
              <BudgetSlider value={draft.model.contextTokens} max={draft.model.modelLimit} onChange={contextTokens => edit('model', { contextTokens })} />
              <Field inline={wide} label="输出预留" value={String(draft.model.outputTokens / 1024)} unit="K tokens" onChange={value => edit('model', { outputTokens: Number(value) * 1024 })} />
              <Card><Label strong>{'输入 ' + Math.max(0, draft.model.contextTokens - draft.model.outputTokens) / 1024 + 'K + 输出 ' + draft.model.outputTokens / 1024 + 'K = 总预算 ' + draft.model.contextTokens / 1024 + 'K'}</Label></Card>
              <Label muted>历史分批分析，按需补充关联上下文；超限时保留原始证据。</Label>
              {draft.model.contextTokens > draft.model.modelLimit ? <Label warning>总预算超过配置的模型上限，请调整后保存。</Label> : draft.model.outputTokens >= draft.model.contextTokens ? <Label warning>输出预留必须小于总预算。</Label> : null}
            </Section>
            <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 14, gap: 10 }}>
              <Field inline={wide} label="模型上限" value={String(draft.model.modelLimit / 1024)} unit="K tokens" onChange={value => edit('model', { modelLimit: Number(value) * 1024 })} />
              <Toggle label="图片分析" checked={draft.model.vision} onChange={vision => edit('model', { vision })} /><Label muted>Token 为保守估算；图片需模型支持视觉输入。</Label>
            </View>
          </View>
        </View> : page === '连接与来源' ? <>
          <View style={{ flexDirection: wide ? 'row' : 'column', gap: 24 }}><View style={{ flex: wide ? 1 : undefined, minWidth: 0 }}><Section title="钉钉 DWS · 账号授权">
            <Label muted>仅监控明确绑定且机器人已加入的群。普通消息无需 @；@ 对象只影响分析重点。</Label>
            <Row><Button active={draft.source.mode === 'custom'} onPress={() => edit('source', { mode: 'custom' })}>自建应用</Button><Button active={draft.source.mode === 'default'} onPress={() => edit('source', { mode: 'default' })}>默认应用</Button></Row>
            <Field inline={wide} label="DWS 可执行程序" id="communications-dws-path" value={draft.source.executable} onChange={executable => edit('source', { executable })} />
            <Button variant="link" icon="ExternalLink" onPress={() => ignoreFailure(Linking.openURL('https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/tag/v1.0.68'))}>DWS v1.0.68 安装指引</Button>
            {draft.source.mode === 'custom' ? <><Field inline={wide} label="Client ID / AppKey" value={draft.source.clientId} onChange={clientId => edit('source', { clientId })} />
              <Field inline={wide} label="App Secret" value={appSecret ?? ''} secret placeholder={snapshot?.credentials.appSecret ? '已配置；留空不变' : '仅保存到后端凭证库'} onChange={value => { mark(); setAppSecret(value); }} />
              {snapshot?.credentials.appSecret || appSecret !== undefined ? <Button variant="link" onPress={() => { mark(); setAppSecret(''); }}>清除已保存的 App Secret</Button> : null}</> : null}
            <Field inline={wide} label="授权 Profile" value={draft.source.profile} onChange={profile => edit('source', { profile })} />
            <Field inline={wide} label="机器人标识" value={draft.source.botId} onChange={botId => edit('source', { botId })} placeholder="OpenBotId / robotCode，用于核对入群" />
            <Row><Button onPress={() => ignoreFailure(action('connection.check'))}>检测连接与版本</Button><Button variant="primary" onPress={() => ignoreFailure(action('auth.start'))}>打开钉钉授权</Button></Row>
            {pendingAuth?.authUrl && ['running', 'waiting'].includes(pendingAuth.state) ? <Button variant="link" onPress={() => ignoreFailure(Linking.openURL(pendingAuth.authUrl!))}>前往钉钉官方授权页</Button> : null}
          </Section></View><View style={{ flex: wide ? 1 : undefined, minWidth: 0 }}><Section title="连接身份与能力">
            <Card><Label warning={!snapshot?.source.authenticated}>{snapshot?.source.detail || '待授权'}</Label><Label muted>{'版本 ' + (snapshot?.source.version || '未检测')}</Label>
              <Label muted>{'应用 ' + (snapshot?.source.identity?.clientId || (draft.source.mode === 'default' ? 'DWS 默认应用' : draft.source.clientId || '未配置'))}</Label><Label muted>{'组织 ' + (snapshot?.source.identity?.corpId || '待授权') + ' · 账号 ' + (snapshot?.source.identity?.userId || '待授权')}</Label></Card>
            <Card><CapabilityRow title="普通群消息" value={snapshot?.source.capabilities.messages} /><CapabilityRow title="遗漏消息补读" value={snapshot?.source.capabilities.history} /><CapabilityRow title="图片与文件" value={snapshot?.source.capabilities.attachments} /></Card>
            <Label muted>授权成功不等于全量采集验收通过。每个群还会单独核对机器人入群、订阅与补读能力。</Label><Label muted>凭证只由服务端保存，不写入项目设置或返回前端。此处不自动安装工具或申请组织权限。</Label>
          </Section></View></View>
          <Section title="绑定项目群" collapsible>
            <Row><View style={{ flex: 1 }}><Field label="搜索群名称" value={groupQuery} onChange={setGroupQuery} /></View><Button disabled={!groupQuery.trim() || !snapshot?.source.authenticated || changed} onPress={() => ignoreFailure(client.call<Array<{ id: string; name: string }>>({ action: 'groups.search', query: groupQuery.trim() }).then(setGroups))}>搜索可访问的群</Button></Row>
            {groups.map(group => <Row key={group.id}><View style={{ flex: 1 }}><Label>{group.name}</Label><Label muted>{group.id}</Label></View><Button onPress={() => ignoreFailure(client.call({ action: 'groups.bind', groupId: group.id, name: group.name }))}>绑定</Button></Row>)}
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 12 }}><View style={{ flex: 1 }}><Field label="或填写群 OpenConversationId" value={groupId} onChange={setGroupId} /></View><View style={{ flex: 1 }}><Field label="群显示名称" value={groupName} onChange={setGroupName} /></View></View>
            <Row><Button disabled={!groupId.trim() || !groupName.trim() || changed} onPress={() => ignoreFailure(client.call({ action: 'groups.bind', groupId: groupId.trim(), name: groupName.trim() }).then(() => { setGroupId(''); setGroupName(''); }))}>绑定指定群</Button><Label muted>首次绑定从当前时刻开始。</Label></Row>
            {snapshot?.groups.map(group => <Card key={group.id}><Row><View style={{ flex: 1 }}><Label strong>{group.name}</Label></View><Badge tone={group.enabled ? 'info' : 'neutral'}>{group.enabled ? '监控已开启' : '已暂停'}</Badge></Row>
              <Label muted>{group.id}</Label><Label muted>{'起点 ' + dateText(group.boundAt) + ' · 成功断点 ' + dateText(group.checkpoint)}</Label>
              <CapabilityRow title="机器人已在群内" value={group.membership} /><CapabilityRow title="普通消息订阅" value={group.stream} /><CapabilityRow title="遗漏补读" value={group.history} />
              {group.error ? <Label warning>{group.error}</Label> : null}<Row><Button onPress={() => ignoreFailure(client.call({ action: group.enabled ? 'groups.pause' : 'groups.resume', groupId: group.id }))}>{group.enabled ? '暂停监控' : '继续监控'}</Button><Button disabled={!group.enabled} onPress={() => ignoreFailure(client.call({ action: 'sync.start', groupId: group.id }))}>补读遗漏</Button></Row>
            </Card>)}
            <Label muted>机器人不在群内或成员状态无法核实时暂停新增采集；再次绑定会重设起点。不要求机器人入群前的历史。</Label>
          </Section>{serviceConnection}
        </> : <>
          <View style={{ paddingVertical: 12 }}><Row><Toggle label="自动分析" checked={draft.analysis.enabled} onChange={enabled => edit('analysis', { enabled })} /><Label muted>暂停分析仍会保存消息；模型恢复后可以继续。</Label></Row></View>
          <View style={{ gap: 14 }}><View><Field inline={wide} minHeight={64} label="关注对象 ID" placeholder="每行一个成员 ID" multiline value={draft.analysis.focusPeople.join('\n')} onChange={value => edit('analysis', { focusPeople: value.split('\n').filter(Boolean) })} /></View>
            <View><Field inline={wide} minHeight={64} label="关注关键词" placeholder="每行一个词语或短语" multiline value={draft.analysis.keywords.join('\n')} onChange={value => edit('analysis', { keywords: value.split('\n').filter(Boolean) })} /></View></View>
          <Label muted>关注条件影响分析重点，仍保留绑定群的完整讨论。</Label>
          <Section title="识别内容"><Row>{(Object.entries(categoryLabels) as Array<[Category, string]>).map(([category, label]) => <Button key={category} icon={draft.analysis.categories.includes(category) ? 'Check' : undefined} active={draft.analysis.categories.includes(category)} onPress={() => edit('analysis', { categories: draft.analysis.categories.includes(category) ? draft.analysis.categories.filter(item => item !== category) : [...draft.analysis.categories, category] })}>{label}</Button>)}</Row></Section>
          <Field label="项目分析说明" multiline value={draft.analysis.instructions} onChange={instructions => edit('analysis', { instructions })} />
          <Section title="处理节奏"><View style={{ flexDirection: wide ? 'row' : 'column', gap: 18 }}><View style={{ flex: 1 }}><Field inline={wide} label="新消息合批" unit="秒" value={String(draft.analysis.coalesceSeconds)} onChange={value => edit('analysis', { coalesceSeconds: Number(value) })} /></View><View style={{ flex: 1 }}><Field inline={wide} label="遗漏增量核对" unit="秒" value={String(draft.analysis.reconcileSeconds)} onChange={value => edit('analysis', { reconcileSeconds: Number(value) })} /></View></View>
            <Row><Button variant="link" onPress={() => ignoreFailure(client.call({ action: 'analysis.retry' }))}>恢复待处理分析</Button></Row></Section>
        </>}
        {page !== '扩展管理' && client.enabled ? <>{!sidebar ? <Button variant="link" disabled={saving} onPress={reload}>重新载入配置</Button> : null}{validation ? <Card style={{ backgroundColor: tint(c.statusWarning, '10') }}><Label warning>{validation}</Label></Card> : null}
          {tasks.filter(task => page === '模型与预算' ? ['models', 'generation'].includes(task.kind) : page === '连接与来源' ? ['auth', 'connection'].includes(task.kind) : false).map(task => task.error || task.detail ? <Label key={task.id} warning={task.state === 'failed'} muted={task.state !== 'failed'}>{taskText[task.kind] + '：' + taskText[task.state] + (task.error ? ' · ' + task.error : '') + (task.detail ? ' · ' + task.detail : '')}</Label> : null)}
        </> : null}
      </ScrollView>
    </View>
  </Dialog>;
}
