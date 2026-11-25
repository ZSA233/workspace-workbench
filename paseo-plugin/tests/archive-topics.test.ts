import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkbenchExtensions } from '../server/extensions.ts';
import { CommunicationsConnection } from '../server/communications-connection.ts';
import { ArchiveTopics } from '../server/archive-topics.ts';
import { TopicMaterials } from '../server/topic-materials.ts';
import { withProject, resolveProject } from '../server/projects.ts';
import { readTopicChatMedia } from '../server/topic-chat-media.ts';
import { putAgentBinding } from '../server/agent-store.ts';
import { prepareTopicVideo, topicVideoPreview } from '../server/topic-video.ts';
import { readStoredArtifact } from '../server/artifacts.ts';
import { topicActionSchema, type ArchiveTopicDetail, type TopicMaterialPreview, type TopicSelection, type TopicTarget } from '../shared/extensions/project-communications/topics.ts';
import type { AgentContext } from '../server/agent-provider.ts';
import type { PaseoAgentCreateOptions } from '@getpaseo/client';
import { startArchiveFixture } from './helpers/archive-service.ts';
import type { IssueConnection, IssueDetail, IssuePage, IssueSelection } from '../shared/extensions/project-communications/issues.ts';
import { changeIssuePart, selectIssue } from '../client/issue-selection.ts';
import { supportedArtifact, MAX_VIDEO_BYTES } from '../shared/artifact-limits.ts';

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
  const state = { uncertain: false, appended: [] as unknown[], sent: [] as Array<{ text: string; options: { messageId: string; images: Array<{ data: string; mimeType: string }>; attachments?: Array<{ type: string; fileName: string; mimeType: string; size: number; path: string }> } }> };
  const context = { paseo: { agents: {
    list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
    ref: (id: string) => ({ refresh: async () => ({ agent: id === agent.id ? agent : null }),
      send: async (text: string, options: typeof state.sent[number]['options']) => { assert.equal(id, agent.id); state.sent.push({ text, options }); if (state.uncertain) throw Error('connection lost after dispatch'); },
      timeline: { append: async (item:unknown)=>{state.appended.push(item);return {seq:state.appended.length,epoch:'fixture'};},
        refetch: async () => ({ entries: [...state.sent.map(item => ({ item: { type: 'user_message', messageId: item.options.messageId } })),...state.appended.map(item=>({item}))] }) },
    }),
  } } } as unknown as AgentContext;
  return { agent, state, context };
}

