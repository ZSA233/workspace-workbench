import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkbenchExtensions } from '../server/extensions.ts';
import { CommunicationsConnection } from '../server/communications-connection.ts';
import { ArchiveTopics } from '../server/archive-topics.ts';
import { TopicMaterials } from '../server/topic-materials.ts';
import { withProject } from '../server/projects.ts';
import { putAgentBinding } from '../server/agent-store.ts';
import { readStoredArtifact } from '../server/artifacts.ts';
import { topicActionSchema, type ArchiveTopicDetail, type TopicMaterialPreview, type TopicSelection, type TopicTarget } from '../shared/extensions/project-communications/topics.ts';
import type { AgentContext } from '../server/agent-provider.ts';
import { startArchiveFixture } from './helpers/archive-service.ts';

async function setup() {
  const fixture = await startArchiveFixture(), root = mkdtempSync(join(tmpdir(), 'wb-archive-topics-'));
  const previous = { home: process.env.PASEO_HOME, registry: process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY };
  const config = join(root, 'project.json'), registry = join(root, 'registry.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, sourceRoot: root, stateRoot: join(root, 'state'), project: { id: 'test' } }));
  writeFileSync(registry, JSON.stringify({ configs: [config] }));
  process.env.PASEO_HOME = join(root, 'paseo'); process.env.WORKSPACE_WORKBENCH_PROJECT_REGISTRY = registry;
  const host = new WorkbenchExtensions();
  await host.connection(config, 'project-communications', 'configure', { revision: 1,
    connection: { endpoint: fixture.url, projectId: 'legacy-project', libraryId: 'default', watchedGroups: [{ sourceId: 'dingtalk:fixture', channelId: 'feedback' }] }, token: fixture.token });
  await host.setEnabled(config, 'project-communications', true);
  const connection = new CommunicationsConnection({ endpoint: fixture.url, projectId: 'legacy-project', watchedGroups: [{ sourceId: 'dingtalk:fixture', channelId: 'feedback' }] }, () => fixture.token);
  const archive = new ArchiveTopics(connection);
  withProject({ projectConfig: config }, () => putAgentBinding({ workspaceId: 'workspace', agentId: 'agent-a', relationship: 'independent',
    paseoWorkspaceId: 'host-workspace', cwd: root, provider: 'fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  return { ...fixture, root, config, host, archive, connection,
    call: (request: Parameters<WorkbenchExtensions['topics']>[3], revision = 2) => host.topics(config, 'project-communications', revision, request),
    inProject: <T>(run: () => T) => withProject({ projectConfig: config }, run),
    close: async () => {
      connection.close(); await host.close(); await fixture.close();
      for (const [key, value] of Object.entries({ PASEO_HOME: previous.home, WORKSPACE_WORKBENCH_PROJECT_REGISTRY: previous.registry })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function selection(topic: ArchiveTopicDetail): TopicSelection {
  return { topicId: topic.id, revision: topic.revision, inputRevision: topic.inputRevision,
    messages: [{ id: topic.messages[0].id, version: topic.messages[0].version }], assets: [], includeAnalysis: false };
}

function nativeSession(root: string) {
  const agent = { id: 'native-codex', cwd: root, workspaceId: 'native-host-workspace', title: '现有反馈分析会话', provider: 'codex',
    status: 'idle', archivedAt: null as string | null, labels: {}, currentModeId: 'full-access', features: [{ id: 'plan_mode', type: 'toggle', value: true }] };
  const state = { uncertain: false, sent: [] as Array<{ text: string; options: { messageId: string; images: Array<{ data: string; mimeType: string }>; attachments?: Array<{ type: string; fileName: string; mimeType: string; size: number; path: string }> } }> };
  const context = { paseo: { agents: {
    list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
    ref: (id: string) => ({ refresh: async () => ({ agent: id === agent.id ? agent : null }),
      send: async (text: string, options: typeof state.sent[number]['options']) => { assert.equal(id, agent.id); state.sent.push({ text, options }); if (state.uncertain) throw Error('connection lost after dispatch'); },
      timeline: { refetch: async () => ({ entries: state.sent.map(item => ({ item: { type: 'user_message', messageId: item.options.messageId } })) }) },
    }),
  } } } as unknown as AgentContext;
  return { agent, state, context };
}

test('archive activation never registers a collection project and directory strips credentials and history', async () => {
  const s = await setup();
  try {
    const directory = await s.call({ action: 'directory' }) as Record<string, unknown>;
    assert.equal('settings' in directory, false); assert.equal('runs' in directory, false);
    assert.equal(JSON.stringify(directory).includes('private-fixture'), false);
    assert.equal(JSON.stringify(directory).includes('credentialRef'), false);
    assert.equal(s.state.requests.some(request => request.url.startsWith('/v1/projects')), false);
    assert.ok(s.state.requests.filter(request => request.url.startsWith('/v2/archive/snapshot')).every(request => request.url.includes('part=directory')));
    assert.equal((await s.archive.list({ query: '', limit: 30 })).items.length, 2);
    assert.equal((await s.archive.directory()).channels[0].channelId, 'feedback');
  } finally { await s.close(); }
});
test('followed-group filtering keeps pagination and denies unbound topics and arbitrary context', async () => {
  const s = await setup();
  try {
    const noGroups = new ArchiveTopics(new CommunicationsConnection({ endpoint: s.url, projectId: 'x' }, () => s.token));
    assert.deepEqual(await noGroups.list({ query: '', limit: 30 }), { items: [], hasMore: false });
    s.state.topics[0].channelId = 'unfollowed'; s.state.topics[1].channelId = 'unfollowed';
    const first = await s.archive.list({ query: '', limit: 30 });
    assert.deepEqual(first.items, []); assert.equal(first.hasMore, true); assert.ok(first.next);
    const next = await s.archive.list({ query: '', limit: 30, ...first.next });
    assert.equal(next.items.length, 2);
    await assert.rejects(s.archive.read('topic-1'), /outside_project_scope/);
    const topic = await s.archive.read('topic-3');
    await assert.rejects(s.archive.message(topic, 'message-1'), /not_associated/);
    s.state.context.channelId = 'unfollowed';
    await assert.rejects(s.archive.message(topic, s.state.context.id, topic.messages[0].id), /context_outside_scope/);
    noGroups.connection.close();
  } finally { await s.close(); }
});
test('only chosen originals are frozen; repeated previews reuse verified image bytes', async () => {
  const s = await setup();
  try {
    const topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.assets = [{ id: 'image-1', messageId: 'message-1', messageVersion: 'version-message-1' }];
    const preview = await s.call({ action: 'preview', workspaceId: 'workspace', selections: [selected] }) as TopicMaterialPreview;
    assert.ok(preview.text.includes(topic.messages[0].text));
    assert.equal(preview.text.includes(topic.messages[1].text), false);
    assert.equal(preview.text.includes('派生分析'), false);
    assert.equal(preview.assets[0].sha256, s.imageHash);
    assert.equal(preview.assets.length, 1);
    const next = await s.call({ action: 'preview', workspaceId: 'workspace', selections: [selected] }) as TopicMaterialPreview;
    assert.notEqual(preview.id, next.id);
    const key = JSON.stringify(['default', 'image-1']), id = 'topic-' + createHash('sha256').update(key + ':' + s.imageHash).digest('hex');
    s.inProject(() => assert.deepEqual(readStoredArtifact(id).bytes, s.image));
  } finally { await s.close(); }
});
test('source revisions, asset membership and changing connections are checked at the boundary', async () => {
  const s = await setup();
  try {
    const topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.messages[0].version = 'stale';
    await assert.rejects(s.call({ action: 'preview', workspaceId: 'workspace', selections: [selected] }), /message_version_changed/);
    selected.messages[0].version = topic.messages[0].version;
    selected.assets = [{ id: 'image-3', messageId: 'message-1', messageVersion: topic.messages[0].version }];
    await assert.rejects(s.call({ action: 'preview', workspaceId: 'workspace', selections: [selected] }), /asset_not_ready/);
    selected.assets = [];
    const preview = await s.call({ action: 'preview', workspaceId: 'workspace', selections: [selected] }) as TopicMaterialPreview;
    await s.host.connection(s.config, 'project-communications', 'configure', { revision: 2, connection: { endpoint: s.url, projectId: 'x', libraryId: 'another' } });
    await assert.rejects(s.call({ action: 'read', topicId: topic.id }), /project_connection_changed/);
    await assert.rejects(s.host.topics(s.config,'project-communications',3,{ action: 'receipt', id: preview.id },{} as never), /scope_changed/);
  } finally { await s.close(); }
});
test('a topic correction during image retrieval rejects a mixed snapshot', async () => {
  const s = await setup();
  try {
    const topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.assets = [{ id: 'image-1', messageId: 'message-1', messageVersion: topic.messages[0].version }];
    const original = s.archive.original.bind(s.archive);
    s.archive.original = async asset => { const data = await original(asset); s.state.topics[0].inputRevision++; return data; };
    await assert.rejects(s.inProject(() => new TopicMaterials(join(s.root, 'state'), 'scope').preview(s.archive, 'workspace', 'agent-a', [selected])), /material_version_changed/);
  } finally { await s.close(); }
});
test('uncertain delivery is never replayed across restart or concurrent calls; only receipts advance it', async () => {
  const s = await setup();
  try {
    const materials = new TopicMaterials(join(s.root, 'state'), 'scope'), topic = await s.archive.read('topic-1');
    const preview = await s.inProject(() => materials.preview(s.archive, 'workspace', 'agent-a', [selection(topic)]));
    let calls = 0;
    await Promise.all([materials.send(preview.id, 'agent-a', async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { delivery: 'uncertain' }; }),
      materials.send(preview.id, 'agent-a', async () => { calls++; return { delivery: 'accepted' }; })]);
    const restarted = new TopicMaterials(join(s.root, 'state'), 'scope');
    await restarted.send(preview.id, 'agent-a', async () => { calls++; return { delivery: 'accepted' }; });
    assert.equal(calls, 1);
    assert.equal((await restarted.receipt(preview.id, 'agent-a', async () => ({ delivery: 'accepted', messageId: 'receipt' }))).state, 'accepted');
    await assert.rejects(restarted.send(preview.id, 'agent-b', async () => ({ delivery: 'accepted' })), /target_changed/);
  } finally { await s.close(); }
});
test('long original text is preserved as a required document instead of truncated', async () => {
  const s = await setup();
  try {
    s.state.topics[0].messages[0].text = '原始讨论。'.repeat(8000);
    const materials = new TopicMaterials(join(s.root, 'state'), 'scope'), topic = await s.archive.read('topic-1');
    const preview = await s.inProject(() => materials.preview(s.archive, 'workspace', 'agent-a', [selection(topic)]));
    const record = materials.read(preview.id);
    assert.ok(preview.text.includes(topic.messages[0].text));
    assert.ok((record.dispatchText?.length || 0) < 32768);
    assert.equal(record.references[0].required, true);
    s.inProject(() => assert.equal(readStoredArtifact(record.references[0].assetId!).bytes.toString('utf8'), preview.text));
  } finally { await s.close(); }
});
test('tool-only updates preserve collection/reply policy and only explicit collect disables reply', async () => {
  const s = await setup();
  try {
    s.state.groups[0].discoveryAction = 'investigate'; s.state.groups[0].replyMode = 'restrained';
    const request = { action: 'group.configure' as const, sourceId: 'dingtalk:fixture', channelId: 'feedback', revision: 1, allowedTools: ['code.search'], requestId: 'tools' };
    await s.call(request);
    assert.equal(s.state.groups[0].discoveryAction, 'investigate'); assert.equal(s.state.groups[0].replyMode, 'restrained');
    assert.deepEqual(s.state.groups[0].customHistory, { retain: true });
    await s.call({ ...request, revision: 2, requestId: 'collect', collect: true });
    assert.equal(s.state.groups[0].enabled, false); assert.equal(s.state.groups[0].discoveryAction, 'collect'); assert.equal(s.state.groups[0].replyMode, 'off');
    await assert.rejects(s.call({ ...request, requestId: 'stale', collect: true }), /revision_conflict/);
  } finally { await s.close(); }
});
test('bounded transport and input contract reject oversized or unrelated actions', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.connection.bytes('/v2/archive/libraries/default/assets/image-1', 'GET', undefined, 1), /response_too_large/);
    assert.equal(topicActionSchema.safeParse({ action: 'auth.start' }).success, false);
    assert.equal(topicActionSchema.safeParse({ action: 'read', topicId: '..' }).success, false);
    assert.equal(topicActionSchema.safeParse({ action: 'preview', workspaceId: 'workspace', selections: [] }).success, false);
  } finally { await s.close(); }
});

test('a confirmed receipt cannot be downgraded by a late uncertain send result', async () => {
  const s = await setup();
  try {
    const materials = new TopicMaterials(join(s.root, 'state'), 'scope'), topic = await s.archive.read('topic-1');
    const preview = await s.inProject(() => materials.preview(s.archive, 'workspace', 'agent-a', [selection(topic)]));
    let finish!: () => void;
    const sending = materials.send(preview.id, 'agent-a', async () => {
      await new Promise<void>(resolve => { finish = resolve; }); return {delivery:'uncertain'};
    });
    await materials.receipt(preview.id, 'agent-a', async () => ({delivery:'accepted',messageId:'receipt'}));
    finish();
    assert.equal((await sending).state, 'accepted');
    assert.equal(materials.read(preview.id).messageId, 'receipt');
  } finally { await s.close(); }
});

test('structured service analysis is normalized but is never needed to read originals', async () => {
  const s = await setup();
  try {
    (s.state.topics[0] as unknown as {lastAnswer:unknown}).lastAnswer = {answer:'Derived answer',privateAudit:{payload:'not-for-the-ui'}};
    const topic = await s.archive.read('topic-1');
    assert.equal(topic.lastAnswer, 'Derived answer');
    assert.equal(JSON.stringify(topic).includes('privateAudit'), false);
    const preview = await s.call({action:'preview',workspaceId:'workspace',selections:[selection(topic)]}) as TopicMaterialPreview;
    assert.equal(preview.text.includes('Derived answer'), false);
  } finally { await s.close(); }
});

test('topic originals reach the bound host session with image bytes and preserve host mode', async () => {
  const s = await setup();
  try {
    const topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.assets = [{id:'image-1',messageId:'message-1',messageVersion:topic.messages[0].version}];
    const preview = await s.call({action:'preview',workspaceId:'workspace',selections:[selected]}) as TopicMaterialPreview;
    const sent: Array<{text:string;options:any}> = [];
    const worker = {id:'agent-a',cwd:s.root,workspaceId:'host-workspace',status:'idle',currentModeId:'plan',
      features:[{id:'plan_mode',type:'toggle',value:true}],pendingPermissions:[]};
    const context = {paseo:{agents:{ref:()=>({
      refresh:async()=>({agent:worker}),
      send:async(text:string,options:any)=>{sent.push({text,options});},
    })}}} as unknown as import('../server/agent-provider.ts').AgentContext;
    const result = await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},context) as TopicMaterialPreview;
    assert.equal(result.state,'accepted');
    assert.equal(result.readConfirmed,false);
    assert.equal(sent.length,1);
    assert.ok(sent[0].text.includes(topic.messages[0].text));
    assert.equal(sent[0].text.includes(topic.messages[1].text),false);
    assert.deepEqual(Buffer.from(sent[0].options.images[0].data,'base64'),s.image);
    assert.equal(sent[0].options.activeTurnBehavior,'steer');
    assert.equal(worker.currentModeId,'plan');
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},context);
    assert.equal(sent.length,1);
  } finally { await s.close(); }
});

