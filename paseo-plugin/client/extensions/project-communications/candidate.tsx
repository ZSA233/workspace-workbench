import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Icon, ScrollView } from '../../native-components';
import type { CommunicationsClient } from '../../use-communications';
import { categoryLabels, type Candidate, type Requirement } from '../../../shared/extensions/project-communications/shared';
import { Badge, Button, Card, Dialog, Field, Footer, Label, Row, Section, dateText, ignoreFailure, tint, useColors } from './ui';
import { Evidence } from './readers';

type Preview = { previous?: Requirement; expectedVersion: number; next: { title: string; body: string; version: number } };
export function CandidateReader({ candidate, client, onContext }: {
  candidate: Candidate; client: CommunicationsClient; onContext: (ids: string[], groupId: string) => void;
}) {
  const c = useColors();
  const [title, setTitle] = useState(candidate.title), [body, setBody] = useState(candidate.body), [related, setRelated] = useState(candidate.relatedRequirementId || '');
  const [editing, setEditing] = useState(false), [choosing, setChoosing] = useState(false), [note, setNote] = useState('');
  const [preview, setPreview] = useState<Preview>(), [busy, setBusy] = useState(false);
  const revision = candidate.revision, proposalBody = body + (note.trim() ? '\n\n核实说明：' + note.trim() : '');
  const requirement = client.snapshot?.requirements.find(item => item.id === related);
  const groupName = client.snapshot?.groups.find(item => item.id === candidate.groupId)?.name || candidate.groupId;
  const pending = candidate.status === 'pending' || candidate.status === 'snoozed';
  useEffect(() => { ignoreFailure(client.call({ action: 'candidate.read', id: candidate.id })); }, [client.call, candidate.id]);
  const inspect = async () => {
    setBusy(true);
    try { setPreview(await client.call<Preview>({ action: 'candidate.preview', id: candidate.id, revision, title, body: proposalBody, ...(related ? { relatedRequirementId: related } : {}) })); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await client.call({ action: 'candidate.accept', id: candidate.id, revision, title, body: proposalBody, expectedVersion: preview.expectedVersion, ...(related ? { relatedRequirementId: related } : {}) });
      setPreview(undefined);
    } finally { setBusy(false); }
  };
  return <View style={{ flex: 1, minHeight: 0 }}>
    <ScrollView testID="communications-candidate-reader" style={{ flex: 1 }} contentContainerStyle={{ padding: 18, paddingTop: 16, paddingBottom: 24 }}>
      <View style={{ gap: 8, marginBottom: 6 }}><Row><Label large>{title}</Label><Badge tone={pending ? 'info' : 'neutral'}>{pending ? '待确认' : candidate.status === 'accepted' ? '已确认入账' : '已忽略'}</Badge></Row>
        <Label muted>{categoryLabels[candidate.category]} · {groupName} · {dateText(candidate.createdAt)}</Label>
      </View>
      <Section title="AI 整理" collapsible action={pending ? <Button variant="link" id="communications-candidate-edit" onPress={() => setEditing(value => !value)}>{editing ? '完成编辑' : '编辑整理结果'}</Button> : undefined}>
        {editing && pending ? <View style={{ gap: 10 }}>
          <Field label="候选标题" id="communications-candidate-title" value={title} onChange={setTitle} />
          <Field label="候选内容" id="communications-candidate-body" value={body} multiline onChange={setBody} />
        </View> : <Card><Label>{body}</Label></Card>}
      </Section>
      {pending || related ? <Section title="关联需求" collapsible action={pending ? <Button variant="link" onPress={() => setChoosing(value => !value)}>{choosing ? '收起选择' : '更换关联'}</Button> : undefined}>
        <Card style={{ backgroundColor: c.surface1 }}><Row><Icon name="FileText" size={17} color={c.foregroundMuted} /><View style={{ flex: 1 }}><Label>{requirement ? 'REQ-' + String(requirement.number).padStart(3, '0') + ' · ' + requirement.title : related ? '已关联需求 · ' + related : '新建需求台账记录'}</Label></View>{requirement ? <Badge>v{requirement.version}</Badge> : null}</Row></Card>
        {choosing ? <View style={{ gap: 6 }}>
          <Label muted>关联已有需求会生成新版本，保留原版本与来源。</Label>
          <Button active={!related} onPress={() => { setRelated(''); setChoosing(false); }}>新建需求</Button>
          {client.snapshot?.requirements.map(item => <Button key={item.id} active={related === item.id} onPress={() => { setRelated(item.id); setChoosing(false); }}>
            {'REQ-' + String(item.number).padStart(3, '0') + ' · ' + item.title + ' · v' + item.version}
          </Button>)}
        </View> : null}
      </Section> : null}
      <Section title={'原始讨论 · ' + groupName} collapsible action={<Button variant="link" onPress={() => onContext(candidate.evidenceIds, candidate.groupId)}>查看上下文</Button>}>
        <Evidence client={client} ids={candidate.evidenceIds} />
      </Section>
      {candidate.uncertainty ? <Section title="待核实" collapsible>
        <Card style={{ backgroundColor: tint(c.statusWarning, '0c') }}><Label>{candidate.uncertainty}</Label>
          {pending ? <Field label="核实说明（可选，将带入修订）" value={note} onChange={setNote} placeholder="请输入核实结论或补充说明…" /> : null}
        </Card>
      </Section> : null}
    </ScrollView>
    {pending ? <Footer>
      <Button variant="ghost" disabled={busy} onPress={() => ignoreFailure(client.call({ action: 'candidate.ignore', id: candidate.id }))}>忽略</Button>
      <Button disabled={busy} onPress={() => ignoreFailure(client.call({ action: 'candidate.snooze', id: candidate.id }))}>稍后处理</Button>
      <Button variant="primary" id="communications-candidate-preview" disabled={busy || !title.trim() || !body.trim()} onPress={() => ignoreFailure(inspect())}>{busy ? '处理中…' : '预览修订'}</Button>
    </Footer> : <Footer><Label muted>{candidate.status === 'accepted' ? '已保存至需求台账，原始依据和历史版本保留。' : '此事项已忽略，原始消息仍然保留。'}</Label></Footer>}
    {preview ? <Dialog title={preview.previous ? '确认需求变更' : '确认新增需求'} id="communications-revision-preview" onClose={() => { if (!busy) setPreview(undefined); }} width={760} height={740}
      footer={<><Button disabled={busy} onPress={() => setPreview(undefined)}>返回编辑</Button><Button variant="primary" id="communications-candidate-confirm" disabled={busy} onPress={() => ignoreFailure(accept())}>{busy ? '确认中…' : '确认并更新台账'}</Button></>}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 4 }}>
        {client.error ? <Label warning>{client.error}</Label> : null}
        <Card style={{ backgroundColor: c.surface1 }}><Row><Icon name="FileText" size={17} color={c.foregroundMuted} /><View style={{ flex: 1 }}><Label strong>{preview.previous ? 'REQ-' + String(preview.previous.number).padStart(3, '0') + ' · ' + preview.previous.title : title}</Label></View>
          {preview.previous ? <><Badge>v{preview.previous.version}</Badge><Icon name="ArrowRight" size={15} color={c.foregroundMuted} /></> : null}<Badge tone="info">v{preview.next.version}</Badge>
        </Row></Card>
        <Section title="变更预览" collapsible>
          <View style={{ borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
            {preview.previous ? <View style={{ padding: 12, gap: 6, backgroundColor: tint(c.statusDanger, '16') }}><Label muted>{'当前版本 v' + preview.previous.version}</Label><Row><Icon name="Minus" size={16} color={c.statusDanger} /><View style={{ flex: 1, gap: 4 }}><Label strong>{preview.previous.title}</Label><Label>{preview.previous.body}</Label></View></Row></View> : null}
            <View style={{ padding: 12, gap: 6, backgroundColor: tint(c.statusSuccess, '16') }}><Label muted>{'确认后 v' + preview.next.version}</Label><Row><Icon name="Plus" size={16} color={c.statusSuccess} /><View style={{ flex: 1, gap: 4 }}><Label strong>{preview.next.title}</Label><Label>{preview.next.body}</Label></View></Row></View>
          </View>
        </Section>
        <Section title="保留的依据" collapsible initiallyOpen={false}><Evidence ids={candidate.evidenceIds} client={client} /></Section>
        <Card><Row><Icon name="Info" size={15} color={c.foregroundMuted} /><View style={{ flex: 1 }}><Label muted>{candidate.evidenceIds.length + ' 条原始消息及其附件保留。确认后生成需求修订，随后可选择带入开发会话。'}</Label></View></Row></Card>
      </ScrollView>
    </Dialog> : null}
  </View>;
}