function nativeCreation(root: string) {
  const native = nativeSession(root);
  const created: PaseoAgentCreateOptions[] = [];
  const state = { available: true, uncertain: false, created, discoveryCalls: [] as string[],
    thinkingOptions:[{id:'low',label:'Low',isDefault:true},{id:'high',label:'High'}],
    permissionModes:[{id:'auto',label:'Default Permissions'},{id:'full-access',label:'Full Access'}] };
  const api = native.context.paseo;
  Object.assign(api, { providers: {
    listAvailable: async () => ({ providers: [{provider:'codex',available:state.available},{provider:'offline',available:false}] }),
    listModels: async (provider: string, options: {cwd: string}) => {
      state.discoveryCalls.push(provider); assert.equal(realpathSync(options.cwd), realpathSync(root));
      return { models: [{id:'analysis-model',label:'分析模型',isDefault:true,thinkingOptions:state.thinkingOptions,defaultThinkingOptionId:'low'},
        {id:'hidden-model',label:'不可选模型',isSelectable:false}] };
    },
    listModes:async()=>({modes:state.permissionModes}),
  } });
  api.agents.create = async options => {
    state.created.push(options);
    Object.assign(native.agent, { id: 'new-topic-agent', cwd: options.cwd, title: options.title, labels: options.labels });
    if(options.prompt)native.state.sent.push({text:options.prompt,options:{messageId:options.clientMessageId!,images:options.images || [],attachments:options.attachments as never}});
    if (state.uncertain) throw Error('creation acknowledgement lost');
    return Object.assign(api.agents.ref(native.agent.id), {id:native.agent.id});
  };
  api.agents.list = async options => ({ entries: Object.entries(options?.filter?.labels || {}).every(([key, value]) =>
    (native.agent.labels as Record<string,string>)[key] === value) ? [{agent:native.agent}] : [], pageInfo:{hasMore:false} }) as never;
  return { ...native, creation: state };
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

test('TAPD topics read only the configured library, todo view and versioned originals', async () => {
  const s = await setup();
  try {
    s.state.issueMachineRead = false;
    const unavailable = await s.call({ action: 'issues.status' }) as IssueConnection;
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(unavailable.manageUrl, undefined);
    assert.equal((await s.archive.list({ query: '', limit: 30 })).items.length, 2);

    s.state.issueMachineRead = true;
    const state = await s.call({ action: 'issues.status' }) as IssueConnection;
    assert.equal(state.state, 'ready');
    assert.equal(JSON.stringify(state).includes('not-for-workbench'), false);
    assert.equal(state.manageUrl, undefined);
    const page = await s.call({ action: 'issues.list', query: '' }) as IssuePage;
    const next = await s.call({ action: 'issues.list', query: '', cursor: page.next }) as IssuePage;
    assert.notEqual(page.items[0].id, next.items[0].id);
    const filtered = await s.call({ action: 'issues.list', query: page.items[0].number, projectId: page.items[0].projectId }) as IssuePage;
    assert.deepEqual(filtered.items, page.items);
    const issue = await s.call({ action: 'issues.read', issueId: page.items[0].id, version: page.items[0].version }) as IssueDetail;
    assert.equal(issue.body, s.state.issues[0].body);
    assert.equal(JSON.stringify(issue).includes('not-for-workbench'), false);
    const original = await s.call({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: issue.attachments[0].id }) as { mimeType: string; base64: string };
    assert.equal(original.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(original.base64, 'base64'), s.image);
    await assert.rejects(s.call({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: issue.attachments[2].id }), /issue_material_unavailable/);
    s.state.issues[0].inTodo = false;
    await assert.rejects(s.call({ action: 'issues.read', issueId: issue.id, version: issue.version }), /issue_outside_todo/);
    assert.ok(s.state.requests.filter(item => item.url.includes('/sources/tapd')).every(item => item.method === 'GET'));
  } finally { await s.close(); }
});

test('TAPD opens the configured HTTPS gateway and a browser-only edit preserves delivery receipts', async () => {
  const s = await setup();
  try {
    const extension = 'project-communications';
    const previous = await s.host.connection(s.config, extension, 'read');
    const host = nativeSession(s.root), topic = await s.archive.read('topic-1');
    const prepared = await s.host.topics(s.config, extension, previous.revision, {
      action: 'preview', targetId: 'session:' + host.agent.id, selections: [selection(topic)],
    }, host.context) as TopicMaterialPreview;
    const configure = (publicUrl: string) => s.host.connection(s.config, extension, 'configure', {
      revision: previous.revision, connection: { ...previous.connection, publicUrl },
    });
    await assert.rejects(configure('https://127.0.0.1/communications'), /HTTPS 公网地址/);
    await assert.rejects(configure('https://access.example.test/communications/?token=example'), /HTTPS 公网地址/);
    const updated = await configure('https://access.example.test/communications');
    assert.equal(updated.connection.endpoint, previous.connection.endpoint);
    assert.equal(updated.hasToken, true);
    const issue = await s.call({ action: 'issues.status' }, updated.revision) as IssueConnection;
    assert.equal(issue.manageUrl, 'https://access.example.test/communications/?view=plugin&provider=tapd&page=issues&library=default&source=tapd%3Aissues');
    assert.equal((await s.host.topics(s.config, extension, updated.revision, { action: 'receipt', id: prepared.id }, host.context) as TopicMaterialPreview).id, prepared.id);
  } finally { await s.close(); }
});

test('TAPD inline body and comment images remain versioned originals through preview and native delivery', async () => {
  const s = await setup();
  try {
    const issue = s.state.issues[0], comment = issue.comments[0], host = nativeSession(s.root);
    const bodyId = createHash('sha256').update('inline-body').digest('hex');
    const commentId = createHash('sha256').update('inline-comment').digest('hex');
    issue.attachments = []; issue.attachmentsState = 'empty';
    issue.inlineImages = [
      { id: bodyId, name: '正文截图.png', state: 'ready', offset: 0 },
      { id: commentId, name: '评论截图.png', state: 'ready', offset: 0, commentId: comment.id },
    ];
    const read = await s.call({ action: 'issues.read', issueId: issue.id, version: issue.version }) as IssueDetail;
    assert.deepEqual(read.inlineImages, issue.inlineImages);
    const asset = () => s.call({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: bodyId }) as Promise<{ mimeType: string; base64: string }>;
    assert.equal((await asset()).mimeType, 'image/png');
    assert.deepEqual(Buffer.from((await asset()).base64, 'base64'), s.image);
    let basket = changeIssuePart({}, read, { kind: 'body' });
    basket = changeIssuePart(basket, read, { kind: 'comments', id: comment.id, version: comment.version });
    const prepare = () => s.host.topics(s.config, 'project-communications', 2, {
      action: 'preview', targetId: 'session:' + host.agent.id, selections: [], issueSelections: [basket[issue.id].selection],
    }, host.context) as Promise<TopicMaterialPreview>;
    const preview = await prepare();
    assert.equal(preview.assets.length, 2, 'both selected source images remain visible in confirmation');
    assert.equal(new Set(preview.assets.map(asset => asset.sha256)).size, 1);
    assert.equal(preview.assets[0].mimeType, 'image/png');
    assert.ok(preview.text.includes(issue.body) && preview.text.includes(comment.text));
    assert.ok(preview.text.includes('正文截图.png') && preview.text.includes('评论截图.png'));
    const send = (id: string) => s.host.topics(s.config, 'project-communications', 2, { action: 'send', id }, host.context) as Promise<TopicMaterialPreview>;
    assert.equal((await send(preview.id)).state, 'accepted');
    assert.equal((await send(preview.id)).state, 'accepted');
    assert.equal(host.state.sent.length, 1);
    assert.equal(host.state.sent[0].options.images.length, 1, 'identical inline originals are delivered once');
    assert.deepEqual(Buffer.from(host.state.sent[0].options.images[0].data, 'base64'), s.image);
    assert.equal(host.state.sent[0].options.attachments?.length || 0, 0);
    const stale = await prepare(); issue.version = 'revision-2';
    await assert.rejects(send(stale.id), /issue_selection_changed/);
    assert.equal(host.state.sent.length, 1);
    issue.body = ''; issue.bodyState = 'empty'; comment.text = ''; comment.version = 'empty-comment';
    const imageOnly = await s.call({ action: 'issues.read', issueId: issue.id, version: issue.version }) as IssueDetail;
    basket = selectIssue({}, imageOnly);
    assert.equal(basket[issue.id].selection.body, false);
    assert.deepEqual(basket[issue.id].selection.comments, []);
    const imageOnlyPreview = await prepare();
    assert.equal((await send(imageOnlyPreview.id)).state, 'accepted');
    assert.equal(host.state.sent.length, 2);
    assert.deepEqual(Buffer.from(host.state.sent[1].options.images[0].data, 'base64'), s.image);
    assert.ok(s.state.requests.filter(request => request.url.includes('/attachments/' + bodyId)).every(request => request.url.endsWith('?view=preview')));
    s.state.assetBytes.set(bodyId, { bytes: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' });
    await assert.rejects(asset(), /artifact_type_not_allowed/);
    s.state.assetBytes.set(bodyId, { bytes: Buffer.alloc(9 * 1024 * 1024), mimeType: 'image/png' });
    await assert.rejects(asset(), /service_response_too_large/);
    issue.commentsState = 'unavailable';
    await assert.rejects(s.call({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: commentId }), /issue_material_unavailable/);
  } finally { await s.close(); }
});

test('mixed TAPD and DingTalk material freezes only selected parts and rechecks access before dispatch', async () => {
  const s = await setup();
  try {
    const host = nativeSession(s.root), issue = s.state.issues[0], [screenshot, pdf] = issue.attachments;
    const selected: IssueSelection = { issueId: issue.id, version: issue.version, body: true, comments: [], attachments: [{ id: pdf.id, version: pdf.version }] };
    const topic = await s.archive.read('topic-1');
    const request = { action: 'preview', targetId: 'session:' + host.agent.id, selections: [selection(topic)], issueSelections: [selected] } as const;
    const prepare = () => s.host.topics(s.config, 'project-communications', 2, topicActionSchema.parse(request), host.context) as Promise<TopicMaterialPreview>;
    const preview = await prepare();
    assert.ok(preview.text.includes(issue.body));
    assert.ok(preview.text.includes(issue.number));
    assert.ok(preview.text.includes(topic.messages[0].text));
    assert.equal(preview.text.includes(issue.comments[0].text), false);
    assert.deepEqual(preview.assets.map(item => item.mimeType), ['application/pdf']);
    assert.equal(s.state.requests.some(item => item.url.includes('/attachments/' + screenshot.id)), false);
    assert.equal('issueVersions' in preview, false);

    const send = (id: string) => s.host.topics(s.config, 'project-communications', 2, { action: 'send', id }, host.context) as Promise<TopicMaterialPreview>;
    const receipt = (id: string) => s.host.topics(s.config, 'project-communications', 2, { action: 'receipt', id }, host.context) as Promise<TopicMaterialPreview>;
    s.state.issueSource.projects[0].authorization = 'expired';
    await assert.rejects(send(preview.id), /issue_project_not_authorized/);
    assert.equal(host.state.sent.length, 0);
    assert.equal((await receipt(preview.id)).state, 'preview');
    s.state.issueSource.projects[0].authorization = 'authorized';
    issue.version = 'revision-2';
    await assert.rejects(send(preview.id), /issue_selection_changed/);
    selected.version = issue.version;
    const next = await prepare();
    host.state.uncertain = true;
    assert.equal((await send(next.id)).state, 'uncertain');
    assert.equal(host.state.sent[0].options.attachments?.[0].fileName, '复现报告.pdf');
    s.state.issueSource.projects[0].authorization = 'expired';
    assert.equal((await receipt(next.id)).state, 'accepted');
    assert.equal(host.state.sent.length, 1);
  } finally { await s.close(); }
});

test('a TAPD-only draft opens the shared new-session path and keeps selected versions when a defect refreshes', async () => {
  const s = await setup();
  try {
    const issue = s.state.issues[0], host = nativeCreation(s.root);
    const basket = selectIssue({}, issue), pinned = basket[issue.id].selection;
    const updated = { ...issue, version: 'revision-2' };
    assert.equal(changeIssuePart(basket, updated, { kind: 'body' }), basket);
    assert.equal(pinned.comments.length, 0);
    assert.deepEqual(pinned.attachments.map(item => item.id), issue.attachments.slice(0, 2).map(item => item.id));
    const preview = await s.host.topics(s.config, 'project-communications', 2, {
      action: 'preview', selections: [], issueSelections: [pinned], newSession: { provider: 'codex', model: 'analysis-model' },
    }, host.context) as TopicMaterialPreview;
    assert.equal(preview.issues?.[0].id, issue.id);
    const sent = await s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, host.context) as TopicMaterialPreview;
    assert.equal(sent.state, 'accepted');
    assert.equal(host.creation.created.length, 1);
    assert.equal(host.state.sent.length, 1);
    assert.equal(host.state.sent[0].options.images.length, 1);
    assert.equal(host.state.sent[0].options.attachments?.[0].mimeType, 'application/pdf');
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
    const another = await s.inProject(() => materials.preview(s.archive,'workspace','agent-a',[selection(topic)]));
    await materials.send(another.id,'agent-a',async()=>({delivery:'uncertain'}));
    let release!:()=>void;
    const late = materials.receipt(another.id,'agent-a',async()=>{
      await new Promise<void>(resolve=>{release=resolve;});
      return {delivery:'uncertain',session:{agentId:'agent-a',cwd:s.root,hostWorkspaceId:'host-workspace'}};
    });
    await materials.receipt(another.id,'agent-a',async()=>({delivery:'accepted',messageId:'confirmed'}));
    release();
    assert.equal((await late).state,'accepted'); assert.equal(materials.read(another.id).messageId,'confirmed');
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
      timeline:{append:async()=>({seq:1,epoch:'fixture'}),refetch:async()=>({entries:[]})},
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

test('per-send instructions are frozen separately from archive originals and never become a later default', async () => {
  const s = await setup();
  try {
    const native = nativeSession(s.root), topic = await s.archive.read('topic-1');
    const note = '请先核对截图。\n只分析问题原因，暂不修改代码。';
    const request = {action:'preview' as const,targetId:'session:'+native.agent.id,note,selections:[selection(topic)]};
    const preview = await s.host.topics(s.config,'project-communications',2,request,native.context) as TopicMaterialPreview;
    request.note = 'later edited draft';
    assert.equal(preview.note,note); assert.equal(preview.text,note+'\n\n'+topic.messages[0].text);
    assert.equal(topic.messages[0].text,s.state.topics[0].messages[0].text);
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},native.context);
    assert.ok(native.state.sent[0].text.includes(note)); assert.equal(native.state.sent[0].text.includes(request.note),false);
    const next = await s.host.topics(s.config,'project-communications',2,{...request,note:undefined},native.context) as TopicMaterialPreview;
    assert.equal(next.note,undefined); assert.equal(next.text.includes(note),false);
    assert.equal(s.state.requests.some(item=>item.method==='POST'),false);
    assert.equal(topicActionSchema.safeParse({...request,note:'x'.repeat(8001)}).success,false);
  } finally { await s.close(); }
});

test('long-original delivery keeps the users instructions inline as well as the complete source document', async () => {
  const s = await setup();
  try {
    s.state.topics[0].messages[0].text = '完整原文。'.repeat(8000);
    const materials = new TopicMaterials(join(s.root,'state'),'scope'), topic = await s.archive.read('topic-1');
    const preview = await s.inProject(()=>materials.preview(s.archive,'workspace','agent-a',[selection(topic)],undefined,{note:'先给出三个结论。'}));
    const stored = materials.read(preview.id);
    assert.ok(stored.dispatchText?.startsWith('先给出三个结论。'));
    s.inProject(()=>assert.equal(readStoredArtifact(stored.references[0].assetId!).bytes.toString('utf8'),preview.text));
  } finally { await s.close(); }
});

test('selected pictures follow their original message chronology across topics',async()=>{
  const s=await setup();
  try{
    s.state.topics[2].messages[0].createdAt=s.state.topics[0].messages[0].createdAt-60000;
    const first=await s.archive.read('topic-1'),earlier=await s.archive.read('topic-3');
    const original=s.archive.original.bind(s.archive);
    s.archive.original=async asset=>{const value=await original(asset);return {...value,bytes:Buffer.concat([value.bytes,Buffer.from(asset.id)])};};
    const materials=new TopicMaterials(join(s.root,'state'),'scope');
    const selections=[first,earlier].map(topic=>({...selection(topic),messages:[],assets:[{id:topic.messages[0].assets[0].id,messageId:topic.messages[0].id,messageVersion:topic.messages[0].version}]}));
    const preview=await s.inProject(()=>materials.preview(s.archive,'workspace','agent',selections,undefined,{note:'看一下图片。'}));
    assert.equal(materials.read(preview.id).references[0].title,'image-3.png');
    assert.equal(materials.read(preview.id).references[1].title,'image-1.png');
  }finally{await s.close();}
});

test('edited originals are frozen separately; formatted text, alias relationships and image bytes reach the native session',async()=>{
  const s=await setup();
  try{
    const host=nativeCreation(s.root),topic=await s.archive.read('topic-1'),selected=selection(topic),original=topic.messages[0];
    selected.messages=[{id:topic.messages[1].id,version:topic.messages[1].version},{id:original.id,version:original.version,editedText:'@阿宁 我已核对，这里是补充后的原文。'}];
    selected.assets=[{id:'image-1',messageId:original.id,messageVersion:original.version}];
    s.state.topics[0].messages[1].createdAt=original.createdAt+60000;
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},
      content:{layout:'auto',identity:'alias',timeZone:'Asia/Shanghai',template:'本次目标：{{note}}\n\n{{materials}}'},note:'只分析，不修改。',selections:[selected]},host.context) as TopicMaterialPreview;
    assert.ok(preview.text.includes('@AN 我已核对'));assert.ok(preview.text.includes('XL（已编辑）'));
    assert.ok(preview.text.indexOf('XL（已编辑）')<preview.text.indexOf('AN ·'));
    assert.equal(preview.text.includes('小林'),false);assert.equal(preview.text.includes('阿宁'),false);
    const raw=JSON.parse(readFileSync(join(s.root,'state/extensions/topic-materials',createHash('sha256').update(preview.id).digest('hex')+'.json'),'utf8'));
    assert.equal(raw.originalTexts.find((entry:any)=>entry.messageId===original.id).text,original.text);
    assert.ok(raw.originalTexts.find((entry:any)=>entry.messageId===original.id).editedText.includes('补充后的原文'));
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);
    assert.equal(host.state.sent[0].text,preview.text);assert.deepEqual(Buffer.from(host.state.sent[0].options.images[0].data,'base64'),s.image);
    assert.equal(s.state.topics[0].messages[0].text,original.text);
    selected.messages[0].editedText='确认后改写不会改变已固定的发送内容';
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);assert.equal(host.state.sent.length,1);
  }finally{await s.close();}
});