test('an older selected original is verified without pulling unrelated message pages', async () => {
  const s = await setup();
  try {
    const topic = await s.archive.read('topic-1');
    topic.messages = topic.messages.slice(0,1); topic.hasMoreMessages = true;
    const original = await s.archive.member(topic,'message-2');
    assert.equal(original.text,s.state.topics[0].messages[1].text);
    assert.equal(s.state.requests.some(request=>request.url.includes('/messages?offset=')),false);
    assert.ok(s.state.requests.some(request=>request.url.includes('messageId=message-2')));
  } finally { await s.close(); }
});

test('ordinary project sessions receive original image bytes without creating a binding or resetting host mode', async () => {
  const s = await setup();
  try {
    const native = nativeSession(s.root);
    const targets = await s.host.topics(s.config, 'project-communications', 2, { action: 'targets' }, native.context) as TopicTarget[];
    const target = targets.find(item => item.kind === 'session')!;
    assert.equal(target.title, '现有反馈分析会话');
    const topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.assets = [{ id: 'image-1', messageId: 'message-1', messageVersion: topic.messages[0].version }];
    const preview = await s.host.topics(s.config, 'project-communications', 2, { action: 'preview', targetId: target.id, selections: [selected] }, native.context) as TopicMaterialPreview;
    assert.equal(preview.targetId, target.id);
    native.agent.features[0].value = false;
    const sent = await s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, native.context) as TopicMaterialPreview;
    assert.equal(sent.state, 'accepted'); assert.equal(sent.readConfirmed, false);
    assert.equal(native.state.sent.length, 1);
    assert.deepEqual(Buffer.from(native.state.sent[0].options.images[0].data, 'base64'), s.image);
    assert.equal(native.agent.features[0].value, false); assert.equal(native.agent.currentModeId, 'full-access');
    await s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, native.context);
    assert.equal(native.state.sent.length, 1);
  } finally { await s.close(); }
});

