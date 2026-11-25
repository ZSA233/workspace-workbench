import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TopicMaterialPreview, TopicSelection, ArchiveMessage, ArchiveAsset } from '../shared/extensions/project-communications/topics.ts';
import { messageText, topicTitle, topicNoteSchema, type TopicTarget, type TopicNewSession } from '../shared/extensions/project-communications/topics.ts';
import type { TopicSessionIdentity } from './topic-targets.ts';
import type { ReviewArtifactReference } from '../shared/review-packet.ts';
import { readStoredArtifact, storeArtifactBytes } from './artifacts.ts';
import type { ArchiveTopics } from './archive-topics.ts';
import {prepareTopicContent,topicMessageKey,type TopicContentEntry,type TopicContentOptions} from '../shared/extensions/project-communications/topic-content.ts';
import {topicVideoPreview} from './topic-video.ts';
import {videoTime,type TopicStoredVideo} from '../shared/topic-video.ts';
import { ArchiveIssues } from './archive-issues.ts';
import { issueMaterialText, type IssueSelection, type IssueVersion } from '../shared/extensions/project-communications/issues.ts';

type StoredPreview = TopicMaterialPreview & { scope: string; agentId: string; references: ReviewArtifactReference[]; dispatchText?: string;
  issueVersions?: IssueVersion[];
  session?: TopicSessionIdentity;content?:TopicContentOptions;sessionTitle?:string;videoMaterials?:TopicStoredVideo[]; originalTexts?: Array<{ topicId: string; messageId: string; version: string; text: string; displayText?: string;editedText?:string;sender?:ArchiveMessage['sender'];createdAt?:number; quote?: unknown }> };