test('an edited message still must match the selected archive version and template changes preserve unrelated preferences',async()=>{
  const s=await setup();
  try{
    const host=nativeCreation(s.root),topic=await s.archive.read('topic-1'),selected=selection(topic);
    selected.messages[0].editedText='修改稿';selected.messages[0].version='old-version';
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},selections:[selected]},host.context),/topic_message_version_changed/);
    const value={destination:'new' as const,newSession:{provider:'codex',model:'analysis-model',modeId:'full-access'},material:{layout:'auto' as const,identity:'alias' as const,presetId:'custom',presets:[{id:'custom',name:'排查',body:'任务：{{note}}\n\n材料：{{materials}}'}]}};
    await s.host.topics(s.config,'project-communications',2,{action:'preferences',value});
    const restarted=new WorkbenchExtensions();
    try{assert.deepEqual(await restarted.topics(s.config,'project-communications',2,{action:'preferences'}),value);}finally{await restarted.close();}
    assert.equal(host.creation.created.length,0);
  }finally{await s.close();}
});

test('new sessions use a host-listed model and selected originals; preview creates nothing and repeated sends create once', async () => {
  const s = await setup();
  try {
    const host = nativeCreation(s.root), topic = await s.archive.read('topic-1'), selected = selection(topic);
    const models = await s.host.topics(s.config,'project-communications',2,{action:'models'},host.context) as Array<{model:string}>;
    assert.deepEqual(models.map(item=>item.model),['analysis-model']); assert.deepEqual(host.creation.discoveryCalls,['codex']);
    selected.assets = [{id:'image-1',messageId:'message-1',messageVersion:topic.messages[0].version}];
    const preview = await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},note:'请先分析图片中的问题。',selections:[selected]},host.context) as TopicMaterialPreview;
    assert.equal(host.creation.created.length,0);
    const send = ()=>s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context) as Promise<TopicMaterialPreview>;
    await Promise.all([send(),send()]);
    const result = await send();
    assert.equal(result.state,'accepted'); assert.equal(result.targetAgentId,'new-topic-agent');
    assert.equal(host.creation.created.length,1);
    const options = host.creation.created[0];
    assert.equal(options.cwd,realpathSync(s.root)); assert.equal(options.config.provider,'codex/analysis-model');
    assert.equal(options.config.modeId,undefined); assert.equal(options.config.options,undefined);
    assert.equal(options.prompt,undefined); assert.equal(options.images,undefined);
    assert.ok(host.state.sent[0].text.includes('请先分析图片中的问题。')); assert.ok(host.state.sent[0].text.includes(topic.messages[0].text));
    assert.equal(host.state.sent[0].text.includes(topic.messages[1].text),false);
    assert.deepEqual(Buffer.from(host.state.sent[0].options.images[0].data,'base64'),s.image);
    assert.equal(host.state.appended.length,1);
    assert.equal(host.agent.features[0].value,true);
  } finally { await s.close(); }
});

