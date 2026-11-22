import type { ArchiveAsset, ArchiveChannel, ArchiveDirectory, ArchiveGroup, ArchiveMessage, ArchiveTopic, ArchiveTopicDetail, ArchiveTool, TopicContext, TopicPage, WatchedGroup } from '../shared/extensions/project-communications/topics.ts';
import { assetIsVideo, groupKey } from '../shared/extensions/project-communications/topics.ts';
import type { CommunicationsConnection } from './communications-connection.ts';
import { MAX_REGISTERED_BYTES } from '../shared/artifact-limits.ts';
import {prepareTopicVideo} from './topic-video.ts';

const segment = (value: string) => encodeURIComponent(value);
function topicHeader(topic: ArchiveTopic): ArchiveTopic {
  const answer: unknown = topic.lastAnswer;
  return { id: topic.id, title: topic.title, question: topic.question, issueSummary: topic.issueSummary, preview: topic.preview,
    sourceId: topic.sourceId, channelId: topic.channelId, sourceAccountId: topic.sourceAccountId,
    revision: topic.revision, inputRevision: topic.inputRevision, status: topic.status, category: topic.category,
    updatedAt: topic.updatedAt, rootMessageId: topic.rootMessageId, summary: topic.summary, messageCount: topic.messageCount,
    lastAnswer: typeof answer === 'string' ? answer : typeof answer === 'object' && answer !== null && 'answer' in answer && typeof answer.answer === 'string' ? answer.answer : '' };
}
export class ArchiveTopics {
  readonly connection: CommunicationsConnection;
  private contexts = new Map<string, Promise<TopicContext>>();
  private members = new Map<string, Map<string, ArchiveMessage>>();
  private assetMetadata = new Map<string, Promise<ArchiveAsset>>();
  constructor(connection: CommunicationsConnection) { this.connection = connection; }
  get libraryId() { return this.connection.config.libraryId || 'default'; }
  path(suffix: string, libraryId = this.libraryId) { return 'libraries/' + segment(libraryId) + '/' + suffix; }
  async directory(libraryId = this.libraryId): Promise<ArchiveDirectory> {
    const [snapshot, groups, tools] = await Promise.all([
      this.connection.archive<{ libraries: ArchiveDirectory['libraries']; channels?: ArchiveChannel[] }>('snapshot?library=' + segment(libraryId) + '&part=directory'),
      this.connection.archive<{ items: ArchiveGroup[] }>(this.path('agent/groups', libraryId)),
      this.connection.archive<{ items: ArchiveTool[]; builtins: ArchiveTool[] }>('agent/tools'),
    ]);
    // Neither model credentials nor run/history payloads cross into the connector UI.
    return { libraries: snapshot.libraries, channels: (snapshot.channels || []).map(channel => ({...channel, channelId: channel.channelId || channel.id})), groups: groups.items || [], tools: [...(tools.builtins || []), ...(tools.items || [])].map(({ id, name, description, enabled, builtin, readOnly }) => ({ id, name, description, enabled, builtin, readOnly })) };
  }
  watched(): WatchedGroup[] { return this.connection.config.watchedGroups || []; }
  allows(value: WatchedGroup) { return this.watched().some(group => groupKey(group) === groupKey(value)); }
  scope(value: WatchedGroup) { if (!this.allows(value)) throw Error('topic_outside_project_scope'); }
  async list(input: {query: string; group?: WatchedGroup; beforeUpdated?: number; beforeId?: string; limit: number}): Promise<TopicPage> {
    if (!this.watched().length) return { items: [], hasMore: false };
    if (input.group) this.scope(input.group);
    const query = new URLSearchParams({ query: input.query, limit: String(input.limit) });
    if (input.group) { query.set('sourceId', input.group.sourceId); query.set('channelId', input.group.channelId); }
    if (input.beforeUpdated) query.set('beforeUpdated', String(input.beforeUpdated));
    if (input.beforeId) query.set('beforeId', input.beforeId);
    const page = await this.connection.archive<TopicPage>(this.path('topics?' + query));
    // Keep the upstream cursor even when a page has no matches in this project's
    // followed groups; the UI must still offer the next page.
    return { ...page, items: (page.items || []).filter(topic => this.allows(topic)).map(topicHeader) };
  }
  async read(id: string): Promise<ArchiveTopicDetail> {
    const topic = await this.connection.archive<ArchiveTopicDetail>(this.path('topics/' + segment(id)));
    this.scope(topic);
    for(const message of topic.messages||[])this.sameScope(topic,message);
    return {
      ...topicHeader(topic),
      messages: await this.hydrate(topic.messages || []),
      messageCount: topic.messageCount, hasMoreMessages: topic.hasMoreMessages,
    };
  }
  private async hydrate(messages: ArchiveMessage[]) {
    const result:ArchiveMessage[]=[];
    for(let offset=0;offset<messages.length;offset+=4) {
      result.push(...await Promise.all(messages.slice(offset,offset+4).map(async message=>{
        const assets=(message.assets||[]).filter(asset=>asset.kind!=='avatar');
        if(assets.length||!/\[(?:视频|图片|媒体|附件|文件)消息\]/.test(message.text||''))return {...message,assets};
        // Legacy topic snapshots can omit attachments. Borrow only the exact
        // original's asset metadata; never a newer body or another speaker's file.
        try {
          const original=await this.connection.archive<ArchiveMessage>(this.path('messages/'+segment(message.id)));
          const matches=original.id===message.id&&original.version===message.version&&original.sourceId===message.sourceId&&
            original.channelId===message.channelId&&original.sourceAccountId===message.sourceAccountId&&(!message.archiveId||original.archiveId===message.archiveId);
          return {...message,assets:matches?(original.assets||[]).filter(asset=>asset.kind!=='avatar'):assets};
        } catch{return {...message,assets};}
      })));
    }
    const videos=result.flatMap(message=>message.assets.flatMap((asset,index)=>assetIsVideo(asset)?[{message,asset,index}]:[]));
    let cursor=0;
    // Probe at most four canonical originals at once. Never read the raw chat URL.
    await Promise.all(Array.from({length:Math.min(4,videos.length)},async()=>{
      while(cursor<videos.length){
        const {message,asset,index}=videos[cursor++];
        const key = JSON.stringify([asset.id, asset.state, asset.mimeType, asset.size]);
        let pending = this.assetMetadata.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              const metadata = await this.connection.metadata(this.originalPath(asset.id));
              if (!metadata.mimeType.startsWith('video/')) return {...asset,kind:'video'};
              const name = !asset.name || asset.name === 'attachment' ? metadata.mimeType === 'video/webm' ? '视频.webm' : metadata.mimeType === 'video/quicktime' ? '视频.mov' : '视频.mp4' : asset.name;
              return {...asset,...metadata,name,kind:'video',state:'ready'};
            } catch {return {...asset,kind:'video'};}
          })(); this.assetMetadata.set(key,pending);
        }
        message.assets[index]=await pending;
      }
    }));
    return result;
  }

  async messages(id: string, offset: number) {
    const topic = await this.read(id);
    const page = await this.connection.archive<{ items: ArchiveMessage[]; hasMore: boolean }>(this.path('topics/' + segment(id) + '/messages?offset=' + offset));
    for (const message of page.items) this.sameScope(topic, message);
    return {...page,items:await this.hydrate(page.items)};
  }
  sameScope(topic: ArchiveTopicDetail, message: ArchiveMessage) {
    if (message.sourceId !== topic.sourceId || message.channelId !== topic.channelId ||
      topic.sourceAccountId && message.sourceAccountId !== topic.sourceAccountId) throw Error('topic_message_outside_scope');
  }
  async member(topic: ArchiveTopicDetail, id: string) {
    const key = JSON.stringify([topic.id, topic.revision, topic.inputRevision]);
    let cache = this.members.get(key);
    if (!cache) {
      cache = new Map(topic.messages.map(message => [message.id, message]));
      this.members.set(key, cache);
    }
    let found = cache.get(id);
    if (!found) {
      // Verify association from topic headers, then read only the selected
      // original. Never scan unselected message pages just to prove membership.
      const query = new URLSearchParams({messageId:id,sourceId:topic.sourceId,channelId:topic.channelId,limit:'100'});
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const page = await this.connection.archive<TopicPage>(this.path('topics?' + query));
        if (page.items.some(item => item.id === topic.id)) {
          found = await this.connection.archive<ArchiveMessage>(this.path('messages/' + segment(id)));
          this.sameScope(topic, found); [found] = await this.hydrate([found]); cache.set(id, found); break;
        }
        if (!page.hasMore || !page.next) break;
        query.set('beforeUpdated',String(page.next.beforeUpdated)); query.set('beforeId',page.next.beforeId);
      }
    }
    if (!found) throw Error('topic_message_not_associated');
    this.sameScope(topic, found);
    return found;
  }
  async context(topicId: string, messageId: string): Promise<TopicContext> {
    const topic = await this.read(topicId);
    return this.contextFor(topic, messageId);
  }
  private contextFor(topic: ArchiveTopicDetail, messageId: string): Promise<TopicContext> {
    const key = JSON.stringify([topic.id, topic.revision, topic.inputRevision, messageId]);
    let cached = this.contexts.get(key);
    if (!cached) {
      cached = (async () => {
        await this.member(topic, messageId);
        const context = await this.connection.archive<TopicContext>(this.path('messages/' + segment(messageId) + '/context'));
        const items = (context.items || []).filter(message => {
          try { this.sameScope(topic, message); return true; } catch { return false; }
        });
        return { items: await this.hydrate(items.slice(0, 41)), hasBefore: context.hasBefore, hasAfter: context.hasAfter };
      })();
      this.contexts.set(key, cached);
    }
    return cached;
  }
  async message(topic: ArchiveTopicDetail, id: string, contextOf?: string): Promise<ArchiveMessage> {
    if (!contextOf) return this.member(topic, id);
    const context = await this.contextFor(topic, contextOf);
    const message = context.items.find(item => item.id === id);
    if (!message) throw Error('topic_context_outside_scope');
    return message;
  }
  async asset(topicId: string, messageId: string, assetId: string, contextOf?: string, part?: 'original'|'video-preview'|'thumbnail') {
    const topic = await this.read(topicId), message = await this.message(topic, messageId, contextOf);
    const asset = message.assets.find(item => item.id === assetId);
    if (!asset || asset.state !== 'ready') throw Error('topic_asset_not_ready');
    const data = part==='thumbnail' ? await this.connection.bytes(this.originalPath(asset.id)+'?view=thumbnail','GET',undefined,MAX_REGISTERED_BYTES) : await this.original(asset);
    if(part==='thumbnail'&&!data.mimeType.startsWith('image/'))throw Error('topic_video_thumbnail_unavailable');
    if(part==='video-preview') {
      if(!assetIsVideo(asset)||!data.mimeType.startsWith('video/'))throw Error('topic_video_not_video');
      return prepareTopicVideo(data.bytes,this.connection.signal);
    }
    return { mimeType: data.mimeType, base64: data.bytes.toString('base64') };
  }
  private originalPath(id: string) {return '/v2/archive/' + this.path('assets/' + segment(id));}
  original(asset: ArchiveAsset) { return this.connection.bytes(this.originalPath(asset.id), 'GET', undefined, MAX_REGISTERED_BYTES); }
  async configure(input: {sourceId: string; channelId: string; revision: number; collect?: boolean; allowedTools: string[]; requestId: string}): Promise<ArchiveGroup> {
    const groups = await this.connection.archive<{items: ArchiveGroup[]}>(this.path('agent/groups'));
    const current = groups.items.find(group => groupKey(group) === groupKey(input));
    if ((current?.revision || 0) !== input.revision) throw Error('agent_revision_conflict');
    return this.connection.archive<ArchiveGroup>(this.path('agent/groups'), 'PUT', {
      sourceId: input.sourceId, channelId: input.channelId, revision: input.revision, requestId: input.requestId,
      // Discovery and permission to reply are separate in the service contract.
      enabled: input.collect === true ? false : current?.enabled || false, allowedTools: input.allowedTools,
      ...(input.collect === true ? {analysisEnabled: true, autoDiscover: true, discoveryAction: 'collect', replyMode: 'off'} :
        input.collect === false ? {autoDiscover: false} : {}),
    });
  }
}
