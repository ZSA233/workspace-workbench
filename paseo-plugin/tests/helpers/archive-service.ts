import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ArchiveMessage, ArchiveTopicDetail } from '../../shared/extensions/project-communications/topics.ts';

export function archiveFixture() {
  const createdAt = Date.parse('2026-11-22T14:32:00+08:00');
  const message = (id: string, text: string, assets: ArchiveMessage['assets'] = []): ArchiveMessage => ({
    id, text, sender: id.endsWith('2') ? '阿宁' : '小林', createdAt, version: 'version-' + id,
    sourceId: 'dingtalk:fixture', channelId: 'feedback', sourceAccountId: 'account', assets,
  });
  const asset = (id: string) => ({ id, name: id + '.png', mimeType: 'image/png', kind: 'image', state: 'ready' });
  const titles = ['文件列表错误提示挤压布局', '移动端图片无法放大', '下载附件后文件名丢失', '工作区切换后内容未刷新'];
  const topics = titles.map((title, index): ArchiveTopicDetail => ({
    id: 'topic-' + (index + 1), title, sourceId: 'dingtalk:fixture', channelId: 'feedback', sourceAccountId: 'account',
    revision: 1, inputRevision: 1, status: 'open', updatedAt: createdAt - index * 600000,
    lastAnswer: '这是一段派生分析，不应默认带入。', summary: '派生摘要', messageCount: index === 0 || index === 2 ? 2 : 1, hasMoreMessages: false,
    messages: index === 0 ? [
      message('message-1', '文件列表出现长错误提示后，目录被往下挤了。', [asset('image-1')]),
      message('message-2', '刷新后还能复现，截图在下面。', [asset('image-2')]),
    ] : index === 2 ? [
      message('message-3', '下载附件后，文件名变成了空白。', [asset('image-3')]),
      message('message-4', '在 Windows 和 macOS 都能复现。'),
    ] : [message('message-' + (index + 5), index === 1 ? '这张图片暂时还没下载完成。' : '切换工作区后仍显示上个项目的文件。',
      index === 1 ? [{ ...asset('pending-image'), state: 'pending' }] : [])],
  }));
  return {
    topics, context: message('context-1', '这是原消息前的一条补充，只有主动选择后才交接。'),
    channels: [{ id: 'feedback', sourceId: 'dingtalk:fixture', name: '产研反馈群', provider: 'dingtalk', state: 'ready' }],
    groups: [{ id: 'followed', name: '产研反馈群', sourceId: 'dingtalk:fixture', channelId: 'feedback', revision: 1, enabled: false,
      analysisEnabled: true, autoDiscover: true, discoveryAction: 'collect', replyMode: 'off', allowedTools: ['messages.read'], customHistory: { retain: true } }],
    libraries: [{ id: 'default', name: '示例资料库' }],
    failLists: false,
    unavailableAssets: new Set<string>(),
    originalMessages: new Map<string,ArchiveMessage>(),
    requests: [] as Array<{ method: string; url: string }>,
  };
}
export async function startArchiveFixture() {
  const state = archiveFixture();
  const token = 'a'.repeat(64);
  const image = readFileSync(new URL('../../../docs/design/archive-topics/concept-c-refined.png', import.meta.url));
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
  const video = readFileSync(new URL('../fixtures/topic-video.mp4', import.meta.url));
  const server = createServer(async (req, res) => {
    state.requests.push({ method: req.method || 'GET', url: req.url || '' });
    const url = new URL(req.url || '/', 'http://fixture');
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(url.pathname === '/health' ? data : { code: status === 200 ? 0 : status, message: status === 200 ? 'ok' : String(data), data }));
    };
    if (req.headers.authorization !== 'Bearer ' + token) return send('unauthorized', 401);
    if (url.pathname === '/health') return send({ product: 'project-communications-service', apiVersion: 1, version: 'fixture' });
    const path = url.pathname.replace(/^\/v2\/archive\//, '');
    if (path === 'snapshot') return send({ libraries: state.libraries, channels: state.channels, settings: { secretFixture: 'must-not-reach-ui' }, runs: [{ raw: 'not-ui-data' }] });
    if (path === 'agent/tools') return send({ builtins: [{ id: 'messages.read', builtin: true, enabled: true, readOnly: true }], items: [
      { id: 'code.search', name: '代码检索', description: '查找项目代码', enabled: true, readOnly: true, endpoint: 'private-fixture', credentialRef: 'private' },
    ] });
    if (path === 'libraries/default/agent/groups') {
      if (req.method === 'GET') return send({ items: state.groups });
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (input.revision !== state.groups[0].revision) return send('agent_revision_conflict', 409);
      state.groups[0] = { ...state.groups[0], ...input, revision: input.revision + 1 };
      return send(state.groups[0]);
    }
    if (path === 'libraries/default/topics') {
      if (state.failLists) { await new Promise(resolve => setTimeout(resolve, 100)); return send('fixture_unavailable', 503); }
      let items = state.topics.filter(topic => !url.searchParams.get('query') || topic.title.includes(url.searchParams.get('query')!));
      if (url.searchParams.has('messageId')) items = items.filter(topic => topic.messages.some(message => message.id === url.searchParams.get('messageId')));
      if (url.searchParams.has('sourceId')) items = items.filter(topic => topic.sourceId === url.searchParams.get('sourceId'));
      if (url.searchParams.has('channelId')) items = items.filter(topic => topic.channelId === url.searchParams.get('channelId'));
      const before = url.searchParams.get('beforeId');
      if (before) items = items.slice(items.findIndex(topic => topic.id === before) + 1);
      const limit = Math.min(Number(url.searchParams.get('limit') || 30), 2), page = items.slice(0, limit), hasMore = items.length > limit;
      return send({ items: page.map(({ messages, ...topic }) => topic), hasMore, ...(hasMore ? { next: { beforeUpdated: page.at(-1)!.updatedAt, beforeId: page.at(-1)!.id } } : {}) });
    }
    const topicMatch = /^libraries\/default\/topics\/([^/]+)(?:\/(messages))?$/.exec(path);
    if (topicMatch) {
      const topic = state.topics.find(item => item.id === decodeURIComponent(topicMatch[1]));
      if (!topic) return send('topic_missing', 404);
      return send(topicMatch[2] ? { items: topic.messages.slice(Number(url.searchParams.get('offset') || 0)), hasMore: false } : topic);
    }
    const original = /^libraries\/default\/messages\/([^/]+)$/.exec(path);
    if (original) {
      const message = state.originalMessages.get(original[1]) || state.topics.flatMap(topic => topic.messages).find(message => message.id === original[1]);
      return message ? send(message) : send('message_missing',404);
    }
    const context = /^libraries\/default\/messages\/([^/]+)\/context$/.exec(path);
    if (context) {
      const anchor = state.topics.flatMap(topic => topic.messages).find(message => message.id === context[1]);
      return send({ items: [state.context, ...(anchor ? [anchor] : [])], hasBefore: false, hasAfter: false });
    }
    if (path === 'libraries/default/assets/pdf-original') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
      return res.end(pdf);
    }
    if (/^libraries\/default\/assets\/video-(original|duplicate)$/.test(path)) {
      if(state.unavailableAssets.has(path.split('/').at(-1)!))return send('asset_not_ready',404);
      if(url.searchParams.get('view')==='thumbnail') {
        res.writeHead(200,{'Content-Type':'image/png','Content-Length':image.length});return res.end(image);
      }
      res.writeHead(200, {'Content-Type':'video/mp4','Content-Length':video.length});
      return res.end(video);
    }
    if (/^libraries\/default\/assets\/image-[123]$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length });
      return res.end(image);
    }
    send('route_missing', 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { state, token, image, pdf, video, url: 'http://127.0.0.1:' + address.port,
    imageHash: createHash('sha256').update(image).digest('hex'),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