test('new sessions receive the selected effort and permission preset without adding planning or provider options',async()=>{
  const s=await setup();
  try{
    const host=nativeCreation(s.root),topic=await s.archive.read('topic-1');
    const models=await s.host.topics(s.config,'project-communications',2,{action:'models'},host.context) as import('../shared/extensions/project-communications/topics.ts').TopicModel[];
    assert.deepEqual(models[0].thinkingOptions,host.creation.thinkingOptions);
    assert.deepEqual(models[0].permissionModes,host.creation.permissionModes);
    const choice={provider:'codex',model:'analysis-model',thinkingOptionId:'high',modeId:'full-access'};
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:choice,selections:[selection(topic)]},host.context) as TopicMaterialPreview;
    assert.deepEqual(preview.newSession,choice);
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);
    assert.deepEqual(host.creation.created[0].config,{provider:'codex/analysis-model',thinkingOptionId:'high',modeId:'full-access'});
    assert.equal(host.agent.features[0].value,true);
  }finally{await s.close();}
});

test('removed model efforts or permission presets are rejected before creating or sending',async()=>{
  const s=await setup();
  try{
    const host=nativeCreation(s.root),topic=await s.archive.read('topic-1');
    const request={action:'preview' as const,newSession:{provider:'codex',model:'analysis-model',thinkingOptionId:'high',modeId:'full-access'},selections:[selection(topic)]};
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{...request,newSession:{...request.newSession,thinkingOptionId:'invented'}},host.context),/topic_effort_unavailable/);
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{...request,newSession:{...request.newSession,modeId:'invented'}},host.context),/topic_permission_unavailable/);
    const preview=await s.host.topics(s.config,'project-communications',2,request,host.context) as TopicMaterialPreview;
    host.creation.thinkingOptions=host.creation.thinkingOptions.filter(option=>option.id!=='high');
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context),/topic_effort_unavailable/);
    host.creation.thinkingOptions.push({id:'high',label:'High'});
    host.creation.permissionModes=host.creation.permissionModes.filter(mode=>mode.id!=='full-access');
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context),/topic_permission_unavailable/);
    assert.equal(host.creation.created.length,0);assert.equal(host.state.sent.length,0);
  }finally{await s.close();}
});