type DeliveryResult = { delivery: string; messageId?: string; session?: TopicSessionIdentity };
const maxMaterialText = 120_000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function register(input: Parameters<typeof storeArtifactBytes>[0]) {
  try {
    const existing = readStoredArtifact(input.id);
    if (hash(existing.bytes) !== hash(Buffer.from(input.bytes))) throw Error('artifact_integrity_failed');
    return existing.metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return storeArtifactBytes(input);
  }
}
export class TopicMaterials {
  readonly root: string;
  readonly scope: string;
  constructor(root: string, scope: string) { this.root = root; this.scope = scope; }
  private file(id: string) { return join(this.root, 'extensions', 'topic-materials', hash(id) + '.json'); }
  private write(value: StoredPreview) {
    const file = this.file(value.id); mkdirSync(join(this.root, 'extensions', 'topic-materials'), { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
  }
  read(id: string): StoredPreview {
    const value: StoredPreview = JSON.parse(readFileSync(this.file(id), 'utf8'));
    if (value.id !== id || value.scope !== this.scope) throw Error('topic_material_scope_changed');
    return value;
  }
  public(value: StoredPreview): TopicMaterialPreview {
    const { scope, agentId, references, dispatchText, session, originalTexts, content, sessionTitle, videoMaterials, issueVersions, ...result } = value; return result;
  }
  async preview(archive: ArchiveTopics, workspaceId: string, agentId: string, selections: TopicSelection[], target?: TopicTarget,
    options: {note?: string; newSession?: TopicNewSession; content?: TopicContentOptions; issueSelections?: IssueSelection[]} = {}) {
    const note = topicNoteSchema.parse(options.note || '');
    const issueSelections = options.issueSelections || [];
    if (new Set(selections.map(item => item.topicId)).size !== selections.length) throw Error('duplicate_topic_selection');
    if (new Set(issueSelections.map(item => item.issueId)).size !== issueSelections.length) throw Error('duplicate_issue_selection');
    if (selections.length + issueSelections.length > 20 ||
      selections.reduce((n, item) => n + item.messages.length, 0) + issueSelections.reduce((n, item) => n + Number(item.body) + item.comments.length, 0) > 100 ||
      selections.reduce((n, item) => n + item.assets.length, 0) + issueSelections.reduce((n, item) => n + item.attachments.length, 0) > 20) throw Error('topic_material_limit');
    if(selections.reduce((sum,item)=>sum+item.messages.reduce((count,message)=>count+(message.editedText?.length||0),0),0)>maxMaterialText)throw Error('topic_material_text_limit');
    if (!issueSelections.length && !selections.some(item => item.messages.length || item.assets.length || item.includeAnalysis)) throw Error('topic_material_empty');
    const value: StoredPreview = { id: randomUUID(), workspaceId, agentId, scope: this.scope, state: 'preview', createdAt: Date.now(), readConfirmed: false, text: '', topics: [], assets: [], references: [], originalTexts: [],
      ...(target?.id ? { targetId: target.id } : {}),
      ...(agentId ? { targetAgentId: agentId } : {}),
      ...(note.trim() ? { note } : {}), ...(options.newSession ? { newSession: options.newSession } : {}),
      ...(target?.kind === 'session' ? { session: { agentId, cwd: target.cwd!, hostWorkspaceId: target.hostWorkspaceId || '' } } : {}) };
    const sections: string[] = [],entries:TopicContentEntry[]=[];
    const videoPreviewDeadline = Date.now() + 8000;
    const files = new Map<string,string>(),contents=new Map<string,string>(),parents=new Map<string,Set<string>>(); let bytes = 0, videoFrameBytes = 0;
    const associate=(referenceId:string,message:ArchiveMessage)=>{const keys=parents.get(referenceId)||new Set<string>();keys.add(topicMessageKey(message));parents.set(referenceId,keys);};
    const freezeAsset = async (key: string, asset: Pick<ArchiveAsset, 'id' | 'name' | 'mimeType' | 'sha256'>,
      load: () => Promise<{ bytes: Buffer; mimeType: string }>, original?: ArchiveMessage) => {
      let referenceId = files.get(key);
      if (!referenceId) {
        const data = await load();
        const sha256 = hash(data.bytes);
        if (asset.sha256 && asset.sha256 !== sha256) throw Error('topic_asset_version_changed');
        const mimeType = (asset.mimeType || data.mimeType).toLowerCase();
        if (mimeType.startsWith('video/') && mimeType !== data.mimeType.toLowerCase()) throw Error('topic_asset_version_changed');
        const contentKey = mimeType + ':' + sha256;
        referenceId = contents.get(contentKey);
        if (!referenceId) {
          bytes += data.bytes.length;
          if (bytes > 24 * 1024 * 1024) throw Error('topic_material_bytes_limit');
          const id = 'topic-' + hash(key + ':' + sha256);
          const stored = register({ id, title: asset.name || '附件', mimeType, bytes: data.bytes, kind: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'file' : mimeType === 'application/pdf' ? 'pdf' : 'document' });
          value.references.push({ id, assetId: id, title: stored.title, mimeType: stored.mimeType, kind: stored.kind, required: false });
          contents.set(contentKey, id);
          referenceId = id;
          if (mimeType.startsWith('video/')) {
            const video = await topicVideoPreview(data.bytes, archive.connection.signal, videoPreviewDeadline - Date.now());
            const frozen: TopicStoredVideo = { assetId: id, name: stored.title, size: stored.size, duration: video.duration, frames: [], ...(video.error ? { error: video.error } : {}) };
            const frameBytes = video.frames.reduce((size, frame) => size + Buffer.byteLength(frame.base64, 'base64'), 0);
            const frameCount = (value.videoMaterials || []).reduce((count, item) => count + item.frames.length, 0);
            const frames = bytes + videoFrameBytes + frameBytes <= 24 * 1024 * 1024 && frameCount + video.frames.length <= 24 ? video.frames : [];
            for (const frame of frames) {
              const frameBytes = Buffer.from(frame.base64, 'base64'); videoFrameBytes += frameBytes.length;
              const frameId = 'topic-frame-' + hash(sha256 + ':' + frame.time + ':' + hash(frameBytes));
              const image = register({ id: frameId, title: stored.title + ' · ' + videoTime(frame.time) + '.jpg', mimeType: frame.mimeType, bytes: frameBytes, kind: 'image' });
              value.references.push({ id: frameId, assetId: frameId, title: image.title, mimeType: image.mimeType, kind: 'image', required: false });
              frozen.frames.push({ assetId: frameId, time: frame.time });
            }
            (value.videoMaterials ||= []).push(frozen);
          }
        }
        files.set(key, referenceId);
        value.assets.push({ id: asset.id, name: asset.name || '附件', mimeType, sha256, size: data.bytes.length });
      }
      if (original) {
        associate(referenceId, original);
        for (const frame of value.videoMaterials?.find(item => item.assetId === referenceId)?.frames || []) associate(frame.assetId, original);
      }
    };
    for (const selection of selections) {
      const topic = await archive.read(selection.topicId);
      if (topic.revision !== selection.revision || topic.inputRevision !== selection.inputRevision) throw Error('topic_material_version_changed');
      const messages = new Map<string, Promise<ArchiveMessage>>();
      const message = (id: string, contextOf?: string) => {
        const key = JSON.stringify([id, contextOf]); let result = messages.get(key);
        if (!result) { result = archive.message(topic, id, contextOf); messages.set(key, result); }
        return result;
      };
      const seen = new Set<string>();
      for (const reference of selection.messages) {
        if (seen.has(reference.id)) throw Error('duplicate_message_selection'); seen.add(reference.id);
        const original = await message(reference.id, reference.contextOf);
        if (original.version !== reference.version) throw Error('topic_message_version_changed');
        const text = messageText(original),editedText=reference.editedText;
        value.originalTexts!.push({ topicId: topic.id, messageId: original.id, version: original.version, text: original.text, displayText: text,
          sender:original.sender,createdAt:original.createdAt,...(editedText===undefined?{}:{editedText}),
          ...(original.quote ? {quote:original.quote} : {}) });
        entries.push({topicId:topic.id,message:original,editedText,includeText:true,assetIds:selection.assets.filter(asset=>asset.messageId===original.id).map(asset=>asset.id)});
      }
      for (const reference of selection.assets) {
        const original = await message(reference.messageId, reference.contextOf);
        if (original.version !== reference.messageVersion) throw Error('topic_message_version_changed');
        const asset = original.assets?.find(item => item.id === reference.id);
        if (!asset || asset.state !== 'ready') throw Error('topic_asset_not_ready');
        if(!selection.messages.some(message=>message.id===original.id))entries.push({topicId:topic.id,message:original,includeText:false,
          assetIds:selection.assets.filter(asset=>asset.messageId===original.id).map(asset=>asset.id)});
        await freezeAsset(JSON.stringify([archive.libraryId, asset.id]), asset, () => archive.original(asset), original);
      }
      if (selection.includeAnalysis) sections.push(topic.lastAnswer || topic.summary || '');
      value.topics.push({ id: topic.id, title: topicTitle(topic), revision: topic.revision, inputRevision: topic.inputRevision, messageCount: selection.messages.length, assetCount: selection.assets.length });
      // An attachment can finish or the topic can receive a correction during
      // retrieval. Reject the mixed snapshot instead of silently expanding it.
      const current = await archive.read(topic.id);
      if (current.revision !== topic.revision || current.inputRevision !== topic.inputRevision) throw Error('topic_material_version_changed');
    }
    const issues = new ArchiveIssues(archive.connection);
    let issueTextLength = 0;
    for (const selection of issueSelections) {
      const { issue, attachments } = await issues.selection(selection);
      const text = issueMaterialText({ issue, selection });
      issueTextLength += text.length;
      if (issueTextLength > maxMaterialText) throw Error('topic_material_text_limit');
      for (const attachment of attachments) {
        await freezeAsset(JSON.stringify(['tapd', issues.libraryId, issue.id, issue.version, attachment.id]), attachment, () => issues.original(issue, attachment));
      }
      if (attachments.length) await issues.current(selection);
      sections.push(text);
      (value.issueVersions ||= []).push({ issueId: issue.id, version: issue.version });
      (value.issues ||= []).push({ id: issue.id, title: issue.title, number: issue.number, version: issue.version,
        messageCount: Number(selection.body) + selection.comments.length, assetCount: attachments.length });
    }
    if (bytes + videoFrameBytes > 24 * 1024 * 1024) {
      const frames = new Set(value.videoMaterials?.flatMap(video => video.frames.map(frame => frame.assetId)));
      value.references = value.references.filter(reference => !frames.has(reference.assetId!));
      for (const video of value.videoMaterials || []) video.frames = [];
    }
    const instruction = value.note ? value.note + '\n\n' : '';
    const rendered=prepareTopicContent(entries,options.content||{layout:'text',identity:'name'},value.note||'',sections);
    value.text=rendered.text;if(options.content)value.content={...rendered.options,aliases:rendered.people.map(({key,label})=>({key,label}))};
    const order=new Map(rendered.rows.map((row,index)=>[row.key,index]));
    const position=(reference:ReviewArtifactReference)=>Math.min(...[...(parents.get(reference.id)||[])].map(key=>order.get(key)??Infinity));
    value.references.sort((left,right)=>position(left)-position(right));
    if(value.videoMaterials?.length) {
      const referenceOrder=new Map(value.references.map((reference,index)=>[reference.assetId,index]));
      const imageOrder=new Map(value.references.filter(reference=>reference.mimeType?.startsWith('image/')).map((reference,index)=>[reference.assetId,index+1]));
      value.videoMaterials.sort((left,right)=>(referenceOrder.get(left.assetId)??Infinity)-(referenceOrder.get(right.assetId)??Infinity));
      value.text += (value.text.trim()?'\n\n':'')+value.videoMaterials.map((video,index)=>
        video.frames.length ? '视频 '+(index+1)+'：'+video.name+'（'+videoTime(video.duration)+'）。已附原视频和 '+video.frames.length+' 张时间点画面：'+video.frames.map(frame=>'附图 '+imageOrder.get(frame.assetId)+' = '+videoTime(frame.time)).join('、')+'。画面不含音频转写。'
          : '视频 '+(index+1)+' '+video.name+'。已附原视频文件，可直接读取。').join('\n');
    }
    value.sessionTitle=(rendered.noteText.split('\n').find(line=>line.trim())||rendered.rows.find(row=>row.text.trim())?.text.split('\n').find(line=>line.trim())||value.issues?.[0]?.title)?.slice(0,80);
    if(!value.text.trim()&&!value.references.length)throw Error('topic_material_empty');
    if (value.text.length > maxMaterialText || value.originalTexts!.reduce((length, item) => length + item.text.length, 0) > maxMaterialText) throw Error('topic_material_text_limit');
    if (value.text.length > 32768 && target?.kind !== 'session' && !options.newSession) {
      if (value.references.length >= 20 || Buffer.byteLength(value.text) > 512 * 1024) throw Error('topic_material_text_limit');
      const id = 'topic-source-' + hash(value.text);
      const stored = register({ id, title: '话题原始材料.md', mimeType: 'text/markdown', bytes: Buffer.from(value.text), kind: 'document' });
      value.references.unshift({ id, assetId: id, title: stored.title, mimeType: stored.mimeType, kind: stored.kind, required: true });
      value.dispatchText = instruction + '完整原文见随附文档「话题原始材料.md」。';
    }
    this.write(value);
    return this.public(value);
  }
  private adoptSession(value: StoredPreview, result: DeliveryResult) {
    if (result.session) { value.session = result.session; value.targetAgentId = result.session.agentId; value.workspaceId = result.session.hostWorkspaceId; }
  }
  recordSession(id: string, session: TopicSessionIdentity, messageId: string) {
    const value = this.read(id);
    if (!['sending','uncertain'].includes(value.state)) throw Error('topic_delivery_not_claimed');
    if (value.session && JSON.stringify(value.session) !== JSON.stringify(session)) throw Error('topic_target_changed');
    this.adoptSession(value,{delivery:value.state,session}); value.messageId=messageId; this.write(value);
  }
  async send(id: string, agentId: string, deliver: (value: StoredPreview) => Promise<DeliveryResult>, checkIssues?: (refs: IssueVersion[]) => Promise<void>) {
    let value = this.read(id);
    if (value.agentId !== agentId) throw Error('topic_target_changed');
    if (value.state !== 'preview') return this.public(value);
    if (value.issueVersions?.length) {
      if (!checkIssues) throw Error('issue_material_unavailable');
      try { await checkIssues(value.issueVersions); }
      catch (error) {
        const latest = this.read(id);
        if (latest.state !== 'preview') return this.public(latest);
        throw error;
      }
      value = this.read(id);
      if (value.state !== 'preview') return this.public(value);
    }
    // This durable claim is never removed: a crash before the receipt is
    // reconciled must not make this preview eligible for another dispatch.
    try { writeFileSync(this.file(id) + '.claim', '', { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      value.state = 'uncertain'; this.write(value); return this.public(value);
    }
    value.state = 'sending'; this.write(value);
    try {
      const result = await deliver(value);
      this.adoptSession(value, result);
      value.state = result.delivery === 'accepted' ? 'accepted' : 'uncertain';
      value.messageId = result.messageId;
    } catch { value.state = 'uncertain'; }
    const current = this.read(id);
    if (current.state === 'accepted') return this.public(current);
    this.write(value); return this.public(value);
  }
  async receipt(id: string, agentId: string, read: (value: StoredPreview) => Promise<DeliveryResult>) {
    const value = this.read(id);
    if (value.agentId !== agentId) throw Error('topic_target_changed');
    if (value.state === 'sending' || value.state === 'uncertain') {
      const result = await read(value);
      const current = this.read(id);
      if (current.state === 'accepted') return this.public(current);
      this.adoptSession(value, result);
      if (result.delivery === 'accepted') { value.state = 'accepted'; value.messageId = result.messageId || value.messageId; }
      if (result.session || result.delivery === 'accepted') this.write(value);
    }
    return this.public(value);
  }
}