test('an uncertain ordinary-session send checks the same receipt and never dispatches twice', async () => {
  const s = await setup();
  try {
    const native = nativeSession(s.root); native.state.uncertain = true;
    const topic = await s.archive.read('topic-1');
    const preview = await s.host.topics(s.config, 'project-communications', 2,
      { action: 'preview', targetId: 'session:' + native.agent.id, selections: [selection(topic)] }, native.context) as TopicMaterialPreview;
    const send = () => s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, native.context) as Promise<TopicMaterialPreview>;
    assert.equal((await send()).state, 'uncertain');
    assert.equal((await send()).state, 'uncertain'); assert.equal(native.state.sent.length, 1);
    const receipt = await s.host.topics(s.config, 'project-communications', 2, { action: 'receipt', id: preview.id }, native.context) as TopicMaterialPreview;
    assert.equal(receipt.state, 'accepted'); assert.equal((await send()).state, 'accepted'); assert.equal(native.state.sent.length, 1);
  } finally { await s.close(); }
});

test('ordinary sessions receive registered non-image originals as host file attachments', async () => {
  const s = await setup();
  try {
    s.state.topics[0].messages[0].assets.push({ id: 'pdf-original', name: '反馈原件.pdf', kind: 'file', mimeType: 'application/pdf', state: 'ready' });
    const native = nativeSession(s.root), topic = await s.archive.read('topic-1'), selected = selection(topic);
    selected.assets = [{ id: 'pdf-original', messageId: 'message-1', messageVersion: topic.messages[0].version }];
    const preview = await s.host.topics(s.config, 'project-communications', 2,
      { action: 'preview', targetId: 'session:' + native.agent.id, selections: [selected] }, native.context) as TopicMaterialPreview;
    const sent = await s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, native.context) as TopicMaterialPreview;
    assert.equal(sent.state, 'accepted');
    const [file] = native.state.sent[0].options.attachments!;
    assert.equal(file.type, 'uploaded_file'); assert.equal(file.fileName, '反馈原件.pdf');
    assert.equal(file.mimeType, 'application/pdf'); assert.equal(file.size, s.pdf.length);
    assert.deepEqual(readFileSync(file.path), s.pdf);
    assert.equal(native.state.sent[0].options.images.length, 0);
  } finally { await s.close(); }
});