test('session choices survive connector restart without reading the archive or changing followed groups and unknown settings',async()=>{
  const s=await setup();
  try{
    const path=join(s.root,'state','extensions','topic-session-preferences.json');
    mkdirSync(join(s.root,'state','extensions'),{recursive:true});
    writeFileSync(path,JSON.stringify({version:1,history:{keep:true},selection:{custom:'retain'}}));
    const before=s.state.requests.length,connection=await s.host.connection(s.config,'project-communications','read');
    const value={destination:'new' as const,newSession:{provider:'codex',model:'analysis-model',thinkingOptionId:'high',modeId:'full-access'},targetId:'session:previous'};
    await s.host.topics(s.config,'project-communications',2,{action:'preferences',value});
    const restarted=new WorkbenchExtensions();
    try{assert.deepEqual(await restarted.topics(s.config,'project-communications',2,{action:'preferences'}),value);}
    finally{await restarted.close();}
    assert.equal(s.state.requests.length,before);
    assert.deepEqual((await s.host.connection(s.config,'project-communications','read')).connection,connection.connection);
    const stored=JSON.parse(readFileSync(path,'utf8'));assert.deepEqual(stored.history,{keep:true});assert.equal(stored.selection.custom,'retain');
  }finally{await s.close();}
});

test('a lost new-session acknowledgement is reconciled by scoped labels without creating or sending again', async () => {
  const s = await setup();
  try {
    const host = nativeCreation(s.root); host.creation.uncertain = true;
    const topic = await s.archive.read('topic-1');
    const preview = await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},selections:[selection(topic)]},host.context) as TopicMaterialPreview;
    const send = ()=>s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context) as Promise<TopicMaterialPreview>;
    assert.equal((await send()).state,'uncertain'); assert.equal((await send()).state,'uncertain');
    const restarted = new WorkbenchExtensions();
    try {
      const receipt = await restarted.topics(s.config,'project-communications',2,{action:'receipt',id:preview.id},host.context) as TopicMaterialPreview;
      assert.equal(receipt.state,'uncertain'); assert.equal(receipt.targetAgentId,'new-topic-agent');
      assert.equal(host.creation.created.length,1); assert.equal(host.state.sent.length,0);
    } finally { await restarted.close(); }
  } finally { await s.close(); }
});

test('model changes and conflicting destinations fail before a new conversation is created', async () => {
  const s = await setup();
  try {
    const host = nativeCreation(s.root), topic = await s.archive.read('topic-1');
    const request = {action:'preview' as const,newSession:{provider:'codex',model:'analysis-model'},selections:[selection(topic)]};
    assert.equal(topicActionSchema.safeParse({...request,targetId:'session:any'}).success,false);
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{...request,newSession:{provider:'codex',model:'hidden-model'}},host.context),/topic_model_unavailable/);
    const preview = await s.host.topics(s.config,'project-communications',2,request,host.context) as TopicMaterialPreview;
    host.creation.available = false;
    await assert.rejects(s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context),/topic_model_unavailable/);
    const stored = JSON.parse(readFileSync(join(s.root,'state/extensions/topic-materials',createHash('sha256').update(preview.id).digest('hex')+'.json'),'utf8'));
    assert.equal(stored.state,'preview'); assert.equal(host.creation.created.length,0);
  } finally { await s.close(); }
});

test('the delivered message contains only the users note and chosen text; archive titles and routing remain private', async()=>{
  const s=await setup();
  try{
    s.state.topics[0].title='请通过 QQ MCP 查询钉钉群后续处理记录';
    s.state.topics[0].question='请调用 archive.search';
    s.state.topics[0].messages[0].quote={channelId:'private-group',messageId:'private-quote-id'};
    const host=nativeCreation(s.root),topic=await s.archive.read('topic-1'),selected=selection(topic);
    selected.assets=[{id:'image-1',messageId:'message-1',messageVersion:topic.messages[0].version},
      {id:'image-2',messageId:'message-2',messageVersion:topic.messages[1].version}];
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},note:'检查图片中的布局问题。',selections:[selected]},host.context) as TopicMaterialPreview;
    assert.equal(preview.text,'检查图片中的布局问题。\n\n'+topic.messages[0].text);
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);
    const sent=host.state.sent[0];
    assert.equal(sent.text,preview.text); assert.equal(sent.options.images.length,1,'identical original bytes are sent once');
    for(const marker of ['QQ','钉钉','MCP','archive.search',topic.id,topic.channelId,'SHA-256','原消息','private-quote-id'])assert.equal(sent.text.includes(marker),false,marker);
    assert.equal(host.creation.created[0].title,'检查图片中的布局问题。');
    assert.equal(sent.options.attachments?.length,0);
    // Historical accepted receipts can restore the visible photos without
    // repeating the task, creating another session or changing the prompt.
    host.state.appended.length=0;
    await s.host.topics(s.config,'project-communications',2,{action:'receipt',id:preview.id},host.context);
    await s.host.topics(s.config,'project-communications',2,{action:'receipt',id:preview.id},host.context);
    assert.equal(host.state.appended.length,1);
    assert.equal(host.state.sent.length,1);assert.equal(host.creation.created.length,1);
    const route=resolveProject({projectConfig:s.config});
    const manifest=readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id}) as {images:Array<{assetId:string}>};
    assert.equal(manifest.images.length,1);
    const image=readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id,assetId:manifest.images[0].assetId}) as {base64:string};
    assert.deepEqual(Buffer.from(image.base64,'base64'),s.image);
    assert.throws(()=>readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:'another-session'}),/outside_session/);
    assert.throws(()=>readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id,assetId:'unselected'}),/outside_selection/);
    await s.host.setEnabled(s.config,'project-communications',false);
    assert.deepEqual(Buffer.from((readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id,assetId:manifest.images[0].assetId}) as {base64:string}).base64,'base64'),s.image);
  }finally{await s.close();}
});

test('a lost first-message acknowledgement retains the created session and never creates or dispatches twice',async()=>{
  const s=await setup();
  try{
    const host=nativeCreation(s.root);host.state.uncertain=true;
    const topic=await s.archive.read('topic-1'),selected=selection(topic);
    selected.assets=[{id:'image-1',messageId:'message-1',messageVersion:topic.messages[0].version}];
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',newSession:{provider:'codex',model:'analysis-model'},selections:[selected]},host.context) as TopicMaterialPreview;
    const send=()=>s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context) as Promise<TopicMaterialPreview>;
    assert.equal((await send()).state,'uncertain');assert.equal((await send()).state,'uncertain');
    const receipt=await s.host.topics(s.config,'project-communications',2,{action:'receipt',id:preview.id},host.context) as TopicMaterialPreview;
    assert.equal(receipt.state,'accepted');assert.equal(receipt.targetAgentId,host.agent.id);
    assert.equal(host.creation.created.length,1);assert.equal(host.state.sent.length,1);assert.equal(host.state.appended.length,1);
  }finally{await s.close();}
});

test('an image-only selection sends an empty caption with original image parts, never a file or placeholder',async()=>{
  const s=await setup();
  try{
    s.state.topics[0].messages[0].text='[图片消息](mediaId=$opaque)';s.state.topics[0].messages[0].displayText='';
    const host=nativeSession(s.root),topic=await s.archive.read('topic-1'),selected=selection(topic);
    selected.assets=[{id:'image-1',messageId:'message-1',messageVersion:topic.messages[0].version}];
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',targetId:'session:'+host.agent.id,selections:[selected]},host.context) as TopicMaterialPreview;
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);
    assert.equal(host.state.sent[0].text,'');assert.equal(host.state.sent[0].options.images.length,1);assert.equal(host.state.sent[0].options.attachments?.length,0);
  }finally{await s.close();}
});


function pendingVideo(s:Awaited<ReturnType<typeof setup>>,id='video-original') {
  const topic=s.state.topics[0],message=topic.messages[0];
  message.text='fileName=mmexport123.mp4\nurl: @opaque';
  message.assets=[{id,name:'attachment',state:'pending',mimeType:'video'}];
  return {topic,message};
}

test('saved image originals replace pending topic metadata without changing the historical message or selection scope', async () => {
  const s = await setup();
  try {
    const topic = s.state.topics[0], message = topic.messages[0], originalText = message.text;
    message.assets = [{ id: 'image-1', name: 'attachment', state: 'pending', mimeType: 'application/octet-stream' }];
    s.state.context.assets = structuredClone(message.assets);
    s.state.assetInfo.set('image-1', { id: 'image-1', name: '图片.png', kind: 'image', state: 'ready', mimeType: 'image/png', size: s.image.length,
      error: '', fetchable: true, remoteUrl: 'https://private.invalid/original', credential: 'must-not-reach-ui' });
    const detail = await s.archive.read(topic.id), asset = detail.messages[0].assets[0];
    assert.equal(asset.state, 'ready'); assert.equal(asset.mimeType, 'image/png'); assert.equal(asset.size, s.image.length);
    assert.equal(detail.messages[0].text, originalText); assert.equal(detail.messages[0].version, message.version);
    assert.deepEqual(detail.messages[0].assets.map(item => item.id), ['image-1']);
    assert.equal(message.assets[0].state, 'pending', 'historical topic snapshots stay unchanged');
    assert.equal(JSON.stringify(asset).includes('private.invalid'), false);
    assert.equal(JSON.stringify(asset).includes('must-not-reach-ui'), false);
    assert.equal((await s.archive.messages(topic.id, 0)).items[0].assets[0].state, 'ready');
    assert.equal((await s.archive.context(topic.id, message.id)).items[0].assets[0].state, 'ready');
    assert.equal(s.state.requests.filter(request => request.url.endsWith('/assets/image-1/info')).length, 1, 'same-ID metadata is merged within the request');
    assert.equal(s.state.requests.some(request => request.url.endsWith('/assets/image-1') || request.method === 'POST'), false, 'metadata reads do not fetch or start acquiring the original');
  } finally { await s.close(); }
});