test('sessions outside the project are unavailable and a moved target is rejected before claiming a preview', async () => {
  const s = await setup();
  try {
    const native = nativeSession(s.root), topic = await s.archive.read('topic-1');
    const preview = await s.host.topics(s.config, 'project-communications', 2,
      { action: 'preview', targetId: 'session:' + native.agent.id, selections: [selection(topic)] }, native.context) as TopicMaterialPreview;
    native.agent.cwd = tmpdir();
    const targets = await s.host.topics(s.config, 'project-communications', 2, { action: 'targets' }, native.context) as TopicTarget[];
    assert.equal(targets.some(item => item.agentId === native.agent.id), false);
    await assert.rejects(s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, native.context), /topic_target_changed/);
    const stored = JSON.parse(readFileSync(join(s.root, 'state/extensions/topic-materials', createHash('sha256').update(preview.id).digest('hex') + '.json'), 'utf8'));
    assert.equal(stored.state, 'preview'); assert.equal(native.state.sent.length, 0);
    await assert.rejects(s.host.topics(s.config, 'project-communications', 2,
      { action: 'preview', targetId: 'session:' + native.agent.id, selections: [selection(topic)] }, native.context), /topic_target_unavailable/);
  } finally { await s.close(); }
});

test('frozen display materials omit transport placeholders while retaining the exact selected source text privately', async () => {
  const s = await setup();
  try {
    s.state.topics[0].title = '[图片消息](mediaId=$truncated';
    s.state.topics[0].question = '登录页俄语翻译缺失';
    s.state.topics[0].messages[0].text = '[图片消息](mediaId=$original)登录页的标题仍是中文';
    s.state.topics[0].messages[0].displayText = '登录页的标题仍是中文';
    const topic = await s.archive.read('topic-1');
    const preview = await s.call({ action: 'preview', workspaceId: 'workspace', selections: [selection(topic)] }) as TopicMaterialPreview;
    assert.equal(preview.topics[0].title, '登录页俄语翻译缺失');
    assert.ok(preview.text.includes('登录页的标题仍是中文')); assert.equal(preview.text.includes('mediaId='), false);
    assert.equal('originalTexts' in preview, false);
    const stored = JSON.parse(readFileSync(join(s.root, 'state/extensions/topic-materials', createHash('sha256').update(preview.id).digest('hex') + '.json'), 'utf8'));
    assert.equal(stored.originalTexts[0].text, s.state.topics[0].messages[0].text);
  } finally { await s.close(); }
});

test('a changed Workbench binding cannot be bypassed by treating its worker as an ordinary session', async () => {
  const s = await setup();
  try {
    const native = nativeSession(s.root); native.agent.id = 'agent-a';
    const targets = await s.host.topics(s.config, 'project-communications', 2, { action: 'targets' }, native.context) as TopicTarget[];
    assert.equal(targets.some(target => target.agentId === 'agent-a'), false);
    const topic = await s.archive.read('topic-1');
    await assert.rejects(s.host.topics(s.config, 'project-communications', 2,
      { action: 'preview', targetId: 'session:agent-a', selections: [selection(topic)] }, native.context), /topic_target_unavailable/);
    assert.equal(native.state.sent.length, 0);
  } finally { await s.close(); }
});