test('pending metadata is retried on a later read and mismatched IDs cannot mark an original ready', async () => {
  const s = await setup();
  try {
    const topic = s.state.topics[0], message = topic.messages[0];
    message.assets = [{ id: 'image-1', name: 'attachment', state: 'pending', mimeType: 'image' }];
    s.state.assetInfo.set('image-1', { id: 'another-image', state: 'ready', mimeType: 'image/png' });
    assert.equal((await s.archive.read(topic.id)).messages[0].assets[0].state, 'pending');
    s.state.assetInfo.set('image-1', { id: 'image-1', state: 'pending', mimeType: 'image/png' });
    assert.equal((await s.archive.read(topic.id)).messages[0].assets[0].state, 'pending');
    s.state.assetInfo.set('image-1', { id: 'image-1', state: 'ready', mimeType: 'image/png', size: s.image.length });
    assert.equal((await s.archive.read(topic.id)).messages[0].assets[0].state, 'ready');
    const count = s.state.requests.length; message.channelId = 'outside-followed-scope';
    await assert.rejects(s.archive.read(topic.id), /message_outside_scope/);
    assert.equal(s.state.requests.slice(count).some(request => request.url.includes('/assets/')), false);
  } finally { await s.close(); }
});

test('saved videos recover canonical MIME, size and ready state across topic, page and context reads without exposing transport metadata',async()=>{
  const s=await setup();
  try{
    const {topic,message}=pendingVideo(s);s.state.context.assets=structuredClone(message.assets);
    const detail=await s.archive.read(topic.id),asset=detail.messages[0].assets[0];
    assert.deepEqual(asset,{id:'video-original',name:'视频.mp4',kind:'video',state:'ready',mimeType:'video/mp4',size:s.video.length});
    assert.equal(s.state.topics[0].messages[0].assets[0].state,'pending');
    assert.equal((await s.archive.messages(topic.id,0)).items[0].assets[0].state,'ready');
    assert.equal((await s.archive.context(topic.id,message.id)).items[0].assets[0].state,'ready');
    assert.equal(s.state.requests.filter(item=>item.method==='GET'&&item.url.endsWith('/assets/video-original')).length,0);
    assert.equal(s.state.requests.filter(item=>item.method==='HEAD'&&item.url.endsWith('/assets/video-original')).length,1);
    const original=await s.archive.asset(topic.id,message.id,asset.id) as {mimeType:string;base64:string};
    assert.equal(original.mimeType,'video/mp4');assert.deepEqual(Buffer.from(original.base64,'base64'),s.video);
  }finally{await s.close();}
});

test('unavailable video originals remain pending and outside-scope messages never trigger metadata requests',async()=>{
  const s=await setup();
  try{
    const {topic,message}=pendingVideo(s);s.state.unavailableAssets.add('video-original');
    assert.equal((await s.archive.read(topic.id)).messages[0].assets[0].state,'pending');
    await assert.rejects(s.archive.asset(topic.id,message.id,'video-original'),/asset_not_ready/);
    const before=s.state.requests.length;message.channelId='outside-followed-scope';
    await assert.rejects(s.archive.read(topic.id),/message_outside_scope/);
    assert.equal(s.state.requests.slice(before).some(item=>item.method==='HEAD'),false);
  }finally{await s.close();}
});

test('selected video originals and timepoint images reach the native session, remain visible after restart and never auto-replay',async()=>{
  const s=await setup();
  try{
    const {topic:source}=pendingVideo(s),host=nativeSession(s.root),topic=await s.archive.read(source.id),selected=selection(topic);
    selected.assets=[{id:'video-original',messageId:topic.messages[0].id,messageVersion:topic.messages[0].version}];
    const video=await s.archive.asset(topic.id,topic.messages[0].id,'video-original',undefined,'video-preview') as Awaited<ReturnType<typeof prepareTopicVideo>>;
    assert.equal(video.frames.length,4);assert.equal(video.duration,2);
    assert.ok(video.frames.every((frame,index)=>index===0||frame.time>video.frames[index-1].time));
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',targetId:'session:'+host.agent.id,note:'请检查视频中的展示问题',selections:[selected]},host.context) as TopicMaterialPreview;
    assert.equal(preview.assets.length,1);assert.equal(preview.text.includes('fileName='),false);assert.equal(preview.text.includes('@opaque'),false);
    assert.ok(preview.text.includes('原视频'));assert.ok(preview.text.includes('不含音频转写'));assert.ok(preview.text.includes('附图 4'));
    const stored=JSON.parse(readFileSync(join(s.root,'state/extensions/topic-materials',createHash('sha256').update(preview.id).digest('hex')+'.json'),'utf8'));
    assert.equal(stored.originalTexts[0].text,s.state.topics[0].messages[0].text);
    const send=()=>s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context) as Promise<TopicMaterialPreview>;
    assert.equal((await send()).state,'accepted');assert.equal((await send()).state,'accepted');assert.equal(host.state.sent.length,1);
    const received=host.state.sent[0];assert.deepEqual(received.options.images,video.frames.map(frame=>({data:frame.base64,mimeType:frame.mimeType})));
    assert.equal(received.options.attachments?.length,1);assert.equal(received.options.attachments?.[0].mimeType,'video/mp4');
    assert.deepEqual(readFileSync(received.options.attachments![0].path),s.video);
    const route=resolveProject({projectConfig:s.config}),manifest=readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id}) as {images:unknown[];videos:Array<{assetId:string;frames:Array<{assetId:string}>}>};
    assert.equal(manifest.images.length,0);assert.equal(manifest.videos.length,1);assert.equal(manifest.videos[0].frames.length,4);
    await s.host.setEnabled(s.config,'project-communications',false);
    const frozen=readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id,assetId:manifest.videos[0].assetId}) as {base64:string};
    assert.deepEqual(Buffer.from(frozen.base64,'base64'),s.video);
    assert.throws(()=>readTopicChatMedia(route,{projectConfig:s.config,materialId:preview.id,agentId:'another',assetId:manifest.videos[0].assetId}),/outside_session/);
  }finally{await s.close();}
});

test('decoding rejects invalid files and aborted work without leaving a sendable preview',async()=>{
  await assert.rejects(prepareTopicVideo(Buffer.from('not a video')),/video_decode_failed/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(prepareTopicVideo(Buffer.from('a different clip'),controller.signal),/extension_host_unloaded/);
  await assert.rejects(topicVideoPreview(Buffer.from('a cancelled preview'),controller.signal),/extension_host_unloaded/);
});

test('DingTalk and TAPD deliver larger video originals when optional preview decoding fails', async () => {
  const s = await setup();
  try {
    const bytes = Buffer.alloc(13 * 1024 * 1024, 9), host = nativeSession(s.root);
    const id = createHash('sha256').update('larger-recording').digest('hex');
    const asset = { id, name: '屏幕录制.mov', mimeType: 'video/quicktime', kind: 'video', state: 'ready', size: bytes.length, version: 'recording-1' };
    assert.equal(supportedArtifact(asset.mimeType, bytes.length), true);
    assert.equal(supportedArtifact(asset.mimeType, MAX_VIDEO_BYTES + 1), false);
    assert.equal(supportedArtifact('image/png', bytes.length), false);
    s.state.assetBytes.set(id, { bytes, mimeType: asset.mimeType });
    const source = s.state.topics[0], message = source.messages[0], issue = s.state.issues[0];
    message.assets = [asset]; issue.attachments = [asset];
    await assert.rejects(s.archive.asset(source.id, message.id, id), /topic_video_inline_unavailable/);
    await assert.rejects(s.call({ action: 'issues.asset', issueId: issue.id, version: issue.version, attachmentId: id }), /topic_video_inline_unavailable/);
    const selected = { ...selection(await s.archive.read(source.id)), assets: [{ id, messageId: message.id, messageVersion: message.version }] };
    for (const material of [
      { selections: [selected] },
      { selections: [], issueSelections: [{ issueId: issue.id, version: issue.version, body: false, comments: [], attachments: [{ id, version: asset.version }] }] },
    ]) {
      const preview = await s.host.topics(s.config, 'project-communications', 2,
        { action: 'preview', targetId: 'session:' + host.agent.id, ...material }, host.context) as TopicMaterialPreview;
      assert.equal(preview.assets[0].size, bytes.length);
      assert.ok(preview.text.includes('已附原视频文件'));
      const send = () => s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: preview.id }, host.context) as Promise<TopicMaterialPreview>;
      assert.equal((await send()).state, 'accepted');
      assert.equal((await send()).state, 'accepted');
      const received = host.state.sent.at(-1)!;
      assert.deepEqual(received.options.images, []);
      assert.deepEqual(readFileSync(received.options.attachments![0].path), bytes);
      const manifest = readTopicChatMedia(resolveProject({ projectConfig: s.config }),
        { projectConfig: s.config, materialId: preview.id, agentId: host.agent.id }) as { videos: Array<{ frames: unknown[]; size: number }> };
      assert.equal(manifest.videos[0].size, bytes.length);
      assert.deepEqual(manifest.videos[0].frames, []);
    }
    const mixed = await s.host.topics(s.config, 'project-communications', 2, {
      action: 'preview', targetId: 'session:' + host.agent.id, selections: [selected],
      issueSelections: [{ issueId: issue.id, version: issue.version, body: false, comments: [], attachments: [{ id, version: asset.version }] }],
    }, host.context) as TopicMaterialPreview;
    assert.equal((await s.host.topics(s.config, 'project-communications', 2, { action: 'send', id: mixed.id }, host.context) as TopicMaterialPreview).state, 'accepted');
    assert.equal(host.state.sent.at(-1)!.options.attachments?.length, 1);
    assert.equal(host.state.sent.length, 3);
  } finally { await s.close(); }
});


test('missing legacy attachments borrow only same-version source metadata and preserve original snapshot text',async()=>{
  const s=await setup();
  try{
    const {topic,message}=pendingVideo(s);
    message.text='[视频消息](mediaId=@legacy) '+message.text;
    const original=structuredClone(message);original.text='newer-looking source body must stay private';
    s.state.originalMessages.set(message.id,original);message.assets=[];
    let current=await s.archive.read(topic.id);
    assert.equal(current.messages[0].text,message.text);assert.equal(current.messages[0].assets[0].state,'ready');
    const thumbnail=await s.archive.asset(topic.id,message.id,'video-original',undefined,'thumbnail') as {mimeType:string;base64:string};
    assert.equal(thumbnail.mimeType,'image/png');assert.deepEqual(Buffer.from(thumbnail.base64,'base64'),s.image);
    original.version='newer-version';current=await s.archive.read(topic.id);assert.equal(current.messages[0].assets.length,0);
    original.version=message.version;original.channelId='another-group';current=await s.archive.read(topic.id);assert.equal(current.messages[0].assets.length,0);
  }finally{await s.close();}
});


test('the same video linked to two selected messages is delivered once with one set of frames',async()=>{
  const s=await setup();
  try{
    const {topic:source}=pendingVideo(s),second=source.messages[1];
    second.assets=[{id:'video-duplicate',name:'attachment',mimeType:'video',state:'pending'}];
    const host=nativeSession(s.root),topic=await s.archive.read(source.id),selected=selection(topic);
    selected.messages=topic.messages.map(message=>({id:message.id,version:message.version}));
    selected.assets=topic.messages.map(message=>({id:message.assets[0].id,messageId:message.id,messageVersion:message.version}));
    const preview=await s.host.topics(s.config,'project-communications',2,{action:'preview',targetId:'session:'+host.agent.id,selections:[selected]},host.context) as TopicMaterialPreview;
    await s.host.topics(s.config,'project-communications',2,{action:'send',id:preview.id},host.context);
    assert.equal(host.state.sent.length,1);assert.equal(host.state.sent[0].options.images.length,4);assert.equal(host.state.sent[0].options.attachments?.length,1);
    const manifest=readTopicChatMedia(resolveProject({projectConfig:s.config}),{projectConfig:s.config,materialId:preview.id,agentId:host.agent.id}) as {videos:unknown[]};
    assert.equal(manifest.videos.length,1);
  }finally{await s.close();}
});
